/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** What Equi0807 does with files sent in Discord. */
export enum UploadMode {
    /** Only files above the size limit are uploaded. */
    AboveLimit = "above-limit",
    /** Every file is uploaded, whatever its size. */
    Everything = "everything",
    /** Nothing is automatic; files are only uploaded from the menu. */
    Manual = "manual"
}

export const DEFAULT_UPLOAD_MODE = UploadMode.AboveLimit;

/** Default size limit in MB. */
export const DEFAULT_THRESHOLD_MB = 9;

/** Slider values, in MB. The first and last entries are also the slider bounds. */
export const THRESHOLD_MARKERS = [0, 1, 5, 9, 10, 25, 50, 100];

export function parseUploadMode(value: unknown): UploadMode {
    return Object.values(UploadMode).includes(value as UploadMode)
        ? value as UploadMode
        : DEFAULT_UPLOAD_MODE;
}

/**
 * Resolves the size limit to bytes.
 * Returns 0 when no limit applies, which means every file should be uploaded.
 */
export function resolveThresholdBytes(mode: UploadMode, megabytes: unknown): number {
    if (mode !== UploadMode.AboveLimit) return 0;

    const value = Number(megabytes);

    if (!Number.isFinite(value) || value <= 0) return 0;

    return value * 1024 * 1024;
}

/** Whether a file of `size` bytes is above the limit. 0 bytes means "no limit". */
export function isAboveThreshold(size: number, thresholdBytes: number): boolean {
    return thresholdBytes <= 0 || size > thresholdBytes;
}

/**
 * Whether a file should be uploaded to 0807.st.
 *
 * `ignoreThreshold` is only used for dropped files when the user asked for
 * every drop to be uploaded. Otherwise the limit applies to every path.
 */
export function shouldUploadFile(size: number, mode: UploadMode, thresholdBytes: number, ignoreThreshold: boolean): boolean {
    if (mode === UploadMode.Manual) return false;
    if (ignoreThreshold) return true;
    if (mode === UploadMode.Everything) return true;

    return isAboveThreshold(size, thresholdBytes);
}

/** Label shown next to the slider. */
export function formatThreshold(megabytes: number): string {
    if (!Number.isFinite(megabytes) || megabytes <= 0) return "Any size";

    return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`;
}
