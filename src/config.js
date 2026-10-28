/**
 * SVU Player — runtime configuration (local standalone mode)
 * ----------------------------------------------------------
 * Single place to configure how the local player behaves.
 */
window.CONFIG = {

  /* ------------------------------------------------------------------ *
   * Asset paths
   * ------------------------------------------------------------------ *
   * The WASM decoder is loaded relative to the page.
   */
  wasmUrl: "assets/core.wasm",

  /** Build token appended to asset URLs to bust the cache. */
  buildToken: "v2.7.0",

  /* ------------------------------------------------------------------ *
   * Backend (local proxy to sessions.svuonline.org only)
   * ------------------------------------------------------------------ *
   * Only catalog browsing and .lrec downloads from sessions.svuonline.org
   * are handled locally by serve.py.
   */
  api: (function () {
    var isLocal = typeof location !== "undefined" && (
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.hostname === ""
    );
    var base = isLocal ? "" : "https://svu-proxy.iateam.workers.dev";
    return {
      browse: base + "/api/browse",
      download: base + "/api/download"
    };
  })(),

  /* ------------------------------------------------------------------ *
   * Feature switches
   * ------------------------------------------------------------------ */
  features: {
    /** Client-side audio enhancement. */
    enhance: true,
    /** Speech-to-text captions (disabled in offline mode). */
    captions: false,
    /** First-run feature tour. */
    tour: true,
    /** Remote version check (disabled in offline mode). */
    updateCheck: false
  },

  /* ------------------------------------------------------------------ *
   * Playback defaults
   * ------------------------------------------------------------------ */
  playback: {
    /** Default playback rate (1 = normal). */
    rate: 1,
    /** Default volume 0..1. */
    volume: 1,
    /** Restore the "stretch to fill" preference across sessions. */
    rememberStretch: true,
    /** Restore the "enhance" preference across sessions. */
    rememberEnhance: true,
    /** Restore the "captions" preference across sessions. */
    rememberCaptions: false
  },

  /* ------------------------------------------------------------------ *
   * Storage keys
   * ------------------------------------------------------------------ */
  storage: {
    language:   "svu.lang.v2",
    theme:      "svu.theme",
    mode:       "svu.mode",
    termColor:  "svu.termColor",
    crt:        "svu.crt",
    pin:        "svu.pinControls",
    stretch:    "lrec.stretch",
    enhance:    "lrec.enhance",
    captions:   "lrec.captions",
    tourSeen:   "lrec.tour.seen",
    indexedDB:  "lrec-library"
  }
};

/**
 * Persistent preference helper (localStorage + Cookie fallback)
 * Guarantees theme, dark/light mode, and language survive refresh & browser restart.
 */
window.SVU_PREFS = {
  get(key, fallback) {
    try {
      const val = localStorage.getItem(key);
      if (val !== null && val !== undefined && val !== "") {
        return val;
      }
    } catch (err) {}
    try {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + escaped + "=([^;]*)"));
      if (m) {
        const decoded = decodeURIComponent(m[1]);
        try { localStorage.setItem(key, decoded); } catch (e) {}
        return decoded;
      }
    } catch (err) {}
    return fallback;
  },
  set(key, value) {
    const str = String(value);
    try {
      localStorage.setItem(key, str);
    } catch (err) {}
    try {
      document.cookie = key + "=" + encodeURIComponent(str) + "; max-age=31536000; path=/; SameSite=Lax";
    } catch (err) {}
  }
};

// Apply saved theme, mode, and language immediately in <head> before first paint
(function () {
  try {
    const docEl = document.documentElement;
    const savedTheme = window.SVU_PREFS.get("svu.theme", "default");
    const savedMode = window.SVU_PREFS.get("svu.mode", "dark");
    const savedLang = window.SVU_PREFS.get("svu.lang.v2", "ar");
    const savedTermColor = window.SVU_PREFS.get("svu.termColor", savedTheme === "terminal" ? "amber" : "green");
    const savedCrt = window.SVU_PREFS.get("svu.crt", "on");
    docEl.dataset.theme = savedTheme;
    docEl.dataset.mode = savedMode === "light" ? "light" : "dark";
    if (savedTheme === "hacker" || savedTheme === "terminal") {
      docEl.dataset.termColor = savedTermColor;
      docEl.dataset.crt = savedCrt;
    }
    docEl.lang = savedLang === "en" ? "en" : "ar";
    docEl.dir = savedLang === "en" ? "ltr" : "rtl";
  } catch (err) {}
})();
