/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Based on EquiMocha by nxllvxxd and Equicord's FileUpload plugin.
export type UploadPhase =
    | "idle"
    | "preparing"
    | "uploading"
    | "retrying"
    | "finalizing"
    | "success"
    | "failed"
    | "cancelled";

export interface UploadOptions {
    /** Base URL of the 0807 instance, e.g. https://0807.st */
    baseUrl: string;
    /** Hours before auto-delete: 0, 1, 24, 168 or 720. */
    expiry: string;
    /** Self-destruct after this many downloads. 0 = unlimited. */
    maxDownloads: string;
    password: string;
    partnerToken: string;
    /** Optional custom link (partner tokens only). */
    vanity: string;
    /** Files above this size use the resumable chunked API. */
    chunkedThresholdBytes: number;
    debug: boolean;
}

export interface NativeUploadProgress {
    phase: Exclude<UploadPhase, "idle">;
    percent: number;
    transferredBytes: number;
    totalBytes: number;
    partNumber: number;
    totalParts: number;
    status: string;
}

export interface NativeUploadResult {
    success: boolean;
    url?: string;
    deletionUrl?: string;
    error?: string;
}

export interface NativeChooseFileResult {
    path: string;
    name: string;
}
