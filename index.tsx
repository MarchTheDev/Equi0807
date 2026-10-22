/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Based on EquiMocha by nxllvxxd and Equicord's FileUpload plugin.
import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { OpenExternalIcon } from "@components/Icons";
import { copyToClipboard } from "@utils/clipboard";
import { classNameFactory } from "@utils/css";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findCssClassesLazy } from "@webpack";
import { createRoot, DraftType, FluxDispatcher, Menu, PermissionsBits, PermissionStore, React, SelectedChannelStore, SelectedGuildStore, showToast, useEffect, useState } from "@webpack/common";

import { computeThresholdBytes, DEFAULT_THRESHOLD_MB, formatThreshold, shouldUploadFile, THRESHOLD_MARKERS } from "./threshold";
import type { NativeChooseFileResult, NativeUploadProgress, NativeUploadResult, UploadOptions } from "./types";

const cl = classNameFactory("vc-equi0807-");
const SERVICE_LABEL = "0807.st";
const STAGING_CHUNK_BYTES = 8 * 1024 * 1024;
/** How recently a file drag must have happened for a dispatcher event to count as a drop. */
const DROP_GRACE_MS = 2000;

function fileKey(file: File): string {
    return `${file.name}:${file.size}:${file.lastModified}`;
}

function claimDroppedFiles(files: readonly File[]) {
    const now = Date.now();

    for (const [key, at] of claimedDropFiles) {
        if (now - at > CLAIMED_DROP_TTL_MS) claimedDropFiles.delete(key);
    }

    for (const file of files) claimedDropFiles.set(fileKey(file), now);
}

function isClaimedDropFile(file: File): boolean {
    const at = claimedDropFiles.get(fileKey(file));

    if (at === undefined) return false;
    if (Date.now() - at > CLAIMED_DROP_TTL_MS) {
        claimedDropFiles.delete(fileKey(file));
        return false;
    }

    return true;
}

const Native = IS_DISCORD_DESKTOP
    ? VencordNative.pluginHelpers.Equi0807 as PluginNative<typeof import("./native")>
    : null;

