/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Based on EquiMocha by nxllvxxd and Equicord's FileUpload plugin.
import * as crypto from "crypto";
import { dialog, type IpcMainInvokeEvent } from "electron";
import { createWriteStream } from "fs";
import { open, readFile, stat, unlink, writeFile } from "fs/promises";
import { cpus, tmpdir } from "os";
import { join } from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { Worker } from "worker_threads";

import type {
    NativeChooseFileResult,
    NativeUploadProgress,
    NativeUploadResult,
    UploadOptions
} from "./types";

const DEFAULT_BASE_URL = "https://0807.st";
const USER_AGENT = "Equi0807/1.0 (Equicord plugin; +https://github.com/MarchTheDev/Equi0807)";
const MAX_ANON_BYTES = 10 * 1024 ** 3;
const MAX_PARTNER_BYTES = 50 * 1024 ** 3;
const MAX_PARTNER_BURN_BYTES = 100 * 1024 ** 3;
const MAX_SIMPLE_BYTES = 128 * 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const CHUNK_RETRIES = 4;
const SESSION_KEEPALIVE_MS = 30_000;

const ONE_SHOT_HASH = (crypto as unknown as {
    hash?: (algorithm: string, data: string, outputEncoding: "buffer") => Buffer;
}).hash;

const POW_WORKER_SOURCE = `
const { parentPort, workerData } = require("worker_threads");
const crypto = require("crypto");
const { prefix, bits, start, step } = workerData;

function leadingZeroBits(buffer) {
    let total = 0;
    for (let i = 0; i < buffer.length; i++) {
        const byte = buffer[i];
        if (byte === 0) { total += 8; continue; }
        total += Math.clz32(byte) - 24;
        break;
    }
    return total;
}

const oneShot = typeof crypto.hash === "function" ? crypto.hash : null;
const hash = value => oneShot
    ? oneShot("sha256", value, "buffer")
    : crypto.createHash("sha256").update(value).digest();

let nonce = start;
for (;;) {
    if (leadingZeroBits(hash(prefix + nonce)) >= bits) {
        parentPort.postMessage(String(nonce));
        break;
    }
    nonce += step;
}
`;

interface ApiUploadResponse {
    url: string;
    deletion_url?: string;
    name?: string;
    size?: number;
    expires?: number;
    max_downloads?: number;
    protected?: boolean;
}

interface PowChallenge {
    id: string;
    ts: number;
    bits: number;
    sig: string;
    ttl?: number;
}

interface TempUpload {
    path: string;
    handle: Awaited<ReturnType<typeof open>>;
    size: number;
    written: number;
}

interface UploadSession {
    progress: NativeUploadProgress;
    controller: AbortController;
    cancelled: boolean;
    temp?: TempUpload;
}

const sessions = new Map<string, UploadSession>();

function debug(options: UploadOptions, ...args: unknown[]) {
    if (!options.debug) return;
    console.log("[Equi0807/native]", ...args);
}

function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value: string): string {
    const trimmed = (value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");

    if (!/^https?:\/\/[^\s/]+/i.test(trimmed)) {
        throw new Error("The 0807 instance URL in Equi0807 settings is invalid.");
    }

    return trimmed;
}

function apiUrl(options: UploadOptions, path: string): string {
    return `${normalizeBaseUrl(options.baseUrl)}${path}`;
}

function formatBytes(bytes: number): string {
    if (!bytes) return "0 B";

    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }

    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function sanitizeFilename(name: string): string {
    const base = (name || "")
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 200);

    return base || "upload.bin";
}

function filenameFromUrl(url: string): string {
    try {
        const segment = new URL(url).pathname.split("/").pop();
        if (segment) return decodeURIComponent(segment);
    } catch { }

    return "download.bin";
}

function tempFilePath(): string {
    return join(tmpdir(), `equi0807-${crypto.randomBytes(12).toString("hex")}`);
}

