# Running the Project Locally

Everything you need to serve, develop, and test SVU Player on your machine.

---

## 1. Quick Start (One Command)

```bash
python3 serve.py          # start the server
```
*(On Windows PowerShell: `python serve.py`)*

Then open **http://localhost:8080/** in your browser.

That is all. The remote session browser, client-side DSP audio enhancement, and local `.lrec` playback work immediately out of the box with zero third-party package dependencies.

---

## 2. Server Configuration

`serve.py` uses only Python's built-in standard library (`http.server`, `urllib`, `socketserver`) and performs two primary roles:

1. **Static File Serving**: Delivers static files with accurate MIME types:
   - `application/wasm` for `assets/core.wasm` (essential for `WebAssembly.instantiateStreaming`)
   - `font/woff2` and `font/woff` for bundled typography
   - `application/manifest+json` for `site.webmanifest`
   - `text/css` for stylesheet compatibility
   - Sends `Cache-Control: no-store` headers during development so asset edits load immediately.
2. **University API Proxy**: Scrapes and cascades catalog metadata from `sessions.svuonline.org` and proxies `.lrec` binary downloads without browser CORS restrictions.

### Command-Line Arguments

```bash
python3 serve.py                 # http://localhost:8080 (default)
python3 serve.py 9000            # custom port (http://localhost:9000)
python3 serve.py 8080 0.0.0.0    # bind to all interfaces (accessible on local network)
python3 serve.py --no-proxy      # disable remote SVU catalog proxy (pure local mode)
```

---

## 3. Bundling with `bundle.py`

The JavaScript architecture is split into 11 modular files under `src/`:

```text
src/
├── config.js
├── 01-dsp.js
├── 03-i18n.js
├── 05-lrec.js
├── 06-library-db.js
├── 07-player.js
├── 08-browse.js
├── 09-captions.js
├── 10-enhance.js
├── 11-tour.js
└── 12-updates.js
```

When you make changes to any file in `src/`, compile them into the root `app.js` bundle by running:

```bash
python3 bundle.py
```
*(On Windows PowerShell: `python bundle.py`)*

`bundle.py` reads `src/config.js` and all numbered modules `src/[0-9][0-9]-*.js` in sorted numerical order, concatenates them with clean section banners, and writes the unified `app.js`.

---

## 4. Service Worker & Cache Invalidation

The application registers a Progressive Web App service worker (`sw.js`, cache name `svu-player-local-v11`) to enable full offline operation.

When actively developing, the browser may serve cached scripts from the service worker. To ensure your latest code loads:

| Method | How to Use |
|---|---|
| **Development Query Flag** *(Recommended)* | Load `http://localhost:8080/?nocache=1` — `sw.js` detects `nocache=1` and bypasses the cache entirely. |
| **DevTools Network Bypass** | Open DevTools (`F12`) → Application → Service Workers → check **Bypass for network**. |
| **Hard Refresh** | Press `Ctrl + F5` or `Ctrl + Shift + R` (Cmd + Shift + R on macOS). |
| **UI Reset** | Click the **About** button in the top toolbar, then click **Hard Reset & Clear Cache**. |

---

## 5. Verifying Functionality

When the page loads, verify key subsystems:

1. **Open File**:
   - Click the folder icon or drag-and-drop `examples/sample.lrec` (6 MB) into the browser window.
   - The multi-stage progress bar will display:
     - `Scanning file` (0% → 2%)
     - `Decoding screen` (2% → 60%)
     - `Decoding audio` (60% → 100%)
   - After decode, playback begins with video on the canvas, 8 kHz audio playing, and 139 chat messages displayed in the right-hand chat panel.
2. **DSP Voice Enhancement**:
   - Click the **Enhance Audio** button in the playback toolbar.
   - The client-side 4-stage DSP will apply the 120 Hz high-pass filter, 2.4 kHz presence EQ, adaptive noise gate, and compressor. The audio element updates smoothly in place.
