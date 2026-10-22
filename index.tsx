/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Based on EquiMocha by nxllvxxd and Equicord's FileUpload plugin.
import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { isPluginEnabled, plugins } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { OpenExternalIcon } from "@components/Icons";
import { copyToClipboard } from "@utils/clipboard";
import { classNameFactory } from "@utils/css";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findCssClassesLazy } from "@webpack";
import { ChannelStore, createRoot, DraftType, FluxDispatcher, Menu, PermissionsBits, PermissionStore, React, SelectedChannelStore, SelectedGuildStore, showToast, useEffect, useState } from "@webpack/common";

import { buildClipboardText, LinkAction, parseLinkAction, planLinkDelivery, shouldIncludeDeletion } from "./links";
import {
    DEFAULT_THRESHOLD_MB,
    DEFAULT_UPLOAD_MODE,
    formatThreshold,
    parseUploadMode,
    resolveThresholdBytes,
    shouldUploadFile,
    THRESHOLD_MARKERS,
    UploadMode
} from "./threshold";
import type { NativeChooseFileResult, NativeUploadProgress, NativeUploadResult, UploadOptions } from "./types";
import { findEnabledUploader } from "./uploader";

const cl = classNameFactory("vc-equi0807-");
const SERVICE_LABEL = "0807.st";
const STAGING_CHUNK_BYTES = 8 * 1024 * 1024;
/** How recently a file drag must have happened for a dispatcher event to count as a drop. */
const DROP_GRACE_MS = 2000;
/** Window in which a file-picker or paste is considered the cause of an upload. */
const INPUT_GRACE_MS = 2000;
/**
 * How long a file stays "already handled" by one of our two interception
 * paths. Short on purpose: one user action produces at most a dispatcher event
 * and a DOM drop, milliseconds apart, while a genuine retry takes longer.
 */
const HANDLED_FILE_TTL_MS = 2000;

let lastFileDragAt = 0;
let lastPickerAt = 0;
let lastPasteAt = 0;

/**
 * Files already claimed by one of our handlers. Both the DOM drop path and the
 * FluxDispatcher path claim their files, so a drop that reaches both is only
 * ever uploaded once.
 */
const handledFiles = new Map<string, number>();

function fileKey(file: File): string {
    return `${file.name}:${file.size}:${file.lastModified}`;
}

function markFilesHandled(files: readonly File[]) {
    const now = Date.now();

    for (const [key, at] of handledFiles) {
        if (now - at > HANDLED_FILE_TTL_MS) handledFiles.delete(key);
    }

    for (const file of files) handledFiles.set(fileKey(file), now);
}

function isFileHandled(file: File): boolean {
    const at = handledFiles.get(fileKey(file));

    if (at === undefined) return false;
    if (Date.now() - at > HANDLED_FILE_TTL_MS) {
        handledFiles.delete(fileKey(file));
        return false;
    }

    return true;
}

function filterUnhandled(files: readonly File[]): File[] {
    return files.filter(file => !isFileHandled(file));
}

/**
 * Releases files from the handled set. Called when a second path reports the
 * same files for the same action, so that dropping the very same file again
 * later is not silently ignored.
 */
function forgetHandledFiles(files: readonly File[]) {
    for (const file of files) handledFiles.delete(fileKey(file));
}

const Native = IS_DISCORD_DESKTOP
    ? VencordNative.pluginHelpers.Equi0807 as PluginNative<typeof import("./native")>
    : null;

const ENDPOINT_PATTERN = /^https?:\/\/[^\s/]+/i;

