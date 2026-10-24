(function (ns) {
  "use strict";
  const AUDIO_RATE = 8000;
  const yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0));
  const EXPORTS = {
    m: "m",
    n: "n",
    o: "o",
    d: "d",
    hd: "hd",
    c: "c",
    cl: "cl",
    v: "v",
    vt: "vt",
    ok: "ok",
    a: "a",
    at: "at",
    f: "f",
    fl: "fl",
    fx: "fx",
    mt: "mt",
    r: "r",
    s: "s",
    w: "w",
    g: "g",
    x: "x",
    memory: "memory",
    $e: "e",
    $h: "h",
    $c: "c"
  };
  let wasmPromise = null;
  function loadWasm() {
    if (wasmPromise) {
      return wasmPromise;
    }
    const imports = {
      [EXPORTS.$e]: {
        [EXPORTS.$h]: () => 0,
        [EXPORTS.$c]: () => 0
      }
    };
    const WASM_URL = (window.CONFIG && window.CONFIG.wasmUrl) || "assets/core.wasm";
    wasmPromise = (async () => {
      let instance;
      try {
        instance = (await WebAssembly.instantiateStreaming(fetch(WASM_URL), imports)).instance;
      } catch (err) {
        const resp = await fetch(WASM_URL);
        if (!resp.ok) {
          throw new Error("HTTP " + resp.status);
        }
        instance = (await WebAssembly.instantiate(await resp.arrayBuffer(), imports)).instance;
      }
      const exports = {};
      for (const k in EXPORTS) {
        if (k[0] !== "$") {
          exports[k] = instance.exports[EXPORTS[k]];
        }
      }
      return exports;
    })();
    wasmPromise.catch(() => {
      wasmPromise = null;
    });
    return wasmPromise;
  }
  if (typeof WebAssembly !== "undefined") {
    loadWasm().catch(() => {});
  }
  let generation = 0;
  function readChat(mod) {
    const chatPtr = mod.c();
    const chatLen = mod.cl();
    const buf = new Uint8Array(mod.memory.buffer, chatPtr, chatLen).slice();
    const view = new DataView(buf.buffer);
    const decoder = new TextDecoder("utf-8");
    const messages = [];
    let offset = 0;
    while (offset + 4 <= buf.length) {
      const t = view.getUint32(offset, true);
      const fields = [];
      offset += 4;
      for (let i = 0; i < 4; i++) {
        const len = view.getUint32(offset, true);
        offset += 4;
        fields.push(decoder.decode(buf.subarray(offset, offset + len)));
        offset += len;
      }
      const [date, user, conn, text] = fields;
      const match = /(\d{1,2}:\d{2}:\d{2})/.exec(date);
      messages.push({
        t: t,
        date: date,
        user: user,
        name: user.replace(/_\d+$/, ""),
        conn: conn,
        clock: match ? match[1] : "",
        text: text
      });
    }
    return messages.sort((a, b) => a.t - b.t);
  }
  async function parseLrec(fileBuffer, onProgress) {
    const progress = (label, frac) => onProgress && onProgress(label, frac);
    const gen = ++generation;
    progress("Scanning file", 0);
    if (typeof WebAssembly === "undefined") {
      throw new Error("This browser cannot run the player (WebAssembly is not available)");
    }
    const mod = await loadWasm();
    const stale = () => gen !== generation;
    if (stale()) {
      return new Promise(() => {});
    }
    const bytes = new Uint8Array(fileBuffer);
    const ptr = mod.m(bytes.length);
    new Uint8Array(mod.memory.buffer, ptr, bytes.length).set(bytes);
    const chunkCount = mod.o(ptr, bytes.length);
    if (chunkCount < 0) {
      throw new Error("Not an .lrec file (no header chunk found)");
    }
    const header = {
      totalChunks: mod.hd(0),
      durationMs: mod.hd(1),
      videoChunks: mod.hd(2),
      audioChunks: mod.hd(3),
      chatMessages: mod.hd(4)
    };
    const duration = mod.d();
    const chat = readChat(mod);
    const decodeAll = async (label, decode, total, step) => {
      progress(label, 0);
      let done = decode(0);
      while (done < total) {
        const t0 = performance.now();
        while (done < total && performance.now() - t0 < 30) {
          done = decode(step);
        }
        progress(label, done / total);
        await yieldFrame();
        if (stale()) {
          return false;
        }
      }
      return true;
    };
    if (!(await decodeAll("Decoding screen", mod.v, mod.vt(), 16))) {
      return new Promise(() => {});
    }
    if (!(await decodeAll("Decoding audio", mod.a, mod.at(), 200))) {
      return new Promise(() => {});
    }
    const pcmPtr = mod.f();
    const pcmLen = mod.fl();
    const pcm = new Int16Array(mod.memory.buffer, pcmPtr, pcmLen).slice();
    mod.fx();
    const video = {
      X: mod,
      gen: gen
    };
    const audio = {
      pcm: pcm,
      rate: AUDIO_RATE
    };
    return {
      header: header,
      durationMs: duration,
      chat: chat,
      video: video,
      audio: audio,
      videoOk: !!mod.ok(),
      chunkCount: chunkCount
    };
  }
  class VideoState {
    constructor(src) {
      this.X = src.X;
      this.gen = src.gen;
      this.X.r();
      this.minT = this.X.mt();
    }
    live() {
      return this.gen === generation;
    }
    seek(time, keyframe = false) {
      return this.live() && !!this.X.s(time, keyframe ? 1 : 0);
    }
    draw(ctx, canvas) {
      if (!this.live()) {
        return;
      }
      const X = this.X;
      const ready = X.w();
      if (!ready) {
        return;
      }
      const width = X.g(0);
      const height = X.g(1);
      if (ready & 2) {
        canvas.width = width;
        canvas.height = height;
      }
      if (!(ready & 1)) {
        return;
      }
      const sx = X.g(2);
      const sy = X.g(3);
      const ex = X.g(4);
      const ey = X.g(5);
      const pixels = X.g(6);
      const imageData = new ImageData(new Uint8ClampedArray(X.memory.buffer, pixels, width * height * 4), width, height);
      ctx.putImageData(imageData, 0, 0, sx, sy, ex - sx, ey - sy);
    }
  }
  function pcmToWav(pcm, rate) {
    const n = pcm.length;
    const buffer = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buffer);
    const writeAscii = (offset, str) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };
    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + n * 2, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, "data");
    view.setUint32(40, n * 2, true);
    new Int16Array(buffer, 44, n).set(pcm);
    return new Uint8Array(buffer);
  }
  function planChunks(pcm, rate, chunkSec, minSec) {
    const n = pcm.length;
    const step = Math.round(rate * 0.2);
    const chunk = Math.round(chunkSec * rate);
    const marks = [0];
    let pos = 0;
    while (n - pos > chunk) {
      const end = Math.min(pos + chunk, n - step);
      const from = Math.max(pos + (chunk >> 1), end - Math.round(minSec * rate));
      let best = end;
      let bestEnergy = Infinity;
      for (let i = from; i <= end; i += step) {
        const energy = Dsp.energy(pcm, i, i + step);
        if (energy < bestEnergy) {
          bestEnergy = energy;
          best = i;
        }
      }
      best |= 0;
      marks.push(best);
      pos = best;
    }
    marks.push(n);
    return marks.slice(0, -1).map((start, i) => [start, marks[i + 1]]);
  }
  function wavToPcm(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      const size = view.getUint32(offset + 4, true);
      if (id === "data") {
        const count = Math.min(size, bytes.length - offset - 8) >> 1;
        const dataOffset = bytes.byteOffset + offset + 8;
        return new Int16Array(bytes.buffer.slice(dataOffset, dataOffset + count * 2));
      }
      offset += 8 + size + (size & 1);
    }
    throw new Error("bad WAV");
  }
  const LREC = {
    parseLrec: parseLrec,
    VideoState: VideoState,
    pcmToWav: pcmToWav,
    planChunks: planChunks,
    wavToPcm: wavToPcm,
    AUDIO_RATE: AUDIO_RATE
  };
  ns.LREC = LREC;
})(typeof globalThis !== "undefined" ? globalThis : this);
;

;