function describeError(error: unknown): string {
    if (!(error instanceof Error)) return String(error);

    const { cause } = (error as { cause?: unknown; });
    if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`;

    return error.message;
}

function translateApiError(raw: string, status: number, context: string): string {
    const messages: Record<string, string> = {
        pow_required: "0807.st rejected the proof-of-work. Please try again.",
        pow_expired: "The proof-of-work expired before the upload finished. Please try again, or lower the simple-upload threshold in settings.",
        pow_reused: "That proof-of-work was already used. Please try again.",
        pow_fail: "Proof-of-work verification failed. Please try again.",
        invalid_token: "Invalid partner token. Check the token in Equi0807 settings.",
        rate: "0807.st rate limit reached. Try again in a few minutes.",
        empty: "Cannot upload an empty file.",
        not_received: "0807.st did not receive the file. Please try again.",
        storage_full: "0807.st storage is full. Try again later.",
        process_fail: "0807.st could not process the file. Please try again.",
        upload_fail: "0807.st rejected the upload. The file type may be blocked, or the upload was interrupted."
    };

    if (raw && messages[raw]) return messages[raw];
    if (status === 401) return messages.invalid_token;
    if (status === 413) return raw || "The file is too large for 0807.st.";
    if (status === 429) return messages.rate;
    if (status === 507) return messages.storage_full;
    if (raw && !/^[a-z0-9_]+$/i.test(raw)) return raw;

    return `${context} failed with HTTP ${status}${raw ? ` (${raw})` : ""}.`;
}

function buildHeaders(options: UploadOptions, extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        ...extra
    };
    const token = options.partnerToken.trim();

    if (token) headers.Authorization = `Bearer ${token}`;

    return headers;
}

async function apiFetch(options: UploadOptions, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(apiUrl(options, path), {
        ...init,
        headers: buildHeaders(options, init.headers as Record<string, string> | undefined)
    });
}

async function readJson<T>(response: Response, context: string): Promise<T> {
    const text = await response.text();
    let data: any = null;

    try {
        data = text ? JSON.parse(text) : null;
    } catch { }

    if (!response.ok) {
        const raw = typeof data?.error === "string" ? data.error : "";
        throw new Error(translateApiError(raw, response.status, context));
    }

    if (data === null) throw new Error(`0807.st returned an empty response (${context}).`);

    return data as T;
}

function createSession(key: string, totalBytes: number): UploadSession {
    const session: UploadSession = {
        controller: new AbortController(),
        cancelled: false,
        progress: {
            phase: "preparing",
            percent: 0,
            transferredBytes: 0,
            totalBytes: Math.max(0, totalBytes),
            partNumber: 0,
            totalParts: 0,
            status: "Preparing upload…"
        }
    };

    sessions.set(key, session);
    return session;
}

function getSession(key: string): UploadSession {
    const session = sessions.get(key);

    if (!session) throw new Error("This upload session is no longer active.");
    if (session.cancelled) throw new Error("Upload cancelled.");

    return session;
}

function setProgress(key: string, patch: Partial<NativeUploadProgress>) {
    const session = sessions.get(key);
    if (!session) return;

    const percent = patch.percent === undefined
        ? session.progress.percent
        : Math.max(0, Math.min(100, patch.percent));

    session.progress = { ...session.progress, ...patch, percent };
}

function throwIfCancelled(session: UploadSession) {
    if (session.cancelled || session.controller.signal.aborted) {
        throw new Error("Upload cancelled.");
    }
}

function finishSession(key: string) {
    const timer = setTimeout(() => sessions.delete(key), SESSION_KEEPALIVE_MS);
    (timer as unknown as { unref?: () => void; }).unref?.();
}

async function cleanupTemp(session: UploadSession) {
    const { temp } = session;
    if (!temp) return;

    session.temp = undefined;
    await temp.handle.close().catch(() => { });
    await unlink(temp.path).catch(() => { });
}

/* -------------------------------------------------------------------------- */
/*                               proof of work                                */
/* -------------------------------------------------------------------------- */

function leadingZeroBits(buffer: Uint8Array): number {
    let bits = 0;

    for (let i = 0; i < buffer.length; i++) {
        const byte = buffer[i];

        if (byte === 0) {
            bits += 8;
            continue;
        }

        bits += Math.clz32(byte) - 24;
        break;
    }

    return bits;
}

function sha256(value: string): Buffer {
    return ONE_SHOT_HASH
        ? ONE_SHOT_HASH("sha256", value, "buffer")
        : crypto.createHash("sha256").update(value).digest();
}

function solvePowSingle(prefix: string, bits: number, signal: AbortSignal): string {
    for (let nonce = 0; ; nonce++) {
        if ((nonce & 0x3fff) === 0 && signal.aborted) throw new Error("Upload cancelled.");
        if (leadingZeroBits(sha256(prefix + nonce)) >= bits) return String(nonce);
    }
}

function solvePowWithWorkers(prefix: string, bits: number, signal: AbortSignal): Promise<string> {
    const workerCount = Math.min(4, Math.max(2, cpus().length));

    return new Promise<string>((resolve, reject) => {
        const workers: Worker[] = [];
        let settled = false;

        const finish = (callback: () => void) => {
            if (settled) return;

            settled = true;
            signal.removeEventListener("abort", onAbort);

            for (const worker of workers) void worker.terminate();

            callback();
        };

        const onAbort = () => finish(() => reject(new Error("Upload cancelled.")));

        signal.addEventListener("abort", onAbort, { once: true });

        for (let index = 0; index < workerCount; index++) {
            let worker: Worker;

            try {
                worker = new Worker(POW_WORKER_SOURCE, {
                    eval: true,
                    workerData: { prefix, bits, start: index, step: workerCount }
                });
            } catch (error) {
                finish(() => reject(error));
                return;
            }

            worker.once("message", (nonce: string) => finish(() => resolve(String(nonce))));
            worker.once("error", error => finish(() => reject(error)));
            worker.once("exit", code => {
                if (!settled) finish(() => reject(new Error(`Proof-of-work worker exited unexpectedly (code ${code}).`)));
            });

            workers.push(worker);
        }
    });
}

async function solvePow(prefix: string, bits: number, signal: AbortSignal): Promise<string> {
    if (bits >= 18 && cpus().length > 1) {
        try {
            return await solvePowWithWorkers(prefix, bits, signal);
        } catch (error) {
            if (signal.aborted) throw error;
            // Worker threads can be unavailable in some hardened Electron setups.
        }
    }

    return solvePowSingle(prefix, bits, signal);
}

async function fetchPow(options: UploadOptions, signal: AbortSignal): Promise<PowChallenge> {
    const response = await fetch(apiUrl(options, "/pow"), {
        headers: {
            "Cache-Control": "no-store",
            "User-Agent": USER_AGENT
        },
        signal
    });
    const challenge = await readJson<PowChallenge>(response, "Fetching proof-of-work");

    if (typeof challenge.id !== "string" || !/^[0-9a-f]{32}$/i.test(challenge.id)
        || !Number.isFinite(challenge.ts) || !Number.isFinite(challenge.bits)
        || typeof challenge.sig !== "string") {
        throw new Error("0807.st returned an invalid proof-of-work challenge.");
    }

    return challenge;
}

async function solveChallenge(options: UploadOptions, key: string, session: UploadSession): Promise<Record<string, string> | null> {
    if (options.partnerToken.trim()) return null;

    throwIfCancelled(session);

    const challenge = await fetchPow(options, session.controller.signal);
    const ttl = challenge.ttl || 120_000;

    if (Math.abs(Date.now() - challenge.ts) > ttl) {
        throw new Error("Your computer's clock is out of sync with the 0807 instance. Fix the system time and try again.");
    }

    const bits = Math.max(1, Math.min(30, Math.round(challenge.bits)));

    setProgress(key, {
        phase: "preparing",
        percent: 1,
        status: `Solving proof-of-work (${bits} bits)…`
    });

    debug(options, "solving pow", { id: challenge.id, bits, ttl: challenge.ttl });

    const nonce = await solvePow(`${challenge.id}.`, bits, session.controller.signal);

    throwIfCancelled(session);

    return {
        pow_id: challenge.id,
        pow_ts: String(challenge.ts),
        pow_bits: String(challenge.bits),
        pow_sig: challenge.sig,
        pow_nonce: nonce
    };
}

/* -------------------------------------------------------------------------- */
/*                                  uploads                                   */
/* -------------------------------------------------------------------------- */

function buildOptionalFields(options: UploadOptions): Record<string, string> {
    const fields: Record<string, string> = {
        expiry: options.expiry,
        maxdl: options.maxDownloads
    };

    if (options.password) fields.password = options.password;
    if (options.vanity) fields.vanity = options.vanity;

    return fields;
}

async function uploadSimple(
    options: UploadOptions,
    key: string,
    session: UploadSession,
    filePath: string,
    filename: string,
    mime: string,
    size: number
): Promise<ApiUploadResponse> {
    const pow = await solveChallenge(options, key, session);

    throwIfCancelled(session);
    setProgress(key, {
        phase: "uploading",
        percent: 5,
        transferredBytes: 0,
        totalBytes: size,
        partNumber: 1,
        totalParts: 1,
        status: "Uploading to 0807.st…"
    });

    const form = new FormData();

    if (pow) {
        for (const [field, value] of Object.entries(pow)) form.append(field, value);
    }

    for (const [field, value] of Object.entries(buildOptionalFields(options))) {
        form.append(field, value);
    }

    const bytes = await readFile(filePath);
    form.append("file", new Blob([bytes], { type: mime }), filename);

    debug(options, "simple upload", { filename, size, mime });

    const response = await apiFetch(options, "/upload", {
        method: "POST",
        body: form,
        signal: session.controller.signal
    });
    const result = await readJson<ApiUploadResponse>(response, "Uploading file");

    if (typeof result.url !== "string") {
        throw new Error("0807.st returned an unexpected upload response.");
    }

    return result;
}

async function uploadChunkWithRetry(
    options: UploadOptions,
    key: string,
    session: UploadSession,
    uploadId: string,
    offset: number,
    buffer: Buffer,
    partNumber: number,
    totalParts: number,
    totalBytes: number,
    completedBytes: number
): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= CHUNK_RETRIES; attempt++) {
        throwIfCancelled(session);

        setProgress(key, {
            phase: attempt === 1 ? "uploading" : "retrying",
            partNumber,
            totalParts,
            totalBytes,
            transferredBytes: completedBytes,
            percent: Math.round(completedBytes / totalBytes * 90) + 5,
            status: attempt === 1
                ? `Uploading part ${partNumber}/${totalParts}…`
                : `Retrying part ${partNumber}/${totalParts} (attempt ${attempt})…`
        });

        try {
            const response = await apiFetch(
                options,
                `/upload/chunk?id=${encodeURIComponent(uploadId)}&offset=${offset}`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/octet-stream",
                        "Content-Length": String(buffer.byteLength)
                    },
                    body: new Uint8Array(buffer),
                    signal: session.controller.signal
                }
            );

            await readJson<{ received: number; }>(response, `Uploading part ${partNumber}`);
            return;
        } catch (error) {
            lastError = error;
            if (session.cancelled) throw error;
            if (attempt === CHUNK_RETRIES) break;

            debug(options, "chunk failed, retrying", { partNumber, attempt, error: describeError(error) });
            await sleep(attempt * 1000);
        }
    }

    throw lastError instanceof Error ? lastError : new Error(`Part ${partNumber} failed.`);
}

async function uploadChunked(
    options: UploadOptions,
    key: string,
    session: UploadSession,
    filePath: string,
    filename: string,
    mime: string,
    size: number
): Promise<ApiUploadResponse> {
    const pow = await solveChallenge(options, key, session);

    throwIfCancelled(session);
    setProgress(key, {
        phase: "preparing",
        percent: 1,
        status: "Starting chunked upload…",
        totalBytes: size
    });

    const initBody: Record<string, unknown> = {
        name: filename,
        size,
        mime,
        maxdl: options.maxDownloads
    };

    if (pow) Object.assign(initBody, pow);
    if (options.vanity) initBody.vanity = options.vanity;

    const initResponse = await apiFetch(options, "/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initBody),
        signal: session.controller.signal
    });
    const init = await readJson<{ uploadId: string; chunkSize?: number; }>(initResponse, "Starting chunked upload");

    if (typeof init.uploadId !== "string" || !init.uploadId) {
        throw new Error("0807.st did not return an upload id.");
    }

    const chunkSize = Math.max(1, Math.min(init.chunkSize || MAX_CHUNK_BYTES, MAX_CHUNK_BYTES));
    const totalParts = Math.ceil(size / chunkSize);
    const handle = await open(filePath, "r");

    debug(options, "chunked upload", { filename, size, chunkSize, totalParts, uploadId: init.uploadId });

    try {
        for (let part = 0; part < totalParts; part++) {
            throwIfCancelled(session);

            const offset = part * chunkSize;
            const length = Math.min(chunkSize, size - offset);
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);

            if (bytesRead !== length) throw new Error("Could not read the file from disk.");

            await uploadChunkWithRetry(
                options,
                key,
                session,
                init.uploadId,
                offset,
                buffer,
                part + 1,
                totalParts,
                size,
                offset
            );

            setProgress(key, {
                phase: "uploading",
                partNumber: part + 1,
                totalParts,
                transferredBytes: offset + length,
                totalBytes: size,
                percent: Math.round((offset + length) / size * 90) + 5
            });
        }
    } finally {
        await handle.close().catch(() => { });
    }

    throwIfCancelled(session);
    setProgress(key, {
        phase: "finalizing",
        percent: 96,
        status: "Finalizing upload…"
    });

    const finishBody: Record<string, unknown> = {
        id: init.uploadId,
        expiry: options.expiry,
        maxdl: options.maxDownloads
    };

    if (options.password) finishBody.password = options.password;
    if (options.vanity) finishBody.vanity = options.vanity;

    const finishResponse = await apiFetch(options, "/upload/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finishBody),
        signal: session.controller.signal
    });
    const result = await readJson<ApiUploadResponse>(finishResponse, "Finalizing upload");

    if (typeof result.url !== "string") {
        throw new Error("0807.st returned an unexpected upload response.");
    }

    return result;
}

async function performPathUpload(
    options: UploadOptions,
    key: string,
    session: UploadSession,
    filePath: string,
    filename: string,
    mime: string,
    knownSize: number
): Promise<ApiUploadResponse> {
    throwIfCancelled(session);

    const size = knownSize > 0 ? knownSize : (await stat(filePath)).size;

    if (size <= 0) throw new Error("Cannot upload an empty file.");

    const limit = !options.partnerToken.trim()
        ? MAX_ANON_BYTES
        : options.maxDownloads === "1" ? MAX_PARTNER_BURN_BYTES : MAX_PARTNER_BYTES;

    if (size > limit) {
        throw new Error(`This file is too large (${formatBytes(size)}). The current limit is ${formatBytes(limit)}.`);
    }

    const safeName = sanitizeFilename(filename);
    const safeMime = mime || "application/octet-stream";
    const simpleLimit = Math.min(options.chunkedThresholdBytes || MAX_SIMPLE_BYTES, MAX_SIMPLE_BYTES);

    setProgress(key, {
        totalBytes: size,
        phase: "preparing",
        percent: 1,
        status: size > simpleLimit ? "Preparing chunked upload…" : "Preparing upload…"
    });

    return size > simpleLimit
        ? uploadChunked(options, key, session, filePath, safeName, safeMime, size)
        : uploadSimple(options, key, session, filePath, safeName, safeMime, size);
}

async function executeUpload(
    key: string,
    totalBytes: number,
    task: (session: UploadSession) => Promise<ApiUploadResponse>
): Promise<NativeUploadResult> {
    const session = createSession(key, totalBytes);

    try {
        const result = await task(session);

        setProgress(key, {
            phase: "success",
            percent: 100,
            partNumber: session.progress.totalParts,
            status: "Uploaded to 0807.st."
        });

        return {
            success: true,
            url: result.url,
            deletionUrl: result.deletion_url
        };
    } catch (error) {
        if (session.cancelled || session.controller.signal.aborted) {
            setProgress(key, { phase: "cancelled", percent: 0, status: "Upload cancelled." });
            return { success: false, error: "Upload cancelled" };
        }

        const message = describeError(error);
        setProgress(key, { phase: "failed", status: message });
        console.error("[Equi0807]", error);

        return { success: false, error: message };
    } finally {
        finishSession(key);
    }
}

async function runPathUpload(
    key: string,
    filePath: string,
    filename: string,
    mime: string,
    size: number,
    options: UploadOptions
): Promise<NativeUploadResult> {
    return executeUpload(key, size, session =>
        performPathUpload(options, key, session, filePath, filename, mime, size)
    );
}

export async function uploadPath(
    _: IpcMainInvokeEvent,
    filePath: string,
    filename: string,
    mime: string,
    options: UploadOptions,
    uploadKey: string
): Promise<NativeUploadResult> {
    return runPathUpload(uploadKey, filePath, filename, mime, 0, options);
}

export async function uploadBuffer(
    _: IpcMainInvokeEvent,
    data: ArrayBuffer,
    filename: string,
    mime: string,
    options: UploadOptions,
    uploadKey: string
): Promise<NativeUploadResult> {
    const tempPath = tempFilePath();

    await writeFile(tempPath, Buffer.from(data));

    try {
        return await runPathUpload(uploadKey, tempPath, filename, mime, data.byteLength, options);
    } finally {
        await unlink(tempPath).catch(() => { });
    }
}

export async function beginTempUpload(
    _: IpcMainInvokeEvent,
    uploadKey: string,
    totalBytes: number
): Promise<void> {
    const session = createSession(uploadKey, totalBytes);
    const tempPath = tempFilePath();
    const handle = await open(tempPath, "w");

    session.temp = {
        path: tempPath,
        handle,
        size: Math.max(0, totalBytes),
        written: 0
    };

    setProgress(uploadKey, {
        phase: "preparing",
        percent: 0,
        transferredBytes: 0,
        totalBytes: Math.max(0, totalBytes),
        status: "Preparing file…"
    });
}

export async function appendTempUpload(
    _: IpcMainInvokeEvent,
    uploadKey: string,
    chunk: ArrayBuffer
): Promise<void> {
    const session = getSession(uploadKey);
    const { temp } = session;

    if (!temp) throw new Error("No temporary upload is active.");

    const buffer = Buffer.from(chunk);
    await temp.handle.write(buffer);

    temp.written += buffer.byteLength;

    const percent = temp.size > 0 ? Math.min(99, Math.round(temp.written / temp.size * 100)) : 0;

    setProgress(uploadKey, {
        phase: "preparing",
        percent,
        transferredBytes: temp.written,
        totalBytes: temp.size,
        status: `Preparing file (${formatBytes(temp.written)}${temp.size > 0 ? ` / ${formatBytes(temp.size)}` : ""})…`
    });
}

export async function uploadTempFile(
    _: IpcMainInvokeEvent,
    uploadKey: string,
    filename: string,
    mime: string,
    options: UploadOptions
): Promise<NativeUploadResult> {
    const session = getSession(uploadKey);
    const { temp } = session;

    if (!temp) throw new Error("No temporary upload is active.");
    if (temp.size > 0 && temp.written !== temp.size) {
        throw new Error(`Only ${formatBytes(temp.written)} of ${formatBytes(temp.size)} were staged.`);
    }

    await temp.handle.close().catch(() => { });
    session.temp = undefined;

    try {
        return await runPathUpload(uploadKey, temp.path, filename, mime, temp.written, options);
    } finally {
        await unlink(temp.path).catch(() => { });
    }
}

export async function discardTempUpload(_: IpcMainInvokeEvent, uploadKey: string): Promise<void> {
    const session = sessions.get(uploadKey);
    if (session) await cleanupTemp(session);
}

export async function getUploadProgress(
    _: IpcMainInvokeEvent,
    uploadKey: string
): Promise<NativeUploadProgress | null> {
    return sessions.get(uploadKey)?.progress ?? null;
}

export async function cancelUpload(_: IpcMainInvokeEvent, uploadKey: string): Promise<void> {
    const session = sessions.get(uploadKey);
    if (!session) return;

    session.cancelled = true;
    session.controller.abort();

    await cleanupTemp(session);

    setProgress(uploadKey, {
        phase: "cancelled",
        percent: 0,
        status: "Upload cancelled."
    });
}

export async function chooseFilePath(_: IpcMainInvokeEvent): Promise<NativeChooseFileResult | null> {
    const result = await dialog.showOpenDialog({ properties: ["openFile"] });

    if (result.canceled || !result.filePaths.length) return null;

    const path = result.filePaths[0];

    return {
        path,
        name: path.split(/[\\/]/).pop() || "upload.bin"
    };
}

/* -------------------------------------------------------------------------- */
/*                               URL uploads                                  */
/* -------------------------------------------------------------------------- */

async function downloadToFile(
    options: UploadOptions,
    key: string,
    session: UploadSession,
    sourceUrl: string,
    destination: string
): Promise<{ size: number; mime: string; }> {
    setProgress(key, {
        phase: "preparing",
        percent: 0,
        transferredBytes: 0,
        totalBytes: 0,
        status: "Downloading source file…"
    });

    const response = await fetch(sourceUrl, {
        redirect: "follow",
        signal: session.controller.signal
    });

    if (!response.ok) throw new Error(`Could not download the source file (HTTP ${response.status}).`);
    if (!response.body) throw new Error("The source returned an empty response.");

    const total = Number(response.headers.get("content-length")) || 0;
    const mime = (response.headers.get("content-type") || "").split(";")[0].trim() || "application/octet-stream";
    let downloaded = 0;

    const stream = Readable.fromWeb(response.body as any);
    const progress = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            downloaded += chunk.byteLength;

            setProgress(key, {
                phase: "preparing",
                percent: total > 0 ? Math.min(99, Math.round(downloaded / total * 100)) : 5,
                transferredBytes: downloaded,
                totalBytes: total,
                status: `Downloading source file (${formatBytes(downloaded)}${total > 0 ? ` / ${formatBytes(total)}` : ""})…`
            });

            callback(null, chunk);
        }
    });

    await pipeline(stream, progress, createWriteStream(destination));

    return { size: downloaded, mime };
}

async function remoteUpload(
    options: UploadOptions,
    key: string,
    session: UploadSession,
    sourceUrl: string
): Promise<ApiUploadResponse> {
    const body: Record<string, unknown> = {
        url: sourceUrl,
        expiry: options.expiry,
        maxdl: options.maxDownloads
    };

    if (options.password) body.password = options.password;
    if (options.vanity) body.vanity = options.vanity;

    setProgress(key, {
        phase: "preparing",
        percent: 1,
        status: "Handing the URL to 0807.st…"
    });

    const response = await apiFetch(options, "/partner/remote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: session.controller.signal
    });
    const job = await readJson<{ jobId: string; status?: string; }>(response, "Starting remote upload");

    if (typeof job.jobId !== "string" || !job.jobId) {
        throw new Error("0807.st did not return a remote upload job id.");
    }

    debug(options, "remote upload job", job);

    for (;;) {
        throwIfCancelled(session);
        await sleep(1500);

        const pollResponse = await apiFetch(options, `/partner/remote/${encodeURIComponent(job.jobId)}`, {
            signal: session.controller.signal
        });
        const poll = await readJson<{
            status: string;
            bytes?: number;
            total?: number;
            error?: string;
            url?: string;
            deletion_url?: string;
            name?: string;
            size?: number;
        }>(pollResponse, "Checking remote upload");

        if (poll.status === "done") {
            if (typeof poll.url !== "string") throw new Error("0807.st finished the remote upload without a link.");

            return {
                url: poll.url,
                deletion_url: poll.deletion_url,
                name: poll.name,
                size: poll.size
            };
        }

        if (poll.status === "failed") throw new Error(poll.error || "0807.st could not fetch that URL.");
        if (poll.status === "cancelled") throw new Error("The remote upload was cancelled.");

        const bytes = poll.bytes || 0;
        const total = poll.total || 0;

        setProgress(key, {
            phase: "uploading",
            percent: total > 0 ? Math.min(99, Math.round(bytes / total * 90) + 5) : 20,
            transferredBytes: bytes,
            totalBytes: total,
            status: `Remote upload: ${poll.status}${total > 0 ? ` (${formatBytes(bytes)} / ${formatBytes(total)})` : ""}…`
        });
    }
}

export async function uploadUrl(
    _: IpcMainInvokeEvent,
    sourceUrl: string,
    filename: string,
    options: UploadOptions,
    uploadKey: string
): Promise<NativeUploadResult> {
    return executeUpload(uploadKey, 0, async session => {
        if (options.partnerToken.trim()) {
            return remoteUpload(options, uploadKey, session, sourceUrl);
        }

        const tempPath = tempFilePath();

        try {
            const downloaded = await downloadToFile(options, uploadKey, session, sourceUrl, tempPath);

            return await performPathUpload(
                options,
                uploadKey,
                session,
                tempPath,
                filename || filenameFromUrl(sourceUrl),
                downloaded.mime,
                downloaded.size
            );
        } finally {
            await unlink(tempPath).catch(() => { });
        }
    });
}