const settings = definePluginSettings({
    baseUrl: {
        type: OptionType.STRING,
        description: "0807 instance URL",
        default: "https://0807.st",
        placeholder: "https://0807.st"
    },
    partnerToken: {
        type: OptionType.STRING,
        description: "Optional partner token. Skips proof-of-work, raises limits and enables server-side URL uploads",
        default: "",
        placeholder: "optional"
    },
    shareExpiry: {
        type: OptionType.SELECT,
        description: "Auto-delete uploaded files after",
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
        type: OptionType.NUMBER,
        description: "Self-destruct after this many downloads (0 = unlimited)",
        default: 0
    },
    password: {
        type: OptionType.STRING,
        description: "Optional password required to open uploaded files",
        default: "",
        placeholder: "optional"
    },
    autoSend: {
        type: OptionType.BOOLEAN,
        description: "Automatically send the uploaded link in the current channel",
        default: true
    },
    copyDeletionUrl: {
        type: OptionType.BOOLEAN,
        description: "After auto-sending, copy the deletion link to the clipboard. Keep it somewhere safe",
        default: false
    },
    autoUploadPastedFiles: {
        type: OptionType.BOOLEAN,
        description: "Upload pasted files to 0807.st",
        default: true
    },
    bypassDiscordUpload: {
        type: OptionType.BOOLEAN,
        description: "Intercept Discord uploads and send them to 0807.st instead",
        default: true
    },
    alwaysUploadDroppedFiles: {
        type: OptionType.BOOLEAN,
        displayName: "Always upload dropped files",
        description: "Files dropped into Discord go to 0807.st no matter their size, ignoring the size threshold",
        default: true
    },
    onlyOverNineMegabytes: {
        type: OptionType.BOOLEAN,
        displayName: "Only upload above the size threshold",
        description: "When off, every file is uploaded to 0807.st, no matter how small",
        default: true
    },
    uploadThresholdMB: {
        type: OptionType.SLIDER,
        displayName: "Size threshold",
        description: "Files larger than this are uploaded to 0807.st instead of Discord. Drag to 0 to upload any size",
        markers: THRESHOLD_MARKERS,
        default: DEFAULT_THRESHOLD_MB,
        stickToMarkers: false,
        disabled: () => !settings.store.onlyOverNineMegabytes,
        componentProps: {
            onValueRender: formatThreshold
        }
    },
    chunkedThresholdMB: {
        type: OptionType.NUMBER,
        description: "Files larger than this use resumable chunked uploads (1–128 MB). Lower it if proof-of-work expires",
        default: 32
    },
    blacklistedServers: {
        type: OptionType.STRING,
        description: "Comma-separated server IDs where upload interception is disabled",
        default: "",
        placeholder: "123456789, 987654321"
    },
    debug: {
        type: OptionType.BOOLEAN,
        description: "Log upload details to the console",
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
let lastFileDragAt = 0;
/** Files handled by the drop listener, so the dispatcher fallback skips them. */
const claimedDropFiles = new Map<string, number>();
const CLAIMED_DROP_TTL_MS = 5000;
let pasteEventListener: ((event: ClipboardEvent) => void) | null = null;
let dragOverEventListener: ((event: DragEvent) => void) | null = null;
let dropEventListener: ((event: DragEvent) => void) | null = null;

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

function isAnotherUploaderEnabled(): boolean {
    try {
        return isPluginEnabled("FileUpload") || isPluginEnabled("EquiMocha");
    } catch {
        return false;
    }
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
        maxDownloads: String(Math.max(0, Math.trunc(settings.store.maxDownloads) || 0)),
        password: settings.store.password ?? "",
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

function getUploadThresholdBytes(): number {
    return computeThresholdBytes(settings.store.onlyOverNineMegabytes, settings.store.uploadThresholdMB);
}

function canInterceptUploads(): boolean {
    return Boolean(Native)
        && isConfigured()
        && Boolean(settings.store.bypassDiscordUpload)
        && !isServerBlacklisted()
        && !isAnotherUploaderEnabled();
}

function shouldInterceptUploadFiles(files: readonly File[], ignoreThreshold = false): boolean {
    if (!files.length) return false;
    if (!canInterceptUploads()) return false;

    const threshold = getUploadThresholdBytes();

    return files.some(file => shouldUploadFile(file.size, threshold, ignoreThreshold));
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

async function notifyUploadSuccess(url: string, copyOnly: boolean, channelId: string | undefined, deletionUrl?: string) {
    try {
        if (!copyOnly && settings.store.autoSend && channelId) {
            await sendMessage(channelId, { content: url });
            showToast({ text: "Uploaded to 0807.st", variant: "success" });

            if (settings.store.copyDeletionUrl && deletionUrl) {
                await copyToClipboard(deletionUrl);
                showToast({ text: "Deletion link copied to clipboard. Keep it safe!", variant: "success" });
            }
        } else {
            await copyToClipboard(url);
            showToast({ text: "Upload complete — link copied to clipboard", variant: "success" });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        try {
            await copyToClipboard(url);
            showToast({ text: `Uploaded, but could not send the link (${message}). It was copied to your clipboard.`, variant: "critical" });
        } catch {
            showToast({ text: `Uploaded, but could not share the link: ${message}`, variant: "critical" });
        }
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

            await notifyUploadSuccess(result.url, copyOnly, channelId, result.deletionUrl);
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

    const fromDrop = Date.now() - lastFileDragAt < DROP_GRACE_MS;
    const ignoreThreshold = fromDrop && Boolean(settings.store.alwaysUploadDroppedFiles);
    const pending = files.filter(file => !isClaimedDropFile(file));

    if (!pending.length || !shouldInterceptUploadFiles(pending, ignoreThreshold)) return;

    payload.files = [];
    payload.uploads = [];
    payload.items = [];

    void uploadInputs(pending.map(fileToInput));
}

function handlePaste(event: ClipboardEvent) {
    if (event.defaultPrevented) return;

    const files = Array.from(event.clipboardData?.files || []);

    if (!files.length) return;
    if (!settings.store.autoUploadPastedFiles) return;
    if (!shouldInterceptUploadFiles(files)) return;

    event.preventDefault();
    event.stopPropagation();

    void uploadInputs(files.map(fileToInput));
}

// Dropped files always go to 0807.st, so a mere presence of files is enough.
function shouldHandleDrop(files: readonly File[]): boolean {
    return shouldInterceptUploadFiles(files, Boolean(settings.store.alwaysUploadDroppedFiles));
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

    // Sizes are not available yet while dragging, so only check the master
    // switches when every drop is supposed to be uploaded.
    if (settings.store.alwaysUploadDroppedFiles) {
        if (!canInterceptUploads()) return;
    } else if (!shouldInterceptUploadFiles(getFilesFromDataTransfer(event.dataTransfer))) {
        return;
    }

    if (!takeFileEvent(event)) return;

    stopFileEvent(event);

    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function handleDrop(event: DragEvent) {
    const files = getFilesFromDataTransfer(event.dataTransfer);

    if (!files.length) return;

    lastFileDragAt = Date.now();

    if (!shouldHandleDrop(files)) return;
    if (!takeFileEvent(event)) return;

    // Discord's own listener may already have queued these files before this
    // handler runs. Claim them so the dispatcher fallback below does not
    // upload the same files a second time.
    claimDroppedFiles(files);

    stopFileEvent(event);

    debugLog("dropped files", files.map(file => `${file.name} (${file.size} bytes)`));

    void uploadInputs(files.map(fileToInput));
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
    authors: [{ name: "Equi0807", id: 0n }],
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
    },
    shouldBypassDiscordUploadSizeCheck(): boolean {
        return Boolean(Native)
            && Boolean(settings.store.bypassDiscordUpload)
            && !isServerBlacklisted()
            && !isAnotherUploaderEnabled();
    }
});
