# Architecture

How SVU Player is put together: core modules, build workflow, interface contracts, and data flows.

---

## Module Map

The source code in `src/` is partitioned into 11 specialized modules:

| # | File | Responsibility | Exposes |
|---|---|---|---|
| 0 | `config.js` | Runtime options & preference persistence | `window.CONFIG`, `window.SVU_PREFS` |
| 1 | `01-dsp.js` | 4-stage DSP voice enhancement & silence metrics | `globalThis.Dsp` |
| 2 | `03-i18n.js` | English + Arabic strings, RTL switching | `globalThis.I18N`, `t()` |
| 3 | `05-lrec.js` | `.lrec` parser, WAV/PCM conversion, video state | `globalThis.LREC` |
| 4 | `06-library-db.js` | IndexedDB store for offline recordings & profiles | `globalThis.LibraryDB` |
| 5 | `07-player.js` | Transport, timeline, chat panel, seek, themes | `window.__lrec` (audio, seekTo, openFile) |
| 6 | `08-browse.js` | Remote catalog browser, downloader, library UI | — |
| 7 | `09-captions.js` | Speech-to-text captions overlay | `window.__lrec.onTick`, `onSession`, `onClose` |
| 8 | `10-enhance.js` | DSP audio enhancement coordinator | `window.__lrec.onSession` |
| 9 | `11-tour.js` | First-run interactive SVG onboarding tour | `window.__lrec.showTour` |
| 10 | `12-updates.js` | Version check and cache reset utilities | — |

---

## Build Pipeline (`bundle.py`)

SVU Player ships with a fast, zero-dependency build script:

```bash
python3 bundle.py
```

`bundle.py` assembles the production bundle `app.js` by concatenating:
1. `src/config.js`
2. `src/[0-9][0-9]-*.js` in sorted numerical order

Each module is wrapped in an immediately invoked function expression (IIFE), providing clean lexical scoping while publishing explicit interfaces via `window` and `globalThis`.

---

## Global Contract

```javascript
// 01-dsp.js → Everyone
globalThis.Dsp = {
  energy(samples, start, end),
  rms(samples, start, end),
  enhance(pcmInt16, sampleRate, progressCb)
}

// 03-i18n.js → Everyone
globalThis.I18N = { apply(root), setLang(code), translate(key, params) }
t(key, params)                                    // bound to I18N.translate

// 05-lrec.js → 07, 09, 10
globalThis.LREC = { parseLrec, VideoState, pcmToWav, planChunks, wavToPcm, AUDIO_RATE }

// 06-library-db.js → 08, 10
globalThis.LibraryDB = {
  available, putFile, getFile, listFiles, deleteFile,
  putTranscript, getTranscript, putEnhanced, getEnhanced,
  usage, setProfile(id), getProfile()
}

// 07-player.js → 09, 10
window.__lrec = { get session(), audio, seekTo, openFile, onTick, onSession, onClose }
```

`window.__lrec.session` represents the currently loaded recording:

```javascript
{
  durationMs,          // total recording length in ms
  vs,                  // LREC.VideoState canvas drawing coordinator
  chat,                // [{t, date, user, name, conn, clock, text}]
  nodes,               // chat DOM row elements
  wavUrl,              // object URL of the audio stream
  audio,               // { pcm: Int16Array, rate: number }
  key                  // unique file / session identifier
}
```

---

## Data Flow: Opening a Recording

```
┌────────────┐   File / Blob   ┌──────────────────┐
│ 07-player  │ ──────────────► │ LREC.parseLrec() │
│ openFile() │                 └────────┬─────────┘
└────────────┘                          │
                                        ▼
                           ┌────────────────────────┐
                           │ load assets/core.wasm  │
                           │ wasm.m(len)  allocate  │
                           │ wasm.o(ptr,len)  parse │
                           │ wasm.hd(i)   header    │
                           │ wasm.v() / wasm.a()    │
                           └────────┬───────────────┘
                                    │
                                    ▼
                           ┌────────────────────────┐
                           │ pcmToWav → <audio>     │
                           │ VideoState → <canvas>  │
                           │ chat → chat panel      │
                           └────────────────────────┘
```

Decoding progress is reported to the UI through `onProgress(label, fraction)` across three discrete stages:

| Stage Label | Fraction Range | Operation |
|---|---|---|
| `Scanning file` | 0.00 → 0.02 | Header validation and chunk index scanning |
| `Decoding screen` | 0.02 → 0.60 | Video frame keyframes and geometry demuxing |
| `Decoding audio` | 0.60 → 1.00 | PCM audio chunk decompression and WAV synthesis |

---

## Data Flow: Browsing Remote Sessions

```
selTerm → selProgram → selCourse → selTutor → selClass → selSession → files[]
```

Each selection change invokes `GET /api/browse?<params>` through `serve.py`, which submits stateful ASP.NET postbacks to `sessions.svuonline.org`. The endpoint returns the populated options for the **next** dropdown tier along with the active selections. Selecting a session populates the lecture file list with direct download and playback actions.

---

## Data Flow: Offline Storage & Multi-Profile Partitioning

IndexedDB databases are dynamically partitioned per profile to isolate student courses, playback history, and completion tracking:

```
Default Profile:        "lrec-library" (v3)
Named Student Profile:  "lrec-library-<profileId>" (v3)
├── store "files"        Downloaded .lrec binary blobs keyed by file ID
├── store "transcripts"  Caption transcription segments keyed by session ID
└── store "enhanced"     Enhanced audio WAV blobs keyed by session ID
```

The Progressive Web App service worker (`sw.js`) precaches the application shell (`index.html`, `app.js`, `assets/core.wasm`, `fonts/*`). In combination with IndexedDB, the entire application functions without an internet connection.

---

## Rendering & Theming Architecture

- **Zero-FOUC Inlined Styling**: Core CSS rules, CSS custom properties, and base theme definitions are inlined directly in `<head>` of `index.html`. This guarantees instantaneous first paint without Flash of Unstyled Content, eliminates cross-origin stylesheet MIME issues, and prevents service worker cache desyncs.
- **Dynamic Theming System**: 9 bespoke themes (`default`, `whatsapp`, `telegram`, `win98`, `winxp`, `win7`, `hacker`, `vscode`, `terminal`) with dual Light and Dark modes. Theme attributes (`data-theme`, `data-theme-mode`) are set on `<html>` and synchronized to `localStorage` and cookies for zero-flash restoration upon page reload.
- **Video Canvas**: Rendered via `CanvasRenderingContext2D.putImageData()` and `drawImage()`, adapting between aspect-ratio preserving fit and full stretch mode.
- **Audio Transport**: Native HTML5 `<audio>` element wrapped by high-precision timeline scrubber, volume scaling, speed multipliers (0.5x to 3.0x), and audio buffer hot-swapping.
- **Synchronized Chat**: Virtualized DOM elements linked to timeline playhead with instant timestamp seeking and role badges.

---

## Error Handling & Resilience

- **Invalid File Containers**: Non-`.lrec` files fail header validation immediately with `t("notLrec")`.
- **Decoder Safety**: WebAssembly crashes or unsupported browser platforms display `t("noWasm")`.
- **Proxy Degeneration**: If `sessions.svuonline.org` times out, the UI displays a clear localized warning while local playback and offline library browsing remain fully functional.
- **Generation Counters**: Race conditions during file loading (e.g. user opens another file while a large file is mid-decode) are canceled via incrementing parse generation IDs.
