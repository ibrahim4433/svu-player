# 🎓 SVU Player — Offline Session Studio

[![Build](https://img.shields.io/badge/version-v2.7.0-blue.svg)](version.json)
[![Platform](https://img.shields.io/badge/platform-Web%20%7C%20PWA-teal.svg)](site.webmanifest)
[![WebAssembly](https://img.shields.io/badge/decoder-WebAssembly%20%28core.wasm%29-654FF0.svg)](docs/WASM.md)
[![Audio DSP](https://img.shields.io/badge/audio-4--Stage%20Client--Side%20DSP-orange.svg)](src/01-dsp.js)
[![i18n](https://img.shields.io/badge/languages-Arabic%20(RTL)%20%7C%20English-emerald.svg)](src/03-i18n.js)
[![License](https://img.shields.io/badge/mode-Standalone%20Local-success.svg)](serve.py)

**SVU Player** is a modern, standalone, offline-first multimedia web application and Progressive Web App (PWA) tailored for students and instructors of the **Syrian Virtual University (SVU — الجامعة الافتراضية السورية)**.

It decodes and replays SVU’s proprietary **Linktivity (`.lrec`)** classroom recordings natively in any modern browser without relying on outdated legacy Windows desktop players. It synchronizes screen video canvas rendering, 8 kHz audio playback, and synchronized live chat messages, all augmented by a client-side 4-stage DSP voice enhancement pipeline, automated catalog scraper, and offline IndexedDB library.

---

## 🌟 Key Features

### ⚡ 1. Native WebAssembly `.lrec` Decoding
- Decodes Linktivity `.lrec` binary session recordings entirely on the client using an Emscripten-compiled WebAssembly core (`assets/core.wasm`).
- Smooth multi-pass decoding pipeline with real-time progress indicators:
  1. Header & metadata validation
  2. Canvas screen reconstruction (`VideoState`)
  3. 16-bit 8 kHz PCM audio demuxing
  4. UTF-8 synchronized chat message extraction with user badges and timestamps

### 🎙️ 2. Client-Side Studio DSP Voice Enhancement
Lecture audio in recorded virtual classrooms often suffers from low bitrates, microphone hum, room echo, and quiet voices. SVU Player includes a **zero-latency, 100% client-side 4-stage DSP audio enhancement engine** (`src/01-dsp.js`):
1. **120 Hz 1st-Order High-Pass Filter (HPF)**: Strips out HVAC rumble, AC mains hum, and microphone plosives.
2. **2.4 kHz Peaking Biquad EQ (+5.5 dB)**: Accentuates critical vocal presence and speech clarity.
3. **Adaptive Speech-Aware Noise Gate**: Profiles background noise floor percentiles to attenuate hiss by ~15 dB between spoken phrases.
4. **2:1 Soft-Knee Speech Compressor & Normalizer**: Uses a hyperbolic tangent (`tanh`) limiter and makeup gain to boost quiet speech while preventing clipping.
- Enhanced audio tracks are cached in IndexedDB and hot-swapped dynamically into the active audio element without losing playback position or playback rate.

### 🌐 3. Built-In SVU Session Catalog Browser & Downloader
- Integrated Python backend (`serve.py`) proxies and automates multi-step ASP.NET ViewState postbacks against `sessions.svuonline.org`.
- Cascading dynamic selection hierarchy:
  $$\text{Term} \longrightarrow \text{Program} \longrightarrow \text{Course} \longrightarrow \text{Tutor} \longrightarrow \text{Class} \longrightarrow \text{Session} \longrightarrow \text{Files}$$
- **Direct Link Downloader**: Paste any direct recording URL from `svuonline.org` to stream, verify, and store it locally.
- In-memory postback cache reduces redundant network trips during catalog exploration.

### 💾 4. Complete Offline Library & Multi-Profile Support
- **PWA Ready**: Installs to Windows, macOS, Linux, Android, or iOS as a standalone desktop/mobile app via `sw.js`.
- **IndexedDB (`lrec-library` v3)**: Stores offline lecture files, audio cache, and metadata.
- **Lecture Progress Tracking**: Tracks watched/unwatched lectures with visual status indicators and auto-marking upon playback completion.
- **Multi-Profile Partitions**: Organize recordings and completion history by semester or user profile.
- Built-in storage quota diagnostics and persistence flags (`navigator.storage.persist()`).

### 🎨 5. 9 Bespoke Themes & Dual Color Modes
- Fully customized themes featuring tailored accents, typography, and authentic chat bubble styles:
  - **Default** (Obsidian & Sky-Gold)
  - **WhatsApp** (Authentic WhatsApp doodle wallpaper & chat bubbles)
  - **Telegram** (Pattern wallpaper & chat design)
  - **Windows 98** / **Windows XP** / **Windows 7** (Classic retro OS aesthetics)
  - **Hacker** (High-contrast Matrix emerald on black)
  - **VS Code** (Developer dark studio)
  - **Terminal** (Monospace retro phosphor)
- Light and Dark modes available across all themes with instant persistence via `localStorage` and cookies.

### 🌍 6. Bilingual (Arabic / English) with Native Typography
- Full Arabic (RTL) and English (LTR) interface localization with instant toggle.
- Bundled **IBM Plex Sans Arabic** web fonts (`.woff2`) for crystal-clear readability across all devices.

---

## 🏗️ System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                              SVU Player UI                             │
│       Toolbar • Canvas Video • Transport Controls • Chat Panel         │
└─────────────────────────────────┬──────────────────────────────────────┘
                                  │
         ┌────────────────────────┼────────────────────────┐
         ▼                        ▼                        ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   05-lrec.js     │    │   01-dsp.js      │    │ 06-library-db.js │
│  Binary Demuxer  │    │  Studio DSP Audio│    │   IndexedDB v3   │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ assets/core.wasm │    │ High-Pass Filter │    │  • files         │
│  Emscripten C++  │    │ 2.4kHz Presence  │    │  • transcripts   │
│  Canvas & Audio  │    │ Noise Gate & Comp│    │  • enhanced audio│
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

### Module Overview (`src/`)

| # | Module | File | Core Responsibility |
|---|---|---|---|
| 0 | **Configuration** | `src/config.js` | Global configuration, feature flags & persistent preferences |
| 1 | **DSP Engine** | `src/01-dsp.js` | 4-stage vocal clarity, noise gate, biquad filter, speech compressor |
| 2 | **Internationalization**| `src/03-i18n.js` | English & Arabic translations, DOM translation engine, RTL rules |
| 3 | **`.lrec` Parser** | `src/05-lrec.js` | WebAssembly interface, chunk demuxing, PCM-to-WAV conversion |
| 4 | **Storage Database** | `src/06-library-db.js` | IndexedDB abstraction (`files`, `transcripts`, `enhanced`), profiles |
| 5 | **Playback Engine** | `src/07-player.js` | Canvas rendering, audio transport, hotkeys, theme manager, PWA |
| 6 | **Catalog & Library** | `src/08-browse.js` | ASP.NET scraper client, direct downloader, offline library manager |
| 7 | **Closed Captions** | `src/09-captions.js` | Speech-to-text captions overlay and timeline synchronization |
| 8 | **Enhance Bridge** | `src/10-enhance.js` | Asynchronous DSP pipeline execution and seamless `<audio>` hot-swap |
| 9 | **Feature Tour** | `src/11-tour.js` | First-run interactive onboarding modal with dynamic SVG arrow vectors |
| 10 | **Cache & Updates** | `src/12-updates.js` | Service worker cache buster and hard reset utility |

---

## 🚀 Getting Started

### Prerequisites
- **Python 3.8+** (no third-party dependencies required; uses Python standard library `http.server` and `urllib`).
- Any modern web browser supporting **WebAssembly** and **HTML5 Canvas / Audio** (Chrome, Firefox, Safari, Edge, Brave, Opera).

### Running Locally

1. **Clone or navigate to the repository:**
   ```bash
   cd svu-player
   ```

2. **Start the local server:**
   ```bash
   python3 serve.py
   ```
   *(On Windows PowerShell: `python serve.py`)*

3. **Open the application in your browser:**
   ```text
   http://localhost:8080/
   ```

### Command-Line Options for `serve.py`

```bash
python3 serve.py [PORT] [HOST]
```

- **Custom Port:** `python3 serve.py 9000`
- **Expose to Local Network:** `python3 serve.py 8080 0.0.0.0`
- **Rebuild Bundle after Edits:** `python3 bundle.py`

> [!TIP]
> **Service Worker Development:** The service worker caches static assets aggressively for offline PWA operation. When actively developing and modifying scripts, append `?nocache=1` to the URL (`http://localhost:8080/?nocache=1`) or use DevTools → Application → Service Workers → *Bypass for network*.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| <kbd>Space</kbd> or <kbd>K</kbd> | Play / Pause |
| <kbd>←</kbd> / <kbd>→</kbd> | Seek backward / forward 5 seconds |
| <kbd>Shift</kbd> + <kbd>←</kbd> / <kbd>→</kbd> | Seek backward / forward 30 seconds |
| <kbd>J</kbd> / <kbd>L</kbd> | Skip backward / forward 10 seconds |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Adjust volume up / down by 5% |
| <kbd>M</kbd> | Toggle Mute |
| <kbd>F</kbd> | Toggle Fullscreen |
| <kbd>C</kbd> | Toggle Chat Panel |
| <kbd>S</kbd> | Toggle Video Stretch to Fill |
| <kbd>Home</kbd> / <kbd>End</kbd> | Jump to start / end of recording |

---

## 📦 Project Structure

```text
svu-player/
├── index.html               # Main application shell, theme definitions & UI layout
├── app.js                   # Unified bundle of all active client modules
├── bundle.py                # Build script: bundles src/ into app.js
├── serve.py                 # Standalone server & ASP.NET ViewState scraper proxy
├── sw.js                    # PWA Service Worker for full offline caching
├── version.json             # Build and version registry
├── favicon.svg              # Universal vector application icon
├── site.webmanifest         # Clean PWA installation manifest
│
├── assets/
│   └── core.wasm            # Emscripten WebAssembly .lrec decoder
│
├── fonts/                   # IBM Plex Sans Arabic WOFF2 fonts
│   ├── IBMPlexSansArabic-400-arabic.woff2
│   ├── IBMPlexSansArabic-400-latin.woff2
│   ├── IBMPlexSansArabic-600-arabic.woff2
│   └── IBMPlexSansArabic-600-latin.woff2
│
├── src/                     # Modular JavaScript source architecture
│   ├── config.js            # Global configuration, feature flags & persistent preferences
│   ├── 01-dsp.js            # Client-side 4-stage DSP voice enhancement engine
│   ├── 03-i18n.js           # Arabic / English localization dictionary & RTL handler
│   ├── 05-lrec.js           # .lrec binary parser, WASM bridge & PCM converter
│   ├── 06-library-db.js     # IndexedDB v3 offline library management
│   ├── 07-player.js         # Video canvas, audio transport, hotkeys & theme manager
│   ├── 08-browse.js         # Remote session browser, direct downloader & offline UI
│   ├── 09-captions.js       # Synchronized caption renderer
│   ├── 10-enhance.js        # Audio enhance lifecycle & hot-swapper
│   ├── 11-tour.js           # Dynamic SVG arrow onboarding tour
│   └── 12-updates.js        # Cache invalidation & upgrade handler
│
├── docs/                    # Technical documentation
│   ├── ARCHITECTURE.md      # Detailed module contracts & data flows
│   ├── API.md               # Backend proxy endpoints specification
│   ├── LREC_FORMAT.md       # Linktivity .lrec binary format specification
│   ├── WASM.md              # core.wasm export signatures & linear memory layout
│   └── RUNNING_LOCALLY.md   # Local development guidelines
│
└── examples/
    └── sample.lrec          # 6 MB reference Linktivity session recording
```

---

## 🔬 The `.lrec` Format & Decoder

A `.lrec` file is a proprietary **Linktivity** multimedia session container:
- **Header**: Contains magic markers (`10 04 0d 04 00 08 00 80`), session IDs, recording metadata strings, and chunk counts.
- **Record Stream**: Sequence of length-prefixed records tagged with bitflags:
  - `0x0200`: Media & stream synchronization events
  - `0x0300`: Audio / Video data chunks
  - `0x0100`: Metadata and control payloads
- **WASM Bridge**: `core.wasm` exposes linear memory allocation (`m`), chunk parsing (`o`), frame geometry pointers (`g`), and decoded mono PCM audio at 8 kHz (`a`, `f`, `fl`).

Detailed specifications can be found in [docs/LREC_FORMAT.md](docs/LREC_FORMAT.md) and [docs/WASM.md](docs/WASM.md).

---

## 🛡️ Privacy & Standalone Status

- **Zero Telemetry**: All decoding, playback, DSP audio enhancement, and library operations occur locally on your machine.
- **Direct University Access**: When browsing or downloading recordings, the local server (`serve.py`) communicates directly and exclusively with `sessions.svuonline.org`.
- **Fully Offline**: Once installed as a PWA and cached by the Service Worker, previously saved recordings can be opened and played with no internet connection.

---

## 📄 License

This project is developed for educational and accessibility purposes to assist Syrian Virtual University students. All university material, trademarks, and recording streams remain the property of their respective owners.