const settings = definePluginSettings({
    // ---- connection -----------------------------------------------------
    baseUrl: {
        type: OptionType.STRING,
        displayName: "Instance URL",
        description: "The 0807 server to upload to. Only change this if you host your own instance.",
        default: "https://0807.st",
        placeholder: "https://0807.st",
        isValid: (value: unknown) => ENDPOINT_PATTERN.test(String(value ?? "").trim()) || "Must start with http:// or https://"
    },
    partnerToken: {
        type: OptionType.STRING,
        displayName: "Partner token",
        description: "Optional key from 0807 for higher limits. Most people do not need one.",
        default: "",
        placeholder: "leave empty to upload anonymously"
    },

    // ---- what gets uploaded ---------------------------------------------
    uploadMode: {
        type: OptionType.SELECT,
        displayName: "When to upload",
        description: "What happens to files you send in Discord. Dropped files always upload unless you pick the + menu option.",
        default: DEFAULT_UPLOAD_MODE,
        options: [
            { label: "Files above the size limit", value: UploadMode.AboveLimit, default: true },
            { label: "Every file", value: UploadMode.Everything },
            { label: "Only from the + menu", value: UploadMode.Manual }
        ]
    },
    uploadThresholdMB: {
        type: OptionType.SLIDER,
        displayName: "Size limit",
        description: "Files bigger than this go to 0807 instead of Discord. Drag to 0 for no limit.",
        markers: THRESHOLD_MARKERS,
        default: DEFAULT_THRESHOLD_MB,
        stickToMarkers: false,
        hidden: () => getUploadMode() !== UploadMode.AboveLimit,
        componentProps: {
            onValueRender: formatThreshold
        }
    },
    chunkedThresholdMB: {
        type: OptionType.NUMBER,
        displayName: "Chunked uploads above (MB)",
        description: "Big files are uploaded in resumable pieces from this size up. 32 MB is a good default.",
        default: 32,
        isValid: value => {
            const mb = Number(value);
            if (!Number.isFinite(mb) || mb < 1 || mb > 128) return "Must be between 1 and 128 MB";

            return true;
        }
    },

    // ---- the link you get back -------------------------------------------
    linkAction: {
        type: OptionType.SELECT,
        displayName: "What to do with the link",
        description: "Send the link in chat, paste it in the chat box without sending, or copy it.",
        default: "send",
        options: [
            { label: "Send it in chat", value: "send", default: true },
            { label: "Paste it in the chat box", value: "paste" },
            { label: "Copy it to the clipboard", value: "copy" }
        ]
    },
    alsoCopyLink: {
        type: OptionType.BOOLEAN,
        displayName: "Also copy the link",
        description: "Copy it to the clipboard as well, even though it was sent or pasted.",
        default: false,
        hidden: () => parseLinkAction(settings.store.linkAction) === "copy"
    },
    copyDeletionUrl: {
        type: OptionType.BOOLEAN,
        displayName: "Include the deletion link",
        description: "Add the deletion link on the next line when the link is copied. It is the only way to delete the file later.",
        default: false,
        hidden: () => !isCopyingLink()
    },

    // ---- file retention ---------------------------------------------------
    shareExpiry: {
        type: OptionType.SELECT,
        displayName: "Delete files after",
        description: "How long 0807 keeps the file.",
        default: "0",
        options: [
            { label: "Never", value: "0" },
            { label: "1 hour", value: "1" },
            { label: "1 day", value: "24" },
            { label: "7 days", value: "168" },
            { label: "30 days", value: "720" }
        ]
    },
    maxDownloads: {
        type: OptionType.SELECT,
        displayName: "Max downloads",
        description: "Remove the file after this many downloads.",
        default: "0",
        options: [
            { label: "Infinite", value: "0", default: true },
            { label: "1 download", value: "1" },
            { label: "5 downloads", value: "5" },
            { label: "25 downloads", value: "25" }
        ]
    },

    // ---- advanced ---------------------------------------------------------
    blacklistedServers: {
        type: OptionType.STRING,
        displayName: "Ignore in these servers",
        description: "Comma-separated server IDs where Equi0807 stays out of the way.",
        default: "",
        placeholder: "123456789, 987654321"
    },
    debug: {
        type: OptionType.BOOLEAN,
        displayName: "Debug logging",
        description: "Log each upload and the decision taken to the console. Useful when something will not upload.",
        default: false
    }
});

type RendererPhase = "idle" | NativeUploadProgress["phase"];

interface UploadState {
    phase: RendererPhase;
    fileName: string;
    attempt: number;
    totalAttempts: number;
    percent: number;
    transferredBytes: number;
    totalBytes: number;
    status: string;
    canCancel: boolean;
}

interface UploadInput {
    name: string;
    size: number;
    mime: string;
    file?: File;
    path?: string;
    sourceUrl?: string;
}

interface UploadAddFilesEvent {
    type: string;
    draftType?: unknown;
    files?: unknown;
    uploads?: unknown;
    items?: unknown;
}

const defaultUploadState: UploadState = {
    phase: "idle",
    fileName: "",
    attempt: 0,
    totalAttempts: 0,
    percent: 0,
    transferredBytes: 0,
    totalBytes: 0,
    status: "",
    canCancel: false
};

let isUploading = false;
let cancelRequested = false;
let activeUploadKey: string | null = null;
let uploadState: UploadState = { ...defaultUploadState };
let uploadAddFilesInterceptor: ((event: unknown) => void) | null = null;
let pasteEventListener: ((event: ClipboardEvent) => void) | null = null;
let dragOverEventListener: ((event: DragEvent) => void) | null = null;
let dropEventListener: ((event: DragEvent) => void) | null = null;
let fileInputChangeEventListener: ((event: Event) => void) | null = null;

const uploadStateListeners = new Set<() => void>();

function emitUploadState() {
    for (const listener of uploadStateListeners) listener();
}

function setUploadState(patch: Partial<UploadState>) {
    uploadState = { ...uploadState, ...patch };
    emitUploadState();
}

function resetUploadState() {
    uploadState = { ...defaultUploadState };
    emitUploadState();
}

function subscribeUploadState(listener: () => void): () => void {
    uploadStateListeners.add(listener);
    return () => uploadStateListeners.delete(listener);
}

