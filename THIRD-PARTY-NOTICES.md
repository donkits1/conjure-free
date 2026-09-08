# Third-party notices

Conjure is licensed under Apache 2.0. It depends on the following open-source components, each under its own license. All of them are permissive and compatible with Apache 2.0. Full license texts ship with each package under `node_modules` after installation.

## Runtime dependencies of the engine (`core/`)

| Package | License | Notes |
| --- | --- | --- |
| better-sqlite3 | MIT | Bundles SQLite (public domain). Its install step uses `prebuild-install` and related packages (MIT, ISC, BSD and Apache-2.0). |
| yaml | ISC | |

## Bundled into the web UI (`core/dist/web`)

| Package | License |
| --- | --- |
| React, React DOM, scheduler | MIT |

The web bundle was produced by Vite (MIT), which is not itself distributed here.

## Desktop container (`app/`)

| Component | License |
| --- | --- |
| Electron 44 | MIT. Electron's own third-party notices (Chromium, Node.js, V8, ICU, ffmpeg and others) are distributed with the Electron binary and are included as `LICENSES.chromium.html` in the portable Windows build. |
| Node.js runtime (portable build only) | MIT and the licenses listed in Node's own LICENSE file, which is included alongside the bundled `node.exe`. |

## Assets

The Conjure emblem and icon are project branding and are not covered by the open-source licenses above (see NOTICE).
