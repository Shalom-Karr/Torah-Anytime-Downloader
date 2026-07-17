# Torah Anytime Downloader

A **desktop app** (and local web app) that opens **[torahanytime.com](https://www.torahanytime.com)**
through a proxy running on your own machine and adds a **one-click lecture
downloader**. Browse the site as normal; every lecture page gets a **Download**
button that saves the shiur as a real, **seekable MP4** (or MP3) — at the
resolution you pick — straight to your Downloads folder.

Launch the app (or open `http://localhost:8787`) and use it like the normal
site. No account, no browser extension, no cloud service.

## ⬇ Download

**[Download for Windows →](https://github.com/Shalom-Karr/Torah-Anytime-Downloader/releases/latest/download/Torah-Anytime-Downloader-Setup.exe)**

Run the installer, then launch **Torah Anytime Downloader**. Prefer the MSI, or
want an earlier build? Everything is on the
[**Releases**](https://github.com/Shalom-Karr/Torah-Anytime-Downloader/releases/latest)
page.

---

## Two ways to run it

### 1. Desktop app (Windows)

Install and run — the app starts its own local proxy and shows TorahAnytime in a
native window. It's also just a good way to use TorahAnytime as a desktop app.

- Grab the installer from **Releases** (`…_x64-setup.exe` or the `.msi`), or build
  it yourself (see [Building](#building-from-source)).
- Launch **Torah Anytime Downloader**. It spawns a bundled Node proxy on
  `127.0.0.1:8787` and loads the site.
- **Closing the window hides it to the system tray and keeps playing** — so a
  shiur keeps going in the background. Click the tray icon to bring the window
  back, or right-click it and choose **Quit** to actually exit (which stops the
  proxy).
- The window is **locked to localhost**: any link to another domain is
  transparently re-opened through the local proxy, so the app never leaves your
  machine's own proxy.

### 2. Local web app (any OS, no build)

Requires **Node.js 18+** (`node --version`). From this folder:

```bash
node server.mjs        # or: npm start
```

Then open **http://localhost:8787**. Use a different port with
`PORT=3000 node server.mjs` (macOS/Linux) or `$env:PORT=3000; node server.mjs`
(PowerShell). There are **no dependencies to install** for this mode.

## Downloading a lecture

1. Open any lecture (`/lectures/<id>`).
2. Click **⬇ Download MP4** (bottom-right).
3. In the dialog: edit the file name, and pick a **quality** — each option shows its
   size (e.g. `360p (MP4) · 9 MB`, `720p · ~20 MB`, `1080p · ~37 MB`, `Audio (MP3) · 2 MB`).
   It defaults to the low-res **direct** MP4, which is instantly seekable; higher
   resolutions are assembled from the stream.
4. Click **Download** — it streams into your Downloads folder with a progress bar.
   No second "Save As" prompt.

Every resolution comes out as a **flat, seekable MP4** (single `moov` + sample
index), so it scrubs in any player — not a fragment concatenation that some
players can't seek.

## How it works

### The proxy (`proxy.mjs`)

A single web-standard handler, `handleRequest(request)`. `server.mjs` runs it on
Node's built-in http server. It's a **path-based** reverse proxy — it mirrors the
site's own paths rather than wrapping URLs in a `?url=` query:

```
/                     ->  https://www.torahanytime.com/
/lectures/123         ->  https://www.torahanytime.com/lectures/123
/__ta/<host>/<path>   ->  https://<host>/<path>     (api, trpc, proxier, media, ...)
```

Because the local path mirrors the real path, client code that builds a URL by
appending to a base (tRPC `httpBatchLink`, Next.js RSC navigation, the HLS player)
keeps working. Absolute URLs in HTML/CSS/JSON get rewritten to `/__ta/<host>/…`;
anything fetched at runtime is caught by lightweight hooks injected into the page.
Non-essential third parties (Stripe/Double donations, Google Analytics, Tawk,
LuckyOrange, Facebook) are short-circuited so they don't error or leak.

Load-bearing details (don't regress): RSC (`text/x-component`) is passed through
byte-for-byte (its rows are length-prefixed); JS bundles aren't rewritten (they
contain XML namespaces); the injected script deletes its own DOM node so React's
hydration isn't shifted; and upstream is requested with `Accept-Encoding: identity`
while the server streams the body straight through.

### The downloader + remuxer

On a lecture page the script asks TorahAnytime's own API for the direct media URLs
and the HLS master, shows the resolutions with sizes, and on download either grabs
the direct progressive MP4 (low-res, already seekable) or fetches the HLS segments
and **remuxes** them to a flat MP4 in the browser (`/__ta__remux.js`, an fMP4/TS →
progressive-MP4 transmuxer). Everything runs on-device.

### The desktop shell (`src-tauri/`)

A [Tauri](https://tauri.app) app. On launch, the Rust shell spawns the proxy as a
**sidecar** — a copy of the Node runtime running the esbuild-bundled
`server.cjs` — on `127.0.0.1:8787`, and the window loads it. The sidecar is
killed when the app fully quits.

The shell also (1) **locks the webview to localhost** — an `on_navigation` guard
rewrites any external URL to `http://127.0.0.1:8787/__ta/<host>/…` so navigation
can never leave the proxy; and (2) **closes to the system tray and keeps
playing** — the window's X hides instead of destroying the webview, and Chromium's
background-throttling is disabled (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`) so
audio/video doesn't freeze while hidden. Quit from the tray to exit for real.

## Building from source

Prereqs: **Node 18+**, the **Rust toolchain**, and (Windows) the MSVC build tools +
WebView2 (preinstalled on Win10/11).

```bash
npm install                # dev tools (@tauri-apps/cli, esbuild)
npm run build:sidecar      # esbuild-bundle the proxy + copy the Node runtime as the sidecar
npm run tauri build        # compile the shell and produce installers
```

Output lands in `src-tauri/target/release/bundle/` (`.msi` and NSIS `-setup.exe`).
To change the icon, replace `src-tauri/icons/ta-logo.svg`, rasterize it to a square
PNG, and run `npx tauri icon <that.png>`.

## Notes

- **Personal, noncommercial use only** — see `LICENSE`. Please respect
  TorahAnytime's content and the speakers behind it.
- The bundled server sets `NODE_TLS_REJECT_UNAUTHORIZED=0` so it works on machines
  behind a TLS-intercepting content filter (whose certificate Node wouldn't
  otherwise trust); it only ever talks to TorahAnytime and its asset hosts.
- It proxies the **live** site, so it needs internet and reflects whatever
  TorahAnytime currently serves; if the site changes its API/media layout the
  downloader may need an update.
- A few console messages remain on lecture pages (a VideoJS preview error, a
  `lecture-messages` 400, and React error #419) — these come from TorahAnytime's
  own site (they appear un-proxied too) and are harmless.

## Files

```
proxy.mjs        the reverse proxy + injected downloader (the core)
remux.mjs        the fMP4/TS -> progressive-MP4 transmuxer, served to the page
server.mjs       Node http server -> 127.0.0.1:8787 (standalone + sidecar)
dist/            loading page shown by the desktop window until the proxy is up
scripts/         build-sidecar.mjs, remux-taRx.js (transmuxer source)
src-tauri/       the Tauri desktop shell (Rust) + icons
```

## License

PolyForm Noncommercial License 1.0.0 — Copyright 2026 Shalom Karr. See [`LICENSE`](./LICENSE).