function getUploadState(): UploadState {
    return uploadState;
}

function debugLog(...args: unknown[]) {
    if (!settings.store.debug) return;
    console.log("[Equi0807]", ...args);
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

function isConfigured(): boolean {
    return Boolean(settings.store.baseUrl?.trim());
}

function isServerBlacklisted(): boolean {
    const guildId = SelectedGuildStore.getGuildId();
    if (!guildId) return false;

    return (settings.store.blacklistedServers ?? "")
        .split(",")
        .map(id => id.trim())
        .filter(Boolean)
        .includes(guildId);
}

function getOtherUploader(): string | null {
    try {
        return findEnabledUploader({
            isInstalled: id => Boolean(plugins[id]),
            isEnabled: id => isPluginEnabled(id)
        });
    } catch {
        return null;
    }
}

/** Whether the link ends up in the clipboard at all. */
function isCopyingLink(): boolean {
    return parseLinkAction(settings.store.linkAction) === "copy" || Boolean(settings.store.alsoCopyLink);
}

let warnedAboutConflict = false;

function warnAboutUploaderConflict() {
    if (warnedAboutConflict) return;

    const other = getOtherUploader();
    if (!other) return;

    warnedAboutConflict = true;
    showToast({
        text: `Equi0807: ${other} is also enabled. Disable one of them if uploads go to the wrong place.`,
        variant: "critical"
    });
}

function isUploadCancelledError(error: unknown): boolean {
    if (cancelRequested) return true;
    if (!(error instanceof Error)) return false;

    const message = error.message.toLowerCase();
    return message.includes("cancelled") || message.includes("canceled") || message.includes("aborted") || message.includes("aborterror");
}

function getUploadOptions(): UploadOptions {
    const chunkedMB = Math.min(128, Math.max(1, Math.round(settings.store.chunkedThresholdMB) || 32));

    return {
        baseUrl: (settings.store.baseUrl ?? "").trim() || "https://0807.st",
        expiry: String(settings.store.shareExpiry ?? "0"),
        maxDownloads: String(Math.max(0, Math.trunc(Number(settings.store.maxDownloads)) || 0)),
        partnerToken: (settings.store.partnerToken ?? "").trim(),
        vanity: "",
        chunkedThresholdBytes: chunkedMB * 1024 * 1024,
        debug: settings.store.debug
    };
}

function createUploadKey(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getNativeFilePath(file: File): string | null {
    const { path } = (file as File & { path?: unknown; });
    return typeof path === "string" && path.length > 0 ? path : null;
}

function filenameFromUrl(url: string): string {
    try {
        const segment = new URL(url).pathname.split("/").pop();
        if (segment) return decodeURIComponent(segment);
    } catch { }

    return "upload.bin";
}

function applyNativeProgress(progress: NativeUploadProgress | null) {
    if (!progress) return;

    setUploadState({
        phase: progress.phase,
        attempt: progress.partNumber,
        totalAttempts: progress.totalParts,
        percent: progress.percent,
        transferredBytes: progress.transferredBytes,
        totalBytes: progress.totalBytes,
        status: progress.status,
        canCancel: progress.phase !== "success" && progress.phase !== "failed" && progress.phase !== "cancelled"
    });
}

function startProgressPolling(key: string): () => void {
    let stopped = false;
    let polling = false;

    const poll = async () => {
        if (stopped || polling || !Native) return;

        polling = true;

        try {
            const progress = await Native.getUploadProgress(key);
            if (!stopped && activeUploadKey === key && progress) applyNativeProgress(progress);
        } catch (error) {
            debugLog("progress poll failed", error);
        } finally {
            polling = false;
        }
    };

    const timer = setInterval(poll, 250);
    void poll();

    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

async function cancelCurrentUpload() {
    if (!activeUploadKey) return;

    cancelRequested = true;

    if (Native) {
        await Native.cancelUpload(activeUploadKey).catch(error => debugLog("cancel failed", error));
    }

    setUploadState({
        phase: "cancelled",
        status: "Upload cancelled.",
        canCancel: false,
        percent: 0
    });
}

function fileToInput(file: File): UploadInput {
    return {
        file,
        name: file.name || "upload.bin",
        size: file.size,
        mime: file.type || ""
    };
}

function getUploadMode(): UploadMode {
    return parseUploadMode(settings.store.uploadMode);
}

function isInterceptionEnabled(): boolean {
    return Boolean(Native)
        && isConfigured()
        && !isServerBlacklisted()
        && getUploadMode() !== UploadMode.Manual;
}

type UploadSource = "drop" | "picker" | "paste" | "unknown";

/*
 * Works out what caused an upload action. This must not depend on our own DOM
 * listeners firing: Discord may stop propagation before they run, in which
 * case an upload looks "unknown" and is treated like a drop (when dots are
 * configured to always upload), instead of silently falling back to Discord.
 */
function describeUploadSource(): UploadSource {
    const now = Date.now();

    if (now - lastFileDragAt < DROP_GRACE_MS) return "drop";
    if (now - lastPickerAt < INPUT_GRACE_MS) return "picker";
    if (now - lastPasteAt < INPUT_GRACE_MS) return "paste";

    return "unknown";
}

function shouldInterceptUploadFiles(files: readonly File[], isDrop: boolean): boolean {
    if (!files.length) return false;
    if (!isInterceptionEnabled()) return false;

    const mode = getUploadMode();
    const threshold = resolveThresholdBytes(mode, settings.store.uploadThresholdMB);

    return files.some(file => shouldUploadFile(file.size, mode, threshold, isDrop));
}

function isArrayLikeFileContainer(value: unknown): value is { length: number;[index: number]: unknown; } {
    return Boolean(
        value
        && typeof value === "object"
        && "length" in value
        && typeof value.length === "number"
        && Number.isFinite(value.length)
    );
}

function extractFilesFromValue(value: unknown, seen = new Set<unknown>()): File[] {
    if (!value || seen.has(value)) return [];
    if (value instanceof File) return [value];
    if (typeof value !== "object") return [];

    seen.add(value);

    if (Array.isArray(value)) {
        return value.flatMap(entry => extractFilesFromValue(entry, seen));
    }

    if (typeof DataTransferItem !== "undefined" && value instanceof DataTransferItem) {
        const file = value.kind === "file" ? value.getAsFile() : null;
        return file ? [file] : [];
    }

    if (isArrayLikeFileContainer(value)) {
        return Array.from({ length: value.length }, (_, index) => value[index])
            .flatMap(entry => extractFilesFromValue(entry, seen));
    }

    const entry = value as Record<string, unknown>;

    return [
        entry.file,
        entry.upload,
        entry.item,
        entry.fileItem,
        entry.uploadItem,
        entry.originalFile,
        entry.platformFile
    ].flatMap(candidate => extractFilesFromValue(candidate, seen));
}

// During dragover the browser exposes no File objects yet, only the "Files" type.
function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    if (dataTransfer.files && dataTransfer.files.length > 0) return true;

    return Array.from(dataTransfer.types || []).includes("Files");
}

function getFilesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
    if (!dataTransfer) return [];

    return Array.from(new Set([
        ...Array.from(dataTransfer.files || []),
        ...extractFilesFromValue(dataTransfer.items)
    ]));
}

function stopFileEvent(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

/* -------------------------------------------------------------------------- */
/*                               upload helpers                               */
/* -------------------------------------------------------------------------- */

/*
 * Copies the file link, with the deletion link on the next line when the user
 * asked for it. Both go into one clipboard entry so neither one is lost.
 */
async function copyLinks(url: string, deletionUrl?: string): Promise<boolean> {
    const includeDeletion = shouldIncludeDeletion(Boolean(settings.store.copyDeletionUrl), deletionUrl);

    await copyToClipboard(buildClipboardText(url, deletionUrl, includeDeletion));

    return includeDeletion;
}

function showCopiedToast(includeDeletion: boolean) {
    showToast({
        text: includeDeletion ? "Link and deletion link copied to clipboard" : "Link copied to clipboard",
        variant: "success"
    });
}

function canWriteIn(channelId: string | undefined): boolean {
    if (!channelId) return false;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return false;

    // Direct messages have no guild permissions to check.
    if (!channel.guild_id) return true;

    return PermissionStore.can(PermissionsBits.SEND_MESSAGES, channel);
}

async function notifyUploadSuccess(url: string, copyOnly: boolean, channelId: string | undefined, deletionUrl?: string, prefix = "") {
    const action: LinkAction = parseLinkAction(settings.store.linkAction);
    const canWrite = canWriteIn(channelId);
    const canPasteHere = Boolean(channelId) && channelId === SelectedChannelStore.getChannelId() && canWrite;
    const delivery = planLinkDelivery(action, Boolean(channelId) && canWrite, canPasteHere, copyOnly);

    if (delivery === "copy") {
        showCopiedToast(await copyLinks(url, deletionUrl));
        return;
    }

    const sendInChat = delivery === "send";

    try {
        if (sendInChat) {
            await sendMessage(channelId!, { content: url });
            showToast({ text: "Link sent in chat", variant: "success" });
        } else {
            insertTextIntoChatInputBox(`${prefix}${url}`);
            showToast({ text: "Link pasted in the chat box", variant: "success" });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        try {
            const includeDeletion = await copyLinks(url, deletionUrl);
            showToast({
                text: `Could not ${sendInChat ? "send" : "paste"} the link (${message}). ${includeDeletion ? "Link and deletion link copied." : "Link copied."}`,
                variant: "critical"
            });
        } catch {
            showToast({ text: `Uploaded, but could not share the link: ${message}`, variant: "critical" });
        }

        return;
    }

    // Sending or pasting does not touch the clipboard unless asked to.
    if (settings.store.alsoCopyLink) {
        await copyLinks(url, deletionUrl).catch(() => { });
    }
}

async function performUpload(input: UploadInput): Promise<NativeUploadResult> {
    if (!Native) {
        throw new Error("0807.st blocks browser uploads (CORS), so Equi0807 requires the Discord desktop app.");
    }

    const key = createUploadKey();
    const options = getUploadOptions();

    activeUploadKey = key;
    cancelRequested = false;

    const stopPolling = startProgressPolling(key);

    try {
        if (input.sourceUrl) {
            return await Native.uploadUrl(input.sourceUrl, input.name, options, key);
        }

        if (input.path) {
            return await Native.uploadPath(input.path, input.name, input.mime, options, key);
        }

        const { file } = input;

        if (!file) throw new Error("No file data was provided.");

        const nativePath = getNativeFilePath(file);

        if (nativePath) {
            return await Native.uploadPath(nativePath, input.name, input.mime, options, key);
        }

        await Native.beginTempUpload(key, file.size);

        try {
            for (let offset = 0; offset < file.size; offset += STAGING_CHUNK_BYTES) {
                if (cancelRequested) throw new Error("Upload cancelled");

                const end = Math.min(offset + STAGING_CHUNK_BYTES, file.size);
                const chunk = await file.slice(offset, end).arrayBuffer();

                await Native.appendTempUpload(key, chunk);
            }
        } catch (error) {
            await Native.discardTempUpload(key).catch(() => { });
            throw error;
        }

        return await Native.uploadTempFile(key, input.name, input.mime, options);
    } finally {
        stopPolling();

        if (activeUploadKey === key) activeUploadKey = null;
    }
}

async function uploadInputs(inputs: UploadInput[], copyOnly = false): Promise<void> {
    if (!Native) {
        showToast({ text: "Equi0807 requires the Discord desktop app.", variant: "critical" });
        return;
    }

    if (!isConfigured()) {
        showToast({ text: "Set a valid 0807 instance URL in Equi0807 settings.", variant: "critical" });
        return;
    }

    if (isUploading) {
        showToast({ text: "An upload is already in progress." });
        return;
    }

    if (!inputs.length) return;

    const channelId = SelectedChannelStore.getChannelId();

    isUploading = true;
    cancelRequested = false;

    try {
        for (let index = 0; index < inputs.length; index++) {
            const input = inputs[index];
            const suffix = inputs.length > 1 ? ` (${index + 1}/${inputs.length})` : "";

            setUploadState({
                phase: "preparing",
                fileName: input.name,
                attempt: 0,
                totalAttempts: 0,
                percent: 0,
                transferredBytes: 0,
                totalBytes: input.size,
                status: `Preparing ${input.name}${suffix}…`,
                canCancel: true
            });

            const result = await performUpload(input);

            if (!result.success || !result.url) {
                throw new Error(result.error || "0807.st did not return a link.");
            }

            setUploadState({
                phase: "success",
                percent: 100,
                status: `Uploaded to ${SERVICE_LABEL}.`,
                canCancel: false
            });

            await notifyUploadSuccess(result.url, copyOnly, channelId, result.deletionUrl, index > 0 ? "\n" : "");
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (isUploadCancelledError(error)) {
            showToast({ text: "Upload cancelled" });
            setUploadState({ phase: "cancelled", status: "Upload cancelled.", canCancel: false, percent: 0 });
        } else {
            showToast({ text: `Upload failed: ${message}`, variant: "critical" });
            console.error("[Equi0807]", error);
            setUploadState({ phase: "failed", status: `Upload failed: ${message}`, canCancel: false, percent: 0 });
        }
    } finally {
        isUploading = false;
        activeUploadKey = null;
        setTimeout(() => {
            if (!isUploading) resetUploadState();
        }, 1800);
    }
}

function uploadUrlFromContext(url: string) {
    void uploadInputs([{
        name: filenameFromUrl(url),
        size: 0,
        mime: "",
        sourceUrl: url
    }], true);
}

async function uploadPickedFile() {
    if (!Native) {
        showToast({ text: "Equi0807 requires the Discord desktop app.", variant: "critical" });
        return;
    }

    let picked: NativeChooseFileResult | null = null;

    try {
        picked = await Native.chooseFilePath();
    } catch (error) {
        debugLog("file picker failed", error);
        showToast({ text: "Could not open the file picker.", variant: "critical" });
        return;
    }

    if (!picked) return;

    await uploadInputs([{
        name: picked.name,
        size: 0,
        mime: "",
        path: picked.path
    }]);
}

/* -------------------------------------------------------------------------- */
/*                              event listeners                               */
/* -------------------------------------------------------------------------- */

function interceptUploadAddFiles(event: unknown) {
    if (!event || typeof event !== "object" || !("type" in event)) return;

    const payload = event as UploadAddFilesEvent;

    if (payload.type !== "UPLOAD_ATTACHMENT_ADD_FILES") return;
    if (payload.draftType !== DraftType.ChannelMessage) return;

    const files = Array.from(new Set([
        ...extractFilesFromValue(payload.files),
        ...extractFilesFromValue(payload.uploads),
        ...extractFilesFromValue(payload.items)
    ]));

    const source = describeUploadSource();
    // An upload with no DOM signal at all is treated as a drop, so it is never
    // silently left to Discord.
    const isDrop = source === "drop" || source === "unknown";
    const pending = filterUnhandled(files);

    debugLog("upload event", {
        source,
        mode: getUploadMode(),
        draftType: payload.draftType,
        files: files.map(file => `${file.name} (${file.size} bytes)`),
        pending: pending.length,
        enabled: isInterceptionEnabled()
    });

    if (!pending.length) {
        debugLog("skipping: every file was already handled by the drop listener");

        // Our drop listener already uploaded these. Make sure Discord does not
        // keep them as attachments either, then release them so the same file
        // can be dropped again later.
        if (files.length) {
            payload.files = [];
            payload.uploads = [];
            payload.items = [];
            forgetHandledFiles(files);
        }

        return;
    }

    if (!shouldInterceptUploadFiles(pending, isDrop)) {
        debugLog("skipping: below threshold or interception disabled");
        return;
    }

    markFilesHandled(pending);

    payload.files = [];
    payload.uploads = [];
    payload.items = [];

    warnAboutUploaderConflict();

    void uploadInputs(pending.map(fileToInput));
}

function handlePaste(event: ClipboardEvent) {
    if (event.defaultPrevented) return;

    const files = Array.from(event.clipboardData?.files || []);

    if (!files.length) return;

    lastPasteAt = Date.now();

    if (!shouldInterceptUploadFiles(files, false)) return;

    event.preventDefault();
    event.stopPropagation();

    markFilesHandled(files);

    void uploadInputs(files.map(fileToInput));
}

// Discord's picker uses a real <input type="file">, so this tells picker
// uploads apart from dropped ones and keeps the size threshold for the picker.
function handleFileInputChange(event: Event) {
    const { target } = event;

    if (target instanceof HTMLInputElement && target.type === "file") {
        lastPickerAt = Date.now();
    }
}

// Dropped files always go to 0807.st, so a mere presence of files is enough.
function shouldHandleDrop(files: readonly File[]): boolean {
    return shouldInterceptUploadFiles(files, true);
}

/*
 * Drag & drop notes (this is subtle, don't "clean it up"):
 *
 * Discord registers its own drag handlers on window and calls
 * preventDefault() + stopPropagation() there. stopPropagation() prevents the
 * event from ever reaching a document listener, so these handlers must be
 * registered on window as well. It does not block other listeners on the very
 * same target, which is why window capture still works even though Discord's
 * listener ran first. For the same reason we must never bail out on
 * event.defaultPrevented: Discord has always set it by the time we run.
 */
const handledFileEvents = new WeakSet<Event>();

function takeFileEvent(event: Event): boolean {
    if (handledFileEvents.has(event)) return false;

    handledFileEvents.add(event);
    return true;
}

function handleDragOver(event: DragEvent) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;

    // Discord may handle the drag itself. Remember that a file drag is in
    // progress so the FluxDispatcher interceptor can recognise dropped files.
    lastFileDragAt = Date.now();

    // Sizes are not available yet while dragging, so only the master switches
    // can be checked here.
    if (!isInterceptionEnabled()) return;

    if (!takeFileEvent(event)) return;

    stopFileEvent(event);

    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function handleDrop(event: DragEvent) {
    const files = getFilesFromDataTransfer(event.dataTransfer);

    if (!files.length) return;

    lastFileDragAt = Date.now();

    // Discord's own listener normally runs first and dispatches the upload
    // action; the interceptor then claims the files. Anything already claimed
    // must not be uploaded a second time here.
    const pending = filterUnhandled(files);

    if (!pending.length) {
        debugLog("drop already handled by the upload interceptor");

        forgetHandledFiles(files);

        if (takeFileEvent(event)) stopFileEvent(event);

        return;
    }

    if (!shouldHandleDrop(pending)) return;
    if (!takeFileEvent(event)) return;

    markFilesHandled(pending);

    stopFileEvent(event);

    warnAboutUploaderConflict();

    debugLog("dropped files", pending.map(file => `${file.name} (${file.size} bytes)`));

    void uploadInputs(pending.map(fileToInput));
}

/* -------------------------------------------------------------------------- */
/*                               context menus                                */
/* -------------------------------------------------------------------------- */

function getMediaUrl(props: any): string | null {
    const src = props?.src ?? props?.itemSrc;
    const href = props?.href ?? props?.itemHref;
    const target = props?.target;

    if (typeof src === "string" && URL.canParse(src)) return src;
    if (typeof href === "string" && URL.canParse(href)) return href;
    if (target instanceof HTMLImageElement && URL.canParse(target.src)) return target.src;
    if (target instanceof HTMLVideoElement && URL.canParse(target.src)) return target.src;
    if (target instanceof HTMLAnchorElement && URL.canParse(target.href)) return target.href;

    return null;
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props) return;

    const url = getMediaUrl({ src: props.itemSrc, href: props.itemHref, target: props.target });
    if (!url) return;

    const group = findGroupChildrenByChildId("open-native-link", children)
        ?? findGroupChildrenByChildId("copy-link", children);

    if (group && !group.some(child => child?.props?.id === "equi0807-upload")) {
        group.push(
            <Menu.MenuItem
                key="equi0807-upload"
                id="equi0807-upload"
                label="Upload to 0807"
                action={() => uploadUrlFromContext(url)}
            />
        );
    }
};

const imageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props) return;
    if ("href" in props && !props.src) return;

    const url = getMediaUrl(props);
    if (!url) return;
    if (children.some(child => child?.props?.id === "equi0807-group")) return;

    children.push(
        <Menu.MenuGroup id="equi0807-group">
            <Menu.MenuItem
                key="equi0807-upload"
                id="equi0807-upload"
                label="Upload to 0807"
                action={() => uploadUrlFromContext(url)}
            />
        </Menu.MenuGroup>
    );
};

const ExternalIcon = () => <OpenExternalIcon height={24} width={24} />;

const channelAttachMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    if (!channel) return;
    if (channel.guild_id && !PermissionStore.can(PermissionsBits.SEND_MESSAGES, channel)) return;
    if (children.some(child => child?.props?.id === "equi0807-manual")) return;

    children.splice(1, 0,
        <Menu.MenuItem
            key="equi0807-manual"
            id="equi0807-manual"
            label="Upload to 0807"
            leadingAccessory={{
                type: "icon",
                icon: ExternalIcon
            }}
            action={() => void uploadPickedFile()}
        />
    );
};

