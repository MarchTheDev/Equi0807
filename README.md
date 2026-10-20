# Equi0807

An [Equicord](https://github.com/Equicord/Equicord) plugin that uploads files to [0807.st](https://0807.st) and drops the short link into Discord.

It is a fork/rewrite of [EquiMocha](https://github.com/nxllvxxd/EquiMocha), adapted to the [0807.st API](https://0807.st/api).

## Features

- Intercepts file uploads over 9 MB (Discord's free limit) and sends them to 0807.st instead
- Works with drag & drop, paste, the attachment **+** menu, and right-click menus
- Live progress + cancel button inside the chat
- Resumable **chunked uploads** for large files, with per-chunk retries
- Automatic **proof-of-work** for anonymous uploads — no account needed
- Optional **partner token**: skips proof-of-work, raises limits, and enables server-side URL uploads
- Optional expiry, max downloads, and password protection
- Optional deletion-link copying (keep it somewhere safe!)
- Works with self-hosted 0807 instances
- Per-server blacklist

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

3. Install pnpm if you do not have it (`npm i -g pnpm` or `corepack enable`), then from the Equicord root install and build:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   pnpm inject
   ```

4. Restart Discord, open **Settings → Plugins**, and enable **Equi0807**.

## Updating

```sh
cd Equicord/src/plugins/Equi0807
git pull
cd ../../..
pnpm build
pnpm inject
```

## Settings

| Setting | Description |
| --- | --- |
| **0807 instance URL** | Base URL of the instance. Defaults to `https://0807.st`; change it for a self-hosted instance. |
| **Partner token** | Optional. Skips proof-of-work, raises size limits, and uses 0807's server-side remote upload for URL uploads. |
| **Auto-delete** | Never, 1 hour, 1 day, 7 days, or 30 days. |
| **Max downloads** | Self-destruct after N downloads. `0` = unlimited. |
| **Password** | Optional password required to open uploaded files. |
| **Automatically send link** | Send the link in the current channel. When off, the link is copied to the clipboard. |
| **Copy deletion link** | After auto-sending, copy the `deletion_url` to the clipboard. |
| **Upload pasted files** | Intercept files pasted into the chat. |
| **Intercept Discord uploads** | Send intercepted uploads to 0807.st. |
| **Only over 9 MB** | Leave smaller files to Discord and only intercept files over the free limit. |
| **Chunked threshold** | Files larger than this (1–128 MB) use the resumable chunked API. Default `32 MB`. |
| **Blacklisted servers** | Comma-separated guild IDs where interception is disabled. |
| **Debug** | Log upload requests and responses to the console. |

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
