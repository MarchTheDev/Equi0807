/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** What happens to the file link after an upload finishes. */
export type LinkAction = "send" | "paste" | "copy";

export const DEFAULT_LINK_ACTION: LinkAction = "send";

/** Stored settings are strings, so anything unexpected falls back to sending. */
export function parseLinkAction(value: unknown): LinkAction {
    return value === "paste" || value === "copy" ? value : DEFAULT_LINK_ACTION;
}

/**
 * Builds the clipboard contents. When the user wants the deletion link, both
 * links are copied together, one per line, so neither one replaces the other.
 */
export function buildClipboardText(url: string, deletionUrl: string | undefined, includeDeletion: boolean): string {
    if (!includeDeletion || !deletionUrl) return url;

    return `${url}\n${deletionUrl}`;
}

/** Whether the deletion link is part of the copied text. */
export function shouldIncludeDeletion(includeDeletion: boolean, deletionUrl: string | undefined): boolean {
    return includeDeletion && Boolean(deletionUrl);
}

/** How the link actually reaches the user. */
export type LinkDelivery = "send" | "paste" | "copy";

/**
 * Decides where the link goes. Sending needs any channel, pasting needs the
 * channel that is open right now, and everything else falls back to the
 * clipboard so the link is never lost.
 */
export function planLinkDelivery(action: LinkAction, hasChannel: boolean, channelIsActive: boolean, forceCopy = false): LinkDelivery {
    if (forceCopy || action === "copy") return "copy";
    if (action === "send") return hasChannel ? "send" : "copy";

    return hasChannel && channelIsActive ? "paste" : "copy";
}
