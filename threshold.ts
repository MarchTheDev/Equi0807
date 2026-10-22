/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Files above this size (in MB) are uploaded to 0807.st instead of Discord.
 * 0 means "any size" — every file is uploaded.
 */
export const DEFAULT_THRESHOLD_MB = 9;

/** Slider values, in MB. The first and last entries are also the slider bounds. */
export const THRESHOLD_MARKERS = [0, 1, 5, 9, 10, 25, 50, 100];

/**
 * Resolves the configured threshold to bytes.
 * Returns 0 when no threshold applies, which means every file should be uploaded.
 */
export function computeThresholdBytes(onlyAboveThreshold: boolean, megabytes: unknown): number {
    if (!onlyAboveThreshold) return 0;

    const value = Number(megabytes);

    if (!Number.isFinite(value) || value <= 0) return 0;

    return value * 1024 * 1024;
}

/** Whether a file of `size` bytes should be uploaded, given a threshold in bytes. */
export function isAboveThreshold(size: number, thresholdBytes: number): boolean {
    return thresholdBytes <= 0 || size > thresholdBytes;
}

/**
 * Whether a file should be uploaded to 0807.st.
 * `ignoreThreshold` is used for drag & drop, which always uploads when enabled.
 */
export function shouldUploadFile(size: number, thresholdBytes: number, ignoreThreshold: boolean): boolean {
    return ignoreThreshold || isAboveThreshold(size, thresholdBytes);
}

/** Label shown next to the slider. */
export function formatThreshold(megabytes: number): string {
    if (!Number.isFinite(megabytes) || megabytes <= 0) return "Any size";

    return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`;
}