/* -------------------------------------------------------------------------- */
/*                                progress bar                                */
/* -------------------------------------------------------------------------- */

const ChatInputClasses = findCssClassesLazy("channelTextArea", "buttonContainer");

function getChatInputRect(): DOMRect | null {
    const candidates: (HTMLElement | null)[] = [];

    try {
        const { channelTextArea } = ChatInputClasses as { channelTextArea?: string; };
        if (channelTextArea) candidates.push(document.querySelector<HTMLElement>(`.${CSS.escape(channelTextArea)}`));
    } catch { }

    candidates.push(
        document.querySelector<HTMLElement>('[class*="channelTextArea"]'),
        document.querySelector<HTMLElement>('[role="textbox"][contenteditable="true"]')
    );

    for (const element of candidates) {
        const rect = element?.getBoundingClientRect();
        if (rect && rect.width > 120 && rect.height > 0) return rect;
    }

    return null;
}

const ProgressCard = () => {
    const [state, setState] = useState(getUploadState);

    useEffect(() => subscribeUploadState(() => setState(getUploadState())), []);

    if (state.phase === "idle") return null;

    const percentage = Math.max(0, Math.min(100, state.percent));
    const meta = state.totalBytes > 0
        ? `${Math.round(percentage)}% · ${formatBytes(state.transferredBytes)} / ${formatBytes(state.totalBytes)}`
        : `${Math.round(percentage)}%`;

    return (
        <div className={cl("progress-wrap")} data-phase={state.phase}>
            <div className={cl("progress-head")}>
                <div className={cl("progress-label")}>
                    {state.status || "Uploading…"}
                </div>
                <div className={cl("progress-meta")}>
                    <span className={cl("progress-percent")}>{meta}</span>
                    {state.canCancel && (
                        <button
                            type="button"
                            className={cl("progress-cancel")}
                            onClick={() => void cancelCurrentUpload()}
                            aria-label="Cancel upload"
                        >
                            ✕
                        </button>
                    )}
                </div>
            </div>
            <div className={cl("progress-track")}>
                <div className={cl("progress-fill")} style={{ width: `${percentage}%` }} />
            </div>
            <div className={cl("progress-file")}>
                {state.fileName}
                {state.attempt > 0 && state.totalAttempts > 1 ? ` · part ${state.attempt}/${state.totalAttempts}` : ""}
                {` · ${SERVICE_LABEL}`}
            </div>
        </div>
    );
};

