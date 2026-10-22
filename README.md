# Equi0807

An [Equicord](https://github.com/Equicord/Equicord) plugin that uploads files to [0807.st](https://0807.st) and drops the short link into Discord.

It is a fork/rewrite of [EquiMocha](https://github.com/nxllvxxd/EquiMocha), adapted to the [0807.st API](https://0807.st/api).

## Features

- One **When to upload** setting: above a size limit, every file, or only from the menu
- Works with drag & drop, paste, the attachment **+** menu, and right-click menus
- **Dropped files always go to 0807.st**, regardless of the size limit
- Theme-aware floating progress card with a cancel button, anchored above the message box
- Resumable **chunked uploads** for large files, with per-chunk retries
- Automatic **proof-of-work** for anonymous uploads — no account needed
- Optional **partner token**: skips proof-of-work, raises limits, and enables server-side URL uploads
- Optional expiry, max downloads, and password protection
- Optional deletion-link copying (keep it somewhere safe!)
- Works with self-hosted 0807 instances
- Per-server blacklist

Made by **TheMarch88** (`511186459588427795`).

## Requirements

- **Discord desktop** with Equicord. 0807.st does not send CORS headers for other origins, so uploads are performed by the native helper. Browser-only Equicord cannot upload.
- Node.js 22+, pnpm, and Git to build Equicord.

## Installation

1. Clone Equicord:

   ```sh
   git clone https://github.com/Equicord/Equicord
   ```

   You **have to clone** the repo (it needs its `.git` directory to build).

2. Clone this repo into the plugins folder:

   ```sh
   cd Equicord/src/plugins
   git clone https://github.com/MarchTheDev/Equi0807
   ```

   > If a plain clone gives you only `LICENSE` and `README.md`, the plugin has not been merged into `main` yet. Re-clone on the branch instead:
   >
   > ```sh
   > rm -rf Equi0807
   > git clone -b arena/85951e3b-equi0807 https://github.com/MarchTheDev/Equi0807
   > ```
   >
   > Already cloned it?
   >
   > ```sh
   > git -C Equi0807 fetch origin arena/85951e3b-equi0807
   > git -C Equi0807 checkout -B arena/85951e3b-equi0807 origin/arena/85951e3b-equi0807
   > ```

   **Check that the files are really there before building:**

   ```sh
   ls Equi0807
   # must list: index.tsx  native.ts  types.ts  styles.css  LICENSE  README.md
   ```

   If you downloaded a ZIP instead of cloning, make sure `index.tsx` sits directly inside `Equicord/src/plugins/Equi0807/` and not in a nested folder.

3. Install pnpm if you do not have it (`npm i -g pnpm` or `corepack enable`), then from the Equicord root install and build:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   pnpm inject
   ```

   `pnpm build` must finish without errors. If it prints `Could not resolve "./plugins/Equi0807"`, the plugin folder is missing `index.tsx` — see step 2.

4. **Fully quit Discord** (tray icon → Quit, not just closing the window) and relaunch it. Open **Settings → Plugins**, search for `0807`, and enable **Equi0807**.

   You can confirm the build picked it up with:

   ```sh
   grep -c Equi0807 dist/desktop/renderer.js
   ```

   A result of `0` means the plugin was not compiled in.

## Updating

```sh
cd Equicord/src/plugins/Equi0807
git pull
cd ../../..
pnpm build
pnpm inject
```

If `git pull` reports "already up to date" but nothing changed, check you are on the right branch:

```sh
git -C Equicord/src/plugins/Equi0807 branch --show-current
```

## Settings

There are only two decisions to make: **what gets uploaded**, and **how long 0807 keeps it**.

### Connection

| Setting | Description |
| --- | --- |
| **Instance URL** | The 0807 server to upload to. Only change this if you host your own instance. |
| **Partner token** | Optional key from 0807 for higher limits. Most people do not need one. |

### When to upload

One setting decides what happens to files you send in Discord:

| Option | Behaviour |
| --- | --- |
| **Files above the size limit** (default) | Attachments and pasted files over the limit go to 0807; smaller ones stay on Discord. **Dropped files are always uploaded.** |
| **Every file** | Everything goes to 0807, any size. |
| **Only from the right-click menu** | Nothing is intercepted automatically. Uploads only happen through *Upload to 0807*. |

| Setting | Description |
| --- | --- |
| **Size limit** | Slider, shown only for *Files above the size limit*. Default 9 MB, drag to 0 for no limit. |
| **Chunked uploads above (MB)** | Big files are uploaded in resumable pieces from this size up. 32 MB is a good default. |

### The link you get back

| Setting | Description |
| --- | --- |
| **Post the link for me** | Post the link in chat after uploading. Turn off to copy it to your clipboard instead. |
| **Copy the deletion link** | Also copy the link that deletes the file. It is the only way to remove it later. |

### File retention

| Setting | Description |
| --- | --- |
| **Delete files after** | How long 0807 keeps the file: never, 1 hour, 1 day, 7 days or 30 days. |
| **Max downloads** | Remove the file after this many downloads. 0 means no limit. |
| **Password** | Require this password to open the file. Leave empty for none. |

### Advanced

| Setting | Description |
| --- | --- |
| **Ignore in these servers** | Comma-separated server IDs where Equi0807 stays out of the way. |
| **Debug logging** | Log each upload and the decision taken to the console. Useful when something will not upload. |

## How it works

Anonymous uploads need a small proof-of-work. Equi0807 fetches `GET /pow`, solves `sha256(id + "." + nonce)` with the required number of leading zero bits (using worker threads when the difficulty is high), and attaches the `pow_*` fields to the upload. Partner tokens skip this.

Files up to the chunked threshold are sent as a single multipart `POST /upload`. Larger files use the resumable flow:

1. `POST /upload/init` with the proof-of-work (and optional partner token)
2. `POST /upload/chunk?id=…&offset=…` in 16 MB chunks, with retries
3. `POST /upload/finish`

The simple POST limit is 2 GB; chunked uploads go up to 10 GB anonymously. Partner limits are higher (50 GB per file, 100 GB for burn-after-read). 0807 also enforces a rate limit of 60 uploads per 10 minutes for anonymous users.

> **Note on proof-of-work lifetime:** an anonymous proof is only valid for a short time (about 2–4 minutes). That is why larger files use the chunked flow, where the proof is validated immediately by `/upload/init`. If you see `pow_expired`, lower the chunked threshold.

Blocked extensions configured on the instance (`exe`, `bat`, `cmd`, `com`, `scr`, `msi`, `vbs`, `ps1`, `sh`, `jar` by default) are rejected by the server.

## Troubleshooting

- **Drag & drop does nothing** — enable **Debug** in the settings and watch the console: a successful interception logs `[Equi0807] dropped files […]`. If nothing is logged, another plugin is claiming the drop first (check FileUpload/EquiMocha) or the plugin is disabled/blacklisted for that server.
- **Dropped a small file and it went to 0807.st** — expected: dropped files always upload, regardless of the size limit. Use *Only from the right-click menu* if you want drops left to Discord.
- **A small file went to 0807.st instead of Discord** — check *When to upload* and the **Size limit** slider. A file of exactly the limit stays on Discord; `0` means every size is uploaded.
- **The progress card sits on top of Discord's header / top bar** — this was an older build. Equi0807 no longer injects anything into Discord's React tree; the card is its own element floating above the message box. Rebuild (`pnpm build && pnpm inject`) and fully restart Discord.
- **The plugin does not appear in the plugins list** — work through these in order:
  1. `ls Equicord/src/plugins/Equi0807` must list `index.tsx`, `native.ts`, `types.ts` and `styles.css`. If it only shows `LICENSE` and `README.md`, you cloned `main`, which does not have the plugin yet — check out the `arena/85951e3b-equi0807` branch (see Installation).
  2. Re-run `pnpm build` and watch for errors. A failed build leaves the previous `dist/` in place, so Discord keeps loading the old plugins.
  3. Run `pnpm inject` from the **same** Equicord checkout you built. If you have several clones, it is easy to build one and inject another.
  4. Confirm the build contains it: `grep -c Equi0807 dist/desktop/renderer.js` should not be `0`.
  5. Fully quit Discord (tray → Quit) and relaunch. Closing the window is not enough.
  6. This plugin needs a source build (`git clone` + `pnpm build` + `pnpm inject`). If Equicord was installed through the installer/GUI, files added to `src/plugins` are never loaded.
- **"Equi0807 requires the Discord desktop app"** — uploads cannot be done from a browser because 0807.st does not allow cross-origin requests. Use the desktop app.
- **`Invalid partner token`** — check the token in the settings, or clear it to upload anonymously.
- **`Too many uploads` / HTTP 429** — wait a few minutes before retrying.
- **`Storage is full` / HTTP 507** — the instance has run out of space; try again later or use another instance.
- **Uploads stop at 0%** — check the `Debug` setting and the console for the underlying error.
- **I also use EquiMocha or Equicord's FileUpload plugin** — enable only one uploader at a time. When either one is enabled, Equi0807 disables its own interception to avoid duplicate uploads; its context-menu actions still work.

## Privacy

Files are uploaded directly from your computer to your configured 0807 instance. There is no third-party proxy or telemetry. The plugin stores no data beyond Equicord's settings; uploaded files are subject to the instance's rules and retention settings.

## Credits

- [EquiMocha](https://github.com/nxllvxxd/EquiMocha) by nxllvxxd — the original plugin this is based on
- [Equicord's FileUpload plugin](https://github.com/Equicord/Equicord/tree/main/src/equicordplugins/fileUpload) — upload UI, progress bar, and Discord integration patterns
- [0807](https://codeberg.org/Sauul/0807) by Sauul — the open-source file host behind 0807.st

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
