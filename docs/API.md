# Backend API Specification

SVU Player is an offline-first application. When running locally with `serve.py`, the backend acts as a lightweight proxy and session scraper for the university portal (`sessions.svuonline.org`).

All endpoints are relative to the application origin.

---

## Architecture Summary

| Endpoint | Method | Status in Standalone Mode | Purpose |
|---|---|---|---|
| `/api/browse` | `GET` | **Active** | Scrapes & cascades session metadata from `sessions.svuonline.org` |
| `/api/download` | `GET` | **Active** | Security-filtered streaming proxy for `.lrec` files |
| `/api/enhance` | `POST` | **Retired (Client DSP)** | Replaced by 100% in-browser 4-stage DSP (`src/01-dsp.js`) |
| `/api/transcribe` | `POST` | **Optional / 404** | Speech-to-text hook (returns 404 in local offline mode; degrades gracefully) |

---

## 1. `GET /api/browse?`

Scrapes and caches the remote session catalog from `http://sessions.svuonline.org/new/Default.aspx`. A single endpoint serves every level of the cascading selection tree by automating ASP.NET `__VIEWSTATE` and `__EVENTVALIDATION` postbacks.

### Query Parameters

All parameters are optional and accumulative:

| Parameter | Type | Description | Example |
|---|---|---|---|
| `term` | string | Academic semester code | `F25` |
| `program` | string | University program code | `BACT` |
| `course` | string | Course identifier | `BAC101` |
| `tutor` | string | Tutor username / handle | `t_mrehawi` |
| `class` | string | Class group identifier | `C1` |
| `session` | integer | Session index from results table | `0` |
| `refresh` | integer | Set to `1` to bypass in-memory postback cache | `1` |

### Cascading Hierarchy

The client (`src/08-browse.js`) walks through the levels sequentially:

$$\text{term} \longrightarrow \text{program} \longrightarrow \text{course} \longrightarrow \text{tutor} \longrightarrow \text{class} \longrightarrow \text{session} \longrightarrow \text{files}$$

Each call returns the list of options for the **next** selection level, while echoing current selections back as scalars.

### Sample Response

```json
{
  "terms":      [{ "value": "F25", "label": "Fall 2025" }],
  "programs":   [{ "value": "BACT", "label": "Business Administration" }],
  "courses":    [{ "value": "BAC101", "label": "Business Operations" }],
  "tutors":     [{ "value": "t_mrehawi", "label": "Mha Maher Rehawi" }],
  "classes":    [{ "value": "C1", "label": "C1" }],
  "sessions":   [
    {
      "index": 0,
      "order": "S5",
      "date": "20-10-2026 15:00",
      "tutor": "t_mrehawi",
      "program": "BACT",
      "course": "BAC101",
      "class": "C1",
      "term": "F25"
    }
  ],
  "files":      [
    {
      "url": "http://sessions.svuonline.org/.../lecture_05.lrec",
      "name": "lecture_05.lrec",
      "description": "Lecture 05 - Supply Chains",
      "date": "20-10-2026",
      "sizeMB": 5.4
    }
  ],
  "term": "F25",
  "program": "BACT",
  "course": "BAC101",
  "tutor": "t_mrehawi",
  "class": "C1",
  "session": 0
}
```

### In-Memory Cache

`serve.py` maintains an internal cache (`_BROWSE_CACHE`) keyed by selection tuples with a 30-minute TTL. This prevents repeated slow HTTP round-trips to the university's ASP.NET server when navigating back and forth. Passing `refresh=1` invalidates cached entries for that subtree.

---

## 2. `GET /api/download?url=`

A streaming proxy that fetches a `.lrec` recording from `sessions.svuonline.org` and streams it directly to the browser. This allows the client to inspect `Content-Length`, track download progress byte-by-byte, and bypass browser CORS restrictions.

### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | Fully-qualified URL pointing to a `.lrec` file |

### Security Validation

To prevent open proxy vulnerabilities, `serve.py` enforces strict validation rules:
- Scheme must be `http` or `https`.
- Hostname must be `svuonline.org` or end with `.svuonline.org`.
- URL path must end with `.lrec` (case-insensitive).
- Protocol-relative URLs (`//host/...`) and arbitrary hosts return `403 Forbidden`:

```json
{"error": "only .lrec URLs from svuonline.org allowed"}
```

### Streaming Behavior

- Forwards HTTP headers from the upstream server (excluding transport hop-by-hop headers).
- Streams bytes in 64 KB chunks (`wfile.write(chunk)`).
- Sets `Access-Control-Allow-Origin: *`.
- Response: `200 application/octet-stream`.

---

## 3. Audio Enhancement (Client-Side DSP)

> [!NOTE]
> In prior versions, audio enhancement relied on an experimental server-side `POST /api/enhance` endpoint. In the current architecture, audio enhancement is **100% client-side** and runs directly in the user's browser via `src/01-dsp.js` and `src/10-enhance.js`.

### Client Pipeline (`src/01-dsp.js`)
1. **120 Hz 1st-Order High-Pass Filter**: Strips microphone plosives, room rumble, and AC hum.
2. **2.4 kHz Peaking Biquad EQ (+5.5 dB)**: Accentuates critical vocal presence frequencies.
3. **Adaptive Speech-Aware Noise Gate**: Identifies noise floor percentile and applies a 15 dB soft downward expansion between spoken words.
4. **2:1 Soft-Knee Compressor with Makeup Gain & `tanh` Limiter**: Boosts low-volume tutor speech while preventing clipping.

Enhanced audio is converted into a standard RIFF WAV blob, stored in IndexedDB (`enhanced` store), and hot-swapped into the active `<audio>` element without loss of playback position.

---

## 4. `POST /api/transcribe` (Optional)

An optional speech-to-text endpoint for external speech recognition services.

- In standalone local mode, `serve.py` returns `404 API endpoint removed (offline mode)`.
- When triggered, `src/09-captions.js` gracefully alerts the user: `t("captionsNotSetup")` ("Captions are not set up on the server").

If an external transcription service is provided:
- **Request**: `POST /api/transcribe` with `Content-Type: audio/wav` containing raw WAV audio chunks.
- **Response**: JSON segments `{ "segments": [ { "start": 0.42, "end": 3.18, "text": "...", "nospeech": 0.03 } ] }`.
- Segments with `nospeech >= 0.6` are discarded as background silence.
- HTTP `413` prompts recursive halving of the chunk duration down to ~20 seconds.

---

## Client Error Handling

| Scenario | Client Handling |
|---|---|
| `/api/browse` fails / network down | Displays localized error message in the status bar (`t("browseError")`) |
| `/api/download` fails | Displays localized download error with retry option |
| `/api/transcribe` 404 / 503 | Displays non-blocking notification: "Captions are not set up on the server" |
| Audio Enhance failure | Displays error toast; original raw audio playback continues uninterrupted |
| Offline mode (No internet) | Fully operational: opens local files, browses offline IndexedDB library, plays cached audio |
