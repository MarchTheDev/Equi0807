/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Other plugins that also replace Discord uploads. */
export const UPLOADER_PLUGINS = ["EquiMocha", "FileUpload"] as const;

export interface PluginRegistry {
    /** Whether the plugin is present in this build. */
    isInstalled: (id: string) => boolean;
    /** Whether the stored settings say it is turned on. */
    isEnabled: (id: string) => boolean;
}

/**
 * Finds another uploader that is really active.
 *
 * Installing and enabling are checked separately on purpose: uninstalling a
 * plugin leaves its old `enabled: true` in the settings file, so trusting the
 * setting alone made Equi0807 warn about EquiMocha long after it was removed.
 */
export function findEnabledUploader(registry: PluginRegistry): string | null {
    for (const id of UPLOADER_PLUGINS) {
        if (registry.isInstalled(id) && registry.isEnabled(id)) return id;
    }

    return null;
}
