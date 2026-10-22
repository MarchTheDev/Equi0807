# Equi0807

An [Equicord](https://github.com/Equicord/Equicord) plugin that uploads files to [0807.st](https://0807.st) and drops the short link into Discord.

It is a fork/rewrite of [EquiMocha](https://github.com/nxllvxxd/EquiMocha), adapted to the [0807.st API](https://0807.st/api).

## Features

- One **When to upload** setting: above a size limit, every file, or only from the **+** menu
- Works with drag & drop, paste, the attachment **+** menu, and right-click menus
- Dropped files follow the same size limit as attachments, or always upload if you turn that on
- Theme-aware floating progress card with a cancel button, anchored above the message box
- Resumable **chunked uploads** for large files, with per-chunk retries
- Automatic **proof-of-work** for anonymous uploads, no account needed
- Optional **partner token**: skips proof-of-work, raises limits, and enables server-side URL uploads
- Optional expiry and max downloads
- Choose what happens to the link: send it in chat, paste it in the chat box without sending, or copy it
- Optional deletion link, copied next to the file link
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

2. Clone this repo into the userplugins folder:

   ```sh
   cd Equicord/src/userplugins
   git clone https://github.com/MarchTheDev/Equi0807
   ```

3. **Fully quit Discord** (tray icon, then Quit, not just closing the window) and relaunch it. Open **Settings → Plugins**, search for `0807`, and enable **Equi0807**.

## Updating

```sh
cd Equicord/src/userplugins/Equi0807
git pull
cd ../../..
pnpm build
```

## Settings

### Connection

| Setting | Description |
| --- | --- |
| **Instance URL** | The 0807 server to upload to. Only change this if you host your own instance. |
| **Partner token** | Optional key from 0807 for higher limits. Most people do not need one. |

### When to upload

One setting decides what happens to files you send in Discord:

| Option | Behaviour |
| --- | --- |
| **Files above the size limit** (default) | Anything over the limit goes to 0807: attachments, pasted files and dropped files. Smaller ones stay on Discord. |
| **Every file** | Everything goes to 0807, any size. |
| **Only from the + menu** | Nothing is intercepted automatically. Uploads only happen through **Upload to 0807** in the **+** menu or a right-click menu. |

| Setting | Description |
| --- | --- |
| **Always upload dropped files** | Upload dropped files even when they are under the size limit. Off means a drop works like any other upload. |
| **Size limit** | Slider, shown only for *Files above the size limit*. Default 9 MB, drag to 0 for no limit. |
| **Chunked uploads above (MB)** | Big files are uploaded in resumable pieces from this size up. 32 MB is a good default. |

### The link you get back

| Setting | Description |
| --- | --- |
| **What to do with the link** | **Send it in chat**, **Paste it in the chat box** (without sending, so you can edit it first), or **Copy it to the clipboard**. |
| **Also copy the link** | Copy it to the clipboard as well when it was sent or pasted. Off by default, so sending or pasting does not touch your clipboard. |

### File retention

| Setting | Description |
| --- | --- |
| **Delete files after** | How long 0807 keeps the file: never, 1 hour, 1 day, 7 days or 30 days. |
| **Max downloads** | Remove the file after a number of downloads: infinite, 1, 5 or 25. |

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

> **Note on proof-of-work lifetime:** an anonymous proof is only valid for a short time (about 2 to 4 minutes). That is why larger files use the chunked flow, where the proof is validated immediately by `/upload/init`. If you see `pow_expired`, lower the chunked threshold.

Blocked extensions configured on the instance (`exe`, `bat`, `cmd`, `com`, `scr`, `msi`, `vbs`, `ps1`, `sh`, `jar` by default) are rejected by the server.

## Troubleshooting

- **Drag & drop does nothing**: enable **Debug logging** in the settings and watch the console. A successful interception logs `[Equi0807] upload event`. If nothing is logged, the plugin is disabled or blacklisted for that server.
- **A small dropped file stays on Discord**: expected, drops follow the size limit. Turn on **Always upload dropped files** if you want every drop uploaded.
- **A small file went to 0807.st instead of Discord**: check *When to upload* and the **Size limit** slider. A file of exactly the limit stays on Discord; `0` means every size is uploaded.
- **The progress card sits on top of Discord's header or top bar**: this was an older build. Equi0807 no longer injects anything into Discord's React tree; the card is its own element floating above the message box. Rebuild (`pnpm build && pnpm inject`) and fully restart Discord.
- **"Equi0807 requires the Discord desktop app"**: uploads cannot be done from a browser because 0807.st does not allow cross-origin requests. Use the desktop app.
- **`Invalid partner token`**: check the token in the settings, or clear it to upload anonymously.
- **`Too many uploads` / HTTP 429**: wait a few minutes before retrying.
- **`Storage is full` / HTTP 507**: the instance has run out of space; try again later or use another instance.
- **Uploads stop at 0%**: check the **Debug logging** setting and the console for the underlying error.

## Privacy

Files are uploaded directly from your computer to your configured 0807 instance. There is no third-party proxy or telemetry. The plugin stores no data beyond Equicord's settings; uploaded files are subject to the instance's rules and retention settings.

## Credits

- [EquiMocha](https://github.com/nxllvxxd/EquiMocha) by nxllvxxd, the original plugin this is based on
- [Equicord's FileUpload plugin](https://github.com/Equicord/Equicord/tree/main/src/equicordplugins/fileUpload), for the upload UI, progress bar, and Discord integration patterns
- [0807](https://codeberg.org/Sauul/0807) by Sauul, the open-source file host behind 0807.st

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
