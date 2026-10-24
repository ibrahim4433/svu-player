# `core.wasm` — The Recording Decoder

`assets/core.wasm` (81,570 bytes) is an **Emscripten-compiled C++** WebAssembly module. It is the only binary component in the application and performs the heavy computational lifting: parsing the proprietary Linktivity `.lrec` container and decoding its video and audio streams.

---

## Loading Pipeline

The module is loaded asynchronously on demand when the first recording is opened:

```javascript
const WASM_URL = (window.CONFIG && window.CONFIG.wasmUrl) || "assets/core.wasm";

const imports = {
  e: {
    h: () => 0,  // host environment check stub
    c: () => 0   // hash string stub
  }
};

let instance;
try {
  instance = (await WebAssembly.instantiateStreaming(fetch(WASM_URL), imports)).instance;
} catch (err) {
  const resp = await fetch(WASM_URL);
  instance = (await WebAssembly.instantiate(await resp.arrayBuffer(), imports)).instance;
}
```

The loader prefers `WebAssembly.instantiateStreaming` for zero-copy compiling directly from network streams, falling back to `fetch` + `arrayBuffer` when streaming instantiation is unavailable.

---

## Exports

The exports are minified to single letters. The app maps them through an
`EXPORTS` table in `src/05-lrec.js`:

| Export | Name | Signature | Purpose |
|---|---|---|---|
| `m` | `alloc` | `(size) -> ptr` | allocate memory for the input |
| `n` | `free` | `(ptr) -> void` | free an allocation |
| `o` | `parse` | `(ptr, len) -> int` | parse the recording; returns chunk count (<0 = no header) |
| `d` | `duration` | `() -> int` | duration in milliseconds |
| `hd` | `header` | `(index) -> int` | header field (see below) |
| `c` | `chatPtr` | `() -> ptr` | pointer to the chat block |
| `cl` | `chatLen` | `() -> int` | length of the chat block |
| `v` | `decodeVideo` | `(…) -> void` | decode all video chunks |
| `vt` | `videoTotal` | `() -> int` | number of video chunks |
| `ok` | `videoOk` | `() -> bool` | whether video was decoded |
| `a` | `decodeAudio` | `(…) -> void` | decode all audio chunks |
| `at` | `audioTotal` | `() -> int` | number of audio chunks |
| `f` | `pcmPtr` | `() -> ptr` | pointer to the decoded PCM |
| `fl` | `pcmLen` | `() -> int` | PCM length in samples |
| `fx` | `pcmFree` | `() -> void` | free the PCM buffer |
| `mt` | `minTime` | `() -> int` | minimum seek time |
| `r` | `reset` | `() -> void` | reset decoder state |
| `s` | `seek` | `(time, keyframe) -> void` | seek to a time |
| `w` | `readyFlags` | `() -> int` | video-ready flags |
| `g` | `frameInfo` | `(index) -> int` | frame geometry / pixel pointer |
| `x` | `extra` | `(…) -> void` | auxiliary |
| `memory` | — | — | the linear memory |

### `hd(index)` header fields

| Index | Meaning |
|---|---|
| 0 | total chunk count |
| 1 | duration in ms |
| 2 | video chunk count |
| 3 | audio chunk count |
| 4 | chat message count |

### `g(index)` frame fields

| Index | Meaning |
|---|---|
| 0 | frame width |
| 1 | frame height |
| 2 | source x |
| 3 | source y |
| 4 | source width |
| 5 | source height |
| 6 | pixel data pointer (RGBA) |

---

## Chat block layout

`c()`/`cl()` return a byte block laid out as repeating records:

```
u32  timestamp (ms)
u32  len(date)   + bytes
u32  len(user)   + bytes
u32  len(conn)   + bytes
u32  len(text)   + bytes
```

The parser reads each field as UTF-8 and produces:

```javascript
{ t, date, user, name, conn, clock, text }
```

where `name` strips a trailing `_digits` from `user`, and `clock` is the
`HH:MM:SS` portion extracted from `date`.

---

## Video decoding

`v()` fills the WASM memory with frame rectangles. `VideoState` (in
`src/05-lrec.js`) then, for a given playhead:

1. calls `w()` to check which frames are ready,
2. reads `g(0..6)` for the frame geometry,
3. builds an `ImageData` from the pixel pointer,
4. draws it to the canvas at the correct position and scale.

---

## Audio decoding

`a()` fills the PCM buffer; `f()`/`fl()` give its pointer and length. The app
copies it into an `Int16Array` and wraps it in a WAV container
(`pcmToWav`) for playback through an `<audio>` element at 8 kHz mono.
