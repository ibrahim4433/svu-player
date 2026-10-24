# The `.lrec` recording format

A `.lrec` file is a **Linktivity** session recording: a header followed by
length-prefixed records carrying video frames, audio chunks, and chat messages.

```
┌─────────────────────────────────────────────┐
│ Header (fixed fields + null-terminated strings) │
├─────────────────────────────────────────────┤
│ Record 1   10 04 <len:u16> <flags:u16> …   │
│ Record 2   …                                │
│ …                                           │
└─────────────────────────────────────────────┘
```

---

## Header

| Offset | Bytes | Meaning |
|---|---|---|
| 0–7 | `00 00 00 00 00 00 00 00` | reserved / zero |
| 8–15 | `10 04 0d 04 00 08 00 80` | format marker |
| 16–23 | `00 00 00 88 13 00 00 00` | counts |
| 24–25 | `0a 00` | `0x000a` — field count |
| 26… | `"12659"` | session id |
| | `"2489252"` | recording id |
| | `"Linktivity"` | format name |
| | `"4089"`, `"8430"`, `"139"`, `"0"` | metadata |
| | `"V1.0.1.0"` | format version |

A parse that does not find this header raises
`Not an .lrec file (no header chunk found)`.

---

## Records

```
10 04  <len:u16 LE>  <flags:u16 LE>  00  <type:u16 LE>  <payload: len bytes>  00
```

| Flags | Typical length | Payload prefix | Meaning |
|---|---|---|---|
| `0x0200` | 349 | `00 80 04 00` | media / stream event |
| `0x0300` | 325–4161 | `00 8e 01 00` | stream chunk (audio or video) |
| `0x0100` | 65–1036 | `00 f0 00 00` | metadata / control |

A sample recording contains **12,578 records**.

---

## Embedded content

Record payloads are opaque to the player — they are handed to `core.wasm` for
decoding. The WASM module exposes the decoded streams:

- **Video** — frame rectangles with pixel data, drawn to a canvas.
- **Audio** — 16-bit PCM mono at 8 kHz (`LREC.AUDIO_RATE`).
- **Chat** — UTF-8 messages read back from WASM memory.

The header also carries the presenter's connection string, e.g.:

```
TCP:2:ip-109-41-112-82.web.vodafone.de/109.41.112.82:443
```

---

## Decoding pipeline

```
.lrec bytes
   │
   ▼
wasm.m(len)          allocate a buffer in WASM memory
   │
   ▼
wasm.o(ptr, len)     parse → returns chunk count (<0 means no header)
   │
   ├─ wasm.hd(0)  total chunks
   ├─ wasm.hd(1)  duration (ms)
   ├─ wasm.hd(2)  video chunks
   ├─ wasm.hd(3)  audio chunks
   ├─ wasm.hd(4)  chat messages
   │
   ├─ wasm.v() / wasm.a()   decode all video / audio chunks
   │
   ├─ wasm.c() / wasm.cl()  chat pointer + length → read UTF-8 fields
   │
   ▼
{ durationMs, video, audio: {pcm, rate}, chat, videoOk, chunkCount }
```

---

## Reference

A real 6 MB sample is included at `examples/sample.lrec`.