3. **SVU Remote Sessions**:
   - Click the globe icon (**SVU Sessions**) in the top toolbar.
   - Select: Term → Program → Course → Tutor → Class → Session.
   - Files for the chosen session will appear with file size, date, and download/play buttons.
4. **Offline Library & Profiles**:
   - Downloaded recordings appear in the **Saved Offline** library.
   - Switching user profiles partitions completion history and lecture watch states.
5. **Themes & Localization**:
   - Click the theme palette icon to cycle through 9 bespoke themes (Default, WhatsApp, Telegram, Windows 98, Windows XP, Windows 7, Hacker, VS Code, Terminal) in Light and Dark modes.
   - Click the language toggle to switch between English (LTR) and Arabic (RTL).
6. **Keyboard Shortcuts**:
   - <kbd>Space</kbd> / <kbd>K</kbd>: Play / Pause
   - <kbd>←</kbd> / <kbd>→</kbd>: Skip 5 seconds (with <kbd>Shift</kbd>: 30 seconds)
   - <kbd>J</kbd> / <kbd>L</kbd>: Skip 10 seconds
   - <kbd>M</kbd>: Mute / Unmute
   - <kbd>F</kbd>: Fullscreen
   - <kbd>C</kbd>: Chat toggle
   - <kbd>S</kbd>: Stretch canvas to fill

---

## 6. Troubleshooting

| Symptom | Cause | Solution |
|---|---|---|
| `Could not reach sessions.svuonline.org` | Network offline or university server down | Verify internet connection; check if `sessions.svuonline.org` is reachable in a browser tab. |
| Edits to `src/*.js` do not appear | `bundle.py` was not run, or service worker served cache | Run `python bundle.py`, then open `http://localhost:8080/?nocache=1`. |
| `core.wasm` fails with MIME error | Served via `file://` or web server without WASM MIME | Run `python serve.py` to serve over HTTP with `application/wasm`. |
| Arabic fonts do not render | Missing `/fonts/` directory | Verify that `fonts/ReadexPro-*.woff2` exists in the project root. |
| Greyed-out cascading dropdowns | Failed initial catalog scrape | Ensure `serve.py` is running and check server console for HTTP 502/timeout logs. |

---

## 7. How the API Proxy Works

The Syrian Virtual University recorded sessions portal (`sessions.svuonline.org`) uses legacy ASP.NET WebForms. Browsing sessions requires stateful HTTP `POST` requests submitting encrypted hidden fields (`__VIEWSTATE`, `__EVENTVALIDATION`, and `__VIEWSTATEGENERATOR`). Furthermore, the server does not supply Cross-Origin Resource Sharing (`CORS`) headers.

`serve.py` bridges this gap seamlessly:

1. **Initial GET Scrape**:
   - Requests `http://sessions.svuonline.org/new/Default.aspx`.
   - Extracts the base hidden fields and parses the `<select id="DropDownList_term">` options into structured JSON.
2. **Cascading State Machine**:
   - When the client requests `/api/browse?term=F25`, `serve.py` constructs a form POST payload with `__EVENTTARGET = DropDownList_term` and the previous state.
   - It submits this to the portal, parses the resulting HTML for the populated `DropDownList_program` options, and returns them as clean JSON.
   - This process repeats as the user selects `program`, `course`, `tutor`, and `class`.
3. **Session & File Extraction**:
   - Selecting a class triggers an extraction of the `GridView_results` HTML table containing individual lecture sessions.
   - Selecting a session index triggers an extraction of `GridView1` containing direct `.lrec` download links, file descriptions, and file sizes.
4. **In-Memory Caching (`_BROWSE_CACHE`)**:
   - Postback results and parsed data are cached in memory for 30 minutes. Subsequent requests for previously visited dropdowns resolve in under 1 millisecond.
5. **Streaming Download Proxy (`/api/download`)**:
   - When downloading a recording, `serve.py` validates that the URL points to `svuonline.org` and ends with `.lrec`.
   - It streams the binary in 64 KB chunks, preserving `Content-Length` headers so the client can calculate exact download progress and save the blob directly to IndexedDB.