const ProgressCardSafe = ErrorBoundary.wrap(ProgressCard, { noop: true });

// The card lives in its own React root attached to <body> and is positioned
// above the message box, so Discord's layout (and its top bar) is never touched.
const ProgressOverlay = () => {
    const [state, setState] = useState(getUploadState);
    const [position, setPosition] = useState<{ left: number; width: number; bottom: number; } | null>(null);

    useEffect(() => subscribeUploadState(() => setState(getUploadState())), []);

    const visible = state.phase !== "idle";

    useEffect(() => {
        if (!visible) return;

        const update = () => {
            const rect = getChatInputRect();
            const width = Math.min(rect?.width ?? 720, window.innerWidth - 40);

            if (rect) {
                setPosition({
                    left: rect.left + (rect.width - width) / 2,
                    width,
                    bottom: Math.max(8, window.innerHeight - rect.top + 8)
                });
            } else {
                setPosition({
                    left: Math.max(20, (window.innerWidth - width) / 2),
                    width,
                    bottom: 96
                });
            }
        };

        update();

        window.addEventListener("resize", update);
        const timer = setInterval(update, 1000);

        return () => {
            window.removeEventListener("resize", update);
            clearInterval(timer);
        };
    }, [visible]);

    if (!visible || !position) return null;

    return (
        <div
            className={cl("progress-overlay")}
            style={{
                left: position.left,
                width: position.width,
                bottom: position.bottom
            }}
        >
            <ProgressCardSafe />
        </div>
    );
};

let progressRoot: ReturnType<typeof createRoot> | null = null;
let progressMountNode: HTMLDivElement | null = null;

function mountProgressOverlay() {
    if (progressRoot) return;

    progressMountNode ??= document.createElement("div");
    if (!progressMountNode.isConnected) document.body.appendChild(progressMountNode);

    progressRoot = createRoot(progressMountNode);
    progressRoot.render(<ProgressOverlay />);
}

function unmountProgressOverlay() {
    progressRoot?.unmount();
    progressRoot = null;

    progressMountNode?.remove();
    progressMountNode = null;
}

/* -------------------------------------------------------------------------- */
/*                                   plugin                                   */
/* -------------------------------------------------------------------------- */

export default definePlugin({
    name: "Equi0807",
    description: "Upload files to 0807.st and share short links.",
    tags: ["Media"],
    authors: [{ name: "TheMarch88", id: 511186459588427795n }],
    settings,
    patches: [
        // Forces an early return on the file size limit nitro upsell modal.
        {
            find: "#{intl::UPLOAD_AREA_TOO_LARGE_HELP_PREMIUM_TIER_1}",
            replacement: {
                match: /(?<=#{intl::UPLOAD_AREA_TOO_LARGE_HELP}.{0,250})Array\.from\(\i\)\.some/,
                replace: "$self.shouldBypassDiscordUploadSizeCheck()?false:$&"
            }
        }
    ],
    contextMenus: {
        "message": messageContextMenuPatch,
        "image-context": imageContextMenuPatch,
        "channel-attach": channelAttachMenuPatch
    },
    start() {
        if (uploadAddFilesInterceptor) return;

        mountProgressOverlay();

        uploadAddFilesInterceptor = event => interceptUploadAddFiles(event);
        FluxDispatcher.addInterceptor(uploadAddFilesInterceptor);

        pasteEventListener = event => handlePaste(event);
        document.addEventListener("paste", pasteEventListener, true);

        dragOverEventListener = event => handleDragOver(event);
        dropEventListener = event => handleDrop(event);
        // window first: Discord stops propagation there, so a document-only
        // listener never sees the event. document is kept as a second chance
        // when the event does propagate; takeFileEvent stops double handling.
        window.addEventListener("dragover", dragOverEventListener, true);
        window.addEventListener("drop", dropEventListener, true);
        document.addEventListener("dragover", dragOverEventListener, true);
        document.addEventListener("drop", dropEventListener, true);

        // tells picker uploads apart from dropped ones
        fileInputChangeEventListener = event => handleFileInputChange(event);
        document.addEventListener("change", fileInputChangeEventListener, true);
    },
    stop() {
        unmountProgressOverlay();

        if (!uploadAddFilesInterceptor) return;

        const index = FluxDispatcher._interceptors.indexOf(uploadAddFilesInterceptor);
        if (index > -1) FluxDispatcher._interceptors.splice(index, 1);

        uploadAddFilesInterceptor = null;

        if (pasteEventListener) {
            document.removeEventListener("paste", pasteEventListener, true);
            pasteEventListener = null;
        }

        if (dragOverEventListener) {
            window.removeEventListener("dragover", dragOverEventListener, true);
            document.removeEventListener("dragover", dragOverEventListener, true);
            dragOverEventListener = null;
        }

        if (dropEventListener) {
            window.removeEventListener("drop", dropEventListener, true);
            document.removeEventListener("drop", dropEventListener, true);
            dropEventListener = null;
        }

        if (fileInputChangeEventListener) {
            document.removeEventListener("change", fileInputChangeEventListener, true);
            fileInputChangeEventListener = null;
        }
    },
    shouldBypassDiscordUploadSizeCheck(): boolean {
        return Boolean(Native)
            && !isServerBlacklisted();
    }
});
