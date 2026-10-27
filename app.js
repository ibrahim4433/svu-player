try {
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
    docEl.dataset.theme = savedTheme;
    docEl.dataset.mode = savedMode === "light" ? "light" : "dark";
    docEl.lang = savedLang === "en" ? "en" : "ar";
    docEl.dir = savedLang === "en" ? "ltr" : "rtl";
  } catch (err) {}
})();
} catch (err) {
  console.error("[SVU] module config.js failed to initialise:", err);
}
;
try {
(function () {
  'use strict';
  const Dsp = {
    energy(samples, start, end) {
      let total = 0;
      for (let i = start; i < end; i++) {
        total += samples[i] * samples[i];
      }
      return total;
    },
    rms(samples, start, end) {
      let total = 0;
      for (let i = start; i < end; i += 4) {
        total += samples[i] * samples[i];
      }
      return Math.sqrt(total / Math.max(1, (end - start) / 4));
    },
    // Client-side studio voice enhancement:
    // 1. 120 Hz High-Pass Filter (removes low-frequency hum, AC rumble & plosives)
    // 2. Vocal Presence Boost (+5.5 dB around 2.5 kHz for speech intelligibility)
    // 3. Speech-Aware Smooth Envelope Noise Gate (suppresses background hiss between words)
    // 4. 2:1 Soft-Knee Speech Compressor + Loudness Normalization
    enhance(pcm, rate) {
      const n = pcm.length;
      if (!n) return new Int16Array(0);
      const sr = rate || 16000;
      const flt = new Float32Array(n);

      // Stage 1: 120 Hz High-Pass Filter (1st-order IIR)
      const rcHp = 1.0 / (2.0 * Math.PI * 120.0);
      const dt = 1.0 / sr;
      const alphaHp = rcHp / (rcHp + dt);
      let prevX = pcm[0] / 32768.0;
      let prevY = 0.0;
      for (let i = 0; i < n; i++) {
        const x = pcm[i] / 32768.0;
        const y = alphaHp * (prevY + x - prevX);
        prevX = x;
        prevY = y;
        flt[i] = y;
      }

      // Stage 2: Vocal Presence & Clarity Boost (Biquad Peaking EQ @ 2400 Hz, Q=1.0, +5.5 dB)
      const f0 = Math.min(2400.0, sr * 0.38);
      const A = Math.pow(10, 5.5 / 40);
      const w0 = (2 * Math.PI * f0) / sr;
      const cosW0 = Math.cos(w0);
      const alphaEq = Math.sin(w0) / (2.0 * 1.0);
      const b0 = 1 + alphaEq * A;
      const b1 = -2 * cosW0;
      const b2 = 1 - alphaEq * A;
      const a0 = 1 + alphaEq / A;
      const a1 = -2 * cosW0;
      const a2 = 1 - alphaEq / A;
      const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0;
      const na1 = a1 / a0, na2 = a2 / a0;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < n; i++) {
        const x = flt[i];
        const y = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
        x2 = x1; x1 = x;
        y2 = y1; y1 = y;
        flt[i] = y;
      }

      // Stage 3: Speech-Aware Noise Floor & Smooth Envelope Gate
      // Ignore pure-silence windows (muted mic) when estimating background hiss
      const winSize = Math.max(64, Math.floor(sr * 0.05));
      const activeRms = [];
      for (let i = 0; i + winSize <= n; i += winSize) {
        let sum = 0;
        for (let j = i; j < i + winSize; j++) {
          sum += flt[j] * flt[j];
        }
        const r = Math.sqrt(sum / winSize);
        if (r > 0.0005) {
          activeRms.push(r);
        }
      }
      activeRms.sort((a, b) => a - b);
      const noiseFloor = activeRms.length
        ? activeRms[Math.floor(activeRms.length * 0.15)]
        : 0.002;
      const gateThresh = Math.min(0.04, Math.max(noiseFloor * 2.2, 0.003));
      const speechRef = activeRms.length
        ? activeRms[Math.floor(activeRms.length * 0.85)]
        : 0.15;

      // Makeup gain so quiet speech reaches a strong, clear studio level
      const targetRms = 0.22;
      const makeupGain = Math.min(4.5, Math.max(1.35, targetRms / Math.max(0.02, speechRef)));

      const attCoeff = Math.exp(-1.0 / (sr * 0.004)); // 4ms attack
      const relCoeff = Math.exp(-1.0 / (sr * 0.060)); // 60ms release
      let env = 0.0;
      const out = new Int16Array(n);

      // Stage 4: Envelope Gate + Soft-Knee Speech Compressor + Limiter
      for (let i = 0; i < n; i++) {
        const absX = Math.abs(flt[i]);
        env = absX > env
          ? attCoeff * env + (1 - attCoeff) * absX
          : relCoeff * env + (1 - relCoeff) * absX;

        // Smooth noise gate ratio
        let gateGain = 1.0;
        if (env < gateThresh) {
          const ratio = env / gateThresh;
          gateGain = ratio * ratio * 0.18; // reduce background hiss by ~15 dB
        }

        let s = flt[i] * gateGain * makeupGain;

        // Soft-knee compression above 0.45 to boost body without clipping
        const absS = Math.abs(s);
        if (absS > 0.45) {
          const compressed = 0.45 + (absS - 0.45) * 0.45;
          s = (s < 0 ? -1 : 1) * Math.tanh(compressed);
        }

        out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      }
      return out;
    }
  };
  globalThis.Dsp = Dsp;
})();
} catch (err) {
  console.error("[SVU] module 01-dsp.js failed to initialise:", err);
}
;
try {
(function (ns) {
  'use strict';

  const STRINGS = {
    en: {
      openSession: "Open session",
      tagline: "Offline session player for Syrian Virtual University",
      loading: "Loading…",
      readingFile: "Reading file…",
      scanningFile: "Scanning file…",
      decodingScreen: "Decoding screen…",
      loadingSession: "Loading session…",
      openFail: "Could not open this file",
      notLrec: "Not a session recording (no header found)",
      seek: "Seek",
      playPause: "Play/Pause (Space)",
      back10: "Back 10 s (←)",
      fwd10: "Forward 10 s (→)",
      mute: "Mute (M)",
      volume: "Volume",
      speed: "Playback speed",
      enhance: "Enhance",
      enhanceOn: "Enhance ON",
      enhanceTitle: "Enhance audio (4-stage vocal clarity & noise reduction)",
      themesBtn: "Themes",
      hideControlsTitle: "Hide controls & cursor (H)",
      pinControls: "Pin / auto-hide controls",
      hideChat: "Hide chat",
      metaCollege: "College",
      metaMaterial: "Material",
      metaClass: "Class",
      metaTerm: "Term",
      metaLesson: "Lesson",
      metaDate: "Date",
      cc: "CC",
      ccTitle: "Captions (auto-generated)",
      stretch: "Stretch",
      stretchTitle: "Enlarge the view to fill the available space (S)",
      chat: "Chat",
      chatTitle: "Show/hide chat (C)",
      fullscreen: "Fullscreen (F)",
      showAll: "Show all",
      chatLiveSync: "Live Sync",
      chatAllMessages: "All Messages ({n})",
      chatEmptyAtStart: "Messages will appear as the lecture plays, or click 'All Messages' to browse questions and jump to any timestamp.",
      chatEmpty: "Open a recording to see its chat.",
      chatNone: "This recording has no chat messages.",
      tabFile: "Open file",
      tabRemote: "SVU sessions",
      tabLink: "Direct link",
      tabSaved: "Saved offline",
      linkTitle: "Download from Direct SVU Recording Link",
      linkSub: "Paste a direct .lrec URL from sessions.svuonline.org to download and play it immediately.",
      dropHeroTitle: "Ready to Watch a Session",
      dropHeroSub: "Browse the university session catalog, paste a direct link, or drop any .lrec file right here.",
      browseSessions: "Browse Sessions",
      installPwa: "Install",
      installPwaShort: "Install",
      installPwaTitle: "Install SVU Player for full offline playback (PWA)",
      pwaInstalled: "Offline player installed ✓",
      themeMenuTitle: "Choose theme",
      modeToggleTitle: "Toggle Dark / Light Mode",
    modeDark: "Dark Mode",
    modeLight: "Light Mode",
    themeSubtitle: "Color Palettes",
      themeDefault: "Default",
      themeWhatsapp: "WhatsApp",
      themeTelegram: "Telegram",
      themeWin98: "Windows 98",
      themeWinxp: "Windows XP",
      themeWin7: "Windows 7",
      themeHacker: "Hacker",
      themeVscode: "VS Code",
      themeTerminal: "Terminal",
      close: "Close",
      dropTitle: "Drop a .lrec file here",
      dropSub: "or click to choose one from your computer",
      noServer: "Remote sessions are not reachable right now. To browse online sessions, run `python3 serve.py` locally. Saved recordings still play from the “Saved offline” tab.",
      lblTerm: "Term",
      lblProgram: "Program",
      lblCourse: "Course",
      lblTutor: "Tutor",
      lblClass: "Class",
      lblSession: "Session",
      selTerm: "Select Term",
      selProgram: "Select Program",
      selCourse: "Select Course",
      selTutor: "Select Tutor",
      selClass: "Select Class",
      selSession: "Select Session",
      sessions: "Sessions",
      recordings: "Recordings",
      keep: "Keep a copy on this device for offline playback",
      cancel: "Cancel",
      downloadPlay: "Download & play",
      playSaved: "Play (saved)",
      play: "Play",
      del: "Delete",
      stLoading: "Loading…",
      stNothing: "Nothing found for this selection.",
      stCouldNotLoad: "Could not load: {e}",
      stChooseSession: "Choose a session.",
      stLoadingFiles: "Loading files…",
      stFilesFail: "Could not load files: {e}",
      noSessions: "No sessions for this class.",
      noFiles: "The SVU site has no recording for this session.",
      dlStarting: "Starting…",
      dlSaving: "Saving to this device…",
      dlSaveFail: "Downloaded, but could not save offline: {e}",
      dlCancelled: "Download cancelled.",
      dlFailed: "Download failed: {e}",
      stTerms: "Loading terms…",
      stOfflineMode: "Or paste a direct .lrec URL from svuonline.org:",
      savedNone: "Nothing saved yet. Download a recording from the “SVU sessions” tab and it will appear here, ready to play offline.",
      savedUnavailable: "Offline storage is not available in this browser.",
      savedReadFail: "Could not read the library: {e}",
      confirmDelete: "Remove “{name}” from this device?",
      usage: "Offline Storage: {used} used ({free} free — room for ~{count} more lectures)",
      ccWorking: "Transcribing {p}%…",
      ccNone: "No speech found.",
      ccNotSet: "Captions are disabled in local offline mode.",
      ccFail: "Captions failed: {e}",
      enhWorking: "Enhancing audio…",
      enhProgress: "Enhancing audio {p}%…",
      enhFail: "Enhance failed: {e}",
      version: "Version",
      reloadLatest: "Update",
      reloadLatestTitle: "Clear the offline copy of the app and load the newest version (saved sessions are kept)",
      updateAvail: "A new version is available.",
      updateNow: "Update now",
      later: "Later",
      videoFail: "This device could not decode the screen video. Audio and chat still work.",
      tour: "Help Guide",
      welcomeTitle: "Welcome to SVU Player Studio",
      welcomeSub: "Replay recorded university sessions with synchronized screen, enhanced vocal audio, and interactive chat — 100% locally and offline:",
      welcomeStart: "Get started",
      shortcuts: "Shortcuts: Space play/pause · ← → skip 5 s · J/L skip 10 s · M mute · F fullscreen · C chat · S stretch",
      wMetaT: "Smart session tags",
      wMetaD: "Automatically displays College, Material, Class, Term, Lesson & Date badges in the top bar",
      wOpenT: "Open session & Install",
      wOpenD: "Browse SVU catalog, paste a direct link, open local .lrec files, or install the offline app",
      wThemesT: "Themes, Mode & AR/EN",
      wThemesD: "Switch between 9 custom themes, Dark/Light mode, and Arabic/English (saved automatically)",
      wScreenT: "Shared screen",
      wScreenD: "Hardware-accelerated replay of the session slides & whiteboard",
      wSeekT: "Interactive timeline",
      wSeekD: "Drag to jump anywhere; white ticks mark exact chat message timestamps",
      wPlayT: "Play & skip ±10 s",
      wPlayD: "Play/pause and jump backward or forward 10 seconds with one click",
      wChatHeadT: "Show all & Close (✕)",
      wChatHeadD: "Reveal future chat messages early or close the chat sidebar with the ✕ button",
      wChatT: "Synchronized chat",
      wChatD: "Messages appear in real time with a scrollbar; click any ▶ timestamp to jump there",
      wPinT: "Fullscreen & Pin bar",
      wPinD: "Watch fullscreen (F) or pin/auto-hide the floating glass control bar",
      wEnhT: "Enhance ON (4-Stage DSP)",
      wEnhD: "Boosts voice clarity and removes background hiss & hum locally",
      wVolT: "Volume, Mute & Speed",
      wVolD: "Mute/unmute, adjust loudness, and change playback speed (0.75× to 2×)",
      wStrT: "Stretch & Chat toggle",
      wStrD: "Enlarge the screen to fill the stage (S) or toggle the chat panel (C)",
      aboutTitle: "About SVU Player",
      aboutDev: "SVU Player — Studio Edition",
      aboutSub: "High-performance local & offline session player engineered for Syrian Virtual University (.lrec) recordings.",
      aboutBadgeOffline: "100% Local & Offline Ready",
      aboutBadgePrivacy: "Zero External Tracking",
      aboutFeat1T: "WASM Decoder & 4-Stage Vocal DSP",
      aboutFeat1D: "Hardware-accelerated screen replay paired with a 4-stage speech processor (high-pass filter, +5.5 dB vocal presence EQ, smooth noise gate, and soft-knee compressor).",
      aboutFeat2T: "9 Studio Themes & Smart Metadata",
      aboutFeat2D: "9 built-in themes (Default, WhatsApp, Telegram, Win98, WinXP, Win7, Hacker, VS Code, Terminal) + Dark/Light mode & automatic .lrec filename tag parsing.",
      aboutFeat3T: "IndexedDB Offline Library & PWA",
      aboutFeat3D: "Save downloaded recordings directly inside your browser and install SVU Player as a standalone offline app.",
      aboutPwaTitle: "Full Offline Deployment (PWA App)",
      aboutPwaSub: "Install SVU Player on your desktop or phone so it launches instantly without a browser bar and works 100% offline with local .lrec files and saved sessions.",
      aboutPwaHint: "If the browser prompt does not appear automatically, click the Install App icon (⊕) in your browser's address bar.",
      aboutServerTitle: "Local Server Deployment (Online SVU Catalog & Downloads)",
      advancedDevOnly: "Local Server & Developer Setup ▾",
      aboutServerSub: "To browse the live SVU session catalog and download .lrec files directly from sessions.svuonline.org, run the local server in your project directory:",
      copyCmd: "Copy",
      copiedCmd: "Copied!",
      tabBatch: "Batch download",
      studentLibBtn: "Student library",
      hubResumeTitle: "Resume Watching",
      hubResumeBtn: "Resume",
      hubBatchSub: "Select your faculty and term to download all lectures at once",
      hubLibSub: "Locally saved recordings for 100% offline study",
      hubBrowseSub: "Browse the live university recording directory",
      hubFileSub: "Play any local .lrec file from your computer or phone",
      hubRecentTitle: "Saved Lectures on This Device",
      hubViewAllSaved: "View All in Library →",
      exitSession: "Exit Session",
      exitSessionTitle: "Return to Student Hub",
      backToHub: "Hub",
    backToHome: "Back to Home",
      profExportModalTitle: "Export Profile Backup",
      profExportSelectItems: "Select data to include in backup file:",
      profExportOptSettings: "Profile Settings & Preferences",
      profExportOptSettingsDesc: "Name, theme, appearance, language, and pre-configured courses.",
      profExportOptHistory: "Watched History & Progress",
      profExportOptHistoryDesc: "Watched checkmarks (✓) and completion dates.",
      profExportOptBatch: "Batch Download Selection & Queue",
      profExportOptBatchDesc: "Selected courses state and queue in batch downloader.",
      profExportOptVideos: "Offline Saved Video Lectures (.lrec)",
      profExportOptVideosDesc: "Includes local video/audio lecture files for 100% offline transfer to another device.",
      profExportLecOne: "lecture",
      profExportLecMany: "lectures",
      profBackupFileName: "Auto-generated export filename:",
      profExportStatusPreparing: "Preparing backup package...",
      profExportStatusPacking: "Packing lecture {current} of {total} ({name})...",
      profExportStatusGenerating: "Generating and downloading backup file...",
      profExportStatusDone: "Export completed successfully!",
      profExportStartBtn: "Export & Download Backup",
      profExportBtnShort: "Export Backup",
      profExportTooltip: "Export a backup bundle of this profile",
      profExportSuccess: "Profile backup exported successfully!\nFile: {filename}",
      profExportError: "Failed to export profile",

      profImportBtn: "Import Backup",
      profImportBtnShort: "Import Backup",
      profImportModalTitle: "Import Profile Backup",
      profImportDestTitle: "Choose import destination:",
      profImportDestNew: "Create as a New Profile",
      profImportDestNewDesc: "Creates a separate profile with isolated storage without modifying existing profiles.",
      profImportDestMerge: "Overwrite / Merge into Active Profile",
      profImportDestMergeDesc: "Merges lectures and updates settings of the current profile.",
      profImportSelectItems: "Select items to restore:",
      profImportMetaSub: "Exported: {date} · Version: {ver}",
      profImportStatusPreparing: "Preparing import...",
      profImportStatusWriting: "Restoring lecture {current} of {total} ({name})...",
      profImportStatusDone: "Import completed successfully!",
      profImportStartBtn: "Start Import Now",
      profImportInvalidFile: "Invalid or unrecognized SVU profile backup file.",
      profImportSuccess: "Profile imported successfully!",
      profImportError: "Failed to import profile",
      profileImportedDefaultName: "Imported Profile",
      introBadge: "SVU Player Studio",
      introTitle: "Syrian Virtual University Session Studio & Offline Library",
      introDesc: "Watch and download SVU lectures for 100% offline study—with automatic voice clarity booster, slide sync, and clickable student Q&A.",
      introFeat1: "Automatic Voice Clarity Booster & Noise Removal",
      introFeat2: "Synchronized Live Chat & Timestamp Seek",
      introFeat3: "Safe Sequential Batch Downloader & Offline Storage",
guideModalTitle: "SVU Player Guide",
    guideHeading: "Quick guide to SVU Player features",
    guideSub: "Everything you need to play sessions, clarify teacher audio, and access offline content on mobile & desktop:",
    guideTouchTitle: "📱 Touch Gestures",
    guideTouchDesc: "Single tap: show/hide controls · Double tap left/right: seek ±10s · Rotate phone: cinema split view.",
    guideDspTitle: "🎙️ 4-Stage DSP Voice Clarity",
    guideDspDesc: "WebAssembly audio processor: noise gate, high-pass vocal cut, equalizer, and limiter to make lecture audio crystal clear.",
    guideChatTitle: "💬 Synchronized Chat & Seek",
    guideChatDesc: "Student questions scroll in sync with speech. Tap any timestamp or message to seek directly to that moment.",
    guideBatchTitle: "⚡ Safe Batch Downloader & Offline Storage",
    guideBatchDesc: "Download full courses in one click with safe rate-limiting. Saved locally in browser storage for 100% offline playback.",
    guideKbdTitle: "⌨️ Keyboard Shortcuts (Tablet & Laptop)",
    guideKbdDesc: "Space: Play/Pause · ← →: Skip 5s · M: Mute · F: Fullscreen · C: Chat toggle · S: Stretch",
    welcomeStartBtn: "Understood, Let's Begin",
    guideBtnHub: "Return to Student Hub & close session",
    guideBtnPlay: "Play or pause lecture (Spacebar)",
    guideBtnSeek: "Skip backward or forward 10s (Arrow keys)",
    guideBtnEnh: "4-Stage DSP vocal clarifier & noise gate",
    guideBtnSpeed: "Speed up or slow down voice (0.75× - 2×)",
    guideBtnChat: "Toggle synchronized student chat (C)",
    guideBtnStretch: "Fit or stretch slide aspect ratio (S)",
    guideBtnPin: "Keep bottom control bar pinned open",
    guideTryDemoAction: "▶ Try Controls in Demo Lecture →",
    guideHubBatchHint: "Select your college and semester to download all lectures with safe rate-limiting.",
    guideHubLibHint: "Access saved lectures offline, toggle watched status (✓), or delete to free memory.",
    guideHubDirHint: "Browse academic degree programs, LMS chains, and search over 1,160 accredited courses.",
    courseDirBadge: "Browse Directory",
    remoteTabTitle: "SVU Session Catalog & Direct Replay",
    remoteTabSub: "Browse the official university directory by Term, Program, Course, Tutor, Class, and Session to play or save any recording.",
    savedTabTitle: "Student Offline Replay Library",
    savedTabSub: "Manage all recordings saved locally in your browser (IndexedDB). Watch 100% offline, track watched status, or free storage.",
    fileTabTitle: "Open Local Recording (.lrec)",
    fileTabSub: "Select or drop any .lrec lecture file stored on your phone or computer to play it instantly with audio clarity filters and synced chat.",
    statCourses: "courses",
    statLessons: "lessons selected",
    statSaved: "saved",
    statToDl: "to download",
    guideBtnDescAll: "Hub button to exit to dashboard · Play/Pause for playback · ±10s for quick seeking · Speed up to 2× · and Fullscreen mode.",
    slide1Tag: "Starting Your Study Session",
    slide1Title: "4 Ways to Play & Save Your SVU Lectures",
    slide1Desc: "Whether streaming a single session, batch-downloading a course, or playing an existing file on your device:",
    slide2Tag: "Player Controls Bar",
    slide2Title: "All playback, audio enhancement, and view tools",
    slide2Desc: "Compact bottom bar gives you instant access to everything: Hub button to return to dashboard, speed boost, vocal DSP, and ±10s precision seeking.",
    slide3Tag: "Widescreen & Synced Live Chat",
    slide3Title: "Real-time question sync with instant video jump",
    slide3Desc: "Student questions stream second-by-second synchronized with teacher voice. Tap any question or timestamp to jump straight to that moment in the video!",
    slide4Tag: "Speech Intelligibility",
    slide4Title: "Crystal-Clear Teacher Voice with One Tap",
    slide4Desc: "Struggling to hear a quiet, echoing, or static-heavy lecturer? Click Enhance in the player bar to automatically clean up the voice and make spoken words crisp and clear.",
    slide5Tag: "Touch Gestures & Shortcuts",
    slide5Title: "Effortless control via keyboard, mouse, or touch",
    slide5Desc: "Single tap for controls, double tap for ±10s seek, and rotating phone activates widescreen cinema split with side-by-side chat.",
    slide6Tag: "Troubleshooting & Storage FAQ",
    slide6Title: "Frequently Asked Questions & Quick Solutions",
    slide6Desc: "Answers to common student questions about downloading, browser memory, offline backups, and direct links:",
    guideStudioBadge: "Studio Guide",
    guideNavTitle: "Guide Chapters",
    guideNavSubtitle: "Select a topic to explore",
    slide1Nav: "Open & Download Lectures",
    slide1NavSub: "4 ways to start playing",
    slide2Nav: "Player Bar & Tools",
    slide2NavSub: "Playback, speed & controls",
    slide3Nav: "Live Synced Chat",
    slide3NavSub: "Smart timestamp jumping",
    slide4Nav: "Vocal DSP Voice Clarity",
    slide4NavSub: "Speech clarity & noise gate",
    slide5Nav: "Shortcuts & Gestures",
    slide5NavSub: "Master keyboard & touch",
    slide6Nav: "Troubleshooting & FAQ",
    slide6NavSub: "Downloads, storage & backup",
    guideProTipTitle: "Study Pro Tip",
    guideProTipDesc: "Saved lectures in IndexedDB work 100% offline without internet. Your watch progress and timestamp are preserved automatically.",
    guidePrevSection: "Previous",
    guideNextSection: "Next",
    guideFootNavHint: "to navigate chapters",
    guideFootCloseHint: "to close",
    guideSyriaNote: "Engineered for Syrian networks: Stored lectures run 100% locally from IndexedDB with zero telemetry and zero bandwidth.",
    guideDspWhen: "When to use: Turn ON Enhance for distant, echoing, or muffled lecturer microphones to restore crystal-clear speech formants.",
    guideWayBrowseTitle: "SVU sessions",
    guideWayBrowseSub: "Stream or save 1 lecture online",
    guideWayBrowseDesc: "Choose TERM → PROGRAM → COURSE → TUTOR → CLASS → SESSION to stream immediately or save a local copy.",
    guideWayBrowseBtn: "Open SVU sessions →",
    guideWayBatchTitle: "Batch download",
    guideWayBatchSub: "Save a full course with safe rate-limiting",
    guideWayBatchDesc: "Select TERM & PROGRAM, click a course row to load its tutor & class, check your lessons, and download safely.",
    guideWayBatchBtn: "Open Batch download →",
    guideWayLibTitle: "Student library",
    guideWayLibSub: "Watch saved lectures 100% offline",
    guideWayLibDesc: "Access all saved recordings without internet, filter by Watched ✓ or Unwatched, or check for new lectures.",
    guideWayLibBtn: "Open Student library →",
    guideWayFileTitle: "Open file / Try Demo",
    guideWayFileSub: "Play local .lrec or sample lecture",
    guideWayFileDesc: "Have a .lrec recording from LMS or Telegram? Open it directly, or launch the demo lecture to test features now.",
    guideWayFileBtn: "Open File →",
    guideWayDemoBtn: "Try Demo Lecture →",
    guideChatShowAllTip: "Tip: Questions appear in real-time as the lecture progresses. Want to read all student questions from the whole session right away? Check Show all at the top of the Chat drawer.",
    dspUnderHoodTitle: "How it works under the hood (4-Stage DSP Engine):",
    shortcutStretch: "Fit / Stretch slide aspect ratio",
    guideFaq1Q: "Why is 'Download Selected Lectures Safely' disabled?",
    guideFaq1A: "In Batch Download, you must first select TERM and PROGRAM, then click a course row (e.g. ITA320) to expand it and load its tutor and class. Once you check at least one lesson checkbox, the download button unlocks automatically.",
    guideFaq2Q: "Will clearing browser data delete my saved lectures?",
    guideFaq2A: "Yes. Offline lectures are stored inside your browser (IndexedDB). Before clearing browser website data or switching devices, open the top-right Quick Menu (☰) and click Export Backup to save your files safely.",
    guideFaq3Q: "How do I stream or download with a direct SVU recording link?",
    guideFaq3A: "Have a direct recording URL from LMS or email? Click SVU sessions on the home screen, switch to the Direct link tab at the top of the popup, paste the URL, and click Play or Download.",
    introCollapse: "Hide details ▴",
    hubCourseLectures: "{n} lectures",
    hubCourseWatched: "({w} watched)",
      introMiniTitle: "SVU Studio • Offline Session Replay & Library",
      introDetails: "Details",
      hubViewAllSavedCount: "View All ({n}) in Library →",
      hubNoSavedHint: "No lectures saved yet. Use Batch Download or Browse Sessions to get started.",
      batchTitle: "Smart Batch Course Downloader",
      batchSub: "Select your Term & College, check the materials you study, pick Tutor, Class & Lessons (or ALL), and download everything safely with one click. Already downloaded lectures are skipped automatically.",
      batchStep1: "1. Select Term & College (Program)",
      batchStep2: "2. Select Materials & Configure Classes / Lessons",
      batchFilterPh: "Search materials (e.g. BPG401, برمجة 1)…",
      batchShowSelected: "Selected only ({n})",
      batchShowSelectedTitle: "Show only selected materials and hide unselected ones",
      batchNoSelectedYet: "No materials selected yet. Turn off “Selected only” to pick your materials.",
      batchSelectAllCourses: "Select visible",
      batchClearCourses: "Clear selection",
      batchNoCollege: "Select a Term and College above to load all available materials.",
      batchLoadingCourses: "Loading materials for this college…",
      batchLoadingMeta: "Loading tutors & classes…",
      batchLoadingSessions: "Loading lessons…",
      batchSelectTutorClass: "Select Tutor & Class to view lessons",
      batchLessons: "Lessons",
      batchAllLessons: "All ({n})",
      batchNewOnly: "Unsaved only",
      batchNoneLessons: "None",
      batchLessonNum: "Lesson {n}",
      batchSavedBadge: "✓ Saved",
      batchSummary: "{c} material(s) · {l} lesson(s) selected ({s} already saved, {d} to download)",
      batchStartBtn: "Download Selected Lectures Safely",
      batchStopBtn: "Stop Queue",
      batchRefreshBtn: "Refresh / Check New",
      batchSafeNote: "🛡 Safe Anti-Ban Mode: Downloads sequentially with polite delays to protect your connection.",
      batchQueuePrep: "Preparing lesson {i} of {n}: {course} (Lesson {s})…",
      batchQueueDl: "Downloading [{i}/{n}] {name}…",
      batchQueueSkip: "Skipped (already in library): {name}",
      batchQueueWait: "Polite safety pause before next lecture ({i}/{n})…",
      batchQueueDone: "✓ Batch complete! Downloaded {d} new lecture(s), skipped {s} already saved.",
      batchOpenLib: "Open Student Library",
      libTitle: "Student Lecture Library",
      libSearchPh: "Search by material, college, lesson, tutor, class, or date…",
      libGroupLbl: "Group:",
      libGroupCourse: "By Material",
      libGroupCollege: "By College",
      libGroupTerm: "By Term",
      libGroupNone: "Flat List",
      libSortLbl: "Sort:",
      libSortLessonAsc: "Lesson (1 → 12)",
      libSortLessonDesc: "Lesson (12 → 1)",
      libSortDateDesc: "Date (Newest)",
      libSortDateAsc: "Date (Oldest)",
      libSortSaved: "Recently Added",
      libFilterAll: "All",
      libFilterUnwatched: "Unwatched",
      libFilterWatched: "Watched ✓",
      libWatched: "Watched ✓",
      libUnwatched: "Unwatched",
      libMarkWatched: "Toggle watched / unwatched status",
      libCheckNewBtn: "Check for new lectures",
      libCheckingNew: "Checking your materials for new lectures on SVU server…",
      libUpToDate: "✓ All your saved materials are up to date! No new lectures found.",
      libFoundNew: "Found {n} new lecture(s) across your materials!",
      libDownloadNewNow: "Download {n} New Lecture(s) Now",
      libStatsSummary: "{total} Lectures · {courses} Materials · {watched}/{total} Watched",
      libCourseProgress: "{w}/{t} watched",
      libNoMatch: "No lectures match your current search or filter.",
      localSaveTitle: "Save Local Recording to App Storage?",
      localSaveSub: "Choose how you want to store this local .lrec file inside your active profile's Student Library:",
      localSaveMergeT: "Auto-Merge into Material Group (Recommended)",
      localSaveMergeD: "Uses filename tags (College, Material, Class, Term, Lesson, Date) to sort this lecture into its Material window automatically, just like a downloaded lecture.",
      localSaveSeparateT: "Save in Separate “Local Files” Group",
      localSaveSeparateD: "Saves a copy in internal storage inside a dedicated “Local Files” window, separate from university course folders.",
      localSavePlayOnlyT: "Play Only (Do Not Save)",
      localSavePlayOnlyD: "Plays the recording right now without storing a copy in internal storage.",
      localFilesGroup: "Local Files (Separate)",
      profileBtnTitle: "Profiles & Course Presets Manager",
      profileModalTitle: "Student Profiles & Isolated Storage",
      profileModalSub: "Create independent profiles — each with its own isolated library storage, theme, language, mode, and pre-configured materials ready to load into Batch Download.",
      profileActiveBadge: "Active Profile",
      profileSwitchBtn: "Activate Profile",
      profileLoadBatchBtn: "Load into Batch Download",
      profileEditBtn: "Edit",
      profileDeleteBtn: "Delete",
      profileNewBtn: "+ New Profile",
      profileConfirmDel: "Delete profile “{name}” and its settings?",
      profileFormNewTitle: "Create New Profile",
      profileFormEditTitle: "Edit Profile",
      profileNameLbl: "Profile Name",
      profileNamePh: "e.g. ITE — F25 (My Courses)",
      profileThemeLbl: "Theme",
      profileModeLbl: "Appearance",
      profileModeDark: "Dark Mode",
      profileModeLight: "Light Mode",
      profileLangLbl: "Language",
      profileTermLbl: "Term (select or type)",
      profileProgramLbl: "College / Program (select or type)",
      profileMatSectionTitle: "Profile Materials & Class Details",
      profileMatAddRow: "+ Add Material Row",
      profileMatCoursePh: "Material (e.g. BMA401)",
      profileMatTutorPh: "Tutor (optional, e.g. t_laldroubi)",
      profileMatClassPh: "Class (e.g. C23)",
      profileMatLessonsPh: "Lessons (ALL, UNSAVED, or 1,2,3)",
      profileMatTextLbl: "Or Type / Paste Materials Directly (Quick Text Box):",
      profileMatTextHint: "Format per line: MATERIAL | CLASS | TUTOR | LESSONS  (e.g. BMA401 | C23 | t_laldroubi | ALL  or simply  BPG401 C15)",
      profileMatSyncFromText: "Parse Text into Rows ↑",
      profileMatSyncToText: "Sync Rows to Text ↓",
      profileSaveBtn: "Save Profile",
      profileSaveAndLoadBtn: "Save & Open in Batch Download",
      profileCancelBtn: "Cancel",
      profileDefaultName: "Profile",
      githubBtnTitle: "GitHub Repository (Source Code)",
      serverStep1Title: "1. Install Python (if needed)",
      serverStep1Text: "Download Python 3 from python.org. On Windows, make sure to check 'Add python.exe to PATH' during installation.",
      serverStep2Title: "2. Clone or Download Repository",
      serverStep2Text: "Clone via Git or download & extract the ZIP file from GitHub:",
      serverStep3Title: "3. Open Folder & Run Server",
      serverStep3Text: "Open your terminal in the svu-player folder and start the local server:",
      serverStep4Title: "4. Open Browser",
      serverStep4Text: "Visit http://localhost:8080/ to explore and download university sessions without limits.",
      scPlay: "Play / Pause",
      scSeek: "Seek",
      scMute: "Mute",
      scFs: "Fullscreen",
      scChat: "Chat",
      langSwitch: "Switch to Arabic",
      mobileMenuTitle: "Quick Menu",
      appearance: "Appearance & Themes",
      moreOptions: "More options",
      touchHintTap: "Tap for controls",
      touchHintDouble: "Double-tap ±10s",
      touchHintRotate: "Rotate for Cinema",
      cinemaExit: "Exit Cinema",
      activeProfileHeader: "Active Student Profile",
      manageProfilesBtn: "Manage",
      installAppPwa: "Install App (PWA)",
      touchHintGesture: "👆 Tap: controls · ✌️ Double-tap: ±10s · 📱 Rotate: Cinema",
      jumpLatest: "Jump to latest ↓",
      courseDirBtn: "Course Directory",
      courseDirBtnTitle: "Browse all 1,163 SVU course codes & titles",
      courseDirTitle: "SVU Course Directory",
      courseDirectoryTitle: "SVU Course Directory",
      courseDirSub: "Instant search across all 1,163 Syrian Virtual University course codes, official Arabic titles, and English names.",
      courseDirSearchPh: "Search by course code, Arabic name, or English name (e.g. BPG401, برمجة, Math)…",
      courseDirAllFaculties: "All Faculties",
      courseDirCopyCode: "Copy Code",
      courseDirCopied: "Copied!",
      courseDirFindInLib: "Find in Library",
      courseDirSavedCount: "Saved ({n})",
      courseDirBrowseDownload: "Browse & Download",
      courseDirBatchSelect: "Batch Downloader",
      rememberProgram: "Remember my program",
      courseDirCountSummary: "Showing {n} of {total} courses",
      courseDirNoMatch: "No courses found matching your search.",
      exportLrec: "Save .lrec to Disk",
      exportLrecSuccess: "Recording saved to disk",
      dropdownSearchPh: "Search or filter options…",
      dropdownNoMatch: "No matching options found",
      demoSessionBtn: "Try Demo Lecture",
      demoLoading: "Loading demo lecture…",
      etaLabel: "ETA: {t}",
      etaSeconds: "{s}s",
      etaMinutes: "{m}m {s}s",
      enhanceTitleActive: "Enhance is ON (4-Stage Vocal DSP active)",
      profBackupScopeHint: "Settings, study history, queue & recordings",
      slide1Callout: "Press H to hide controls and cursor for a clean cinema view; move mouse or press any key to show.",
      slide3Callout: "Press C to quickly open the synchronized student chat drawer.",
      chatDemoAuthor1: "Ahmed Salama",
      chatDemoMsg1: "Doctor, is this slide included in the exam?",
      chatDemoAuthor2: "Sara Al-Ali",
      chatDemoMsg2: "Could you please re-explain the last step?",
      chatDemoJumpHint: "Click to seek video directly to 11:05",
      chatDemoAuthor3: "Instructor",
      chatDemoMsg3: "Yes, we will cover this practical example now.",
      dspStage1Title: "Noise Gate",
      dspStage1Desc: "Suppresses background hiss and whispers during speech pauses",
      dspStage2Title: "High-Pass Filter",
      dspStage2Desc: "Cuts low-end room air rumble and A/C hum below 90 Hz",
      dspStage3Title: "Vocal Formant EQ",
      dspStage3Desc: "Boosts vocal clarity (1–4 kHz) for crisp teacher speech formants",
      dspStage4Title: "Fast Peak Limiter",
      dspStage4Desc: "Prevents sudden audio clipping and loud pops",
      shortcutFullscreen: "Toggle Fullscreen",
      shortcutHide: "Hide controls & cursor",
      shortcutMute: "Mute / Unmute audio"
    },
    ar: {
      openSession: "فتح جلسة",
      tagline: "مشغّل الجلسات دون اتصال للجامعة الافتراضية السورية",
      loading: "جارٍ التحميل…",
      readingFile: "جارٍ قراءة الملف…",
      scanningFile: "جارٍ فحص الملف…",
      decodingScreen: "جارٍ فك ترميز الشاشة…",
      loadingSession: "جارٍ تحميل الجلسة…",
      openFail: "تعذّر فتح هذا الملف",
      notLrec: "هذا ليس ملف جلسة مسجّلة (لم يُعثر على الترويسة)",
      seek: "شريط التقدّم",
      playPause: "تشغيل/إيقاف مؤقت (مسافة)",
      back10: "رجوع ١٠ ثوانٍ (←)",
      fwd10: "تقديم ١٠ ثوانٍ (→)",
      mute: "كتم الصوت (M)",
      volume: "مستوى الصوت",
      speed: "سرعة التشغيل",
      enhance: "تحسين الصوت",
      enhanceOn: "تحسين الصوت: مفعل",
      enhanceTitle: "تحسين الصوت (توضيح الصوت البشري وعزل الضجيج عبر ٤ مراحل)",
      themesBtn: "الثيمات",
      hideControlsTitle: "إخفاء أدوات التحكم والمؤشر (H)",
      pinControls: "تثبيت / إخفاء شريط التحكم تلقائيًا",
      hideChat: "إخفاء الدردشة",
      metaCollege: "الكلية",
      metaMaterial: "المادة",
      metaClass: "الشعبة",
      metaTerm: "الفصل",
      metaLesson: "الجلسة",
      metaDate: "التاريخ",
      cc: "ترجمة",
      ccTitle: "ترجمة نصية (تلقائية)",
      stretch: "تكبير",
      stretchTitle: "تكبير العرض ليملأ المساحة المتاحة (S)",
      chat: "الدردشة",
      chatTitle: "إظهار/إخفاء الدردشة (C)",
      fullscreen: "ملء الشاشة (F)",
      showAll: "عرض الكل",
      chatLiveSync: "مزامنة حية",
      chatAllMessages: "جميع الرسائل ({n})",
      chatEmptyAtStart: "ستظهر رسائل الطلاب تباعاً مع تقدم المحاضرة، أو انقر 'جميع الرسائل' للاطلاع على أسئلة الطلاب والقفز لتوقيتها فوراً.",
      chatEmpty: "افتح جلسة لعرض الدردشة.",
      chatNone: "لا توجد رسائل دردشة في هذه الجلسة.",
      tabFile: "فتح ملف",
      tabRemote: "جلسات الجامعة",
      tabLink: "رابط مباشر",
      tabSaved: "المحفوظة دون اتصال",
      linkTitle: "التنزيل من رابط تسجيل مباشر",
      linkSub: "الصق رابط .lrec مباشر من sessions.svuonline.org لتنزيله وتشغيله فورًا.",
      dropHeroTitle: "جاهز لمشاهدة جلسة",
      dropHeroSub: "تصفّح دليل جلسات الجامعة، أو الصق رابطًا مباشرًا، أو أفلت ملف .lrec هنا.",
      browseSessions: "تصفّح الجلسات",
      installPwa: "تثبيت",
      installPwaShort: "تثبيت",
      installPwaTitle: "تثبيت مشغّل SVU كتطبيق يعمل دون اتصال (PWA)",
      pwaInstalled: "المشغّل مثبّت دون اتصال ✓",
      themeMenuTitle: "اختر الثيم",
      modeToggleTitle: "تبديل الوضع الداكن / الفاتح",
    modeDark: "الوضع الداكن",
    modeLight: "الوضع الفاتح",
    themeSubtitle: "السمات اللونية",
      themeDefault: "الافتراضي",
      themeWhatsapp: "واتساب",
      themeTelegram: "تيليغرام",
      themeWin98: "ويندوز 98",
      themeWinxp: "ويندوز XP",
      themeWin7: "ويندوز 7",
      themeHacker: "هاكر",
      themeVscode: "VS Code",
      themeTerminal: "الطرفية",
      close: "إغلاق",
      dropTitle: "أفلت ملف ⁦.lrec⁩ هنا",
      dropSub: "أو انقر لاختيار ملف من جهازك",
      noServer: "تعذّر الوصول إلى الجلسات البعيدة حاليًا. لتصفّح جلسات الجامعة عبر الإنترنت، شغّل الخادم المحلي عبر الأمر `python3 serve.py`. ما زالت التسجيلات المحفوظة تعمل دون اتصال.",
      lblTerm: "الفصل",
      lblProgram: "البرنامج",
      lblCourse: "المقرر",
      lblTutor: "المدرّس",
      lblClass: "الشعبة",
      lblSession: "الجلسة",
      selTerm: "اختر الفصل",
      selProgram: "اختر البرنامج",
      selCourse: "اختر المقرر",
      selTutor: "اختر المدرّس",
      selClass: "اختر الشعبة",
      selSession: "اختر الجلسة",
      sessions: "الجلسات",
      recordings: "التسجيلات",
      keep: "احتفظ بنسخة على هذا الجهاز للتشغيل دون اتصال",
      cancel: "إلغاء",
      downloadPlay: "تنزيل وتشغيل",
      playSaved: "تشغيل (محفوظ)",
      play: "تشغيل",
      del: "حذف",
      stLoading: "جارٍ التحميل…",
      stNothing: "لا يوجد شيء لهذا الاختيار.",
      stCouldNotLoad: "تعذّر التحميل: {e}",
      stChooseSession: "اختر جلسة.",
      stLoadingFiles: "جارٍ تحميل الملفات…",
      stFilesFail: "تعذّر تحميل الملفات: {e}",
      noSessions: "لا توجد جلسات لهذه الشعبة.",
      noFiles: "لا يوجد تسجيل لهذه الجلسة على موقع الجامعة.",
      dlStarting: "جارٍ البدء…",
      dlSaving: "جارٍ الحفظ على هذا الجهاز…",
      dlSaveFail: "تم التنزيل لكن تعذّر الحفظ للاستخدام دون اتصال: {e}",
      dlCancelled: "أُلغي التنزيل.",
      dlFailed: "فشل التنزيل: {e}",
      stTerms: "جارٍ تحميل الفصول…",
      stOfflineMode: "أو الصق رابط .lrec مباشر من svuonline.org:",
      savedNone: "لا يوجد شيء محفوظ بعد. نزّل تسجيلًا من تبويب «جلسات الجامعة» وسيظهر هنا جاهزًا للتشغيل دون اتصال.",
      savedUnavailable: "التخزين دون اتصال غير متاح في هذا المتصفح.",
      savedReadFail: "تعذّرت قراءة المكتبة: {e}",
      confirmDelete: "حذف «{name}» من هذا الجهاز؟",
      usage: "التخزين المحلي: تم استخدام {used} ({free} مساحة شاغرة — تتسع لنحو {count} محاضرة إضافية)",
      ccWorking: "جارٍ التفريغ {p}٪…",
      ccNone: "لم يُعثر على كلام.",
      ccNotSet: "الترجمة النصية معطّلة في الوضع المحلي.",
      ccFail: "فشلت الترجمة النصية: {e}",
      enhWorking: "جارٍ تحسين الصوت…",
      enhProgress: "جارٍ تحسين الصوت {p}٪…",
      enhFail: "فشل تحسين الصوت: {e}",
      version: "الإصدار",
      reloadLatest: "تحديث",
      reloadLatestTitle: "مسح النسخة المخزّنة من التطبيق وتحميل أحدث إصدار (تبقى الجلسات المحفوظة)",
      updateAvail: "يتوفر إصدار جديد.",
      updateNow: "حدّث الآن",
      later: "لاحقًا",
      videoFail: "تعذّر على هذا الجهاز فك ترميز فيديو الشاشة. الصوت والدردشة يعملان.",
      tour: "دليل المساعدة",
      welcomeTitle: "مرحبًا بك في استوديو مشغّل SVU",
      welcomeSub: "شغّل محاضرات الجامعة المسجّلة مع الشاشة والصوت المحسّن والدردشة المتزامنة — محليًا ١٠٠٪ ودون اتصال:",
      welcomeStart: "ابدأ الاستخدام",
      shortcuts: "الاختصارات: مسافة تشغيل/إيقاف · ← → تخطّي ٥ ثوانٍ · J/L تخطّي ١٠ ثوانٍ · M كتم · F ملء الشاشة · C الدردشة · S تكبير",
      wMetaT: "بطاقات معلومات الجلسة",
      wMetaD: "تستخرج الكلية والمادة والشعبة والفصل والجلسة والتاريخ تلقائيًا في الشريط العلوي",
      wOpenT: "فتح جلسة وتثبيت المشغّل",
      wOpenD: "تصفّح دليل الجامعة، أو الصق رابطًا مباشرًا، أو افتح ملفًا محليًا، أو ثبّت التطبيق دون اتصال",
      wThemesT: "الثيمات والوضع واللغة",
      wThemesD: "اختر من ٩ ثيمات، وبدّل بين الوضع الداكن/الفاتح والعربية/الإنجليزية مع حفظ تلقائي",
      wScreenT: "الشاشة المشتركة",
      wScreenD: "عرض متزامن عالي الدقة لشرائح المحاضرة ولوح الشرح",
      wSeekT: "الشريط الزمني التفاعلي",
      wSeekD: "اسحب للانتقال لأي ثانية؛ العلامات البيضاء توضّح مواضع رسائل الدردشة",
      wPlayT: "التشغيل والتخطّي ±١٠ث",
      wPlayD: "تشغيل/إيقاف مؤقت مع أزرار الرجوع والتقديم السريع ١٠ ثوانٍ",
      wChatHeadT: "عرض الكل وإغلاق الدردشة (✕)",
      wChatHeadD: "اعرض جميع رسائل المحاضرة مسبقًا أو أغلق لوحة الدردشة من زر ✕ العلوي",
      wChatT: "الدردشة المتزامنة",
      wChatD: "تظهر الرسائل بوقتها الفعلي مع شريط تمرير؛ انقر على أي وقت ▶ للانتقال إليه",
      wPinT: "ملء الشاشة وتثبيت الشريط",
      wPinD: "شاهد بوضع ملء الشاشة (F) أو ثبّت شريط التحكم الزجاجي العائم",
      wEnhT: "تحسين الصوت (٤ مراحل)",
      wEnhD: "توضيح الصوت البشري وإزالة الضجيج والهمهمة محليًا فور التفعيل",
      wVolT: "الصوت والكتم والسرعة",
      wVolD: "كتم/إلغاء كتم، ضبط مستوى الصوت، وتغيير سرعة التشغيل (من 0.75× إلى 2×)",
      wStrT: "تكبير العرض وزر الدردشة",
      wStrD: "تكبير الشاشة لملء المساحة (S) أو إظهار/إخفاء لوحة الدردشة (C)",
      aboutTitle: "حول مشغّل SVU",
      aboutDev: "مشغّل SVU — إصدار الاستوديو",
      aboutSub: "مشغّل جلسات محلي عالي الأداء يعمل دون اتصال لتشغيل محاضرات الجامعة الافتراضية السورية (.lrec).",
      aboutBadgeOffline: "يعمل محليًا ودون اتصال ١٠٠٪",
      aboutBadgePrivacy: "خصوصية كاملة بدون تتبّع",
      aboutFeat1T: "مفكّك ترميز WASM وتحسين صوتي رباعي",
      aboutFeat1D: "فك ترميز سريع للشاشة والصوت مع معالج صوتي من ٤ مراحل (مرشّح الترددات المنخفضة، تعزيز وضوح الصوت البشري +5.5 dB، بوابة عزل الضجيج، وضاغط ديناميكي).",
      aboutFeat2T: "٩ ثيمات احترافية وتحليل ذكي للملفات",
      aboutFeat2D: "٩ ثيمات متكاملة (الافتراضي، واتساب، تيليغرام، ويندوز 98/XP/7، هاكر، VS Code، الطرفية) مع الوضع الداكن والفاتح واستخراج بيانات الجلسة تلقائيًا.",
      aboutFeat3T: "مكتبة محفوظات محلية وتطبيق PWA",
      aboutFeat3D: "احفظ الجلسات مباشرة في متصفحك عبر IndexedDB وثبّت المشغّل كتطبيق مستقل يعمل دون إنترنت.",
      aboutPwaTitle: "النشر الكامل دون اتصال (تطبيق PWA)",
      aboutPwaSub: "ثبّت مشغّل SVU على جهازك أو هاتفك ليفتح كتطبيق مستقل ويعمل دون اتصال ١٠٠٪ لتشغيل ملفات .lrec المحلية والجلسات المحفوظة.",
      aboutPwaHint: "إذا لم تظهر نافذة التثبيت التلقائية، انقر على أيقونة تثبيت التطبيق (⊕) في شريط عنوان المتصفح.",
      aboutServerTitle: "تشغيل الخادم المحلي (لتصفّح دليل الجامعة والتنزيل عبر الإنترنت)",
      aboutServerSub: "لتصفّح دليل جلسات الجامعة وتنزيل ملفات .lrec مباشرة من sessions.svuonline.org، شغّل الخادم المحلي في مجلد المشروع بالأمر التالي:",
      copyCmd: "نسخ",
      copiedCmd: "تم النسخ!",
      tabBatch: "تنزيل المواد (دفعة واحدة)",
      studentLibBtn: "مكتبة الطالب",
      hubResumeTitle: "استئناف المشاهدة",
      hubResumeBtn: "متابعة",
      hubBatchSub: "اختر كليتك وفصلك ونزّل محاضراتك بضغطة واحدة",
      hubLibSub: "المحاضرات المحفوظة محليًا للتشغيل دون إنترنت",
      hubBrowseSub: "تصفّح دليل المحاضرات مباشرة من موقع الجامعة",
      hubFileSub: "تشغيل أي ملف .lrec مسجل على هاتفك أو حاسوبك",
      hubRecentTitle: "المحاضرات المحفوظة على هذا الجهاز",
      hubViewAllSaved: "عرض الكل في المكتبة ←",
      exitSession: "خروج من الجلسة",
      exitSessionTitle: "العودة إلى لوحة الطالب",
      backToHub: "الرئيسية",
    backToHome: "العودة للرئيسية",
      profExportModalTitle: "تصدير نسخة احتياطية للبروفايل",
      profExportSelectItems: "حدد البيانات المراد تضمينها في ملف النسخة الاحتياطية:",
      profExportOptSettings: "إعدادات وتفضيلات البروفايل",
      profExportOptSettingsDesc: "الاسم، السمة، المظهر، اللغة، والمقررات والشعب المحددة مسبقاً.",
      profExportOptHistory: "سجل المشاهدة والمحاضرات المنتهية",
      profExportOptHistoryDesc: "علامات إتمام المحاضرات (✓) وتاريخ مشاهدتها.",
      profExportOptBatch: "حالة التنزيل والمفضلات",
      profExportOptBatchDesc: "بيانات المواد المحددة في التنزيل المجمّع وقائمة الانتظار.",
      profExportOptVideos: "المحاضرات وملفات الفيديو المحفوظة أوفلاين (.lrec)",
      profExportOptVideosDesc: "تضمين جميع فيديوهات وملفات المحاضرات المحفوظة محلياً داخل ملف النسخة لنقلها لجهاز آخر.",
      profExportLecOne: "محاضرة",
      profExportLecMany: "محاضرة",
      profBackupFileName: "اسم ملف التصدير التلقائي:",
      profExportStatusPreparing: "جارٍ تجهيز ملف النسخة الاحتياطية...",
      profExportStatusPacking: "جارٍ تجميع محاضرة {current} من {total} ({name})...",
      profExportStatusGenerating: "جارٍ إنشاء وتنزيل ملف النسخة الاحتياطية...",
      profExportStatusDone: "اكتمل التصدير بنجاح!",
      profExportStartBtn: "بدء تصدير النسخة الاحتياطية",
      profExportBtnShort: "تصدير نسخة",
      profExportTooltip: "تصدير نسخة احتياطية من هذا البروفايل",
      profExportSuccess: "تم تصدير النسخة الاحتياطية للبروفايل بنجاح!\nالملف: {filename}",
      profExportError: "فشل تصدير البروفايل",

      profImportBtn: "استيراد نسخة",
      profImportBtnShort: "استيراد نسخة",
      profImportModalTitle: "استيراد نسخة بروفايل احتياطية",
      profImportDestTitle: "طريقة استيراد البيانات:",
      profImportDestNew: "إنشاء كبروفايل جديد ومستقل",
      profImportDestNewDesc: "سيتم إنشاء بروفايل إضافي جديد مع ذاكرة تخزين ومكتبة منفصلة دون التأثير على بروفايلاتك الحالية.",
      profImportDestMerge: "الكتابة فوق / دمج مع البروفايل الحالي النشط",
      profImportDestMergeDesc: "سيتم دمج المحاضرات وتحديث إعدادات البروفايل النشط حالياً دون مسح الموجود.",
      profImportSelectItems: "العناصر المراد استعادتها:",
      profImportMetaSub: "تاريخ التصدير: {date} · النسخة: {ver}",
      profImportStatusPreparing: "جارٍ تجهيز استيراد البيانات...",
      profImportStatusWriting: "جارٍ حفظ محاضرة {current} من {total} ({name})...",
      profImportStatusDone: "اكتمل الاستيراد بنجاح!",
      profImportStartBtn: "بدء الاستيراد",
      profImportInvalidFile: "ملف النسخة الاحتياطية غير صالح أو تالف.",
      profImportSuccess: "تم استيراد البروفايل بنجاح!",
      profImportError: "فشل استيراد البروفايل",
      profileImportedDefaultName: "بروفايل مستورد",
      introBadge: "استوديو مشغّل SVU",
      introTitle: "مشغّل ومكتبة محاضرات الجامعة الافتراضية السورية",
      introDesc: "مشاهدة وتنزيل محاضرات الجامعة الافتراضية السورية للدراسة دون إنترنت — مع معزز نقاء الصوت التلقائي، ومزامنة الشرائح، والتنقل الفوري عبر أسئلة الطلاب.",
      introFeat1: "معزز نقاء الصوت التلقائي وعزل الضجيج",
      introFeat2: "دردشة متزامنة بالثواني مع إمكانية القفز للأسئلة",
      introFeat3: "تنزيل تسلسلي آمن للمقررات وحفظها محلياً دون إنترنت",
guideModalTitle: "دليل استخدام مشغّل SVU",
    guideHeading: "دليلك السريع للاستفادة الكاملة من مميزات المشغّل",
    guideSub: "كل ما تحتاجه لتشغيل المحاضرات، توضيح الصوت، والوصول السريع للمحتوى على هاتفك أو حاسوبك:",
    guideTouchTitle: "📱 إيماءات اللمس السريعة",
    guideTouchDesc: "نقرة واحدة لإظهار أو إخفاء عناصر التحكم · نقرة مزدوجة على اليمين أو اليسار للتقديم والترجيع ±١٠ ثوانٍ · تدوير الهاتف يفعّل وضع السينما العريض.",
    guideDspTitle: "🎙️ فلتر ٤ مراحل لتوضيح صوت المدرس",
    guideDspDesc: "زر Enhance في شريط التحكم يشغّل معالج صوت WebAssembly: عزل الضجيج والصفير، قص هواء القاعة، وتضخيم ترددات الصوت البشري لتسمع الشرح بنقاء فائق.",
    guideChatTitle: "💬 الدردشة المتزامنة والقفز للأسئلة",
    guideChatDesc: "أسئلة الطلاب تظهر في نفس لحظة طرحها أثناء المحاضرة. اضغط على أي رسالة أو توقيت زمني للقفز بالفيديو مباشرة لتلك اللحظة في الشرح.",
    guideBatchTitle: "⚡ التنزيل المجمّع والحفظ محلياً",
    guideBatchDesc: "اختر كليتك وفصلك ونزل كامل محاضرات المقرر دفعة واحدة بمعدل آمن يمنع حظر الحساب. تُحفظ المحاضرات محلياً (IndexedDB) وتشاهدها ١٠٠٪ دون إنترنت.",
    guideKbdTitle: "⌨️ اختصارات لوحة المفاتيح (للأجهزة اللوحية والحاسوب)",
    guideKbdDesc: "المسافة: تشغيل/إيقاف مؤقت · ← →: تقديم/ترجيع ٥ ثوانٍ · M: كتم الصوت · F: ملء الشاشة · C: إظهار الدردشة · S: تمديد الشاشة",
    welcomeStartBtn: "فهمت، لنبدأ الاستخدام",
    guideBtnHub: "العودة للرئيسية وإغلاق الجلسة",
    guideBtnPlay: "تشغيل أو إيقاف المحاضرة (مسطرة Space)",
    guideBtnSeek: "تقديم أو ترجيع 10 ثوانٍ (الأسهم ← →)",
    guideBtnEnh: "فلتر تنقية الصوت وعزل الصفير وهواء القاعة",
    guideBtnSpeed: "تسريع أو إبطاء صوت المحاضرة (0.75× - 2×)",
    guideBtnChat: "إظهار أو إخفاء محادثات الطلاب المتزامنة (C)",
    guideBtnStretch: "تمديد وتوسيع الشريحة لملء الشاشة (S)",
    guideBtnPin: "تثبيت شريط التحكم مفتوحاً دوماً دون إخفاء",
    guideTryDemoAction: "▶ تجربة أدوات التحكم في محاضرة نموذجية ←",
    guideHubBatchHint: "اختر كليتك وفصلك ونزل كامل محاضرات المادة بضغطة واحدة وبمعدل آمن يمنع حظر حسابك.",
    guideHubLibHint: "استعرض جميع المحاضرات المحفوظة محلياً، مع إمكانية تعليم المحاضرات المشاهدة (✓) أو حذفها لتفريغ الذاكرة.",
    guideHubDirHint: "تصفح البرامج الدراسية وسلاسل الـ LMS والبحث السريع في أكثر من 1,160 مادة جامعية معتمدة.",
    courseDirBadge: "تصفح شامل",
    remoteTabTitle: "جلسات ومحاضرات الجامعة (SVU)",
    remoteTabSub: "استعراض الدليل المباشر للجامعة الافتراضية السورية وتصفّح المحاضرات حسب الفصل، البرنامج، المادة، والمدرس للتشغيل الفوري أو الحفظ أوفلاين.",
    savedTabTitle: "مكتبة الطالب للمحاضرات المحفوظة أوفلاين",
    savedTabSub: "استعراض وإدارة جميع محاضراتك المحفوظة محلياً على هذا الجهاز للتشغيل ١٠٠٪ دون إنترنت، مع إمكانية تمييز المحاضرات المنتهية أو تفريغ المساحة.",
    fileTabTitle: "تشغيل ملف محلي من جهازك (.lrec)",
    fileTabSub: "اختر أو اسحب أي ملف محاضرة (.lrec) مسجل على هاتفك أو حاسوبك لتشغيله فوراً وبأعلى نقاء صوتي ودردشة متزامنة دون اتصال بالإنترنت.",
    statCourses: "مقرر",
    statLessons: "محاضرة محددة",
    statSaved: "محفوظة",
    statToDl: "جاهزة للتنزيل",
    guideBtnDescAll: "زر Hub للعودة للرئيسية وإغلاق الجلسة · زر Play للتشغيل والإيقاف · زرا ±10s للقفز السريع · زر Speed للتحكم بالسرعة حتى 2× · وزر Fullscreen لملء الشاشة.",
    slide1Tag: "بدء جلسة المذاكرة",
    slide1Title: "٤ طرق لتشغيل وحفظ محاضرات الجامعة الافتراضية",
    slide1Desc: "سواء أردت تشغيل محاضرة واحدة مباشرة، تنزيل مقرر كامل بأمان، المشاهدة دون إنترنت، أو فتح ملف جاهز على جهازك:",
    slide2Tag: "شريط تحكم المشغّل",
    slide2Title: "كل أدوات التحكم بالصوت، الفيديو، والتنقل وضبط العرض",
    slide2Desc: "شريط تحكم سفلي مدمج يمنحك سرعة الوصول لجميع الوظائف: زر Hub للعودة لشاشة الطالب، تسريع الصوت، تنقية الشرح، والتنقل الدقيق بالثواني.",
    slide3Tag: "الدردشة والقفز الذكي",
    slide3Title: "تزامن حي لأسئلة الطلاب مع قفز فوري بالفيديو",
    slide3Desc: "تتدفق رسائل الطلاب بالثانية تزامناً مع كلام المدرس. اضغط على أي رسالة أو توقيتها الزمني للانتقال بالفيديو فوراً لتلك اللحظة في الشرح!",
    slide4Tag: "وضوح ونقاء الشرح",
    slide4Title: "توضيح صوت الدكتور بأعلى نقاء بضغطة زر",
    slide4Desc: "هل تعاني من انخفاض صوت الدكتور، صدى القاعة، أو أزيز المايك؟ اضغط زر Enhance في شريط التحكم لتصفية نبرة الصوت فوراً وسماع الشرح بنقاء مريح للمذاكرة.",
    slide5Tag: "التحكم بالاختصارات والإيماءات",
    slide5Title: "تحكم مرن وسريع عبر اللمس أو لوحة المفاتيح",
    slide5Desc: "إيماءات نقر سريعة على جانبي الشاشة للتنقل، وتدوير الهاتف يفصل الشاشة بين الشريحة والدردشة جنباً إلى جنب دون أن تحجب الدردشة محتوى المحاضرة.",
    slide6Tag: "الأسئلة الشائعة والحلول",
    slide6Title: "أهم الأسئلة الشائعة والحلول السريعة للطلاب",
    slide6Desc: "إجابات مباشرة على أكثر استفسارات الطلاب تكراراً حول التنزيل، ذاكرة المتصفح، والنسخ الاحتياطي:",
    guideStudioBadge: "دليل الاستوديو المكتبي",
    guideNavTitle: "أبواب الدليل",
    guideNavSubtitle: "اختر قسماً للاطلاع على تفاصيله",
    slide1Nav: "طرق تشغيل وتنزيل المحاضرات",
    slide1NavSub: "٤ طرق لبدء المشاهدة",
    slide2Nav: "شريط التحكم والمشغّل",
    slide2NavSub: "التشغيل، السرعة، والتحكم",
    slide3Nav: "الدردشة والقفز الذكي",
    slide3NavSub: "التزامن الفوري مع الفيديو",
    slide4Nav: "معالج تنقية الصوت (DSP)",
    slide4NavSub: "وضوح الصوت وعزل الضجيج",
    slide5Nav: "الاختصارات والإيماءات",
    slide5NavSub: "جدول التحكم بالكيبورد واللمس",
    slide6Nav: "الأسئلة الشائعة والحلول",
    slide6NavSub: "التنزيل، الذاكرة، والنسخ",
    guideProTipTitle: "نصيحة للمذاكرة الأكاديمية",
    guideProTipDesc: "المحاضرات المحفوظة في مكتبتك تعمل أوفلاين ١٠٠٪ دون أي اتصال بالإنترنت مع حفظ توقيت آخر دقيقة شاهدتها تلقائياً.",
    guidePrevSection: "السابق",
    guideNextSection: "التالي",
    guideFootNavHint: "للتنقل بين الأقسام",
    guideFootCloseHint: "للإغلاق",
    guideSyriaNote: "مصمم لظروف الشبكة في سوريا: جميع الملفات المحفوظة تخزن بأمان محلياً (IndexedDB) وتعمل بكفاءة كاملة دون استهلاك أي رصيد بيانات.",
    guideDspWhen: "متى تستخدم فلتر الصوت؟ فعّله في المحاضرات ذات التسجيل الضعيف أو صدى القاعة لرفع وضوح مخارج الحروف فوراً.",
    guideWayBrowseTitle: "جلسات الجامعة (SVU sessions)",
    guideWayBrowseSub: "تشغيل مباشر أو حفظ محاضرة واحدة أونلاين",
    guideWayBrowseDesc: "اختر الفصل (TERM) ← البرنامج (PROGRAM) ← المادة (COURSE) ← المدرس (TUTOR) ← الشعبة (CLASS) ← الجلسة (SESSION).",
    guideWayBrowseBtn: "فتح جلسات الجامعة ←",
    guideWayBatchTitle: "تنزيل المواد (Batch download)",
    guideWayBatchSub: "تنزيل مقرر كامل دفعة واحدة بمعدل آمن",
    guideWayBatchDesc: "اختر TERM و PROGRAM، اضغط على المادة لعرض المدرس والشعبة، حدد المحاضرات المطلوبة، ثم اضغط تنزيل بأمان.",
    guideWayBatchBtn: "فتح التنزيل المجمّع ←",
    guideWayLibTitle: "مكتبة الطالب (Student library)",
    guideWayLibSub: "مشاهدة المحاضرات المحفوظة ١٠٠٪ دون إنترنت",
    guideWayLibDesc: "استعرض جميع تسجيلاتك المحفوظة دون استهلاك إنترنت، صفِّ حسب المحاضرات المشاهدة ✓، أو تحقق من توفر محاضرات جديدة.",
    guideWayLibBtn: "فتح مكتبة الطالب ←",
    guideWayFileTitle: "فتح ملف / التجربة الفورية",
    guideWayFileSub: "تشغيل ملف .lrec محلي أو تجربة المشغل",
    guideWayFileDesc: "لديك ملف محاضرة .lrec من التيليجرام أو LMS؟ افتحه فوراً، أو جرّب المحاضرة النموذجية لاختبار مزايا المشغل الآن.",
    guideWayFileBtn: "فتح ملف ←",
    guideWayDemoBtn: "تجربة محاضرة نموذجية ←",
    guideChatShowAllTip: "نصيحة: تظهر رسائل الدردشة تدريجياً تزامناً مع تقدم وقت المحاضرة. لتصفح جميع أسئلة الطلاب من أول دقيقة، فعّل خيار إظهار الكل (Show all) في أعلى لوحة الدردشة.",
    dspUnderHoodTitle: "كيف يعمل المعالج تقنياً (٤ مراحل معالجة DSP):",
    shortcutStretch: "تمديد وتوسيع الشريحة (S)",
    guideFaq1Q: "لماذا زر «تنزيل المحاضرات المحددة بأمان» غير مفعّل (رمادي)؟",
    guideFaq1A: "في التنزيل المجمّع، يجب أولاً اختيار الفصل (TERM) والبرنامج (PROGRAM)، ثم الضغط على سطر المادة (مثل ITA320) لعرض مدرسيها وشعبها، وتحديد مربع اختيار محاضرة واحدة على الأقل. يتفعّل الزر تلقائياً فور تحديد المحاضرات.",
    guideFaq2Q: "هل يؤدي مسح بيانات المتصفح لحذف المحاضرات المحفوظة؟",
    guideFaq2A: "نعم. المحاضرات أوفلاين تُحفظ داخل ذاكرة المتصفح (IndexedDB). إذا مسحت بيانات المواقع أو غيّرت جهازك فستُحذف. قبل مسح البيانات، افتح القائمة السريعة (☰) واضغط تصدير نسخة (Export Backup) لحفظ مقرراتك في ملف آمن على جهازك.",
    guideFaq3Q: "كيف أشغّل محاضرة باستخدام رابط مباشر من الجامعة؟",
    guideFaq3A: "لديك رابط محاضرة مباشر من الـ LMS أو البريد؟ اضغط جلسات الجامعة من الشاشة الرئيسية، ثم اختر تبويب الرابط المباشر (Direct link) في أعلى النافذة، والصق الرابط للتشغيل أو الحفظ فوراً.",
    introCollapse: "إخفاء التفاصيل ▴",
    hubCourseLectures: "{n} محاضرات",
    hubCourseWatched: "({w} تمت مشاهدتها)",
      introMiniTitle: "استوديو مشغّل SVU • تشغيل وحفظ دون إنترنت",
      introDetails: "تفاصيل",
      hubViewAllSavedCount: "عرض جميع المحاضرات ({n}) في المكتبة ←",
      hubNoSavedHint: "لم يتم حفظ أي محاضرات بعد. استخدم التنزيل المجمّع أو تصفح جلسات الجامعة للبدء.",
      batchTitle: "التنزيل الذكي لجميع محاضرات المواد",
      batchSub: "اختر الفصل والكلية، حدّد المواد التي تدرسها، واختر المدرّس والشعبة والمحاضرات (أو الكل)، ثم نزّلها بضغطة واحدة وبأمان تام. يتم تخطّي المحاضرات المحفوظة مسبقًا تلقائيًا.",
      batchStep1: "١. اختر الفصل والكلية (البرنامج)",
      batchStep2: "٢. حدّد المواد واختر الشعبة والمحاضرات لكل مادة",
      batchFilterPh: "ابحث عن مادة (مثل BPG401)…",
      batchShowSelected: "المحددة فقط ({n})",
      batchShowSelectedTitle: "عرض المواد المحددة فقط وإخفاء غير المحددة لسهولة الوصول",
      batchNoSelectedYet: "لم يتم تحديد أي مواد بعد. أوقف فلتر «المحددة فقط» لاختيار موادك.",
      batchSelectAllCourses: "تحديد الظاهر",
      batchClearCourses: "إلغاء التحديد",
      batchNoCollege: "اختر الفصل والكلية أعلاه لعرض جميع المواد المتاحة.",
      batchLoadingCourses: "جارٍ تحميل مواد هذه الكلية…",
      batchLoadingMeta: "جارٍ تحميل المدرّسين والشعب…",
      batchLoadingSessions: "جارٍ تحميل المحاضرات…",
      batchSelectTutorClass: "اختر المدرّس والشعبة لعرض المحاضرات",
      batchLessons: "المحاضرات",
      batchAllLessons: "الكل ({n})",
      batchNewOnly: "غير المحفوظة فقط",
      batchNoneLessons: "بلا",
      batchLessonNum: "المحاضرة {n}",
      batchSavedBadge: "✓ محفوظة",
      batchSummary: "{c} مواد · {l} محاضرة محددة ({s} محفوظة مسبقًا، {d} للتنزيل)",
      batchStartBtn: "تنزيل المحاضرات المحددة بأمان",
      batchStopBtn: "إيقاف الطابور",
      batchRefreshBtn: "تحديث وفحص الجديد",
      batchSafeNote: "🛡 وضع الحماية الآمن: تنزيل متسلسل بفاصل زمني آمن لمنع الحظر وحماية الاتصال.",
      batchQueuePrep: "جارٍ تحضير المحاضرة {i} من {n}: {course} (المحاضرة {s})…",
      batchQueueDl: "جارٍ تنزيل [{i}/{n}] {name}…",
      batchQueueSkip: "تم التخطّي (محفوظة مسبقًا): {name}",
      batchQueueWait: "وقفة أمان قصيرة قبل المحاضرة التالية ({i}/{n})…",
      batchQueueDone: "✓ اكتمل التنزيل! تم تنزيل {d} محاضرة جديدة، وتخطّي {s} محفوظة مسبقًا.",
      batchOpenLib: "فتح مكتبة الطالب",
      libTitle: "مكتبة محاضرات الطالب",
      libSearchPh: "ابحث بالمادة، الكلية، رقم المحاضرة، المدرّس، الشعبة أو التاريخ…",
      libGroupLbl: "تجميع:",
      libGroupCourse: "حسب المادة",
      libGroupCollege: "حسب الكلية",
      libGroupTerm: "حسب الفصل",
      libGroupNone: "قائمة مسطّحة",
      libSortLbl: "ترتيب:",
      libSortLessonAsc: "رقم المحاضرة (١ ← ١٢)",
      libSortLessonDesc: "رقم المحاضرة (١٢ ← ١)",
      libSortDateDesc: "التاريخ (الأحدث)",
      libSortDateAsc: "التاريخ (الأقدم)",
      libSortSaved: "المضافة مؤخرًا",
      libFilterAll: "الكل",
      libFilterUnwatched: "غير مشاهدة",
      libFilterWatched: "تمت مشاهدتها ✓",
      libWatched: "تمت المشاهدة ✓",
      libUnwatched: "لم تُشاهد",
      libMarkWatched: "تبديل حالة المشاهدة (مشاهدة / غير مشاهدة)",
      libCheckNewBtn: "فحص المحاضرات الجديدة",
      libCheckingNew: "جارٍ فحص موادك بحثًا عن محاضرات جديدة على خادم الجامعة…",
      libUpToDate: "✓ جميع موادك محدّثة بالكامل! لا توجد محاضرات جديدة غير منزّلة.",
      libFoundNew: "تم العثور على {n} محاضرة جديدة في موادك الدراسية!",
      libDownloadNewNow: "تنزيل المحاضرات الجديدة ({n}) الآن",
      libStatsSummary: "{total} محاضرة · {courses} مواد · تمت مشاهدة {watched} من {total}",
      libCourseProgress: "شُوهدت {w} من {t}",
      libNoMatch: "لا توجد محاضرات تطابق البحث أو التصفية الحالية.",
      localSaveTitle: "حفظ الملف المحلي في تخزين التطبيق؟",
      localSaveSub: "اختر طريقة حفظ ملف المحاضرة (.lrec) داخل مكتبة الطالب للبروفايل الحالي:",
      localSaveMergeT: "دمج تلقائي مع المادة في المكتبة (موصى به)",
      localSaveMergeD: "يستخرج بيانات الملف (الكلية، المادة، الشعبة، الفصل، رقم المحاضرة، التاريخ) من الاسم ويدمجها تلقائيًا في نافذة المادة الخاصة بها تمامًا كما لو تم تنزيلها من التطبيق.",
      localSaveSeparateT: "حفظ في نافذة «ملفات محلية» مستقلة",
      localSaveSeparateD: "يحفظ نسخة في التخزين الداخلي ضمن مجموعة مستقلة مخصّصة للملفات المحلية.",
      localSavePlayOnlyT: "تشغيل فقط (دون حفظ في التخزين)",
      localSavePlayOnlyD: "تشغيل المحاضرة الآن مباشرة دون حفظ نسخة منها في تخزين المتصفح.",
      localFilesGroup: "ملفات محلية مستقلة",
      profileBtnTitle: "إدارة البروفايلات ومجموعات المواد والتخزين المستقل",
      profileModalTitle: "البروفايلات والتخزين المستقل للطالب",
      profileModalSub: "أنشئ بروفايلات متعددة — لكل بروفايل مكتبة تخزين مستقلة تمامًا، وثيم ولغة ووضع خاص، وقائمة مواد جاهزة للتحميل الفوري في التنزيل الذكي.",
      profileActiveBadge: "البروفايل النشط ✓",
      profileSwitchBtn: "تفعيل البروفايل",
      profileLoadBatchBtn: "تحميل المواد في التنزيل الذكي",
      profileEditBtn: "تعديل",
      profileDeleteBtn: "حذف",
      profileNewBtn: "+ بروفايل جديد",
      profileConfirmDel: "هل تريد حذف البروفايل «{name}» وإعداداته؟",
      profileFormNewTitle: "إنشاء بروفايل جديد",
      profileFormEditTitle: "تعديل البروفايل",
      profileNameLbl: "اسم البروفايل",
      profileNamePh: "مثال: هندسة المعلوماتية ITE — فصل F25",
      profileThemeLbl: "الثيم",
      profileModeLbl: "المظهر",
      profileModeDark: "الوضع الداكن",
      profileModeLight: "الوضع الفاتح",
      profileLangLbl: "اللغة",
      profileTermLbl: "الفصل الدراسي (اختر أو اكتب)",
      profileProgramLbl: "الكلية / البرنامج (اختر أو اكتب)",
      profileMatSectionTitle: "مواد البروفايل وتفاصيل الشعب والمحاضرات",
      profileMatAddRow: "+ إضافة مادة",
      profileMatCoursePh: "المادة (مثل BMA401)",
      profileMatTutorPh: "المدرّس (اختياري، مثل t_laldroubi)",
      profileMatClassPh: "الشعبة (مثل C23)",
      profileMatLessonsPh: "المحاضرات (ALL أو UNSAVED أو 1,2,3)",
      profileMatTextLbl: "أو اكتب / الصق تفاصيل المواد نصيًا مباشرة (مربع النص السريع):",
      profileMatTextHint: "الصيغة لكل سطر: المادة | الشعبة | المدرّس | المحاضرات  (مثال: BMA401 | C23 | t_laldroubi | ALL  أو ببساطة  BPG401 C15)",
      profileMatSyncFromText: "تحويل النص إلى جدول المواد ↑",
      profileMatSyncToText: "تحديث النص من الجدول ↓",
      profileSaveBtn: "حفظ البروفايل",
      profileSaveAndLoadBtn: "حفظ وفتح في التنزيل الذكي",
      profileCancelBtn: "إلغاء",
      profileDefaultName: "البروفايل",
      githubBtnTitle: "مستودع المشروع على GitHub (الكود المصدري)",
      serverStep1Title: "1. تثبيت بايثون (إن لم يكن مثبتًا لديك)",
      serverStep1Text: "نزّل بايثون من python.org. في نظام ويندوز، احرص على تفعيل خيار 'Add python.exe to PATH' أثناء التثبيت.",
      serverStep2Title: "2. تنزيل أو استنساخ المشروع",
      serverStep2Text: "استنسخ المشروع عبر Git أو نزّل ملف ZIP من GitHub وفك ضغطه:",
      serverStep3Title: "3. فتح المجلد وتشغيل الخادم",
      serverStep3Text: "افتح موجه الأوامر (PowerShell أو Terminal) داخل مجلد المشروع وشغّل الخادم:",
      serverStep4Title: "4. فتح المتصفح",
      serverStep4Text: "افتح الرابط http://localhost:8080/ لتصفّح وتحميل جميع جلسات ومواد الجامعة بحرية تامة.",
      scPlay: "تشغيل / إيقاف",
      scSeek: "تخطّي",
      scMute: "كتم",
      scFs: "ملء الشاشة",
      scChat: "الدردشة",
      langSwitch: "التبديل إلى الإنجليزية",
      mobileMenuTitle: "القائمة السريعة",
      appearance: "المظهر والسمات",
      moreOptions: "خيارات إضافية",
      touchHintTap: "نقرة واحدة للتحكم",
      touchHintDouble: "نقرتان لتقديم/ترجيع 10ث",
      touchHintRotate: "تدوير الشاشة للعرض الكامل",
      cinemaExit: "خروج من العرض الكامل",
      activeProfileHeader: "الملف الدراسي النشط",
      manageProfilesBtn: "إدارة",
      installAppPwa: "تثبيت التطبيق (PWA)",
      touchHintGesture: "👆 نقرة: للتحكم · ✌️ نقرتان: ±10ث · 📱 تدوير: شاشة كاملة",
      jumpLatest: "الانتقال للأحدث ↓",
      courseDirBtn: "دليل المواد",
      courseDirBtnTitle: "تصفح والبحث في جميع مواد الجامعة الـ ١١٦٣ برمزها واسمها",
      courseDirTitle: "دليل مواد الجامعة الافتراضية السورية",
      courseDirSub: "بحث فوري في جميع مقررات ومواد الجامعة الافتراضية (١١٦٣ مادة) برموزها الدقيقة ومسمياتها الرسمية بالعربية والإنجليزية.",
      courseDirSearchPh: "ابحث برمز المادة، اسمها بالعربية، أو بالإنجليزية (مثال: BPG401 أو البرمجة أو Programming)…",
      courseDirAllFaculties: "جميع الكليات والاختصاصات",
      courseDirCopyCode: "نسخ الرمز",
      courseDirCopied: "تم النسخ!",
      courseDirFindInLib: "البحث في المكتبة",
      courseDirSavedCount: "محفوظة ({n})",
      courseDirBrowseDownload: "تصفح وتنزيل المحاضرات",
      courseDirBatchSelect: "التحميل المتعدد",
      rememberProgram: "تذكر كليتي وموادي",
      courseDirCountSummary: "عرض {n} من أصل {total} مادة",
      courseDirNoMatch: "لم يتم العثور على أية مواد تطابق بحثك.",
      exportLrec: "تصدير ملف \u2066.lrec\u2069 إلى القرص",
      exportLrecSuccess: "تم حفظ ملف المحاضرة على جهازك بنجاح",
      dropdownSearchPh: "بحث وتصفية الخيارات…",
      dropdownNoMatch: "لم يتم العثور على خيارات مطابقة",
      demoSessionBtn: "تجربة محاضرة نموذجية",
      demoLoading: "جارٍ تحميل المحاضرة النموذجية…",
      etaLabel: "متبقي: {t}",
      etaSeconds: "{s} ث",
      etaMinutes: "{m} د {s} ث",
      enhanceTitleActive: "فلتر الصوت مفعّل (معالج تنقية صوت المدرس ٤ مراحل يعمل حالياً)",
      profBackupScopeHint: "الإعدادات، سجل المشاهدة، قائمة التنزيل والتسجيلات",
      slide1Callout: "H يخفي شريط التحكم والمؤشر معاً لشاشة نقية تماماً، واضغط أي زر أو حرك الماوس للإظهار فوراً.",
      slide3Callout: "C لفتح درج الدردشة الجانبي سريعاً والبحث في نصوص أسئلة الطلاب خلال المحاضرة.",
      chatDemoAuthor1: "أحمد سلامة",
      chatDemoMsg1: "دكتور هل هذه الشريحة مطلوبة في الامتحان؟",
      chatDemoAuthor2: "سارة العلي",
      chatDemoMsg2: "ممكن إعادة شرح الخطوة الأخيرة من فضلك؟",
      chatDemoJumpHint: "اضغط للقفز بالفيديو للدقيقة 11:05",
      chatDemoAuthor3: "المدرس",
      chatDemoMsg3: "نعم سنشرح هذا المثال بالتفصيل الآن.",
      dspStage1Title: "Noise Gate",
      dspStage1Desc: "عزل الصفير والهمس أثناء فترات الصمت",
      dspStage2Title: "High-Pass Filter",
      dspStage2Desc: "قص ترددات هواء القاعة وأزيز التكييف",
      dspStage3Title: "Vocal Formant EQ",
      dspStage3Desc: "تضخيم نبرة صوت المدرس (1-4 kHz) ليصبح واضحاً",
      dspStage4Title: "Fast Peak Limiter",
      dspStage4Desc: "حماية من التشويه والفرقعات الصوتية المفاجئة",
      shortcutFullscreen: "ملء الشاشة Fullscreen",
      shortcutHide: "إخفاء عناصر التحكم والمؤشر",
      shortcutMute: "كتم أو تشغيل الصوت"
    }
  };
  const LANG_KEY = "svu.lang.v2";
  const getPref = (k, def) => (window.SVU_PREFS ? window.SVU_PREFS.get(k, def) : def);
  const setPref = (k, val) => {
    if (window.SVU_PREFS) {
      window.SVU_PREFS.set(k, val);
    } else {
      try { localStorage.setItem(k, val); } catch (e) {}
    }
  };
  function detectSystemLang() {
    try {
      const navLangs = (typeof navigator !== "undefined" && navigator.languages) || [
        (typeof navigator !== "undefined" && (navigator.language || navigator.userLanguage)) || ""
      ];
      for (let i = 0; i < navLangs.length; i++) {
        const l = navLangs[i] || "";
        if (/^ar\b/i.test(l)) return "ar";
        if (/^en\b/i.test(l)) return "en";
      }
      const primary = navLangs[0] || "";
      return /^ar\b/i.test(primary) ? "ar" : "en";
    } catch (e) {
      return "en";
    }
  }

  let savedLang = null;
  if (window.SVU_PREFS) {
    savedLang = window.SVU_PREFS.get(LANG_KEY, null);
  } else {
    try { savedLang = localStorage.getItem(LANG_KEY); } catch (e) {}
  }
  let lang = savedLang && STRINGS[savedLang] ? savedLang : detectSystemLang();
  setPref(LANG_KEY, lang);

  function translate(key, params) {
    let value = (STRINGS[lang] && STRINGS[lang][key]) ?? STRINGS.en[key] ?? key;
    if (params) {
      for (const name in params) {
        value = value.replaceAll("{" + name + "}", params[name]);
      }
    }
    return value;
  }
  function apply(root = document) {
    root.querySelectorAll("[data-i18n]").forEach(el => {
      el.textContent = translate(el.dataset.i18n);
    });
    root.querySelectorAll("[data-i18n-title]").forEach(el => {
      el.title = translate(el.dataset.i18nTitle);
    });
    root.querySelectorAll("[data-i18n-aria]").forEach(el => {
      el.setAttribute("aria-label", translate(el.dataset.i18nAria));
    });
    root.querySelectorAll("[data-i18n-ph]").forEach(el => {
      el.placeholder = translate(el.dataset.i18nPh);
    });
  }
  function setLang(code, silent) {
    if (!STRINGS[code]) {
      return;
    }
    lang = code;
    setPref(LANG_KEY, code);
    const docEl = document.documentElement;
    docEl.lang = code;
    docEl.dir = code === "ar" ? "rtl" : "ltr";
    apply();
    const btn = document.getElementById("langBtn");
    if (btn) {
      btn.classList.toggle("is-ar", code === "ar");
      btn.setAttribute("aria-checked", String(code === "ar"));
      btn.title = translate("langSwitch");
      btn.setAttribute("aria-label", translate("langSwitch"));
    }
    const event = {
      detail: code
    };
    if (!silent) {
      document.dispatchEvent(new CustomEvent("langchange", event));
    }
  }
  ns.I18N = {
    t: translate,
    apply: apply,
    setLang: setLang,
    get lang() {
      return lang;
    },
    toggle() {
      setLang(lang === "ar" ? "en" : "ar");
    }
  };
  ns.t = translate;
})(globalThis);
;

;
} catch (err) {
  console.error("[SVU] module 03-i18n.js failed to initialise:", err);
}
;
try {
(function (ns) {
  'use strict';

  // SVU Materials Database (Auto-generated from assets/svu-material-codes.csv)
  // 1163 total course records
  const RAW = [["GCS301","Computer Skills-ICDL","مهارات الحاسوب"],["GOE301","Introduction to On-Line Education","مدخل إلى التعلم الإلكتروني"],["GTW301","Communications Skills and Technical Writing","مهارات التواصل والكتابة العلمية"],["GEN301","English Language I","اللغة الإنكليزية ( 1 )"],["GEN401","English Language II","اللغة الإنكليزية ( 2 )"],["GMN401","Fundamentals of Management","أساسيات الإدارة"],["GEN501","English Language III","اللغة الإنكليزية ( 3 )"],["GEN502","English language IV","اللغة الإنكليزية ( 4 )"],["GAC501","Accounting","المحاسبة"],["GPM601","IT Project Management","إدارة المشاريع المعلوماتية"],["GEN601","English Language V","اللغة الإنكليزية ( 5 )"],["GET601","Ethics of Profession & Society","أخلاقيات المهنة والمجتمع"],["GEP601","Epistemology & Computer Science","نظرية المعرفة وعلوم الحاسب"],["BPH401","Physics","الفيزياء"],["BMA401","Mathematical Analysis I","تحليل رياضي ( 1 )"],["BAS401","Algebraic Structures","بنى جبرية"],["BMA402","Mathematical Analysis II","تحليل رياضي ( 2 )"],["BLA401","Linear Algebra","الجبر الخطي"],["BNA401","Numerical Analysis","تحليل عددي"],["BEC401","Electronic Circuits","الدارات الإلكترونية"],["BLC401","Logical Circuits","دارات منطقية"],["BPG401","Programming 1","البرمجة 1"],["BPG402","Programming II","برمجة (2)"],["BWP401","Web Programming I","برمجة الويب (1)"],["BSP501","Signal Processing","معالجة إشارة"],["BDM501","Discrete Mathematics","الرياضيات المتقطعة"],["BDA501","Data Structures & Algorithms","بنى المعطيات والخوارزميات"],["BDB501","Database Systems I","نظم قواعد البيانات (1)"],["BDBL501","Database Systems I Lab","مخبر نظم قواعد بيانات (1)"],["BCA501","Computer Architecture I","بنيان الحاسوب (1)"],["BOS501","Operating Systems I","نظم التشغيل ( 1 )"],["BOSL501","Operating System Lab I","مخبر نظم تشغيل ( 1 )"],["BTS501","Telecommunication Systems","نظم الاتصالات"],["BWP501","Web Programming II","برمجة الويب (2)"],["BAU501","Automata & Formal Languages","اوتومات ولغات صورية"],["BNT501","Computer Networks I","الشبكات الحاسوبية (1)"],["BAI501","Artificial Intelligence","الذكاء الصنعي"],["BPG601","Programming III","برمجة (3)"],["BCM601","Compilers","المترجمات"],["BPS601","Probability & Statistics","الاحتمالات والإحصاء"],["BPR601","Project I","مشروع (1)"],["BSE601","Software Engineering I","هندسة البرمجيات (1)"],["BID601","Information Systems Analysis and Design","تحليل وتصميم نظم المعلومات"],["BIS601","Information System Security","أمن تظم المعلومات"],["BCG601","Computer Graphics","البيانيات"],["BMM601","Multimedia Systems","نظم الوسائط المتعددة"],["BMP601","Mobile Applications Programming","برمجة تطبيقات النقال"],["BIA601","Intelligent Algorithms","الخوارزميات الذكية"],["BPR602","Project II","مشروع ( 2 )"],["BSM601","Simulation and Modelling and Verification","النمذجة والمحاكاة والتحقق"],["SSE602","Software Engineering II","هندسة البرمجيات (2) (باللغة الانكليزية)"],["SDA601","Data Structures & Algorithms II","بنى المعطيات والخوارزميات (2)"],["SAD601","Algorithm Analysis & Design","تحليل وتصميم الخوارزميات"],["SDB601","Database Systems II","نظم قواعد البيانات (2)"],["SDBL601","Database Systems II Lab","مخبر نظم قواعد البيانات (2)"],["SDE601","Data Mining","تنقيب البيانات"],["SCP601","Compiler Project","مشروع مترجمات"],["SIR601","Information Retrieval","استرجاع المعلومات"],["SSW601","Semantic Web","الويب الدلالي"],["SSQ601","Software Quality (In English)","جودة البرمجيات (باللغة الانكليزية)"],["ANN601","Neural Networks & Fuzzy Logic","الشبكات العصبونية والمنطق العائم"],["AVR601","Virtual Reality","الواقع الافتراضي"],["AML601","Machine Learning","تعلم الآلة"],["ANL601","Natural Language Processing","معالجة اللغات الطبيعية"],["AES601","Expert Systems","النظم الخبيرة"],["AIP601","Digital Image Processing","معالجة الصورة الرقمية (باللغة الانكليزية)"],["ACV601","Computer Vision (In English)","الرؤية الحاسوبية (باللغة الانكليزية)"],["NCA601","Computer Architecture II","بنيان الحاسوب (2)"],["NNP601","Network Application Programming","برمجة التطبيقات الشبكية"],["NNS601","Network Services","خدمات شبكية"],["NNT601","Networking II","شبكات (2)"],["NOS601","Operating Systems II (In English)","نظم التشغيل ( 2 ) (باللغة الانكليزية)"],["NOSL601","Operating Systems II Lab","مخبر نظم التشغيل ( 2 )"],["NNM601","Network Management","إدارة الشبكات"],["NSS601","Computer Networks Security","أمن الشبكات الحاسوبية"],["NDS601","Distributed & Cloud Systems (In English)","النظم الموزعة والسحابية (باللغة الانكليزية)"],["NRT601","Real Time Systems","نظم الزمن الحقيقي"],["GBS101","Computer Skills","مهارات الحاسوب"],["GBS103","Introduction to On-Line Education","مقدمة في التعلم الإلكتروني"],["GHS101","Introduction to Philosophy","مقدمة في الفلسفة"],["GBS102","Career Preparation","تحضير السيرة المهنية"],["GHS102","Introduction to Sociology","مقدمة في علم الاجتماع"],["Eng1","English Level 1","لغة إنكليزية – مستوى أول"],["Eng2","English Level 2","لغة إنكليزية – مستوى ثاني"],["Eng3","English Level 3","لغة إنكليزية – مستوى ثالث"],["Eng4","English Level 4","لغة إنكليزية – مستوى رابع"],["Eng5","English Level 5","لغة إنكليزية – مستوى خامس"],["GMA101","Mathematical Algebra","الجبر الرياضي"],["GMA102","Mathematical Analysis","التحليل الرياضي"],["GMA204","Discrete Mathematics","الرياضيات المتقطعة"],["GMA205","Probability & Statistics","الاحتمالات والإحصاء"],["GDE101","Digital Electronics","الإلكترونيات الرقمية"],["IPG101","Introduction to Programming","مقدمة في البرمجة"],["IWB101","E-Commerce Technologies","تقانات التجارة الإلكترونية"],["IIS101","Introduction to Data Modeling","مقدمة في نمذجة المعطيات"],["INT101","Introduction to Networks","مقدمة في الشبكات"],["IOS101","Introduction to Operating Systems","مقدمة في نظم التشغيل"],["IPG202","Procedural Programming","البرمجة الإجرائية"],["IPG203","Event Driven Programming","البرمجة المقادة بالأحداث"],["IPG204","Object Oriented Programming","التصميم والبرمجة غرضية التوجه"],["IOS202","Windows Platform 1","منصة ويندوز 1"],["IOS203","Linux Platform 1","منصة لينوكس 1"],["IOS204","Network Operating System","نظم التشغيل الشبكية"],["IWB202","Web Application Development and Design","تصميم وتطوير تطبيقات الوِب"],["INT305","Network & IT Infrastructure Security","أمن الشبكات والبنية التحتية المعلوماتية"],["IOS304","Windows Platform 2","منصة ويندوز 2"],["IOS305","Linux Platform 2","منصة لينوكس 2"],["IIS202","Database Architecture and Design","تصميم وبنيان قواعد المعطيات"],["INT202","Network Services","خدمات الشبكات"],["INT203","Wireless Networks","الشبكات اللاسلكية"],["INT204","Routing Principles","مبادئ التوجيه"],["IWB303","Mobile Programming","برمجة التطبيقات النقّالة"],["ISE301","Software Engineering","هندسة البرمجيات"],["ISE302","IT Project Management","إدارة مشاريع تقانة المعلومات"],["IIS303","Advanced SQL Programming","البرمجة المتقدمة بلغة SQL"],["IIS404","MS-SQL Server Administration","إدارة قواعد بيانات MS-SQL Server"],["IIS405","Oracle Database Administration I","إدارة قواعد بيانات Oracle 1"],["IIS406","Oracle Database Administration II","إدارة قواعد بيانات Oracle 2"],["IWB404","Data & Applications Security","أمن التطبيقات والمعطيات"],["IPI405","IT Final Project (ISDN)","مشروع"],["IPM405","IT Final Project (MIS)","مشروع"],["BMN101","Fundamentals of Management","أساسيّات الإدارة"],["BAC101","Principles of Accounting","أسس المحاسبة"],["BEC101","Introduction to Economics","مدخل إلى علم الاقتصاد"],["BMN202","Introduction to Marketing","مدخل إلى التسويق"],["BMN203","Human Resources Management","إدارة الموارد البشريّة"],["BFB201","Fundamentals of Financial Management","أسس الإدارة الماليّة"],["BEC202","Microeconomics","اقتصاد جزئي"],["BFB305","Banking","الخدمات المصرفيّة"],["BAC202","Cost Analysis","المحاسبة التحليليّة (محاسبة التكاليف)"],["BQM301","Operations Management","إدارة العمليّات"],["BMN305","Supply Chain Management","إدارة الإمداد (إدارة سلاسل التوريد)"],["BAC303","Feasibility Studies","تقييم المشاريع ودراسات الجدوى"],["BQM202","Operational Researches","بحوث العمليّات"],["BQM303","Decision Theory","نظريّة القرارات"],["BMN306","Strategic Management","الإدارة الاستراتيجيّة"],["BQM304","Project Management","إدارة المشاريع"],["BMN308","Entrepreneurship and SMEs Management","ريادة الأعمال وإدارة الشركات المتوسطة والصغيرة"],["BQM305","Data Analysis","تحليل البيانات"],["BMN309","Corporate Social Responsibility and Business Ethics","المسؤولية الاجتماعية للشركات وأخلاقيّات العمل"],["GPH101","Physics","الفيزياء"],["BQM406","Research in Marketing","بحوث التسويق"],["CEE101","Electrical Circuits","دارات كهربائية"],["CEE102","Data Communications","تراسل البيانات"],["CML201","MATLAB for Numerical Computing","ماتلاب للحوسبة العددية"],["CEE202","Electronics","إلكترونيات"],["CEE203","Signals and Systems","إشارات ونظم"],["CEE204","Digital Electronics","إلكترونيات رقمية"],["CEE205","Digital Signal Processing","معالجة الإشارة الرقمية"],["CEE306","Analog Communications","اتصالات تمثيلية"],["CEE307","Microprocessors and Microcontrollers","المعالجات والمتحكمات الصغرية"],["CEE308","Digital Communications","اتصالات رقمية"],["CRF301","Electromagnetic Waves and Transmission Lines","الأمواج الكهرطيسية وخطوط النقل"],["CCS401","Introduction to Wireless Systems","مدخل إلى النظم اللاسلكية"],["CRF402","Antennas and Wave Propagation","الهوائيات وانتشار الأمواج"],["CRF403","Microwave Engineering","هندسة الأمواج المكروية"],["CRF404","RF & Microwave telecommunications systems","نظم الاتصالات الراديوية والمكروية"],["CRF406","Optical Communications","اتصالات بصرية"],["CCN401","Wireless networks","شبكات الاتصالات اللاسلكية"],["CPR401","BACT Final Project - RF & Microwave Communications (RMC)","مشروع تخرج في تقانة الاتصالات– اختصاص الاتصالات الراديوية والمكروية"],["CCN403","Mobile Applications","التطبيقات النقالة"],["CCN404","Multimedia Networking","تشبيك الوسائط المتعددة"],["CCN402","Digital Transport and Broadband Access Technologies","تقانات النقل الرقمي والنفاذ العريض الحزمة"],["CPS401","BACT Final Project - Communications Services & Business (CSB)","مشروع تخرج في تقانة الاتصالات– اختصاص خدمات الاتصالات والأعمال"],["CCS402","Mobile and Wireless communications","اتصالات لاسلكية ونقالة"],["CCS404","Embedded System Fundamentals","أساسيات النظم المضمّنة"],["CCS403","Mobile communications Systems","نظم الاتصالات النقالة"],["CPM401","BACT Final Project - Mobile Communications Systems (MCS)","مشروع تخرج في تقانة الاتصالات– اختصاص نظم الاتصالات النقالة"],["AWP","Web Programming","برمجيات الوب"],["ADE","Advanced Concepts in Data Repository and Data Exchange","مفاهيم متقدمة في تخزين وتبادل البيانات"],["ADM","Data Mining","التنقيب عن المعطيات"],["ADP","Distributed Applications Programming","برمجة التطبيقات الشبكية والموزعة"],["AWE","Web Engineering","هندسة الوب"],["AHM","Hyper and Multimedia","الوسائط المتعددة والفائقة"],["AMW","Mobile Web","الوب النقال"],["AIR","Information Retrieval","استرجاع المعلومات"],["AWM","Web Mining","التنقيب في الوب"],["AWS","Web Security","أمن المعلومات"],["ATH","Thesis","الرسالة"],["WWD","Web Design","تصميم تطبيقات الوب"],["WXL","XML Techniques","تقانات XML"],["WNT","Networks","شبكات حاسوبية"],["WJD","Java Application Development","تطوير التطبيقات بلغة جافا"],["WDB","DataBase","قواعد البيانات"],["WEB","Electronic Business","الأعمال الالكترونية"],["WIM","Internet & Multimedia","تعدد الوسائط والانترنت"],["WMS","Mobile Services","الخدمات النقالة"],["WEG","Web Engineering","هندسة الوب"],["WIS","Internet Security","أمن الانترنت"],["WDA","Distributed Applications","التطبيقات الموزعة"],["WDE","Data Exploring","استكشاف البيانات"],["WPR","Project","مشروع التخرج"],["MCBG","Molecular Cell Biology and Genetics","البيولوجيا الجزيئية للخلية وعلم الوراثة"],["FBDA","Fundamentals of Bioinformatics and Data Analysis","أساسيات المعلوماتية الحيوية وتحليل البيانات"],["MBA","Methods in Bioinformatics and Algorithms","طرائق المعلوماتية الحيوية والخوارزميات"],["BSS","Biostatistics","الإحصاء الحيوي"],["IRDM","Information Resources and Data Mining Techniques","مصادر المعلومات وتقنيات التنقيب عن البيانات"],["AIML","Artificial Intelligence and Machine Learning in biological applications","الذكاء الصنعي وتعلم الآلة في التطبيقات البيولوجية"],["BITM","BioMolecular Interactions: Theories and Methods","تآثرات الجزيئات الحيوية: النظريات والطرائق"],["ABI","Advanced BioInformatics","المعلوماتية الحيوية المتقدمة"],["PSBI","Protein and Structural BioInformatics","المعلوماتية الحيوية للبروتينات والبنى"],["SRM","Scientific Research Methodologies","أساليب البحث العلمي"],["BIP","Master Project","مشروع الماجستير"],["BID","Master Project (Study Plan Code)","مشروع الماجستير"],["RDSC","Rational Design and Structural Characterization of Bioactive Molecules","التصميم الرشيد والتحديد البنيوي للجزيئات الفعالة حيوياً"],["AMCB","Advanced Molecular and Cellular Biotechnology","التقانة الحيوية الخلوية والجزيئية المتقدمة"],["APCB","Advanced Plant Cell Biotechnology","التقانة الحيوية المتقدمة للخلية النباتية"],["PEME","Protein Engineering and Molecular Enzymology","هندسة البروتين وعلم الإنزيمات الجزيئي"],["BIMP","Bioimaging and Image Processing","التصوير الحيوي وتحليل الصور"],["MSPD","Molecular Strategies in Control of Parasites and Vector-Borne Diseases","الاستراتيجيات الجزيئية في ضبط الأمراض المسببة بالطفيليات والنواقل"],["NNDL","Neural Network and Deep learning","الشبكات العصبونية والتعلم العميق"],["SE","Software Engineering","هندسة البرمجيات"],["SB","Systems biology","بيولوجيا المنظومات"],["MBPG","Molecular breeding and plant genetics","التهجين الجزيئي ووراثيات النبات"],["PHG","Pharmacogenomics","علم تأثير الأدوية المجيني"],["WP1","Web programming 1","برمجة الويب 1"],["PRB","Programming Basics","أساسيات البرمجة"],["DBS","Database Systems","نظم قواعد البيانات"],["STP","Principles of Statistics","مبادئ الاحصاء"],["NTP","Networks and Protocols","الشبكات الحاسوبية والبروتوكولات"],["WP2","Web programming 2","برمجة الويب 2"],["IAI","Introduction to Artificial Intelligence","مقدمة في الذكاء الصنعي"],["CYS","Cyber Security","الأمن السيبراني"],["CIT","Cloud Computing and the Internet of Things","الحوسبة السحابية وانترنت الأشياء"],["SWP","Software Principles","مبادئ هندسة البرمجيات"],["SWE","Software Principles (Study Plan Code)","مبادئ هندسة البرمجيات"],["AWD","Advanced Web Development","تطوير الويب المتقدم"],["IDM","Introduction to Data Mining","مقدمة في تنقيب البيانات"],["MAD","Mobile Application Development","تطوير تطبيقات المحمول"],["DSA","Distributed Systems and Applications","النظم والتطبيقات الموزعة"],["MLT","Machine Learning Technologies","تقانات تعلم الآلة"],["MPR","Master's Project","مشروع الماجستير"],["RSW","Switch and Routing","التبديل والتوجيه"],["WNT","Wireless Networks","الشبكات اللاسلكية"],["DCD","Data Center Design","تصميم مراكز المعطيات"],["ISP","Internet Service Providers","مزودي خدمة الانترنت"],["MMS","Multimedia Systems","أنظمة الوسائط المتعددة"],["NSS","Network Security","أمن الشبكات"],["WNS","Wireless Network Security","أمن الشبكات اللاسلكية"],["ANA","Advanced Network Administration","إدارة شبكات متقدمة"],["IPR","Internet Protocols","بروتوكولات الأنترنت"],["SSD","Server Design","تصميم الخوادم"],["CYS","Cyber Security","أمن الأنترنت"],["AHN","Ad-hoc Networks","الشبكات Ad-hoc"],["SDN","Software Defined Networks","الشبكات المعرفة برمجياً"],["IOT","The Internet of things","أنترنت الأشياء"],["CID","Cloud Computing Infrastructure","بنية الحوسبة السحابية التحتية"],["NPR","Master's Project","مشروع الماجستير"],["GMA401","Mathematics","رياضيات"],["GMA402","Probability & Statistics","الإحصاء و الاحتمالات"],["GBS301","Introduction to On-Line Education","التعليم الإلكتروني"],["GBS302","Computer Skills","مهارات الحاسوب"],["GBL401","Business Law","قانون الأعمال"],["GMA403","Economic and Administrative Mathematics","الرياضيات الاقتصادية والإدارية"],["GBS303","Career Preparation","تحضير السيرة المهنية"],["GBS504","Computer Applications in Management","تطبيقات حاسوبية في الإدارة"],["GRM501","Research Methodology","مناهج البحث العلمي"],["BAC401","Accounting Principles (1)","مبادئ محاسبة(1)"],["BMN401","Fundamentals of Management","أساسيات الإدارة"],["BEC401","The History of Economic Thought","تاريخ الفكر الاقتصادي"],["BMK401","Introduction to Marketing","مدخل إلى التسويق"],["BEC402","Microeconomics","الاقتصاد الجزئي"],["BHR401","Human Resources Management","إدارة الموارد البشرية"],["BAC402","Accounting Principles (2)","مبادئ محاسبة (2)"],["BEC403","Macroeconomics","الاقتصاد الكلي"],["BMK502","Consumer Behavior","سلوك المستهلك"],["BQM501","Operations Management","إدارة العمليات"],["BHR502","Organizational Behavior","السلوك تنظيمي"],["BFB401","Principles of Financial Management","مبادئ الإدارة المالية"],["BMN502","Negotiation Management","إدارة التفاوض"],["BMN503","Organization Theory","نظرية المنظمة"],["BFB502","Public Finance","المالية العامة"],["BQM502","Operations Research","بحوث العمليات"],["BQM603","Decision Theory","نظرية القرارات"],["BMN504","Management Information Systems","نظم المعلومات الإدارية"],["BMN505","Quality Management","إدارة الجودة"],["BMN606","Strategic Management","الإدارة الاستراتيجية"],["BMN507","E-Business Management","إدارة الأعمال الإلكترونية"],["BMN508","Corporate Social Responsibility and Business Ethics","المسؤولية الاجتماعية للشركات وأخلاقيات العمل"],["BAC506","Administrative Accounting","المحاسبة الإدارية"],["BMN609","Crisis Management","إدارة الأزمات"],["BAC607","Feasibility Studies","دراسات الجدوى الاقتصادية"],["BQM604","Data Analysis","تحليل البيانات"],["BMN610","Entrepreneurship","ريادة الأعمال"],["BQM607","Project Management","إدارة المشاريع"],["BAC504","Financial Accounting for Companies","محاسبة مالية للشركات"],["BMK603","Services Marketing","تسويق الخدمات"],["BMK604","Product and Brand Management","إدارة المنتج والعلامة التجارية"],["BMK605","Sales Management","إدارة المبيعات"],["BMK606","Pricing and Distribution","التسعير والتوزيع"],["BMK607","Integrated Marketing Communications","الاتصالات التسويقية المتكاملة"],["BMK608","E-Marketing","التسويق الإلكتروني"],["BMK609","Public Relations Management","إدارة العلاقات العامة"],["BMK610","Strategic Marketing","التسويق الاستراتيجي"],["BMK612","International Marketing","التسويق الدولي"],["BMK611","Business to Business Marketing","التسويق نحو منظمات الأعمال"],["PMK601","Graduation Project (Marketing)","مشروع"],["BHR603","Industrial & Managerial Psychology","علم النفس الإداري والصناعي"],["BHR604","Human Resource Training","التدريب والتطوير"],["BHR605","Employment Management","إدارة التوظيف"],["BHR606","Managerial Leadership","القيادة الإدارية"],["BHR607","Career Path Management","إدارة المسار المهني"],["BHR608","Strategic Human Resource Management","الإدارة الاستراتيجية للموارد البشرية"],["BHR609","Knowledge Management & Intellectual Capital","إدارة المعرفة ورأس المال الفكري"],["BHR610","Teamwork Management","إدارة فرق العمل"],["BHR6011","Diversity Management","إدارة التنوع"],["BHR6012","Modern Trends in Human Resource Management","اتجاهات حديثة في إدارة الموارد البشرية"],["PHR601","Graduation Project (HRM)","مشروع"],["BAC603","Accounting for Partnership Companies","محاسبة شركات الأشخاص"],["BFB503","Financial Management of Enterprises","الإدارة المالية للشركات"],["BAC605","Accounting for Corporations","محاسبة شركات الأموال"],["BFB604","Management of Financial Institutions","إدارة مؤسسات مالية"],["BFB605","Financial Analysis","تحليل مالي"],["BFB606","International Finance","مالية دولية"],["BFB607","Banking","خدمات مصرفية"],["BFB608","Islamic Finance","مالية إسلامية"],["BFB609","Management of Financial Markets","إدارة أسواق مالية"],["BAC608","Intermediate Accounting (1)","محاسبة متوسطة1"],["BAC609","Intermediate Accounting (2)","محاسبة متوسطة2"],["BFB610","Management of Credit Risk","إدارة المخاطر الإئتمانية"],["PFB601","Graduation Project (Finance & Banking)","مشروع"],["QMH51","Management Fundamentals and Human Resource Management","أساسيات الإدارة وإدارة الموارد البشرية"],["QAS51","Applied Statistics","الإحصاء التطبيقي"],["QDM61","Problem Solving and Decision Making","حل المشكلات وصناعة القرار"],["QMS61","Quality Management Systems","أنظمة إدارة الجودة"],["QIT62","Techniques and Tools for Quality Improvements","تقنيات وأدوات تحسين الجودة"],["QFM62","Financial Management and Quality Costs","الإدارة المالية وتكاليف الجودة"],["QTM62","Total Quality Management","إدارة الجودة الشاملة"],["QPM72","Project Quality Management","إدارة الجودة في المشاريع"],["QSC72","Statistical Quality Control","الضبط الإحصائي للجودة"],["QIA72","Internal Quality Audit","التدقيق الداخلي للجودة"],["QMM72","Measurement Systems","أنظمة القياس"],["QDE72","Design and Analysis of Experiments","تصميم وتحليل التجارب"],["QPD72","Product and Process Design","تصميم المنتجات والإجرائيات"],["QSM72","Service Quality Management","إدارة جودة الخدمات"],["QSP72","Planning and Strategic Analysis","التخطيط والتحليل الاستراتيجي"],["QCM72","Supply Chain Management","إدارة سلاسل الإمداد"],["QMC72","Marketing and Customer Relationship Management","التسويق وإدارة العلاقة مع الزبون"],["QPR73","Master Project","مشروع الماجستير"],["MET","Management and Economics of Technology","إدارة واقتصاد التقانة"],["SCM","Supply Chain Management","إدارة سلاسل التزويد"],["ICT","Information and Communication Technology","تقانة المعلومات والاتصالات"],["TCI","Technology Change and Innovation","التغيير التقاني والإبداع"],["SMM","Scientific Methods in Management","طرق علمية في الإدارة"],["AFM","Accounting and Financial Management","محاسبة وإدارة مالية"],["QRM","Quality, Reliability and Maintainability","جودة ووثوقية وصيانة"],["TDT","Technology Development and Transfer","نقل وتطوير التقانة"],["MIS","Management Information Systems","نظم معلومات إدارية"],["SE","System Engineering","هندسة النظم"],["ITM","Industrial and Technological Marketing","تسويق صناعي وتكنلوجي"],["TPM","Technology Project Management","إدارة مشاريع التقانة"],["BTL","Business and Technology Law","قانون الأعمال والتقانة"],["NPD","New Product Development","تطوير منتج جديد"],["CTM","Cases in Technology Management","تجارب في إدارة التقانة"],["FIP","Final Project","مشروع نهائي"],["BRM.12","Business Research Methods","طرائق البحث في إدارة الأعمال"],["PCM.11","Principle of Management","أساسيات الإدارة"],["MEC.13","Managerial Economics","اقتصاديات الأعمال"],["HRM.14","Human Resources Management","إدارة الموارد البشرية"],["MKG.15","Marketing","التسويق"],["OPM.22","Operation Management","إدارة العمليات"],["DAC.23","Data analysis by computer","تحليل البيانات باستخدام الحاسوب"],["ACM.21","Accounting for Managers","المحاسبة للمديرين"],["ORB.24","Organizational Behavior","السلوك التنظيمي"],["BUL.25","Business Law","قانون الأعمال"],["MIS.32","Management Information Systems","نظم المعلومات الإدارية"],["IMT.33","International Marketing and Trading","التسويق والتجارة الدولية"],["PRM.34","Project Management","إدارة المشروعات"],["STM.35","Strategy (in English)","الإدارة الإستراتيجية (بالإنكليزية)"],["FIN.31","Financial Management","الإدارة المالية"],["PRJ.40","The Project","مشروع التخرج"],["CRI101","Public Criminal Law 1","قانون العقوبات العام 1"],["INL102","Public International Law","القانون الدولي العام"],["ECO103","Principles of Economics","مبادئ علم الاقتصاد"],["CON104","Constitutional Law and Political Systems","القانون الدستوري والنظم السياسية"],["MET105","Legal Methodology","المنهجية القانونية"],["IL106","Introduction to Law","مدخل إلى علم القانون"],["CDL107","ICDL","الرخصة الدولية لقيادة الحاسوب"],["GBS108","E-learning","التعليم الالكتروني"],["HUM201","Human Rights","حقوق الإنسان"],["CRI202","Public Criminal Law 2","قانون العقوبات العام 2"],["IS203","Principles of Islamic Sharia","مبادئ الشريعة الإسلامية"],["POL 204","Introduction to Political Science","المدخل الى علم السياسة"],["INT205","Introduction to Law and Legal Systems (E1)","مقدمة إلى علم القانون والأنظمة القانونية (باللغة الإنجليزية)"],["CIV206","Civil Law 1","القانون المدني 1 مصادر الالتزام"],["CRI301","Private Criminal Law 3","قانون العقوبات الخاص 1"],["COM302","Commercial Law 1","القانون التجاري 1 (الأعمال التجارية والتاجر والمتجر)"],["ADM303","Administrative Law 1","القانون الإداري 1"],["FAM304","Personal Status Law 1","قانون الأحوال الشخصية 1 زواج وطلاق"],["EIL305","International Economic Law","القانون الدولي الاقتصادي"],["CIV306","Civil Law 2","القانون المدني 2 مصادر الالتزام"],["CRI401","Private Criminal Law 4","قانون العقوبات الخاص 2"],["COM402","Commercial Law 2 (Company Law)","القانون التجاري 2 (الشركات التجارية)"],["COL403","Cooperative Law","التشريع التعاوني"],["CL404","Criminal Law (E2)","القانون الجنائي (باللغة الإنجليزية)"],["CIV405","Civil Law 3","القانون المدني 3 أحكام الالتزام"],["ADM406","Administrative Law 2","القانون الإداري 2"],["CIP501","Civil Procedures 1","أصول المحاكمات المدنية 1"],["FL502","Public Finance Law 1","المالية العامة 1 الإيرادات والنفقات"],["CL503","Commercial Law 3 (Commercial Papers)","القانون التجاري 3 (الأسناد التجارية)"],["Cive504","Civil Law 4","القانون المدني 4 العقود المسماة"],["CIV504","Civil Law 4","القانون المدني 4 العقود المسماة"],["FAM505","Personal Status Law 2","قانون الأحوال الشخصية 2 المواريث"],["ADM506","Administrative Law 3","القانون الإداري 3"],["CIP601","Civil Procedures 2","أصول المحاكمات المدنية 2"],["PIL602","Private International Law 1","القانون الدولي الخاص 1"],["INT 603","Public International Law (E3)","القانون الدولي العام (باللغة الإنجليزية)"],["CIV604","Civil Law 5","القانون المدني 5 (الحقوق العينية الأصلية)"],["CRP605","Criminal Procedures 1","أصول المحاكمات الجزائية 1"],["ML606","Commercial Law 4 (Maritime and Air Law)","القانون التجاري 4 القانون البحري والجوي"],["PIL701","Private International Law 2","القانون الدولي الخاص 2"],["CIV702","Execution Procedures","أصول التنفيذ"],["ICL703","International Trade Law (E4)","قانون التجارة الدولية (باللغة الإنجليزية)"],["CIV704","Civil Law 6","القانون المدني 6 (الحقوق العينية التبعية)"],["CRP705","Criminal Procedures 2","أصول المحاكمات الجزائية 2"],["B706","Commercial Arbitration","التحكيم التجاري"],["TAX801","Tax Law","التشريع الضريبي"],["LL802","Labor Law","قانون العمل"],["ID803","Islamic Doctrine","أصول الفقه"],["A-INL-811","Insurance Law","التأمين"],["A - BL - 812","Banking Legislation","المصارف والتشريعات المصرفية"],["A -Bany- 813","Bankruptcy","الإفلاس والصلح الواقي"],["A- EC -814","E-commerce","التجارة الإلكترونية"],["B-ARL- 821","Agricultural Relations Law","قانون العلاقات الزراعية"],["B - IP- 822","Intellectual Property Rights","حقوق الملكية الفكرية"],["B - CPL -823","Consumer Protection Law","قانون حماية المستهلك"],["B-LSL- 824","Legal Sociology","علم الاجتماع القانوني"],["C-EL -831","Environmental Law","التشريع البيئي"],["AC- 832-C","Administrative Contracts","العقود الإدارية"],["FC- 833-C","Financial Control","الرقابة المالية"],["LAL834 -C","Local Administrative Law","قانون الإدارة المحلية"],["841 - DL -D","Diplomatic Law","العلاقات الدبلوماسية والقنصلية"],["842 – IHL-D","International Humanitarian Law","القانون الدولي الإنساني"],["IEO-843-D","International Economic Organizations","المنظمات الدولية الاقتصادية"],["ILS- 844-D","International Law of the Sea","القانون الدولي للبحار"],["851 – DL-E","Drugs Law","قانون المخدرات"],["852 – JL-E","Juvenile Law","قانون الأحداث الجانحين"],["853 – ML-E","Money Laundering Law","قانون غسل الأموال"],["854 – Cybc-E","Cyber Crime","جرائم المعلوماتية"],["MME13","Introduction to Mass Media Organization Management","مدخل إلى وسائل الإعلام- إدارة المؤسسات الإعلامية"],["IIC13","Introduction to Image and Cinema","مدخل إلى الصورة والسينما"],["MML13","Media English Language I","مادة إعلامية بلغة انكليزية 1"],["IJ13","Introduction to Journalism","مدخل إلى الصحافة"],["APM13","Advertising- Principles and Management","الإعلان - مبادئ وإدارة"],["PR13","Public Relations- Principles and Management","العلاقات العامة- مبادئ وإدارة"],["CDL11","Computer Skills","مهارات الحاسوب"],["GBS103","Introduction to Online Education","التعليم الإلكتروني"],["IME121","Introduction to Media Editing","مدخل إلى التحرير الإعلامي"],["MMRM121","Mass Media Research Methods","مناهج البحث الإعلامي"],["MMLII121","Media English Language II","مادة إعلامية بلغة انكليزية 2"],["CS122","Communication and Society","الاتصال والمجتمع"],["LCLM122","Literature, Criticism and Media Language","الأدب والنقد واللغة الإعلامية"],["IRT122","Introduction to Radio and TV","مدخل إلى الإذاعة والتلفزيون"],["MCT131","Media and Communication Theory","نظريات الإعلام والاتصال"],["LEMC131","Legislations and Ethics of Media and Communication","التشريعات الإعلامية وأخلاقيات المهنة"],["MMLIII231","Media English Language III","مادة إعلامية بلغة انكليزية 3"],["OPA131","Public Opinion and it's Assessment","الرأي العام وطرق قياسه"],["IMS132","Introduction to Media Sociology","مدخل إلى علم الاجتماع الإعلامي"],["OC132","Organizational Communication","الاتصال التنظيمي"],["CA132","Current Affairs","قضايا راهنة"],["TPSM241","Techniques of Persuasion and Social Marketing","أساليب الإقناع والتسويق الاجتماعي"],["MPA241","Media Planning","التخطيط الإعلامي"],["MKE241","Media and the Knowledge Economy","اقتصاد الإعلام والمعرفة"],["SIDM241","Sources of Information and Media Documentation","مصادر المعلومات والتوثيق الإعلامي"],["OMC242","Online Media and Communication","الإعلام والاتصال الإلكتروني"],["AL242","Administrative Leadership","القيادة الإدارية"],["MCI242","International Media and Communication","الإعلام والاتصال الدولي"],["RTPD533","Radio and Television Presentation and Delivery","التقديم والإلقاء الإذاعي والتلفزيوني"],["NPRT534","News Programs in Radio and TV","البرامج الإخبارية في الإذاعة والتلفزيون"],["RP535","Preparation of Radio Programs","إعداد البرامج الإذاعية"],["SMRT536","Specialized Media in Radio and Television","الإعلام الإذاعي والتلفزيوني المتخصص"],["MCI537","Management of Creativity and Innovation","إدارة الإبداع والابتكار"],["IPR532","Intellectual Property Rights","حقوق الملكية الفكرية"],["MIM645","Media Institutions Management","إدارة المؤسسات الإعلامية"],["TRTP646","Talk Programs In Radio and Television","البرامج الحوارية الإذاعية والتلفزيونية"],["ML648","Media Legislations","تشريعات إعلامية"],["MM647","Multimedia","الوسائط المتعددة"],["LS649","Investigative Articles' Editing","التحرير الاستقصائي"],["IAT650","Photos' Analysis Techniques","أساليب تحليل الصورة"],["IS872","Information Society","مجتمع المعلومات"],["WBN752","Writing and Preparation of News Reports","كتابة وإعداد التقارير الإخبارية"],["RTP758","Radio and TV Production","الإنتاج الإذاعي والتلفزيوني"],["MTE759","Technology of Media and Education","تكنولوجيا الإعلام والتعليم"],["RTA760","Radio and Television Advertising","الإعلان الإذاعي والتلفزيوني"],["SD756","Scenario and Drama","السيناريو والدراما"],["RTVD785","Radio and TV Direction","الإخراج الإذاعي والتلفزيوني"],["EOM874","Editing of Opinion Articles","تحرير مواد الرأي"],["DO757","Documentary Films","الأفلام الوثائقية"],["GD762","Graphic Design","التصميم الجرافيكي"],["ATVW787","Advanced TV Writing","كتابة تلفزيونية مستوى متقدم"],["G796","Graduation Project_RTV","مشروع تخرج"],["BP540","Principles of Business Management","أسس إدارة الأعمال"],["OGP528","Online Journalism and Publishing","الصحافة الالكترونية والنشر الالكتروني"],["CB539","Consumer Behavior","سلوك المستهلك"],["PSEM538","Persuasion Skills by Electronic Media","مهارات الإقناع بالوسائل الإلكترونية"],["EMC687","Electronic Means of Communication","وسائل الاتصال الالكترونية"],["CJ686","Citizen Journalism","صحافة المواطن"],["MI530","Media Interview","المقابلة الإعلامية"],["IWD753","Web Page Creation","تكوين صفحة الويب"],["NPD755","Newspaper Production and Layout","إنتاج وإخراج الصحف"],["EM790","Electronic Marketing","التسويق الإلكتروني"],["PMPT870","Methods, Principles and Techniques of Publication","أساليب وأصول وتقنيات النشر"],["TVIC 786","TV Interview and Reportage","الحديث والتحقيق التلفزيوني"],["G797","Graduation Project_EM","مشروع تخرج"],["PMAC542","Planning of Advertisement Content","تخطيط المحتوى الإعلاني"],["PM541","Principles of Marketing","مبادئ التسويق"],["MSP533","Marketing Strategies and Policies","استراتيجيات وسياسات التسويق"],["PA534","Advertising Psychology","سيكولوجيا الإعلان"],["E649","Economics","علم الاقتصاد"],["PRS650","Public Relations Skills","مهارات العلاقات العامة"],["SM791","Service Marketing","تسويق الخدمات"],["AD792","Advertisement Designing","تصميم الإعلان"],["MC764","Marketing Communication","الاتصال التسويقي"],["EA763","Economic Analysis","التحليل الاقتصادي"],["BM764","Trade Mark Management","إدارة العلامة التجارية"],["A794","Aesthetics","علم الجمال"],["G795","Graduation Project_AD","مشروع تخرج"],["NWE527","News Writing and Editing I","كتابة وتحرير الأخبار1"],["JOA529","Reportage, Interviews and Opinion Articles","التحقيق والحديث الصحفي ومواد الرأي"],["APP531","Art of Press Photography","فن التصوير الصحفي"],["NWE527-2","News Writing and Editing II","كتابة وتحرير الأخبار II"],["ETP 757","Online Press Editing","تحرير الصحافة الإلكترونية"],["TAT754","Text Analysis Techniques","أساليب تحليل النصوص"],["SP871","Specialized Press","الصحافة المتخصصة"],["PT751","Printing Technologies","تقنيات الطباعة"],["MPW873","Media and Psychological Warfare","الإعلام والحرب النفسية"],["G799","Graduation Project_JO","مشروع تخرج"],["PRC543","Public Relations and Crises","العلاقات العامة والأزمات"],["MP544","Publicity and Media Relations","العلاقات الإعلامية والإعلانية"],["IPR649","International Public Relations","العلاقات العامة الدولية"],["CB535","Organizational Behavior","السلوك التنظيمي"],["PRN766","Public Relations and Negotiation","العلاقات العامة والتفاوض"],["IS769","Internet and Society","الانترنت والمجتمع"],["PRC768","Public Relations Campaigns","حملات العلاقات العامة"],["EPRM767","Writing for Public Relations","الكتابة للعلاقات العامة"],["G798","Graduation Project_PR","مشروع تخرج"],["CET","Education Technology","تكنولوجيا التعليم"],["CCE","Comparative Education","التربية المقارنة"],["CEC","Educational Curricula","المناهج التربوية"],["CEP","Educational Psychology","علم النفس التربوي"],["CME","Measurement and Evaluation in Modern Education","القياس والتقويم في التربية الحديثة"],["CDP","Developmental Psychology","علم نفس النمو"],["CMT","General Methods of Teaching","طرائق التدريس العامة"],["CGE","General Education and Philosophy of Education","التربية العامة وفلسفة التربية"],["CMH","Mental Health","الصحة النفسية"],["ICDL","Computer Skills","مهارات قيادة الحاسوب"],["CTP","Practical Education","التربية العملية"],["GBS103","Introduction to E-learning","مقدمة في التعلم الالكتروني"],["PRO","Project","المشروع"],["ESC","School Counseling","الإرشاد المدرسي"],["ESE","Special Needs Education","تربية ذوي الاحتياجات الخاصة"],["ETT","Thinking Skills Teaching","تعليم مهارات التفكير"],["EME","Modern Educational Trends","الاتجاهات التربوية المعاصرة"],["EEL","E-learning","التعليم الالكتروني"],["ECS","Scientific Education","التربية العلمية"],["CCL","Computer and Internet Learning","التعلم بالحاسوب والانترنت"],["CSM","School and Classroom Management","الإدارة الصفية والمدرسية"],["IET","Introduction to education Technology","مدخل إلى تكنولوجيا التعليم"],["TCM","Contemporary trends in curriculum and teaching methods","اتجاهات حديثة في المناهج وطرائق التدريس"],["EDC","Educational Communication","الاتصال التربوي"],["ISL","Uniqueness of teaching and self-learning","تفريد التعليم والتعلم الذاتي"],["LRC","Learning Resources centres and their management","مراكز مصادر التعلم وإدارتها"],["SET","Effective teaching strategies and active learning","استراتيجيات التدريس الفعال والتعلم النشط"],["BLL","Blending Learning","التعليم المتمازج"],["ITA","Applications of integrating technology into learning","تطبيقات دمج التكنولوجيا في التعليم"],["CPD","Designing, production and evaluation of computer educational Programmes","تصميم البرمجيات التعليمية الحاسوبية وإنتاجها وتقويمها"],["IAE","Internet applications in education","تطبيقات الانترنت في التعليم"],["EDL","e-learning and distant learning","التعلم الالكتروني والتعليم من بعد"],["ERM","Research methods in education","مناهج البحث في التربية"],["IND","Education Design","التصميم التعليمي"],["CIE","Contemporary issues in educational technology","موضوعات معاصرة في تكنولوجيا التعليم"],["ETS","Learning technology for people with special needs","تكنولوجيا التعليم لذوي الحاجات الخاصة"],["GRD","Master's Project","مشروع الماجستير"],["PIL","Public international law","القانون الدولي العام"],["IHRL","International human rights law","القانون الدولي لحقوق الإنسان"],["GTIHL","General Theory of International Humanitarian Law","النظرية العامة للقانون الدولي الإنساني"],["ISIHL","In-depth studies in international humanitarian law","دراسات معمقة في القانون الدولي الإنساني"],["LAC","Law of Armed Conflict","قانون النزاعات المسلحة"],["JAB","JUS AD BELLUM","القانون الدولي للجوء إلى القوة"],["ICL","International criminal law","القانون الدولي الجزائي"],["IHO","International and humanitarian organizations","المنظمات الدولية والإنسانية"],["CII","Contemporary international issues","قضايا دولية معاصرة"],["IRL","International refugee law","القانون الدولي للاجئين"],["RLM","Research and Legal Methodology","البحث والمنهجية القانونية"],["TSFL","Terms and studies in foreign language","مصطلحات ودراسات باللغة الأجنبية"],["MGP","Graduation Project","مشروع التخرج"],["RES","Basics of scholarly research","منهجية البحث العلمي"],["METHODS","Theories and methods of language teaching","نظريات تعليم اللغات وطرائق تدريسها"],["CURR","Curriculum design and computerizing content","تصميم مناهج اللغات وحوسبتها"],["SOCLIN","Sociolinguistics and diglossia","اللسانيات الاجتماعية والازدواجية"],["PSYCLIN","Language acquisition and psycholinguistics","اكتساب اللغة واللسانيات النفسية"],["GENLIN","General linguistics and phonology","اللسانيات العامة"],["APPLIN","Applied linguistics","اللسانيات التطبيقية"],["LANCULT","Arabic language and culture","اللغة العربية وثقافتها"],["SMPR","Semantics and pragmatics","علم الدلالة والتداولية"],["SYN","Syntax and morphology","النحو والصرف"],["STATS","Measurement, evaluation, educational statistics","القياس و التقييم والإحصاء التربوي"],["THES","Thesis writing","مشروع التخرج (كتابة الرسالة)"],["GBS301","Virtual Learning Systems","أنظمة التعلم الافتراضي"],["GSC301","The Syrian Culture1","الحضارة السورية (1)"],["GSC302","The Syrian Culture2","الحضارة السورية (2)"],["TGT401","Introduction to Tourism","مدخل إلى السياحة"],["GIS402","Introduction to Statistics Science","مدخل إلى الإحصاء"],["GEL403","E- Learning","تعليم إلكتروني"],["BMN401","Introduction to Management","مدخل إلى الإدارة"],["GIA405","Introduction to Accounting","مدخل إلى المحاسبة"],["GIM406","Introduction to Marketing","مدخل إلى التسويق"],["GIT407","Introduction to Tourism Economics","مدخل إلى الاقتصاد السياحي"],["Gcp303","Career Preparation","بناء السيرة المهنية"],["BTP601","Tourism Planning","التخطيط السياحي"],["BHS404","The History Of Syrian Arts","تاريخ الفن السوري"],["BTAS605","Tourism establishments in Accounting","محاسبة منشآت سياحية"],["BHR604","Human Resources Management (HR)","إدارة موارد بشرية"],["BTD407","Tourism Destinations Marketing","تسويق المواقع السياحية"],["BTS502","Tourism services Quality","جودة الخدمات السياحية"],["BFM504","Financial Management","إدارة مالية"],["BLT506","Legislations in Tourism & Hotels","تشريعات سياحية وفندقية"],["BSR59","Social responsibility and work ethics","المسؤولية الاجتماعية وأخلاقيات العمل"],["BTS401","Tourism Marketing Department","إدارة التسويق السياحية"],["BSR603","Scientific Research Methodologies","منهجية البحث العلمي"],["BSP402","Sustainable Development of Tourism","التنمية السياحية المستدامة"],["BSM602","Services Marketing","التسويق الخدمي"],["GBS401","Communication Skills","مهارات التواصل"],["BMS403","Managing Safe & Healthy Work Environment","إدارة الصحة والسلامة المهنية"],["BMR508","Management of resorts and tourist villages","إدارة المنتجعات والقرى السياحية"],["BTE501","Tourism Events Management","إدارة الفعاليات السياحية"],["BTP505","Tourism Projects Management","إدارة مشاريع سياحية"],["TTM501","Cultural tourism","السياحة الثقافية"],["TTM606","Syrian Intangible Heritage","التراث اللامادي السوري"],["TTM608","Management of tourist camps","إدارة المخيمات السياحية"],["TTM610","The Art of Etiquette (Ceremonies & Professional Attitude)","فن الاتيكيت (المراسم وآداب اللياقة)"],["TTM 615","Feasibility study for tourism establishments","دراسة الجدوى الاقتصادية بالمنشآت السياحية"],["TTM614","Syrian Tourism Map","الخارطة السياحية السورية"],["TTM601","Tourism Companies & Travel Agencies Management","إدارة شركات السياحة والسفر"],["TTM603","Airline Service Management","إدارة خدمات شركات الطيران"],["TTM607","Creating & Operating Tours & Traveling Products","تنظيم البرامج السياحية والجولات"],["TTM502","Specialized English (1)","لغة إنكليزية تخصصية (1)"],["TTM605","Tourism Destination Management","إدارة المواقع السياحية"],["TTM503","Specialized English (2)","لغة إنكليزية تخصصية (2)"],["TTM611","Tourism Product Development Strategy","إستراتيجية تطوير المنتج السياحي"],["TTM612","Tourism auditing","المراجعة والتدقيق السياحي"],["TTM613","Tourism Information Systems","تطبيقات حاسوبية في السياحة"],["PTM616","Graduation Project (Tourism Management)","مشروع تخرج"],["THM601","Hotel Operations Management","إدارة العمليات الفندقية"],["THM602","Introduction To Hospitality Industry","مدخل إلى الضيافة"],["THM501","Food & Beverage Service (F&B Service)","خدمة الأغذية والمشروبات"],["THM604","Customer behavior","سلوك العملاء"],["THM502","Rooms Division Management","إدارة الإيواء"],["THM607","Purchase & Store Management","إدارة المشتريات والمخازن"],["THM503","Specialized English 1","لغة إنكليزية تخصصية (1)"],["THM609","Bar Management","إدارة البارات"],["THM603","Feasibility study In hotel establishments","دراسة الجدوى الاقتصادية في المنشآت فندقية"],["THM605","Hotel Security","الأمن الفندقي"],["THM610","Event Management","إدارة المناسبات"],["THM606","Restaurant Management","إدارة المطاعم"],["THM505","Computer applications in hotel establishments","تطبيقات حاسوبية في المنشآت الفندقية"],["PHM611","Graduation Project (Hotel Management)","مشروع تخرج"],["TMK601","E-Marketing In Tourism","التسويق الالكتروني السياحي"],["TMK603","Marketing research in Tourism","بحوث التسويق السياحي"],["TMK605","Tourism Marketing Communications","الاتصالات التسويقية السياحية"],["TMK608","Tourist markets","الأسواق السياحية"],["TMK502","Tourist behavior","سلوك السائح"],["TMK602","Tourism Marketing Information Systems","نظم المعلومات التسويقية السياحية"],["TMK501","International Tourism Marketing","التسويق السياحي الدولي"],["TMK607","Pricing Strategy for Tourism Products","التسعير السياحي"],["TMK503","Tourism Marketing Information Systems (Computer Applications)","تطبيقات حاسوبية في التسويق السياحي"],["TMK604","Tourism product development strategies","استراتيجيات تطوير المنتج السياحي"],["TMK606","Innovation Marketing in Tourism Industry","التسويق الابتكاري السياحي"],["TMK609","Digital Tourism","السياحة الرقمية"],["TMK611","Social Marketing","التسويق الاجتماعي"],["THM504","Specialized English 2","لغة إنكليزية تخصصية (2)"],["MGMT101","Principles of Management and Business","مبادئ الإدارة والأعمال"],["ECON101","Principles of Economics","مبادئ الاقتصاد"],["STAT101","Principles of Statistics","مبادئ الإحصاء"],["MKTG101","Principles of Marketing","مبادئ التسويق"],["ACCT101","Principles of Financial Accounting","مبادئ المحاسبة المالية"],["IT101","Computer Skills and Information Technology","مهارات الحاسوب وتكنولوجيا المعلومات"],["BLAW101","Business Law","قانون الأعمال"],["MGMT301","Strategic Management","الإدارة الإستراتيجية"],["HRM101","Introduction to Human Resource Management","المدخل إلى إدارة الموارد البشرية"],["MIS201","Management Information Systems","نظم المعلومات الإدارية"],["ACCT201","Principles of Managerial Accounting","مبادئ المحاسبة الإدارية"],["COMM301","Communication and Negotiation Skills in the Workplace","مهارات التواصل والتفاوض في بيئة العمل"],["OB201","Organizational Behavior","السلوك التنظيمي"],["EBUS301","E-Business Management","إدارة الأعمال الإلكترونية"],["CSR301","Corporate Social Responsibility and Business Ethics","المسؤولية الاجتماعية للشركة وأخلاقيات العمل"],["ADML401","Administrative Leadership","القيادة الإدارية"],["KM401","Knowledge Management and Intellectual Capital","إدارة المعرفة ورأس المال الفكري"],["HRM301","Human Resource Development and Training","تنمية وتدريب الموارد البشرية"],["SHRM401","Strategic Human Resource Management","الإدارة الاستراتيجية للموارد البشرية"],["DATA301","Data Analysis","تحليل البيانات"],["WP301","Workforce Planning","تخطيط القوى العاملة"],["PM301","Project Management","إدارة المشاريع"],["CS101","Programming for Non-Specialists","البرمجة لغير المختصين"],["CPM401","Career Path Management","إدارة المسار الوظيفي"],["EM301","Employment Management","إدارة التوظيف"],["MC301","Management by Creativity","الإدارة بالإبداع"],["QM401","Quality Management and Institutional Excellence","إدارة الجودة والتمييز المؤسسي"],["OHSM301","Occupational Health and Safety Management","إدارة الصحة والسلامة المهنية"],["RM301","Scientific Research Methodology","منهجية البحث العلمي"],["MTHRM401","Modern Trends in Human Resource Management","اتجاهات حديثة في إدارة الموارد البشرية"],["PM401","Performance Management","إدارة الاداء"],["CM401","Compensation Management","إدارة التعويضات"],["IHRM401","International Human Resource Management","إدارة الموارد البشرية الدولية"],["OG401","Organizational Governance","حوكمة المنظمات"],["HRMIS401","Human Resource Management Information Systems","نظم معلومات إدارة الموارد البشرية"],["AIHRM401","AI Applications in Human Resource Management","تطبيقات الذكاء الصنعي في إدارة الموارد البشرية"],["GP499","Graduation Project","مشروع التخرج"],["BMN401","Basics of Project Management","أساسيات إدارة المشاريع"],["BSC","Basics of Smart Cities","مبادئ المدن الذكية"],["Gph101","Physics","الفيزياء"],["Gma101","Mathematical Algebra","الجبر الرياضي"],["CAD","Computer Aided Design (AutoCAD)","التصميم بمعونة الحاسوب (AutoCAD)"],["ENM","Engineering Mechanics","الميكانيك الهندسي"],["PRG","Programming","البرمجة وبنى المعطيات بلغة بايثون"],["BBM","Basics of Building Information Modelling + Revit","أساسيات نمذجة معلومات البناء (مع أساسيات ريفيت)"],["GBS304","Entering Labour Market Skills","مهارات الدخول إلى سوق العمل"],["SCP 1","Smart Cities Policies 1","سياسات المدن الذكية 1"],["CAL","Calculus","التكامل والتفاضل"],["LADL","Linear Algebra and Data Learning","الجبر الخطي والتعلم من لبيانات"],["SSC","Sustainability in Smart Cities","الاستدامة في المدن الذكية"],["SUD","Smart Urban Design","التصميم الحضري الذكي (تطبيقية)"],["PCEI","Principles of Civil Engineering and Infrastructure","مبادئ الهندسة المدنية والبنية التحتية"],["MSC 1","Materials Science I","علم المواد 1 ( تطبيقية)"],["ENG 3","English 3","إنكليزي 3"],["PROB","Probability","الاحتمالات"],["OBJP","Object-oriented Programming","برمجة غرضية التوجه"],["MSC2","Materials Science 2","علم مواد 2 ( تطبيقية)"],["BCR","Building Construction (Revit)","انشاء مباني (Revit)"],["GIS 1","Geographic Information Systems (GIS)1","نظم المعلومات الجغرافية GIS (1)"],["SCP 2","Smart Cities Policies 2","سياسات المدن الذكية 2"],["ENG 4","English 4","انكليزي 4"],["OEHS","Occupational, Environmental, and Health Safety","السلامة و الصحة المهنية و البيئية"],["SDP","Statistics and Data Processing","الإحصاء ومعالجة المعطيات"],["SCP 1 (Planning)","Smart Cities Planning I","تخطيط المدن الذكية 1 ( تطبيقية)"],["SSM 1","Smart Systems I","النظم الذكية 1"],["DSM","Database Systems","نظم قواعد البيانات"],["SUS","Smart urban sociology","السيسولوجيا الحضرية الذكية"],["ENG 5","English 5","انكليزي 5"],["ORSC","Operations Research in Smart Cities","بحوث العمليات في المدن الذكية"],["SCP 2 (Planning)","Smart Cities Planning 2","تخطيط المدن الذكية 2 ( تطبيقية)"],["BCT","Basics of Construction Technology","تكنولوجيا التشييد"],["MLDM","Machine Learning and Data Mining","تعلم الالة و التنقيب في البيانات"],["UGC","Urban Governance","الحوكمة الحضرية"],["ATSC","Architectural Theories in Smart Cities","نظريات العمارة في المدن الذكية"],["RMAN","Risk Management","إدارة المخاطر"],["SBIM","Sustainability in BIM","الاستدامة في BIM"],["UAI","Urban Artificial Intelligence","الذكاء الاصطناعي الحضري"],["BDSC","Big Data in Smart Cities","البيانات الضخمة في المدن الذكية"],["QSC","Quality Systems and Quality Control","نظم و مراقبة الجودة"],["SSM 2","Smart Systems 2","النظم الذكية 2"],["CNS","Communication Networks","شبكات الاتصالات"],["IMBIM","INTEGRATED Management in BIM","الإدارة المتكاملة في الـ BIM _ ISO19650"],["QTM","Quality Testing and Total Quality Management","اختبارات الجودة و إدارة الجودة الشاملة (تطييقية)"],["IoT","Internet of Things (IoT)","إنترنت الأشياء IoT"],["EDSC","Executive Designs for Smart Cities","التصميمات التنفيذية للمدن الذكية"],["SCMDS","Smart City Management & Decision Support","ادارة المدن الذكية ودعم القرار (CIM) GIS ADV+"],["SAPH","Smart Architecture Philosophy","فلسفة العمارة الذكية"],["SPAD","Smart Parametric in Architectural Design","البارامترية الذكية في التصميم المعماري"],["TENT","Technology Entrepreneurship","ريادة الأعمال التقنية"],["PRP","Project Research Plan","خطة بحث المشروع"],["DTC","Digital Twin for Cities","التوأم الرقمي للمدن"],["UCS","Urban Cybersecurity","الأمن السيبراني الحضري"],["PR","Project (Smart City Design)","مشروع التخرج (تصميم مدينة ذكية)"],["CPME","Curriculum design in medical education and modern tendencies","تصميم المناهج في التعليم الطبي والتوجهات الحديثة"],["TLME","Teaching and learning strategies in medical education","استراتيجيات التدريس والتعلم في التعليم الطبي"],["QAMS","Quality Assurance and Reliability of medical professions institutions","ضمان جودة واعتمادية مؤسسات المهن الطبية"],["MCMT","Measuring Competencies of medical team","قياس كفاءات الفريق الطبي"],["EMP","Evaluation of Medical Programs","تقويم البرامج الطبية"],["LME","Management and administrative leadership in medical education","الإدارة والقيادة الإدارية في التعليم الطبي"],["TME","Applying technology in medical education","تطبيق التكنولوجيا في التعليم الطبي"],["CPD","Continuous professional development","التطوير المهني المستمر"],["SRME","Scientific Research in Medical Education","البحوث العلمية في مجال التعليم الطبي"],["MEP","Master's Project","مشروع الماجستير"],["MES","Medical education for surgeons","التعليم الطبي للجراحين"],["MEA","Medical education for anesthetists","التعليم الطبي للأطباء المخدرين"],["MEO","Medical Education for Oncologists","التعليم الطبي لأطباء الأورام"],["SRMS","Social responsibility of medical professions colleges","المسؤولية الاجتماعية لكليات المهن الطبية"],["QAME","Quality Assurance of medical education (English language)","ضمان جودة التعليم الطبي (اللغة الإنكليزية)"],["MEE","Medical education environment","بيئة التعلم الطبي"],["PDMT","Developing Medical training package","تطوير حقيبة تدريبية طبية"],["PBL","Problem solving-based learning (English language)","التعلم المرتكز على حل المشكلات (اللغة الإنكليزية)"],["EBP","Developing evidence-based practice (English language)","تطوير الممارسة المسندة بالدليل (اللغة الإنكليزية)"],["MM","Medical Management (English language)","التوجيه الطبي (اللغة الإنكليزية)"],["MCC","Measuring clinical competency","قياس الكفاءة السريرية"],["EMEP","Medical e-training program (English language)","برنامج تدريبي طبي الكتروني (اللغة الإنكليزية)"],["BIM-F","Fundamentals of Building Information Modeling","أساسيات نمذجة معلومات البناء"],["BIM-MA","Enterprise Maturity Analysis for BIM","تحليل نضج المؤسسات للـ BIM"],["OTB","Organizational and Behavioral Theory","النظرية التنظيمية والسلوكية"],["SM","Strategic Management","الإدارة الاستراتيجية"],["PM","Project Management","إدارة المشاريع"],["IM-BIM","Integrated Management in BIM","الإدارة المتكاملة في الـ BIM"],["CM","Construction Contract Management","إدارة عقود البناء"],["EE","Engineering Economics","الاقتصاد الهندسي"],["QM","Quality Management","إدارة الجودة"],["BIM-C","BIM-based Contracts","العقود القائمة على الـ BIM"],["PMP","Professional Project Management","الإدارة الاحترافية للمشاريع"],["BIM-A","Advanced Cases in BIM","حالات متقدمة في الـ BIM"],["BIM-SI","The Successful Application of BIM","التطبيق الناجح للـ BIM"],["RM-BIM","Managing Risks using BIM","إدارة المخاطر باستخدام الـ BIM"],["PR","Master project","مشروع الماجستير"],["NR","Natural Resources","الموارد الطبيعية"],["ES","Ecosystem Services","خدمات النظم الإيكولوجية"],["ASNE","Assessment of the State of Natural Ecosystems","تقييم حالة النظم الإيكولوجية الطبيعية"],["RNE","Resilience of Natural Ecosystems","مرونة النظم الإيكولوجية الطبيعية"],["EAM","Environmental Adaptive Management","الإدارة البيئية التكيفية"],["EPPC","Environment Protection and Pollution Control","حماية البيئة والتحكم بالتلوث"],["CCFS","Climate Change and Food Security","التغيرات المناخية والأمن الغذائي"],["SDNC","Sustainable Development & Natural Capital","التنمية المستدامة والرأسمال الطبيعي"],["EASPC","Environmental Adaptive Strategic Planning Cycle","دورة التخطيط الاستراتيجي التكيفي البيئي"],["PA","Participatory Approach in Environmental Adaptive Management","التشاركية في الإدارة البيئية التكيفية"],["MVNE","Monetary Valuation of Natural Ecosystem","التقييم النقدي للنظم الإيكولوجية الطبيعية"],["SSPC","Support the Strategic Planning Cycle","مساندة دورة التخطيط الاستراتيجي"],["NRLL","Application of Integrated Management of Natural Resources at Local Level","تطبيق الإدارة المتكاملة للموارد الطبيعية على المستوى المحلي"],["IMNR1","Integrated Management of Natural Resources (1)","الإدارة المتكاملة للموارد الطبيعية (القسم 1)"],["IMNR2","Integrated Management of Natural Resources (2)","الإدارة المتكاملة للموارد الطبيعية (القسم 2)"],["Ma","Master Project","مشروع الماجستير"],["ITNGO","Introduction to NGOs","مدخل إلى المنظمات غير الحكومية"],["ANGO","Accounting for NGOs","المحاسبة في المنظمات غير الحكومية"],["HRVM","Human Resources and Volunteering Management in NGOs","إدارة الموارد البشرية والتطوع في المنظَّمات غير الحكوميَّة"],["SRM","Research Methods in Management","منهجية البحث العلمي في الإدارة"],["RNGO","Regulations of NGOs","تشريعات المنظمات غير الحكومية"],["FMNGO","Financial Management for NGOs","الإدارة المالية في المنظَّمات غير الحكوميَّة"],["BES","Business Ethics and Sustainability in NGOs","أخلاقيات العمل والاستدامة في المنظَّمات غير الحكوميَّة"],["PRC","Public Relations and Communication in NGOs","العلاقات العامة والتواصل في المنظمات غير الحكومية"],["LMWT","Leadership and Teams' Management in NGOs","القيادة وإدارة الفرق في المنظمات غير الحكومية"],["GNGO","Governance in NGOs","الحوكمة في المنظمات غير الحكومية"],["INGO","International NGOs and Cooperation","المنظمات غير الحكومية الدولية والتعاون الدولي"],["QMNGO","Quality Management in NGOs","إدارة الجودة في المنظمات غير الحكوميَّة"],["ITI","Information Technology and Innovations in NGOs","تكنولوجيا المعلومات والابتكار في المنظمات غير الحكومية"],["MHDP","Humanitarian and Developmental Project Management (In English)","إدارة المشروعات الإنسانية والتنموية (In English)"],["CMER","Crisis Management and Emergency Response","إدارة الأزمات والاستجابة الطارئة"],["SMNGO","Strategic Management in NGOs","الإدارة الإستراتيجية في المنظّمات غير الحكوميَّة"],["PCNGO","Practical Class in NGOs","مقرر تطبيقي"],["MPG","Project","مشروع التخرج"],["HSM 1","Health Systems Management (1)","إدارة النظم الصحية1 (التنظيم وتوفير الخدمات)"],["HSM 2","Health Systems Management (2)","إدارة النظم الصحية2 (التخطيط الاستراتيجي والإدارة)"],["GHS","Global Health Systems","النظم الصحية العالمية"],["HCF","Health Finance","التمويل الصحي (التحليل وصنع القرار)"],["HE.HCM","Health Economics","اقتصاديات الصحة (تسويق الرعاية الصحية)"],["HQ.EBP","Health Quality 1","جودة الصحة1 (اتخاذ القرارات المبنية على الأدلة للمديرين)"],["HSM 3","Health Systems Management (3)","إدارة النظم الصحية3 (مبادئ القيادة-صنع التغيير وحل المشكلات)"],["HP1.R","Health Policies1","السياسات الصحية1 (السياسة والتنظيم الصحي)"],["HP2.GE","Health Policies2","السياسات الصحية2 (الحوكمة والاعتبارات القانونية والأخلاقية في أنظمة الرعاية الصحية)"],["HQ.PS","Health Quality 2","جودة الصحة2 (إدارة الجودة وسلامة المرضى وتحسين الأداء)"],["HR.HCM","Human Resources in Healthcare","إدارة الموارد البشرية في الرعاية الصحية"],["FPH.E","Fundamentals of Public Health & Epidemiology","أساسيات الصحة العامة والوبائيات"],["BS.HSM","Statistics in Healthcare Systems","الإحصاء في أنظمة الرعاية الصحية"],["R.HOM","Research in Healthcare Operations","بحوث إدارة عمليات الرعاية الصحية"],["HIM.T","Health Information Administration & Technology","إدارة وتقانات المعلومات الصحية"],["EI.HSM","Emerging Issues in Health Systems Management","القضايا الطارئة في إدارة النظم الصحية (إدارة الكوارث- الأوبئة- المتغيرات)"],["MEP","Master Thesis","مشروع الماجستير"],["HOA","History of Architecture","تاريخ العمارة"],["ICL","International Charters and Laws","المواثيق والقوانين الدولية والعربية والمحلية (قانون الاثار السوري)"],["CSHC","Conservation Strategies for Historic Cities","استراتيجيات الحفاظ على المدن التاريخية"],["ADMS","Archaeological Documentation and Manual Surveying","الرفع اليدوي والتوثيق الأثري (المسح التصويري والفوتوغرامتري)"],["BIMB","BIM Basics","أساسيات الـ BIM"],["ITR","Introduction to Restoration and Structural Strengthening","مدخل إلى الترميم والتدعيم الإنشائي للأبنية التاريخية"],["TBM","Traditional Building Materials in the Arab Region","مواد البناء التقليدية في المنطقة العربية"],["RVA","Revit Advanced","ريفيت متقدم"],["SBIM","Scan to BIM","Scan to BIM"],["HAC","Heritage Adaptive Reuse & Conservation","حفظ وتوظيف الأبنية التراثية"],["RMH","Risk Management in Heritage Projects","إدارة المخاطر في المشاريع التراثية"],["HPV","Heritage Projects Visualization with AI","إظهار المشاريع التراثية باستخدام AI"],["SAH","Structural Analysis of Historic Buildings","التحليل الإنشائي للمباني التاريخية"],["HPM","Heritage Project Management","الإدارة المستدامة للمشاريع التراثية"],["PR","PROJECT","مشروع الماجستير (HBIM)"],["GMA101","Mathematical Analysis","التحليل الرياضي"],["IPG201","Event Driven Programming","البرمجة المقادة بالأحداث"],["IIS201","Database Architecture and Design","تصميم وبنيان قواعد المعطيات"],["IWB201","Web Application Development and Design","تصميم وتطوير تطبيقات الوِب"],["IOS201","Network Operating System","نظم التشغيل الشبكية"],["IPG203","Object Oriented Programming","التصميم والبرمجة غرضية التوجه"],["IOS202","Windows Platform","منصة ويندوز"],["IOS203","Linux Platform","منصة لينوكس"],["IIS202","Advanced SQL Programming","البرمجة المتقدمة بلغة SQL"],["IIS303","MS-SQL Server Administration","إدارة قواعد بيانات MS-SQL Server"],["IIS203","Oracle Database Administration","إدارة قواعد بيانات Oracle"],["IPG204","Mobile Programming","برمجة التطبيقات النقّالة"],["IPI201","TIC Final Project","مشروع"],["GBS303","Entering Labor Market Skills","مهارات الدخول إلى سوق العمل"],["GMA401","Introduction to Statistics","مدخل إلى الإحصاء"],["BAC401","Introduction to Accounting","مدخل إلى المحاسبة"],["BMK502","Customer Behavior","سلوك العملاء"],["TGT402","The Syrian Culture1","الحضارة السورية (1)"],["TGT403","The Syrian Culture2","الحضارة السورية (2)"],["TGT406","Introduction to Hotel Management","مدخل إلى الإدارة الفندقية"],["TGT404","Syrian Intangible Heritage","التراث اللامادي السوري"],["BMN601","Tourism Services Quality","جودة الخدمات السياحية"],["GLL401","Legislations in Tourism & Hotels","تشريعات سياحية وفندقية"],["BMK503","Sales Management in Tourism Establishments","إدارة المبيعات في المنشآت السياحية"],["BMN502","Health and Safety in Work Environment","الصحة والسلامة المهنية"],["TTM502","Syrian Tourism Geography","جغرافية سورية السياحية"],["TTM602","Airlines Services Management","إدارة خدمات شركات الطيران"],["TTM604","Tours in Tourism Companies & Travel Agencies (practical course)","جولات في شركات السياحة ومكاتب السفر (عملي)"],["TTM603","Tour Guide Techniques","تقنيات الدليل السياحي"],["TGT405","Tourism Archeological Sites","المواقع السياحية الأثرية"],["TTM606","Computer Applications for Tourism Companies & Travel Agencies (practical course)","تطبيقات حاسوبية في شركات السياحة ومكاتب السفر(عملي)"],["THM501","Operational Processes in Food Production","العمليات التشغيلية في إنتاج الطعام"],["THM504","Operational Processes in Food Production (practical course1)","العمليات التشغيلية في إنتاج الطعام(عملي1)"],["THM503","Operational Processes in Food Service","العمليات التشغيلية في خدمة الطعام"],["THM506","Operational Processes in Food Service (practical course1)","العمليات التشغيلية في خدمة الطعام (عملي1)"],["THM502","Housekeeping Supervision","إدارة الإشراف الداخلي"],["THM505","Front Office Operations","عمليات مكاتب أمامية"],["THM603","Front Office Operations and Housekeeping Supervision (practical course)","عمليات مكاتب أمامية وإدارة الاشراف الداخلي (عملي)"],["THM507","Purchasing & Store Management","إدارة المشتريات والمخازن"],["THM604","Computer Applications in Hotel Establishments (practical course)","تطبيقات حاسوبية في المنشآت الفندقية (عملي)"],["TMK501","Tourism Companies & Travel Agencies","شركات السياحة ومكاتب السفر"],["TMK504","Tourism Marketing Communications","الاتصالات التسويقية السياحية"],["TMK502","Pricing in Tourism","التسعير السياحي"],["TMK505","Development Strategies for Tourism Product","استراتيجيات تطوير المنتج السياحي"],["TMK503","Distribution in Tourism","التوزيع السياحي"],["TMK604","Tours in Tourism Companies & Travel Agencies (practical course)","جولات في شركات السياحة ومكاتب السفر (عملي)"],["TMK602","Tours in Hotels (practical course)","جولات في الفنادق(عملي)"],["TMK606","Tourism Tours (practical course)","الجولات السياحية (عملي)"],["BED","Basics of Engineering Design","مبادئ التصميم الهندسي"],["BRV","Revit Basic","أساسيات Revit"],["BPS","Basics of Project Planning – Scheduling","مبادئ تخطيط المشاريع (الجدولة)"],["BPE","Basics of Project Planning – Quantity and Cost Estimations","مبادئ تخطيط المشاريع (حساب الكميات والأسعار)"],["BDC","Building Documents","مستندات البناء"],["PMR","Project Management using Revit","الإدارة باستخدام Revit"],["ETW","Engineering Technical Writing","الكتابة التقنية الهندسية"],["BCQ","Basics of Construction Quality","مبادئ الجودة"],["PRT","PROJECT","مشروع"],["BSB","Basics of Sustainable Building","مبادئ البناء المستدام"],["BMS","Building Materials","مواد بناء"],["BEI","Building Elements Implementation","عناصر تنفيذية"],["ARV","Revit Advanced (2)","برنامج Revit متقدم (2)"],["HBM","Heritage BIM","البيم للتراث العمراني"],["BSA","Basics of Structural Analysis","مبادئ التحليل الإنشائي"],["SHD","Shop Drawings","المخططات التنفيذية"],["IND","Infrastructure Design","تصميم البنى التحتية"],["BSM(1)","Basics of Mechanical Modelling 1","مبادئ النمذجة الميكانيكية1"],["BEM(1)","Basics of Electrical Modelling 1","مبادئ النمذجة الكهربائية 1"],["BPM(1)","Basics of Plumbing Modelling 1","مبادئ النمذجة الصحية 1"],["BFR","Basics of Fire Systems Design","مبادئ ونمذجة أنظمة الحرائق"],["BSM(2)","Basics of Mechanical Modelling 2","مبادئ النمذجة الميكانيكية 2"],["BEM(2)","Basics of Electrical Modelling 2","مبادئ برنامج نمذجة كهرباء 2"],["BPM(2)","Basics of Plumbing Modelling 2","مبادئ ونمذجة الأعمال الصحية 2"],["BDM","Basics of Disaster Management","أسس إدارة الكوارث"],["AED","Assessment and Evaluation of Damages in Buildings","كشف وتقييم الأضرار (تطبيقي)"],["RMN","Risk Management","إدارة المخاطر"],["MCN","Methodologies of Collaboration","النظم التعاونية"],["OSN","Occupational Safety using Navisworks","السلامة المهنية باستخدام Navisworks"],["DSM","Disaster Strategic Management","الإدارة الاستراتيجية للكوارث"],["L1","Level One (Elementary)","المستوى الأول (مبتدئ)"],["L2","Level Two (Lower Intermediate)","المستوى الثاني (دون المتوسط)"],["L3","Level Three (Mid Intermediate)","المستوى الثالث (متوسط)"],["L4","Level Four (Upper Intermediate)","المستوى الرابع (فوق المتوسط)"],["L5","Level Five (Advanced)","المستوى الخامس (متقدم)"],["CS","Computer Skills","مهارات الحاسوب"],["CSTW","Communications Skills and Technical Writing","مهارات التواصل والكتابة العلمية"],["EN1","English Language I","اللغة الإنكليزية (1)"],["EN2","English Language II","اللغة الإنكليزية (2)"],["EN3","English Language III","اللغة الإنكليزية (3)"],["EN4","English Language IV","اللغة الإنكليزية (4)"],["EN5","English Language V","اللغة الإنكليزية (5)"],["MA1","Mathematical Analysis I","تحليل رياضي (1)"],["AS","Algebraic Structures","بنى جبرية (2)"],["MA2","Mathematical Analysis II","تحليل رياضي (2)"],["LA","Linear Algebra","الجبر الخطي"],["NA","Numerical Analysis","تحليل عددي"],["CP1","Computer Programming I","البرمجة (1)"],["CP2","Computer Programming II","البرمجة (2)"],["DSA","Data Structures and Algorithms","الخوارزميات وبنى المعطيات"],["OO","Object Oriented Programming","البرمجة غرضية التوجه"],["DB","Database Systems","قواعد البيانات"],["DG","Digital Systems","النظم الرقمية"],["DSR","Discrete Structures","البنى المتقطعة"],["EC","Electronic Circuits","الدارات الإلكترونية"],["ICA","Introduction to Computer Architecture","مدخل إلى بنيان الحاسوب"],["OS1","Operating Systems I","نظم التشغيل (1)"],["TS","Data Communication","الاتصالات الرقمية"],["CN","Computer Networks","الشبكات الحاسوبية"],["CMP","Compilers","مترجمات"],["VP","Visual Programming","البرمجة المرئية"],["PR1","Project1","مشروع 1"],["EA","Basics of Economics & Accounting","أساسيات الاقتصاد والمحاسبة"],["PRB","Probability","الاحتمالات"],["IS","Systems Analysis and Design","تحليل وتصميم النظم"],["ST","Statistics","الإحصاء"],["WB","Web applications","تطبيقات الويب"],["MG","Management","الإدارة"],["OR","Operational Research","بحوث العمليات"],["CM","e-commerce technology","تقانة التجارة الإلكترونية"],["PM","Software Project Management","إدارة مشاريع البرمجيات"],["SS","Decision Support Systems","نظم دعم القرار"],["RQE","Requirements Engineering","هندسة المتطلبات"],["CMPP","Compiler project","مشروع مترجمات"],["IR","Information Retrieval","استرجاع المعلومات"],["PR2","Project2","مشروع 2"],["NAP","Network Application Programming","برمجة التطبيقات الشبكية"],["CSR","Computer Security","أمن الحواسيب"],["CR","Cryptography","التعمية"],["CG","Computer Graphics","البيانيات"],["MP","Microprocessor","المعالجات الصغرية"],["NS","Network Services","خدمات شبكية"],["AN","Advanced Networking","شبكات متقدمة"],["LP","Logic Programming","البرمجة المنطقية"],["OS2","Operating Systems II","نظم التشغيل (2)"],["MI","Man-Machine Interface","التخاطب بين الإنسان والآلة"],["NM","Network Management","إدارة شبكات"],["AE","Artificial Intelligence","الذكاء الصنعي"],["PPR","Parallel Processing","المعالجة التفرعية"],["VR","Virtual Reality","الواقع الافتراضي"],["DST","Distributed Systems","النظم الموزعة"],["NLP","Natural Language Processing","معالجة اللغات الطبيعية"],["ES","Expert Systems","النظم الخبيرة"],["SM","Simulation and modeling","النمذجة والمحاكاة"],["RT","Real Time Systems","نظم الزمن الحقيقي"],["MM","Multimedia Systems","نظم الوسائط المتعددة"],["SIP","Signal Processing","معالجة إشارة"],["IMP","Image Processing","معالجة صورة"],["EM610","Essential Mathematics (1)","أساسيات الرياضيات (1)"],["BMP612","Basic Management Principles","أساسيات الادارة"],["AE614","Accounting Essentials 1","أساسيات المحاسبة 1"],["MA624","Microeconomic Analysis","أساسيات التحليل الجزئي"],["ICDL","International Computer driving Licence","رخصة قيادة الحاسب الدولية"],["AIC613","Arabic Islamic Civilization","الحضارة العربية والإسلامية"],["EM621","Essential Mathematics 2","أساسيات الرياضيات 2"],["AE622","Accounting Essentials 2","أساسيات المحاسبة 2"],["PS623","Principles of Statistics","أساسيات الإحصاء"],["PM625","Principals of Marketing","أساسيات التسويق"],["ENG1","English I","اللغة الانكليزية [1]"],["ENG2","English II","اللغة الانكليزية [2]"],["ENG3","English III","اللغة الانكليزية [3]"],["ENG4","English IV","اللغة الانكليزية [4]"],["ENG5","English V","اللغة الانكليزية [5]"],["MA","Macroeconomics Analysis","التحليل الكلي"],["BE","Business Environment","بيئة الأعمال القانونية"],["AO","Administrative Organization","التنظيم الإداري"],["EAM","Economics & Administrative Mathematics","الرياضيات الإقتصادية والإدارية"],["CAM","Computer Applications Of Management","تطبيقات الحاسوب في الادارة"],["MM","The Management of Marketing","إدارة التسويق"],["FA","Financial Accounting of Companies","المحاسبة المالية في الشركات"],["CA","Cost Accounting","محاسبة التكاليف"],["DBM","Database management","نظم إدارة قواعد البيانات"],["FM","Financial Management","الإدارة المالية"],["OM","Operations Management","إدارة الإنتاج"],["SBM823","Small and medium Business Management","إدارة المشاريع الصغيرة والمتوسطة"],["GRM","General relation Management","إدارة العلاقات العامة"],["GA834","General Administration","الإدارة العامة"],["MFM","Management of Financial Markets","إدارة الأسواق المالية"],["AE","Administrative Economy","الإقتصاد الإداري"],["SAA","Statistical applications for administration","تطبيقات الإحصاء في الإدارة"],["GF","General Finance","المالية العامة"],["PA842","Projects Administration","إدارة المشاريع"],["LSA843","Logistic and supplying administration","إدارة التخزين والإمداد"],["HRM","Human resources Management","إدارة الموارد البشرية"],["ADT","Administrative Decisions Theory","نظرية القرارات الإدارية"],["SM","Services Marketing","التسويق الخدمي"],["SA","Strategic Management","الإدارة الإستراتيجية"],["TQM855","Quality Management","ادارة الجودة"],["IBA853","International Businesses Management","إدارة الأعمال الدولية"],["CM864","Crisis Management","إدارة الأزمات"],["IM","International Marketing","التسويق الدولي"],["CIM862","Contemporary Issues In Management","قضايا إدارية معاصرة"],["OT865","Organization Theory","نظرية المنظمة"],["MC864","Management Of Change","إدارة التغيير"],["MSE","Managerial Studies (in English)","دراسات إدارية باللغة الإنكليزية"],["OB923","Organization Behaviour","السلوك التنظيمي"],["SM924","Sales management","ادارة المبيعات"],["AA","Administrative accounting","المحاسبة الإدارية"],["MP934","Management Of Promotion","إدارة الترويج"],["COB942","Consumer Behaviour","سلوك المستهلك"],["ISP943","Individual-Selling Policies","سياسات البيع الشخصي"],["SM952","Strategic Marketing","التسويق الإستراتيجي"],["MR953","Marketing Research","بحوث التسويق"],["PDP954","Pricing and Distribution Policies","سياسات التسعير والتوزيع"],["MEC962","Marketing and Electronic Commerce","التسويق والتجارة الإلكترونية"],["CIM961","Contemporary Issues In Marketing","قضايا معاصرة في التسويق"],["INNO964","Innovative Marketing","التسويق الإبتكاري"],["IRM753","Insurance & Risk Management","إدارة التأمين والمخاطر"],["FA731","Financial Accounting1","المحاسبة المالية 1"],["FM740","Financial Management 1","الادارة المالية 1"],["BA742","Banking Administration","إدارة المصارف"],["BM743","Banks and Money","النقود والمصارف"],["FA745","Financial Accounting 2","المحاسبة المالية 2"],["IA750","Intermediate Accounting1","المحاسبة المتوسطة 1"],["FM751","Financial Management 2","الإدارة المالية 2"],["IA760","Intermediate accounting 2","المحاسبة المتوسطة 2"],["CB762","Commercial Banks","المصارف التجارية"],["IBF763","International banks and finance","المصارف الدولية والتمويل"],["IFO770","Islamic financial organizations","المؤسسات المالية الإسلامية"],["FB774","Financial Budgeting","الموازنة المالية"],["EB775","E-Banks","المصارف الإلكترونية"],["FAN780","Financial Analysis","مقرر التحليل المالي"],["CFBI781","Contemporary Financial and Banking Issues","قضايا مصرفية ومالية معاصرة"],["INVM773","Investment Management","إدارة الإستثمارات"],["BF783","Business Finance","تمويل المنظمات"],["ENG101","English Level 1","لغة إنكليزية مستوى 1"],["ENG102","English Level 2","لغة إنكليزية مستوى 2"],["PSP103","English Level 3 – Public Speaking","لغة إنكليزية مستوى 3"],["ENG104","English Level 4","لغة إنكليزية مستوى 4"],["ENG105","English Level 5","لغة إنكليزية مستوى 5"],["UNV101","Introduction to On-Line Education","مقدمة في التعلم الإلكتروني"],["CIS101","Computer Skills","مهارات الحاسوب"],["PHL201","Introduction to Philosophy","مقدمة في الفلسفة"],["SOC101","Introduction to Sociology","مقدمة في علم الإجتماع"],["UNV301","Career Preparation","تحضير السيرة المهنية"],["MTH160","Math with Business Applications","الرياضيات وتطبيقاتها في إدارة الأعمال"],["ITC100","Discrete Mathematics","الرياضيات المتقطعة"],["QMB240","Statistics","الإحصاء"],["BUS242","Introduction to Business","مقدمة في الأعمال"],["MGT250","Leadership and Management","القيادة والإدارة"],["MKT244","Introduction to Marketing","مقدمة في التسويق"],["ACG242","Introduction to Accounting","مقدمة في المحاسبة"],["MGT246","Introduction to Finance","مقدمة في المالية"],["MGT325","Banking and Finance","البنوك والمصارف"],["ITC110","Introduction to Operating Systems","مقدمة في نظم التشغيل"],["ITC200","Introduction to Networks","مقدمة في الشبكات"],["ITC220","Web Development and E-Commerce","الوب والتجارة الإلكترونية"],["ITC210","Introduction to Data Modeling","مقدمة في نمذجة المعطيات"],["ITC230","Introduction to Programming","مقدمة في البرمجة"],["MGT345","Project Management","إدارة المشاريع"],["ITD300","Data Base Architecture and Design","بنيان وتصميم قواعد المعطيات"],["ITA310","Object Oriented Programming and Design","التصميم والبرمجة غرضية التوجه"],["ITI300","Network Operating Systems","نظم التشغيل الشبكية"],["ITA320","Web Application Design and Development","تصميم وتطوير تطبيقات الوب"],["ITD310","Advanced SQL Programming","البرمجة المتقدمة بلغة SQL"],["ITADD430","Mobile Application","تطبيقات نقّالة"],["ITA330","Business Process Modeling","نمذجة إجراءات العمل"],["ITD410","MS-SQL Development and Administration","إدارة وتطوير أنظمة MS-SQL"],["ITI410","Data Security","أمن المعطيات"],["ITI310","Windows Platform 1","منصات ويندوز 1"],["ITD415","Advanced Data Base Administration I","إدارة قواعد المعطيات I"],["ITP390","Internship","مشروع تدريبي"],["ITI420","Data Networks","شبكات المعطيات"],["ITI320","Linux Platform","منصات لينوكس"],["ITD420","Advanced Database Administration II","إدارة قواعد المعطيات II"],["IND","Induction","الدراسات التمهيدية"],["EBD","eBusiness Development","تطوير الأعمال الإلكترونية"],["ECT","eCommerce Technology","تقنيات التجارة الإلكترونية"],["IS","Internet Studies","دراسات الانترنيت"],["ECP","eCommerce Project","مشروع في التجارة الإلكترونية"],["ECP1","eCommerce Project 1","مشروع في التجارة الإلكترونية 1"],["ECP2","eCommerce Project 2","مشروع في التجارة الإلكترونية 2"],["SCM","Supply Chain Management","إدارة السلسلة التموينية"],["WD","Website Design","تصميم مواقع الويب"],["MFC","Marketing for eCommerce","التسويق في التجارة الإلكترونية"],["MPP","eMarketing Processes in Practice","اجراءات التسويق الإلكتروني"],["IMC","Integrated Marketing in eCommerce","التواصل التسويقي المتكامل في التجارة الإلكترونية"],["MPI","Market Planning & Intelligence for eCommerce","مهارات التخطيط التسويقي في التجارة الإلكترونية"],["GMP","Global Marketplace","الأسواق العالمية"],["DHA","Data Handling and Analysis","دراسة وتحليل المعطيات"],["IP","Introduction to Programming","مقدمة إلى البرمجة"],["PP","Programming Principles","مبادئ البرمجة"],["DAD","Data Analysis & Database Design","تحليل المعلومات وتصميم قواعد المعطيات"],["PDS","Developing Personal Skills","تطوير المهارات الشخصية"],["TC","Technology Culture Dissemination and Strategies","نشر الثقافة التقانية واستراتيجياتها"],["HRTM","Managing Emerging High Technologies and Their Challenges","إدارة التقانات العالية البازغة وتحدياتها"],["IITDM","Managing Technological Development and Intermediate Institutions","إدارة التنمية التقانية والمؤسسات الوسيطة"],["TDT","Technology Transfer, Dissemination, Acquisition, and Development","نقل ونشر واكتساب وتحصيل وتطوير التقانة"],["ITTTC","International Experiences in Technology Transfer, Management, and Localization","التجارب الدولية في نقل وإدارة وتوطين التقانة"],["TTM","Technology Transfer Models","نماذج نقل التقانة"],["TMTH","Applied Research and Training / Graduation Project - Thesis","البحث التطبيقي والتدريب / مشروع التخرج- الأطروحة"],["QMS","Quality Management Systems","أنظمة إدارة الجودة"],["SCO","Statistical Process Control","الضبط الاحصائي للعمليات"],["STQMS","Quality Tools and Supporting Technologies for QMS Implementation","أدوات الجودة والتقانات الداعمة لتطبيق أنظمة إدارة الجودة"],["IAQCS","Internal Auditing of Quality Management Systems ISO 9001","التدقيق الداخلي لأنظمة إدارة الجودة ISO 9001"],["QMSS","Special Quality Control Systems","أنظمة ضبط الجودة الخاصة"],["RY","Reliability","الوثوقية"],["QMTH","Applied Research and Training / Graduation Project - Thesis","البحث التطبيقي والتدريب / مشروع التخرج- الأطروحة"]];

  const codeMap = new Map();
  const allList = [];

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = str => String(str || '').replace(/[&<>"']/g, ch => ESC_MAP[ch]);

  for (let i = 0; i < RAW.length; i++) {
    const row = RAW[i];
    const code = row[0];
    const en = row[1];
    const ar = row[2];
    const upper = code.toUpperCase();

    if (!codeMap.has(upper)) {
      const entry = { code, en, ar, alts: [] };
      codeMap.set(upper, entry);
      allList.push(entry);
    } else {
      const existing = codeMap.get(upper);
      if (existing.en !== en || existing.ar !== ar) {
        if (!existing.alts.some(a => a.en === en && a.ar === ar)) {
          existing.alts.push({ en, ar });
        }
      }
    }
  }

  const MaterialsDB = {
    get(rawCode) {
      if (!rawCode) return null;
      const key = String(rawCode).trim().toUpperCase();
      return codeMap.get(key) || null;
    },

    getName(rawCode, lang) {
      const mat = this.get(rawCode);
      if (!mat) return '';
      const currentLang = lang || (ns.I18N && ns.I18N.lang) || 'ar';
      return currentLang === 'en' ? (mat.en || mat.ar) : (mat.ar || mat.en);
    },

    getLabel(rawCode, lang) {
      const mat = this.get(rawCode);
      if (!mat) return String(rawCode || '');
      const currentLang = lang || (ns.I18N && ns.I18N.lang) || 'ar';
      const name = currentLang === 'en' ? (mat.en || mat.ar) : (mat.ar || mat.en);
      return mat.code + ' — ' + name;
    },

    getBadgeHtml(rawCode, options) {
      const opts = options || {};
      const mat = this.get(rawCode);
      const codeStr = mat ? mat.code : String(rawCode || '');
      const currentLang = opts.lang || (ns.I18N && ns.I18N.lang) || 'ar';
      if (!mat) {
        return '<span class="mtag mtag-material"><b>' + esc(codeStr) + '</b></span>';
      }
      const mainName = currentLang === 'en' ? (mat.en || mat.ar) : (mat.ar || mat.en);
      let title = mat.ar + ' / ' + mat.en;
      if (mat.alts && mat.alts.length) {
        title += ' (' + mat.alts.map(a => a.ar + ' / ' + a.en).join('; ') + ')';
      }
      return '<span class="mtag mtag-material" title="' + esc(title) + '"><b>' + esc(codeStr) + '</b> · ' + esc(mainName) + '</span>';
    },

    getTooltip(rawCode) {
      const mat = this.get(rawCode);
      if (!mat) return '';
      let t = mat.ar + ' / ' + mat.en;
      if (mat.alts && mat.alts.length) {
        t += ' (' + mat.alts.map(a => a.ar + ' / ' + a.en).join('; ') + ')';
      }
      return t;
    },

    search(query, limit) {
      const lim = typeof limit === 'number' ? limit : 50;
      if (!query) return allList.slice(0, lim);
      const q = String(query).trim().toLowerCase();
      const exactCode = [];
      const startsCode = [];
      const matchesName = [];

      for (let i = 0; i < allList.length; i++) {
        const item = allList[i];
        const codeLower = item.code.toLowerCase();
        const enLower = item.en.toLowerCase();
        const arLower = item.ar.toLowerCase();

        if (codeLower === q) {
          exactCode.push(item);
        } else if (codeLower.startsWith(q)) {
          startsCode.push(item);
        } else if (codeLower.includes(q) || enLower.includes(q) || arLower.includes(q)) {
          matchesName.push(item);
        } else if (item.alts && item.alts.some(a => a.en.toLowerCase().includes(q) || a.ar.toLowerCase().includes(q))) {
          matchesName.push(item);
        }
        if (exactCode.length + startsCode.length + matchesName.length >= lim * 2) break;
      }
      return exactCode.concat(startsCode, matchesName).slice(0, lim);
    },

    all() {
      return allList;
    },

    count() {
      return allList.length;
    }
  };

  ns.MaterialsDB = MaterialsDB;
})(globalThis);
} catch (err) {
  console.error("[SVU] module 04-materials.js failed to initialise:", err);
}
;
try {
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
} catch (err) {
  console.error("[SVU] module 05-lrec.js failed to initialise:", err);
}
;
try {
(function (ns) {
  'use strict';

  const BASE_DB_NAME = "lrec-library";
  const STORE_FILES = "files";
  const STORE_TRANSCRIPTS = "transcripts";
  const STORE_ENHANCED = "enhanced";
  let activeProfileId = "default";
  try {
    const savedProf = (window.SVU_PREFS && window.SVU_PREFS.get("svu.activeProfile.v1", "default")) || localStorage.getItem("svu.activeProfile.v1") || "default";
    if (savedProf && typeof savedProf === "string") {
      activeProfileId = savedProf.trim() || "default";
    }
  } catch (e) {}

  function getDbName() {
    if (!activeProfileId || activeProfileId === "default") {
      return BASE_DB_NAME;
    }
    return BASE_DB_NAME + "-" + activeProfileId.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(getDbName(), 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES, {
            keyPath: "id"
          });
        }
        if (!db.objectStoreNames.contains(STORE_TRANSCRIPTS)) {
          db.createObjectStore(STORE_TRANSCRIPTS, {
            keyPath: "id"
          });
        }
        if (!db.objectStoreNames.contains(STORE_ENHANCED)) {
          db.createObjectStore(STORE_ENHANCED, {
            keyPath: "id"
          });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function withStore(mode, fn, store = STORE_FILES) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      Promise.resolve(fn(tx.objectStore(store))).then(value => {
        result = value;
      }, reject);
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    });
  }
  const reqToPromise = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  ns.LibraryDB = {
    available: typeof indexedDB !== "undefined",
    setProfile(profileId) {
      activeProfileId = (profileId && String(profileId).trim()) || "default";
    },
    getProfile() {
      return activeProfileId;
    },
    put: record => withStore("readwrite", store => reqToPromise(store.put(record))),
    get: id => withStore("readonly", store => reqToPromise(store.get(id))),
    updateMeta: (id, patch) => withStore("readwrite", async store => {
      const existing = await reqToPromise(store.get(id));
      if (!existing) return null;
      const updated = Object.assign({}, existing, patch);
      await reqToPromise(store.put(updated));
      const { blob, ...rest } = updated;
      return rest;
    }),
    remove: async id => {
      await withStore("readwrite", store => reqToPromise(store.delete(id)));
      await withStore("readwrite", store => reqToPromise(store.delete(id)), STORE_TRANSCRIPTS);
      await withStore("readwrite", store => reqToPromise(store.delete(id)), STORE_ENHANCED);
    },
    putEnhanced: record => withStore("readwrite", store => reqToPromise(store.put(record)), STORE_ENHANCED),
    getEnhanced: id => withStore("readonly", store => reqToPromise(store.get(id)), STORE_ENHANCED),
    putTranscript: record => withStore("readwrite", store => reqToPromise(store.put(record)), STORE_TRANSCRIPTS),
    getTranscript: id => withStore("readonly", store => reqToPromise(store.get(id)), STORE_TRANSCRIPTS),
    async list() {
      const records = await withStore("readonly", store => reqToPromise(store.getAll()));
      return records.map(({
        blob: blob,
        ...rest
      }) => rest).sort((a, b) => b.savedAt - a.savedAt);
    },
    async usage() {
      try {
        const estimate = await navigator.storage.estimate();
        const usage = {
          used: estimate.usage,
          quota: estimate.quota
        };
        return usage;
      } catch (err) {
        return null;
      }
    },
    persist() {
      try {
        return navigator.storage.persist();
      } catch (err) {
        return Promise.resolve(false);
      }
    }
  };
})(globalThis);
;

;
} catch (err) {
  console.error("[SVU] module 06-library-db.js failed to initialise:", err);
}
;
try {
(function () {
  'use strict';

  // Block context menu / text selection on app chrome, but keep them working in
  // editable fields (mobile long-press paste, cursor placement, text selection).
  const isEditable = el => !!(el && el.closest && el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
  document.addEventListener("contextmenu", event => { if (!isEditable(event.target)) event.preventDefault(); });
  document.addEventListener("dragstart", event => event.preventDefault());
  document.addEventListener("selectstart", event => { if (!isEditable(event.target)) event.preventDefault(); });
  const byId = id => document.getElementById(id);
  const getPref = (k, def) => (window.SVU_PREFS ? window.SVU_PREFS.get(k, def) : def);
  const setPref = (k, val) => {
    if (window.SVU_PREFS) {
      window.SVU_PREFS.set(k, val);
    } else {
      try { localStorage.setItem(k, val); } catch (e) {}
    }
  };
  const stage = byId("stage");
  const screen = byId("screen");
  const ctx = screen.getContext("2d");
  const audio = byId("audio");
  const controls = byId("controls");
  const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  let unlocked = false;
  const unlockAudio = () => {
    if (unlocked) {
      return;
    }
    unlocked = true;
    if (audio.src) {
      return;
    }
    audio.src = SILENT_WAV;
    const reset = () => {
      if (audio.src === SILENT_WAV) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
    };
    const playResult = audio.play();
    if (playResult && playResult.then) {
      playResult.then(reset, reset);
    } else {
      reset();
    }
  };
  const CAPTURE_ONCE = {
    capture: true,
    once: true
  };
  ["pointerdown", "touchend", "keydown", "click"].forEach(type => document.addEventListener(type, unlockAudio, CAPTURE_ONCE));
  const seek = byId("seek");
  const fill = byId("fill");
  const knob = byId("knob");
  const tip = byId("tip");
  const ticks = byId("ticks");
  const msgs = byId("msgs");
  let session = null;
  let lastSize = [0, 0];
  let rafId = 0;
  let cursor = -1;
  let userScrolled = false;
  let wasPlaying = false;
  const formatTime = ms => {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const h = sec / 3600 | 0;
    const m = sec % 3600 / 60 | 0;
    const s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  };
  function setStage(cls) {
    stage.classList.remove("loading", "ready", "dragover");
    if (cls) {
      stage.classList.add(cls);
    }
  }
  async function openFile(file, opts = {}) {
    if (!file) {
      return;
    }
    if (byId("dlg").open) {
      byId("dlg").close();
    }
    closeSession();
    setStage("loading");
    byId("err").textContent = "";
    byId("stagename").textContent = t("readingFile");
    byId("barfill").style.width = "0%";
    try {
      const buffer = await file.arrayBuffer();
      const STAGES = {
        "Scanning file": [0, 0.02],
        "Decoding screen": [0.02, 0.6],
        "Decoding audio": [0.6, 1]
      };
      const parsed = await LREC.parseLrec(buffer, (label, frac) => {
        const [lo, hi] = STAGES[label] || [0, 1];
        byId("stagename").textContent = t({
          "Scanning file": "scanningFile",
          "Decoding screen": "decodingScreen",
          "Decoding audio": "loadingSession"
        }[label] || "loading");
        byId("barfill").style.width = ((lo + (hi - lo) * Math.min(1, frac)) * 100).toFixed(1) + "%";
      });
      loadSession(file, parsed);
      if (opts.autoplay) {
        audio.play().catch(() => {});
      }
    } catch (err) {
      console.error(err);
      byId("stagename").textContent = t("openFail");
      byId("err").textContent = /^Not an \.lrec/.test(err.message || "") ? t("notLrec") : String(err.message || err);
      byId("barfill").style.width = "0%";
      stage.classList.add("loading");
    }
  }
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" };
  const escHtml = str => String(str || "").replace(/[&<>"]/g, ch => ESC_MAP[ch]);

  function parseLrecFilename(rawName) {
    const base = String(rawName || "").replace(/\.[li]rec$/i, "");
    const parts = base.split("_").filter(Boolean);
    if (parts.length >= 6) {
      const dm = parts[5].match(/^(\d{4})(\d{2})(\d{2})/);
      return {
        college: parts[0],
        material: parts[1],
        cls: parts[2].replace(/^C/i, ""),
        term: parts[3],
        lesson: parts[4].replace(/^S/i, ""),
        date: dm ? (dm[1] + "-" + dm[2] + "-" + dm[3]) : parts[5]
      };
    }
    const info = {};
    const rest = [];
    for (const p of parts) {
      const dm = p.match(/^(20\d{2})(\d{2})(\d{2})\d*$/);
      if (dm && !info.date) {
        info.date = dm[1] + "-" + dm[2] + "-" + dm[3];
      } else if (/^C\d+$/i.test(p) && !info.cls) {
        info.cls = p.replace(/^C/i, "");
      } else if (/^[FSU]\d{2,4}$/i.test(p) && !info.term) {
        info.term = p;
      } else if (/^S\d+$/i.test(p) && !info.lesson) {
        info.lesson = p.replace(/^S/i, "");
      } else {
        rest.push(p);
      }
    }
    if (rest.length >= 2) {
      info.college = rest[0];
      info.material = rest[1];
    } else if (rest.length === 1) {
      info.material = rest[0];
    }
    return Object.keys(info).length >= 2 ? info : null;
  }

  function renderSessionMeta(name) {
    const metaEl = byId("meta");
    if (!metaEl) return;
    if (!name) {
      metaEl.innerHTML = "";
      return;
    }
    const info = parseLrecFilename(name);
    if (!info) {
      metaEl.innerHTML = "<span class=\"mtag mtag-file\" dir=\"ltr\">" + escHtml(name) + "</span>";
      return;
    }
    const tags = [];
    if (info.college) tags.push("<span class=\"mtag mtag-college\" title=\"" + escHtml(t("metaCollege")) + "\"><b>" + escHtml(info.college) + "</b></span>");
    if (info.material) {
      if (window.MaterialsDB) {
        tags.push(window.MaterialsDB.getBadgeHtml(info.material));
      } else {
        tags.push("<span class=\"mtag mtag-material\" title=\"" + escHtml(t("metaMaterial")) + "\"><b>" + escHtml(info.material) + "</b></span>");
      }
    }
    if (info.cls) tags.push("<span class=\"mtag mtag-class\">" + escHtml(t("metaClass")) + " " + escHtml(info.cls) + "</span>");
    if (info.term) tags.push("<span class=\"mtag mtag-term\">" + escHtml(info.term) + "</span>");
    if (info.lesson) tags.push("<span class=\"mtag mtag-lesson\">" + escHtml(t("metaLesson")) + " " + escHtml(info.lesson) + "</span>");
    if (info.date) tags.push("<span class=\"mtag mtag-date\">" + escHtml(info.date) + "</span>");
    tags.push("<span class=\"mtag mtag-file\" dir=\"ltr\" title=\"" + escHtml(name) + "\">" + escHtml(name) + "</span>");
    tags.push("<button id=\"exitSessionBtn\" class=\"exit-session-btn\" title=\"" + escHtml(t("exitSessionTitle")) + "\"><svg style=\"width:13px;height:13px;vertical-align:middle;margin-inline-end:4px\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><line x1=\"18\" y1=\"6\" x2=\"6\" y2=\"18\"/><line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"/></svg><span>" + escHtml(t("exitSession")) + "</span></button>");
    metaEl.innerHTML = tags.join("");
    const exitBtn = byId("exitSessionBtn");
    if (exitBtn) {
      exitBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeSession();
      });
    }
  }

  function loadSession(file, parsed) {
    const wav = LREC.pcmToWav(parsed.audio.pcm, parsed.audio.rate);
    const wavUrl = URL.createObjectURL(new Blob([wav], {
      type: "audio/wav"
    }));
    audio.src = wavUrl;
    audio.playbackRate = +byId("speed").value;
    audio.volume = +byId("vol").value;
    audio.muted = false;
    session = {
      durationMs: parsed.durationMs,
      vs: new LREC.VideoState(parsed.video),
      chat: parsed.chat,
      nodes: [],
      wavUrl: wavUrl,
      audio: parsed.audio,
      key: file.name
    };
    renderSessionMeta(file.name);
    const parsedMeta = parseLrecFilename(file.name);
    const matName = (window.MaterialsDB && parsedMeta && parsedMeta.material) ? window.MaterialsDB.getName(parsedMeta.material) : "";
    document.title = (matName ? (parsedMeta.material + " (" + matName + ") · " + (parsedMeta.lesson ? "S" + parsedMeta.lesson : file.name)) : file.name) + " | SVU Player";
    byId("vnotice").hidden = parsed.videoOk !== false;
    renderChat();
    renderTicks();
    seek.setAttribute("aria-valuemax", Math.floor(parsed.durationMs / 1000));
    controls.classList.remove("disabled");
    document.body.classList.add("has-session");
    try {
      const pm = parseLrecFilename(file.name) || {};
      const matTitle = (window.MaterialsDB && pm.material) ? window.MaterialsDB.getName(pm.material) : "";
      localStorage.setItem("svu_last_played", JSON.stringify({
        name: file.name,
        material: pm.material || "",
        matTitle: matTitle,
        lesson: pm.lesson || "",
        college: pm.college || "",
        term: pm.term || "",
        className: pm.className || pm.cls || "",
        date: pm.date || "",
        durationMs: parsed.durationMs || 0,
        ts: Date.now()
      }));
    } catch (_) {}
    setStage("ready");
    stage.classList.add("paused");
    seekTo(0);
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(frame);
    if (window.__lrec.onSession) {
      window.__lrec.onSession(session);
    }
  }
  function closeSession() {
    audio.pause();
    cancelAnimationFrame(rafId);
    if (session) {
      URL.revokeObjectURL(session.wavUrl);
      session = null;
      if (window.__lrec && window.__lrec.onClose) {
        window.__lrec.onClose();
      }
    }
    audio.removeAttribute("src");
    audio.load();
    controls.classList.add("disabled");
    renderSessionMeta("");
    ticks.innerHTML = "";
    msgs.innerHTML = "<div class=\"empty\" data-i18n=\"chatEmpty\"></div>";
    I18N.apply(msgs);
    byId("chatCount").textContent = "";
    cursor = -1;
    syncPlayIcon();
    document.body.classList.remove("has-session");
    if (window.__refreshHub) {
      window.__refreshHub();
    }
  }
  const AVATAR_COLORS = ["#6cb6ff", "#f2994a", "#6fcf97", "#bb86fc", "#f2c94c", "#56ccf2", "#eb5757", "#9bd1a8", "#ff9ec4", "#a5b4fc"];
  function colorFor(str) {
    let hash = 0;
    for (const ch of str) {
      hash = hash * 31 + ch.codePointAt(0) >>> 0;
    }
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }
  function renderChat() {
    msgs.innerHTML = "";
    const chat = session.chat;
    byId("chatCount").textContent = "(" + chat.length + ")";
    const allLbl = byId("chatAllMsgsLbl");
    if (allLbl) {
      allLbl.textContent = t("chatAllMessages", { n: chat.length });
    }
    if (!chat.length) {
      msgs.innerHTML = "<div class=\"empty\" data-i18n=\"chatNone\"></div>";
      I18N.apply(msgs);
      return;
    }
    const introEl = document.createElement("div");
    introEl.className = "chat-empty-intro";
    introEl.id = "chatEmptyIntro";
    introEl.textContent = t("chatEmptyAtStart");
    msgs.appendChild(introEl);

    for (const msg of chat) {
      const row = document.createElement("div");
      row.className = "msg";
      row.title = msg.date + "\n" + msg.user + "\n" + msg.conn;
      const avatar = document.createElement("div");
      avatar.className = "av";
      avatar.style.background = colorFor(msg.user);
      avatar.textContent = msg.name[0] || "?";
      const body = document.createElement("div");
      body.className = "bd";
      const who = document.createElement("div");
      who.className = "who";
      const nameEl = document.createElement("b");
      nameEl.textContent = msg.user;
      nameEl.style.color = colorFor(msg.user);
      const timeEl = document.createElement("span");
      timeEl.className = "time-link";
      timeEl.textContent = "▶ " + formatTime(msg.t);
      who.append(nameEl, timeEl);
      const text = document.createElement("div");
      text.className = "tx";
      text.dir = "auto";
      text.textContent = msg.text || "…";
      body.append(who, text);
      row.append(avatar, body);
      row.addEventListener("click", () => seekTo(msg.t / 1000));
      msgs.appendChild(row);
      session.nodes.push(row);
    }
    cursor = -1;
    updateChat(0, true);
  }
  function updateChat(now, force) {
    if (!session || !session.nodes.length) {
      return;
    }
    const chat = session.chat;
    const showAll = byId("showAll").checked;
    let count = 0;
    while (count < chat.length && chat[count].t <= now) {
      count++;
    }
    const introEl = byId("chatEmptyIntro");
    if (introEl) {
      introEl.hidden = showAll || count > 0;
    }
    if (count === cursor && !force) {
      return;
    }
    const forward = count > cursor;
    cursor = count;
    session.nodes.forEach((node, i) => {
      node.hidden = !showAll && i >= count;
      node.classList.toggle("future", showAll && i >= count);
      node.classList.toggle("latest", i === count - 1);
    });
    const latest = count > 0 ? session.nodes[count - 1] : null;
    if (latest && (forward || force) && !userScrolled) {
      latest.scrollIntoView({
        block: "nearest"
      });
    }
  }
  const PASSIVE = {
    passive: true
  };
  ["wheel", "touchmove"].forEach(type => msgs.addEventListener(type, () => {
    userScrolled = true;
    if (byId("chatJumpBtn")) byId("chatJumpBtn").hidden = false;
    clearTimeout(msgs._t);
    msgs._t = setTimeout(() => {
      userScrolled = false;
      if (byId("chatJumpBtn")) byId("chatJumpBtn").hidden = true;
    }, 4500);
  }, PASSIVE));
  if (byId("chatJumpBtn")) {
    byId("chatJumpBtn").addEventListener("click", () => {
      userScrolled = false;
      byId("chatJumpBtn").hidden = true;
      if (cursor >= 0 && session && session.nodes && session.nodes[cursor]) {
        session.nodes[cursor].scrollIntoView({ block: "center", behavior: "smooth" });
      } else {
        msgs.scrollTop = msgs.scrollHeight;
      }
    });
  }
  const syncBtn = byId("chatLiveSyncBtn");
  const allBtn = byId("chatAllMsgsBtn");
  const showAllCb = byId("showAll");

  function setChatMode(mode) {
    const isAll = mode === "all";
    if (showAllCb) showAllCb.checked = isAll;
    if (syncBtn) {
      syncBtn.classList.toggle("active", !isAll);
      syncBtn.setAttribute("aria-checked", String(!isAll));
    }
    if (allBtn) {
      allBtn.classList.toggle("active", isAll);
      allBtn.setAttribute("aria-checked", String(isAll));
    }
    if (session) {
      updateChat(audio.currentTime * 1000, true);
    }
  }

  if (syncBtn) syncBtn.addEventListener("click", () => setChatMode("sync"));
  if (allBtn) allBtn.addEventListener("click", () => setChatMode("all"));

  byId("showAll").addEventListener("change", () => {
    setChatMode(byId("showAll").checked ? "all" : "sync");
  });
  function renderTicks() {
    ticks.innerHTML = "";
    const duration = session.durationMs;
    for (const msg of session.chat) {
      const tick = document.createElement("i");
      tick.className = "tick";
      tick.style.left = (msg.t * 100 / duration).toFixed(3) + "%";
      ticks.appendChild(tick);
    }
  }
  function currentMs() {
    return Math.min(session.durationMs, audio.currentTime * 1000);
  }
  function seekTo(sec) {
    if (!session) {
      return;
    }
    const time = Math.max(0, Math.min(session.durationMs / 1000, sec));
    audio.currentTime = time;
    session.vs.seek(time * 1000, true);
    session.vs.draw(ctx, screen);
    renderTime(time * 1000);
    updateChat(time * 1000, true);
  }
  function seekBy(deltaSec) {
    if (!session) {
      return;
    }
    seekTo(audio.currentTime + deltaSec);
  }
  function drawFrame() {
    if (!session) {
      return;
    }
    session.vs.draw(ctx, screen);
  }
  function syncPlayIcon() {
    const playing = !audio.paused && !audio.ended;
    byId("icoPlay").style.display = playing ? "none" : "";
    byId("icoPause").style.display = playing ? "" : "none";
    stage.classList.toggle("paused", !playing);
  }
  function togglePlay() {
    if (!session) {
      return;
    }
    if (audio.paused || audio.ended) {
      if (audio.ended || currentMs() >= session.durationMs - 50) {
        seekTo(0);
      }
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }
  function renderTime(ms) {
    const duration = session.durationMs;
    const frac = Math.min(1, ms / duration);
    fill.style.width = (frac * 100).toFixed(3) + "%";
    knob.style.left = (frac * 100).toFixed(3) + "%";
    byId("time").textContent = formatTime(ms) + " / " + formatTime(duration);
    byId("tCur").textContent = formatTime(ms);
    byId("tTot").textContent = formatTime(duration);
    seek.setAttribute("aria-valuenow", Math.floor(ms / 1000));
    seek.setAttribute("aria-valuetext", formatTime(ms) + " of " + formatTime(duration));
  }
  function frame() {
    rafId = requestAnimationFrame(frame);
    if (!session) {
      return;
    }
    const now = currentMs();
    if (session.vs.seek(now)) {
      session.vs.draw(ctx, screen);
    }
    if (screen.width !== lastSize[0] || screen.height !== lastSize[1]) {
      lastSize = [screen.width, screen.height];
      stage.style.setProperty("--ar", screen.width + " / " + screen.height);
    }
    renderTime(now);
    updateChat(now, false);
    if (window.__lrec.onTick) {
      window.__lrec.onTick(now);
    }
  }
  audio.addEventListener("play", syncPlayIcon);
  audio.addEventListener("pause", syncPlayIcon);
  audio.addEventListener("ended", syncPlayIcon);
  function seekFromPointer(event) {
    const rect = seek.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * session.durationMs / 1000;
  }
  seek.addEventListener("pointerdown", event => {
    if (!session) {
      return;
    }
    seek.setPointerCapture(event.pointerId);
    seek.classList.add("drag");
    wasPlaying = !audio.paused;
    audio.pause();
    seekTo(seekFromPointer(event));
  });
  seek.addEventListener("pointermove", event => {
    if (!session) {
      return;
    }
    const sec = seekFromPointer(event);
    const rect = seek.getBoundingClientRect();
    tip.textContent = formatTime(sec * 1000);
    tip.style.left = Math.max(24, Math.min(rect.width - 24, event.clientX - rect.left)) + "px";
    if (seek.classList.contains("drag")) {
      seekTo(sec);
    }
  });
  const endDrag = event => {
    if (!seek.classList.contains("drag")) {
      return;
    }
    seek.classList.remove("drag");
    if (wasPlaying) {
      audio.play().catch(() => {});
    }
  };
  seek.addEventListener("pointerup", endDrag);
  seek.addEventListener("pointercancel", endDrag);
  byId("play").addEventListener("click", togglePlay);
  byId("bigplay").addEventListener("click", togglePlay);
  screen.addEventListener("click", togglePlay);
  byId("back").addEventListener("click", () => seekBy(-10));
  byId("fwd").addEventListener("click", () => seekBy(10));
  byId("speed").addEventListener("change", event => {
    audio.playbackRate = +event.target.value;
  });
  byId("vol").addEventListener("input", event => {
    audio.volume = +event.target.value;
    audio.muted = false;
    syncVolumeIcon();
  });
  byId("mute").addEventListener("click", () => {
    audio.muted = !audio.muted;
    syncVolumeIcon();
  });
  function syncVolumeIcon() {
    const muted = audio.muted || audio.volume === 0;
    byId("icoVol").style.display = muted ? "none" : "";
    byId("icoMute").style.display = muted ? "" : "none";
  }
  const isLandscapeMobile = () => (window.innerHeight <= 560 && window.innerWidth > window.innerHeight);

  const toggleChat = () => {
    if (isLandscapeMobile()) {
      const open = document.body.classList.toggle("chat-drawer-open");
      byId("chatToggle").classList.toggle("on", open);
      byId("chatToggle").setAttribute("aria-pressed", String(open));
    } else {
      const hidden = document.body.classList.toggle("nochat");
      byId("chatToggle").classList.toggle("on", !hidden);
      byId("chatToggle").setAttribute("aria-pressed", String(!hidden));
    }
  };
  byId("chatToggle").addEventListener("click", toggleChat);
  if (byId("chatClose")) {
    byId("chatClose").addEventListener("click", () => {
      if (document.body.classList.contains("chat-drawer-open")) {
        document.body.classList.remove("chat-drawer-open");
        byId("chatToggle").classList.remove("on");
        byId("chatToggle").setAttribute("aria-pressed", "false");
      } else {
        toggleChat();
      }
    });
  }

  // Pin / Auto-hide bottom controls + 3-second mouse movement visibility inside player window
  let mouseIdleTimer = null;
  let isHoveringControls = false;
  let isForceHidden = false;
  let forceHideTime = 0;
  const stageWrap = stage.closest(".stage-wrap") || stage;
  const stageBackBtn = byId("stageBackToHubBtn");
  const hideControlsBtn = byId("hideControlsBtn");

  function forceHideAll() {
    isForceHidden = true;
    forceHideTime = Date.now();
    if (mouseIdleTimer) {
      clearTimeout(mouseIdleTimer);
      mouseIdleTimer = null;
    }
    if (cinemaTimer) {
      clearTimeout(cinemaTimer);
      cinemaTimer = null;
    }
    document.body.classList.add("controls-forced-hidden");
    controls.classList.add("force-hidden");
    controls.classList.remove("mouse-active", "active");
    if (stageBackBtn) stageBackBtn.classList.remove("visible");
    stageWrap.classList.add("cursor-none");
  }

  function unhideAll() {
    if (!isForceHidden) return;
    isForceHidden = false;
    document.body.classList.remove("controls-forced-hidden");
    controls.classList.remove("force-hidden");
    stageWrap.classList.remove("cursor-none");
    showControlsOnMouseActivity();
  }

  function handleUserMovement(e) {
    if (isForceHidden) {
      if (Date.now() - forceHideTime < 450) return;
      unhideAll();
      return;
    }
    showControlsOnMouseActivity();
  }

  function showControlsOnMouseActivity() {
    if (isForceHidden) return;
    controls.classList.add("mouse-active");
    if (stageBackBtn) stageBackBtn.classList.add("visible");
    if (mouseIdleTimer) {
      clearTimeout(mouseIdleTimer);
    }
    mouseIdleTimer = setTimeout(() => {
      if (!isHoveringControls && !controls.classList.contains("pinned")) {
        controls.classList.remove("mouse-active");
        if (stageBackBtn) stageBackBtn.classList.remove("visible");
      }
    }, 3000);
  }

    stage.addEventListener("pointerdown", () => {
    if (isForceHidden && Date.now() - forceHideTime > 200) {
      unhideAll();
    }
  });
  stageWrap.addEventListener("mousemove", handleUserMovement, { passive: true });
  stageWrap.addEventListener("pointermove", handleUserMovement, { passive: true });
  stageWrap.addEventListener("mouseleave", () => {
    if (mouseIdleTimer) {
      clearTimeout(mouseIdleTimer);
      mouseIdleTimer = null;
    }
    if (!controls.classList.contains("pinned")) {
      controls.classList.remove("mouse-active");
      if (stageBackBtn) stageBackBtn.classList.remove("visible");
    }
  });
  controls.addEventListener("mouseenter", () => {
    isHoveringControls = true;
    controls.classList.add("mouse-active");
    if (stageBackBtn) stageBackBtn.classList.add("visible");
    if (mouseIdleTimer) {
      clearTimeout(mouseIdleTimer);
    }
  });
  controls.addEventListener("mouseleave", () => {
    isHoveringControls = false;
    handleUserMovement();
  });

  if (stageBackBtn) {
    stageBackBtn.addEventListener("mouseenter", () => {
      isHoveringControls = true;
      if (mouseIdleTimer) clearTimeout(mouseIdleTimer);
    });
    stageBackBtn.addEventListener("mouseleave", () => {
      isHoveringControls = false;
      handleUserMovement();
    });
  }

  if (hideControlsBtn) {
    hideControlsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      forceHideAll();
    });
  }

  const setPinned = on => {
    controls.classList.toggle("pinned", !!on);
    if (stageBackBtn) stageBackBtn.classList.toggle("pinned", !!on);
    if (byId("pinBtn")) {
      byId("pinBtn").classList.toggle("on", !!on);
      byId("pinBtn").setAttribute("aria-pressed", String(!!on));
    }
    setPref("svu.pinControls", on ? "1" : "0");
  };
  if (byId("pinBtn")) {
    const pinnedStored = getPref("svu.pinControls", "0");
    setPinned(pinnedStored === "1");
    byId("pinBtn").addEventListener("click", () => {
      setPinned(!controls.classList.contains("pinned"));
    });
  }
  const setStretch = on => {
    stage.classList.toggle("stretch", on);
    byId("stretchBtn").classList.toggle("on", on);
    byId("stretchBtn").setAttribute("aria-pressed", String(on));
    setPref("lrec.stretch", on ? "1" : "0");
  };
  const toggleStretch = () => setStretch(!stage.classList.contains("stretch"));
  byId("stretchBtn").addEventListener("click", toggleStretch);
  {
    const stored = getPref("lrec.stretch", "1");
    setStretch(stored === "1");
  }
  if (!document.documentElement.requestFullscreen && !document.documentElement.webkitRequestFullscreen) {
    byId("fsBtn").hidden = true;
  }
  byId("fsBtn").addEventListener("click", toggleFullscreen);
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      try { window.screen.orientation?.unlock?.(); } catch (e) {}
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().then(() => {
        if (window.matchMedia && window.matchMedia("(hover: none) and (pointer: coarse)").matches) {
          try { window.screen.orientation?.lock?.("landscape").catch(() => {}); } catch (e) {}
        }
      }).catch(() => {});
    }
  }
  document.addEventListener("fullscreenchange", () => document.body.classList.toggle("fs", !!document.fullscreenElement));

  // Touch Gestures, Double-Tap Seeking & Cinema Controls Overlay
  let lastTapTime = 0;
  let lastTapPos = { x: 0, y: 0 };
  let cinemaTimer = null;

  function showCinemaControls() {
    controls.classList.add("active", "mouse-active");
    if (stageBackBtn) stageBackBtn.classList.add("visible");
    if (cinemaTimer) clearTimeout(cinemaTimer);
    if (!audio.paused) {
      cinemaTimer = setTimeout(() => {
        if (!controls.matches(":hover") && !controls.classList.contains("pinned")) {
          controls.classList.remove("active", "mouse-active");
          if (stageBackBtn) stageBackBtn.classList.remove("visible");
        }
      }, 3200);
    }
  }

  function triggerRipple(elemId) {
    const el = byId(elemId);
    if (!el) return;
    el.classList.add("active");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("active"), 650);
  }

  stage.addEventListener("pointerup", event => {
    if (event.target.closest("button, a, input, select, .controls, .controls-zone, .loading-box, .mobile-touch-strip, .shortcut-strip")) {
      return;
    }
    if (document.body.classList.contains("chat-drawer-open")) {
      document.body.classList.remove("chat-drawer-open");
      if (byId("chatToggle")) {
        byId("chatToggle").classList.remove("on");
        byId("chatToggle").setAttribute("aria-pressed", "false");
      }
      return;
    }
    const now = Date.now();
    const rect = stage.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const relX = x / rect.width;
    const dt = now - lastTapTime;
    const dist = Math.hypot(event.clientX - lastTapPos.x, event.clientY - lastTapPos.y);

    if (dt < 320 && dist < 45) {
      lastTapTime = 0;
      if (relX < 0.35) {
        seekBy(-10);
        triggerRipple("doubleTapBack");
        try { navigator.vibrate?.(25); } catch (e) {}
      } else if (relX > 0.65) {
        seekBy(10);
        triggerRipple("doubleTapFwd");
        try { navigator.vibrate?.(25); } catch (e) {}
      } else {
        togglePlay();
        try { navigator.vibrate?.(25); } catch (e) {}
      }
    } else {
      lastTapTime = now;
      lastTapPos = { x: event.clientX, y: event.clientY };
      if (isLandscapeMobile() || window.innerWidth <= 768) {
        if (controls.classList.contains("active") || controls.classList.contains("mouse-active")) {
          controls.classList.remove("active", "mouse-active");
          if (stageBackBtn) stageBackBtn.classList.remove("visible");
        } else {
          showCinemaControls();
        }
      }
    }
  });

  audio.addEventListener("play", () => {
    document.body.classList.add("is-playing");
    if (isLandscapeMobile()) {
      if (cinemaTimer) clearTimeout(cinemaTimer);
      cinemaTimer = setTimeout(() => {
        if (!controls.matches(":hover") && !controls.classList.contains("pinned")) {
          controls.classList.remove("active", "mouse-active");
          if (stageBackBtn) stageBackBtn.classList.remove("visible");
        }
      }, 3200);
    }
  });
  audio.addEventListener("pause", () => {
    document.body.classList.remove("is-playing");
    controls.classList.add("active", "mouse-active");
    if (stageBackBtn) stageBackBtn.classList.add("visible");
  });
  document.addEventListener("keydown", event => {
    if (event.target.matches("input[type=range], select, input[type=checkbox]") && event.key !== " ") {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || !session) {
      return;
    }
    switch (event.key) {
      case " ":
      case "k":
        event.preventDefault();
        togglePlay();
        break;
      case "h":
      case "H":
        event.preventDefault();
        if (isForceHidden) {
          unhideAll();
        } else {
          forceHideAll();
        }
        break;
      case "Escape":
        if (isForceHidden) {
          event.preventDefault();
          unhideAll();
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        seekTo(audio.currentTime - (event.shiftKey ? 30 : 5));
        break;
      case "ArrowRight":
        event.preventDefault();
        seekTo(audio.currentTime + (event.shiftKey ? 30 : 5));
        break;
      case "j":
        seekTo(audio.currentTime - 10);
        break;
      case "l":
        seekTo(audio.currentTime + 10);
        break;
      case "ArrowUp":
        event.preventDefault();
        audio.volume = Math.min(1, audio.volume + 0.05);
        byId("vol").value = audio.volume;
        syncVolumeIcon();
        break;
      case "ArrowDown":
        event.preventDefault();
        audio.volume = Math.max(0, audio.volume - 0.05);
        byId("vol").value = audio.volume;
        syncVolumeIcon();
        break;
      case "m":
        audio.muted = !audio.muted;
        syncVolumeIcon();
        break;
      case "f":
        toggleFullscreen();
        break;
      case "c":
        toggleChat();
        break;
      case "s":
        toggleStretch();
        break;
      case "Home":
        seekTo(0);
        break;
      case "End":
        seekTo(session.durationMs / 1000);
        break;
    }
  });
  const fileInput = byId("file");
  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    if (byId("dlg") && byId("dlg").open) {
      byId("dlg").close();
    }
    if (typeof window.__svuHandleLocalFileOpen === "function") {
      window.__svuHandleLocalFileOpen(f);
    } else {
      openFile(f, { autoplay: true });
    }
  });
  ["dragenter", "dragover"].forEach(type => window.addEventListener(type, event => {
    event.preventDefault();
    document.body.classList.add("dragging");
    if (!stage.classList.contains("loading")) {
      stage.classList.add("dragover");
    }
  }));
  ["dragleave", "drop"].forEach(type => window.addEventListener(type, event => {
    event.preventDefault();
    document.body.classList.remove("dragging");
    stage.classList.remove("dragover");
  }));
  window.addEventListener("drop", event => {
    const file = event.dataTransfer.files[0];
    if (file) {
      if (byId("dlg") && byId("dlg").open) {
        byId("dlg").close();
      }
      if (typeof window.__svuHandleLocalFileOpen === "function") {
        window.__svuHandleLocalFileOpen(file);
      } else {
        openFile(file, { autoplay: true });
      }
    }
  });
  I18N.setLang(I18N.lang, true);
  byId("langBtn").addEventListener("click", () => I18N.toggle());

  // Theme & Dark/Light Mode Manager (9 Themes + Dark/Light Mode) — Persistent across refresh & restart
  const THEME_KEYS = {
    default: "themeDefault",
    whatsapp: "themeWhatsapp",
    telegram: "themeTelegram",
    win98: "themeWin98",
    winxp: "themeWinxp",
    win7: "themeWin7",
    hacker: "themeHacker",
    vscode: "themeVscode",
    terminal: "themeTerminal"
  };
  let curTheme = getPref("svu.theme", "default");
  let curMode = getPref("svu.mode", "dark");
  if (!THEME_KEYS[curTheme]) {
    curTheme = "default";
  }
  function applyTheme(theme, mode) {
    curTheme = THEME_KEYS[theme] ? theme : "default";
    curMode = mode === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = curTheme;
    document.documentElement.dataset.mode = curMode;
    setPref("svu.theme", curTheme);
    setPref("svu.mode", curMode);
    const lbl = byId("curThemeLbl");
    if (lbl) {
      lbl.dataset.i18n = "themesBtn";
      lbl.textContent = t("themesBtn");
    }
    document.querySelectorAll(".theme-opt[data-theme-opt]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.themeOpt === curTheme);
    });
    document.querySelectorAll(".m-theme-opt[data-theme-opt]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.themeOpt === curTheme);
    });
    const modeBtn = byId("mobileModeToggle");
    if (modeBtn) {
      const darkSeg = modeBtn.querySelector("[data-mode='dark']");
      const lightSeg = modeBtn.querySelector("[data-mode='light']");
      if (darkSeg && lightSeg) {
        darkSeg.classList.toggle("active", curMode === "dark");
        darkSeg.setAttribute("aria-checked", String(curMode === "dark"));
        lightSeg.classList.toggle("active", curMode === "light");
        lightSeg.setAttribute("aria-checked", String(curMode === "light"));
      }
      const darkTag = modeBtn.querySelector(".mode-tag.dark");
      const lightTag = modeBtn.querySelector(".mode-tag.light");
      if (darkTag && lightTag) {
        darkTag.style.display = curMode === "dark" ? "" : "none";
        lightTag.style.display = curMode === "light" ? "" : "none";
      }
    }
  }
  applyTheme(curTheme, curMode);
  window.__svuApplyTheme = applyTheme;
  window.__svuGetTheme = () => ({ theme: curTheme, mode: curMode });
  if (byId("themeBtn")) {
    byId("themeBtn").addEventListener("click", () => {
      applyTheme(curTheme, curMode === "light" ? "dark" : "light");
    });
  }
  if (byId("themeMenuBtn") && byId("themeDropdown")) {
    byId("themeMenuBtn").addEventListener("click", event => {
      event.stopPropagation();
      byId("themeDropdown").classList.toggle("open");
    });
    document.querySelectorAll(".theme-opt[data-theme-opt]").forEach(btn => {
      btn.addEventListener("click", event => {
        event.stopPropagation();
        applyTheme(btn.dataset.themeOpt, curMode);
        byId("themeDropdown").classList.remove("open");
      });
    });
    document.addEventListener("click", () => {
      byId("themeDropdown").classList.remove("open");
    });
  }
  document.addEventListener("langchange", () => {
    applyTheme(curTheme, curMode);
    if (session && session.key) {
      renderSessionMeta(session.key);
    }
    const allLbl = byId("chatAllMsgsLbl");
    if (allLbl && session && session.chat) {
      allLbl.textContent = t("chatAllMessages", { n: session.chat.length });
    }
    const introEl = byId("chatEmptyIntro");
    if (introEl) {
      introEl.textContent = t("chatEmptyAtStart");
    }
  });

  // PWA Offline Install & Local Server Deployment Manager
  let deferredPwaPrompt = null;
  const isStandalone = () =>
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true;

  function syncPwaButtons() {
    const installed = isStandalone();
    const hdrBtn = byId("installPwaBtn");
    const abtBtn = byId("aboutInstallBtn");
    if (hdrBtn) {
      hdrBtn.hidden = installed;
    }
    if (abtBtn) {
      const span = abtBtn.querySelector("span");
      if (installed) {
        abtBtn.disabled = true;
        if (span) {
          span.dataset.i18n = "pwaInstalled";
          span.textContent = t("pwaInstalled");
        }
      } else {
        abtBtn.disabled = false;
        if (span) {
          span.dataset.i18n = "installPwa";
          span.textContent = t("installPwa");
        }
      }
    }
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredPwaPrompt = event;
    syncPwaButtons();
  });

  window.addEventListener("appinstalled", () => {
    deferredPwaPrompt = null;
    syncPwaButtons();
    const hint = byId("pwaHint");
    if (hint) {
      hint.textContent = t("pwaInstalled");
      hint.classList.add("ok");
    }
  });

  async function triggerPwaInstall(fromAbout) {
    if (deferredPwaPrompt) {
      try {
        deferredPwaPrompt.prompt();
        const choice = await deferredPwaPrompt.userChoice;
        if (choice && choice.outcome === "accepted") {
          deferredPwaPrompt = null;
        }
      } catch (err) {}
      syncPwaButtons();
      return;
    }
    if (!fromAbout && byId("about") && !byId("about").open) {
      byId("about").showModal();
    }
    const pwaBox = byId("aboutPwaCard");
    if (pwaBox) {
      pwaBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
      pwaBox.classList.add("pulse-card");
      setTimeout(() => pwaBox.classList.remove("pulse-card"), 1400);
    }
  }

  if (byId("installPwaBtn")) {
    byId("installPwaBtn").addEventListener("click", () => triggerPwaInstall(false));
  }
  if (byId("aboutInstallBtn")) {
    byId("aboutInstallBtn").addEventListener("click", () => triggerPwaInstall(true));
  }
  if (byId("copyServerCmdBtn")) {
    byId("copyServerCmdBtn").addEventListener("click", () => {
      const cmdText = "python3 serve.py";
      const btn = byId("copyServerCmdBtn");
      const done = () => {
        btn.textContent = t("copiedCmd");
        setTimeout(() => {
          btn.textContent = t("copyCmd");
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmdText).then(done, done);
      } else {
        done();
      }
    });
  }
  syncPwaButtons();

  byId("aboutBtn").addEventListener("click", () => byId("about").showModal());
  byId("aboutClose").addEventListener("click", () => byId("about").close());
  byId("about").addEventListener("click", event => {
    if (event.target === byId("about")) {
      byId("about").close();
    }
  });
  // Mobile Quick Menu Action Sheet Controller
  const sheet = byId("mobileMenuSheet");
  const sheetBackdrop = byId("mobileSheetBackdrop");
  const moreBtn = byId("mobileMoreBtn");
  const sheetClose = byId("mobileSheetClose");

  function syncMobileBadges() {
    const count = byId("libHeaderCount")?.textContent || "";
    if (byId("mobileLibBadge")) byId("mobileLibBadge").textContent = count;
    const prof = byId("activeProfileLbl")?.textContent || "البروفايل";
    if (byId("mobileProfileName")) byId("mobileProfileName").textContent = prof;
  }

  function openMobileSheet() {
    if (!sheet) return;
    syncMobileBadges();
    sheet.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
    sheet.style.visibility = "visible";
    sheet.style.pointerEvents = "auto";
    if (sheetBackdrop) {
      sheetBackdrop.classList.add("open");
      sheetBackdrop.setAttribute("aria-hidden", "false");
      sheetBackdrop.style.visibility = "visible";
      sheetBackdrop.style.pointerEvents = "auto";
    }
    document.body.style.overflow = "hidden";
  }

  function closeMobileSheet() {
    if (!sheet) return;
    sheet.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
    sheet.style.visibility = "hidden";
    sheet.style.pointerEvents = "none";
    if (sheetBackdrop) {
      sheetBackdrop.classList.remove("open");
      sheetBackdrop.setAttribute("aria-hidden", "true");
      sheetBackdrop.style.visibility = "hidden";
      sheetBackdrop.style.pointerEvents = "none";
    }
    document.body.style.overflow = "";
  }

  if (moreBtn) moreBtn.addEventListener("click", openMobileSheet);
  if (sheetClose) sheetClose.addEventListener("click", closeMobileSheet);
  if (sheetBackdrop) sheetBackdrop.addEventListener("click", closeMobileSheet);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && sheet && sheet.classList.contains("open")) {
      closeMobileSheet();
    }
  });

  if (byId("mobileLibBtn")) {
    byId("mobileLibBtn").addEventListener("click", () => {
      closeMobileSheet();
      if (window.openBrowseDialog) {
        window.openBrowseDialog("saved");
      } else if (byId("libHeaderBtn")) {
        byId("libHeaderBtn").click();
      }
    });
  }
  if (byId("mobileBatchBtn")) {
    byId("mobileBatchBtn").addEventListener("click", () => {
      closeMobileSheet();
      if (window.openBrowseDialog) {
        window.openBrowseDialog("batch");
      } else if (byId("tabBatch")) {
        byId("tabBatch").click();
        if (byId("dlg")) byId("dlg").showModal();
      }
    });
  }
  if (byId("mobilePwaBtn")) {
    byId("mobilePwaBtn").addEventListener("click", () => {
      closeMobileSheet();
      if (byId("installPwaBtn")) byId("installPwaBtn").click();
    });
  }
  if (byId("mobileGuideBtn")) {
    byId("mobileGuideBtn").addEventListener("click", () => {
      closeMobileSheet();
      if (window.__lrec && window.__lrec.showTour) {
        window.__lrec.showTour();
      } else if (byId("welcome")) {
        byId("welcome").showModal();
      }
    });
  }
  if (byId("mobileAboutBtn")) {
    byId("mobileAboutBtn").addEventListener("click", () => {
      closeMobileSheet();
      if (byId("aboutBtn")) byId("aboutBtn").click();
    });
  }
  // Item 5: Quick Menu - clicking the big boxes also triggers profile and theme toggle
  function openMobileProfileManager() {
    closeMobileSheet();
    const profileBtn = byId("profileBtn");
    if (profileBtn) {
      profileBtn.click();
    } else {
      const profileDlg = byId("profileDlg");
      if (profileDlg) {
        if (byId("profEditor")) byId("profEditor").hidden = true;
        profileDlg.showModal();
      }
    }
  }

  const mobileProfileCard = byId("mobileProfileCard");
  if (mobileProfileCard) {
    mobileProfileCard.addEventListener("click", openMobileProfileManager);
  }
  const mobileProfileManageBtn = byId("mobileProfileManageBtn");
  if (mobileProfileManageBtn) {
    mobileProfileManageBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMobileProfileManager();
    });
  }

  const mobileModeToggle = byId("mobileModeToggle");
  if (mobileModeToggle) {
    mobileModeToggle.addEventListener("click", (e) => {
      const seg = e.target.closest("[data-mode]");
      if (seg && seg.dataset.mode) {
        applyTheme(curTheme, seg.dataset.mode);
      } else {
        applyTheme(curTheme, curMode === "light" ? "dark" : "light");
      }
    });
  }
  document.querySelectorAll(".m-theme-opt[data-theme-opt]").forEach(btn => {
    btn.addEventListener("click", () => {
      applyTheme(btn.dataset.themeOpt, curMode);
    });
  });

  // Responsive Orientation & Viewport Handler
  function handleScreenResize() {
    const isPortrait = window.innerWidth <= 768 && window.innerHeight > window.innerWidth;
    const isLandscape = isLandscapeMobile();
    document.body.classList.toggle("is-mobile-portrait", isPortrait);
    document.body.classList.toggle("is-mobile-landscape", isLandscape);
    if (!isLandscape && document.body.classList.contains("chat-drawer-open")) {
      document.body.classList.remove("chat-drawer-open");
    }
  }
  window.addEventListener("resize", handleScreenResize, PASSIVE);
  window.addEventListener("orientationchange", () => setTimeout(handleScreenResize, 150), PASSIVE);
  handleScreenResize();

  window.__closeActiveSession = closeSession;
  window.__lrec = {
    get session() {
      return session;
    },
    audio: audio,
    seekTo: seekTo,
    openFile: openFile,
    closeSession: closeSession
  };

  // Stage Upper Corner & Header Return to Hub buttons (with Fullscreen Exit)
  function returnToHubWithFsExit() {
    if (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
    if (document.body.classList.contains("fs")) {
      document.body.classList.remove("fs");
    }
    closeSession();
  }

  if (stageBackBtn) {
    stageBackBtn.addEventListener("click", returnToHubWithFsExit);
  }
  const headerBackBtn = byId("headerBackToHubBtn");
  if (headerBackBtn) {
    headerBackBtn.addEventListener("click", returnToHubWithFsExit);
  }
})();
;

;
} catch (err) {
  console.error("[SVU] module 07-player.js failed to initialise:", err);
}
;
try {
(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const dialog = byId("dlg");
  const getPref = (k, def) => (window.SVU_PREFS ? window.SVU_PREFS.get(k, def) : def);
  const setPref = (k, val) => {
    if (window.SVU_PREFS) {
      window.SVU_PREFS.set(k, val);
    } else {
      try { localStorage.setItem(k, val); } catch (e) {}
    }
  };

  const CASCADE = [{
    key: "term",
    plural: "terms",
    sel: "selTerm",
    ph: "selTerm"
  }, {
    key: "program",
    plural: "programs",
    sel: "selProgram",
    ph: "selProgram"
  }, {
    key: "course",
    plural: "courses",
    sel: "selCourse",
    ph: "selCourse"
  }, {
    key: "tutor",
    plural: "tutors",
    sel: "selTutor",
    ph: "selTutor"
  }, {
    key: "class",
    plural: "classes",
    sel: "selClass",
    ph: "selClass"
  }];

  let termsLoaded = false;
  let cachedTerms = [];
  let controller = null;
  let selected = {};
  const DEFAULTS_KEY = "svu_student_defaults";
  function getStudentDefaults() {
    try {
      const raw = localStorage.getItem(DEFAULTS_KEY);
      return raw ? JSON.parse(raw) : { term: "", program: "" };
    } catch (_) {
      return { term: "", program: "" };
    }
  }
  function setStudentDefaults(term, program) {
    try {
      const cur = getStudentDefaults();
      const updated = {
        term: (term != null && term !== "") ? String(term).trim() : cur.term,
        program: (program != null && program !== "") ? String(program).trim() : cur.program
      };
      localStorage.setItem(DEFAULTS_KEY, JSON.stringify(updated));
    } catch (_) {}
  }
  let savedIds = new Set();
  let savedSignatures = new Set();
  let savedRecordsCache = [];
  let downloading = false;
  let sessions = [];

  // Watched lectures map persisted per profile in SVU_PREFS + IndexedDB
  const WATCHED_BASE_KEY = "svu.watched.v1";
  let watchedMap = {};
  function getWatchedKey() {
    const profId = (LibraryDB && LibraryDB.getProfile && LibraryDB.getProfile()) || "default";
    return profId === "default" ? WATCHED_BASE_KEY : (WATCHED_BASE_KEY + "." + profId);
  }
  function loadWatchedMap() {
    try {
      const k = getWatchedKey();
      const raw = localStorage.getItem(k) || getPref(k, "{}");
      watchedMap = JSON.parse(raw || "{}") || {};
    } catch (err) {
      watchedMap = {};
    }
  }
  loadWatchedMap();
  function saveWatchedMap() {
    try {
      const k = getWatchedKey();
      const s = JSON.stringify(watchedMap);
      try { localStorage.setItem(k, s); } catch (e) {}
      setPref(k, s);
    } catch (err) {}
  }
  function isLectureWatched(rec) {
    if (!rec) return false;
    if (watchedMap[rec.id] !== undefined) return !!watchedMap[rec.id];
    return !!rec.watched;
  }
  async function setLectureWatched(id, val) {
    watchedMap[id] = !!val;
    saveWatchedMap();
    if (LibraryDB.available && LibraryDB.updateMeta) {
      try {
        await LibraryDB.updateMeta(id, { watched: !!val });
      } catch (err) {}
    }
    const item = savedRecordsCache.find(r => r.id === id);
    if (item) item.watched = !!val;
    renderLibraryView();
  }

  // Auto-mark lecture as watched when playback finishes
  if (window.__lrec && window.__lrec.audio) {
    window.__lrec.audio.addEventListener("ended", () => {
      const s = window.__lrec.session;
      if (s && s.key && savedIds.has(s.key)) {
        setLectureWatched(s.key, true);
      }
    });
  }

  const formatSize = bytes => (bytes / 1048576).toFixed(bytes > 100000000 ? 0 : 1) + " MB";
  const ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;"
  };
  const escapeHtml = str => String(str || "").replace(/[&<>"]/g, ch => ESCAPES[ch]);

  const setStatus = (text, bad) => {
    const el = byId("rstatus");
    if (el) {
      el.textContent = text || "";
      el.classList.toggle("bad", !!bad);
    }
  };

  function showToast(message, isError) {
    if (!message) return;
    let toast = byId("studioToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "studioToast";
      toast.className = "studio-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.toggle("is-error", !!isError);
    toast.classList.add("is-visible");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 2800);
  }
  window.showToast = showToast;

  function normCode(str) {
    return String(str || "").trim().toUpperCase();
  }
  function normClass(str) {
    return String(str || "").trim().replace(/^C/i, "").toUpperCase();
  }
  function normLesson(str) {
    const m = String(str || "").trim().match(/(\d+)/);
    return m ? String(parseInt(m[1], 10)) : String(str || "").trim().replace(/^S/i, "").toUpperCase();
  }
  function makeLessonSig(term, college, material, cls, lesson) {
    const c = normCode(college);
    const m = normCode(material);
    const cl = normClass(cls);
    const l = normLesson(lesson);
    if (!m || !l) return "";
    return [normCode(term), c, m, cl, l].join("|");
  }

  function parseLrecNameMeta(rawName) {
    const base = String(rawName || "").replace(/\.[li]rec$/i, "");
    const parts = base.split("_").filter(Boolean);
    if (parts.length >= 6) {
      const dm = parts[5].match(/^(\d{4})(\d{2})(\d{2})/);
      return {
        college: parts[0],
        material: parts[1],
        className: parts[2].replace(/^C/i, ""),
        term: parts[3],
        lesson: parts[4].replace(/^S/i, ""),
        date: dm ? (dm[1] + "-" + dm[2] + "-" + dm[3]) : parts[5]
      };
    }
    const info = {};
    const rest = [];
    for (const p of parts) {
      const dm = p.match(/^(20\d{2})(\d{2})(\d{2})\d*$/);
      if (dm && !info.date) {
        info.date = dm[1] + "-" + dm[2] + "-" + dm[3];
      } else if (/^C\d+$/i.test(p) && !info.className) {
        info.className = p.replace(/^C/i, "");
      } else if (/^[FSU]\d{2,4}$/i.test(p) && !info.term) {
        info.term = p;
      } else if (/^S\d+$/i.test(p) && !info.lesson) {
        info.lesson = p.replace(/^S/i, "");
      } else {
        rest.push(p);
      }
    }
    if (rest.length >= 2) {
      info.college = rest[0];
      info.material = rest[1];
    } else if (rest.length === 1) {
      info.material = rest[0];
    }
    return info;
  }

  function enrichRecordMeta(rec) {
    const fromName = parseLrecNameMeta(rec.name || rec.id || "");
    const labelParts = String(rec.label || "").split("·").map(s => s.trim()).filter(Boolean);
    // label format when saved from catalog: [term, program, course, class, order, tutor]
    const fromLabel = labelParts.length >= 5 ? {
      term: labelParts[0],
      college: labelParts[1],
      material: labelParts[2],
      className: labelParts[3],
      lesson: labelParts[4],
      tutor: labelParts[5] || ""
    } : {};
    const m = rec.meta || {};
    const localGroup = !!m.localGroup;
    const college = normCode(m.college || fromName.college || fromLabel.college || "");
    const material = localGroup
      ? "__LOCAL_FILES__"
      : normCode(m.material || fromName.material || fromLabel.material || "OTHER");
    const className = normClass(m.className || fromName.className || fromLabel.className || "");
    const term = normCode(m.term || fromName.term || fromLabel.term || "");
    const lessonRaw = m.lesson || fromName.lesson || fromLabel.lesson || "";
    const lesson = normLesson(lessonRaw);
    const lessonNum = /^\d+$/.test(lesson) ? parseInt(lesson, 10) : 999;
    const tutor = m.tutor || fromLabel.tutor || "";
    const date = m.date || fromName.date || (rec.savedAt ? new Date(rec.savedAt).toISOString().slice(0, 10) : "");
    return {
      college,
      material,
      localGroup,
      className,
      term,
      lesson,
      lessonNum,
      tutor,
      date,
      rawIds: m.rawIds || null
    };
  }

  function initCustomCascadeDropdown(sel) {
    if (!sel || sel._svuDd) return sel ? sel._svuDd : null;

    const wrap = document.createElement("div");
    wrap.className = "svu-dd";
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "svu-dd-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    if (sel.id) trigger.id = sel.id + "_trigger";

    const valSpan = document.createElement("span");
    valSpan.className = "svu-dd-val";

    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("class", "svu-dd-chevron");
    chevron.setAttribute("viewBox", "0 0 24 24");
    chevron.setAttribute("width", "14");
    chevron.setAttribute("height", "14");
    chevron.setAttribute("fill", "none");
    chevron.setAttribute("stroke", "currentColor");
    chevron.setAttribute("stroke-width", "2");
    chevron.innerHTML = "<polyline points='6 9 12 15 18 9'/>";

    trigger.append(valSpan, chevron);
    wrap.appendChild(trigger);

    const menu = document.createElement("div");
    menu.className = "svu-dd-menu";
    menu.setAttribute("role", "listbox");
    menu.tabIndex = -1;
    menu.hidden = true;

    const searchBox = document.createElement("div");
    searchBox.className = "svu-dd-search-box";
    searchBox.innerHTML = "<svg viewBox='0 0 24 24' width='13' height='13' fill='none' stroke='currentColor' stroke-width='2'><circle cx='11' cy='11' r='8'/><line x1='21' y1='21' x2='16.65' y2='16.65'/></svg>";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "svu-dd-search";
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;
    searchBox.appendChild(searchInput);
    menu.appendChild(searchBox);

    const listEl = document.createElement("div");
    listEl.className = "svu-dd-list";
    menu.appendChild(listEl);
    wrap.appendChild(menu);

    function selectVal(val) {
      if (sel.value !== val) {
        sel.value = val;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      closeMenu();
      trigger.focus();
    }

    function filterItems(query) {
      const q = (query || "").trim().toLowerCase();
      let matches = 0;
      listEl.querySelectorAll(".svu-dd-item").forEach(item => {
        const match = !q || item.textContent.toLowerCase().includes(q);
        item.hidden = !match;
        if (match) matches++;
      });
      let noMatch = listEl.querySelector(".svu-dd-no-match");
      if (!matches) {
        if (!noMatch) {
          noMatch = document.createElement("div");
          noMatch.className = "svu-dd-no-match";
          noMatch.textContent = t("dropdownNoMatch") || "No matching options found";
          listEl.appendChild(noMatch);
        }
        noMatch.hidden = false;
      } else if (noMatch) {
        noMatch.hidden = true;
      }
    }

    function openMenu() {
      if (trigger.disabled) return;
      document.querySelectorAll(".svu-dd.is-open-menu").forEach(el => {
        if (el !== wrap && el._svuDdClose) el._svuDdClose();
      });

      wrap.classList.add("is-open-menu");
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");

      const rect = trigger.getBoundingClientRect();
      const scrollParent = dialog.querySelector(".dlg-body") || document.body;
      const pRect = scrollParent.getBoundingClientRect();
      const spaceBelow = pRect.bottom - rect.bottom;
      const spaceAbove = rect.top - pRect.top;
      wrap.classList.toggle("is-dropup", spaceBelow < 220 && spaceAbove > spaceBelow);

      if (!searchBox.hidden) {
        searchInput.value = "";
        filterItems("");
        setTimeout(() => searchInput.focus(), 25);
      } else {
        const selected = listEl.querySelector(".svu-dd-item.is-selected");
        if (selected) {
          selected.classList.add("is-focused");
          selected.scrollIntoView({ block: "nearest" });
        }
      }
    }

    function closeMenu() {
      wrap.classList.remove("is-open-menu");
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      listEl.querySelectorAll(".svu-dd-item.is-focused").forEach(it => it.classList.remove("is-focused"));
    }

    function refresh() {
      trigger.disabled = sel.disabled;
      const isEnabled = !sel.disabled && sel.options.length > 1;
      const hasVal = isEnabled && !!sel.value;
      trigger.classList.toggle("is-open", isEnabled);
      trigger.classList.toggle("has-val", hasVal);

      const selectedOpt = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
      valSpan.textContent = selectedOpt ? selectedOpt.textContent : (sel.options[0] ? sel.options[0].textContent : "");

      listEl.innerHTML = "";
      const opts = Array.from(sel.options);
      const showSearch = opts.length > 6;
      searchBox.hidden = !showSearch;
      if (showSearch) {
        searchInput.placeholder = t("dropdownSearchPh") || "Search or filter options…";
        searchInput.value = "";
      }

      opts.forEach(opt => {
        const item = document.createElement("div");
        item.className = "svu-dd-item";
        item.setAttribute("role", "option");
        item.dataset.val = opt.value;
        item.textContent = opt.textContent;
        const isSelected = opt.value === sel.value || (opt.selected && !sel.value);
        if (isSelected) {
          item.classList.add("is-selected");
          item.setAttribute("aria-selected", "true");
        }
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          selectVal(opt.value);
        });
        listEl.appendChild(item);
      });
    }

    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      if (wrap.classList.contains("is-open-menu")) {
        closeMenu();
      } else {
        openMenu();
      }
    });

    trigger.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openMenu();
      }
    });

    searchInput.addEventListener("input", () => filterItems(searchInput.value));
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeMenu();
        trigger.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const firstVisible = Array.from(listEl.querySelectorAll(".svu-dd-item")).find(it => !it.hidden);
        if (firstVisible) {
          firstVisible.classList.add("is-focused");
          firstVisible.focus();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const firstVisible = Array.from(listEl.querySelectorAll(".svu-dd-item")).find(it => !it.hidden);
        if (firstVisible) {
          selectVal(firstVisible.dataset.val);
        }
      }
    });

    listEl.addEventListener("keydown", (e) => {
      const items = Array.from(listEl.querySelectorAll(".svu-dd-item")).filter(it => !it.hidden);
      const curr = listEl.querySelector(".svu-dd-item.is-focused");
      let idx = items.indexOf(curr);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (idx < items.length - 1) idx++;
        else idx = 0;
        items.forEach(it => it.classList.remove("is-focused"));
        if (items[idx]) {
          items[idx].classList.add("is-focused");
          items[idx].scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (idx > 0) idx--;
        else idx = items.length - 1;
        items.forEach(it => it.classList.remove("is-focused"));
        if (items[idx]) {
          items[idx].classList.add("is-focused");
          items[idx].scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (curr) selectVal(curr.dataset.val);
      } else if (e.key === "Escape") {
        closeMenu();
        trigger.focus();
      }
    });

    if (sel.id) {
      const lbl = sel.form ? sel.form.querySelector("label[for='" + sel.id + "']") : document.querySelector("label[for='" + sel.id + "']");
      if (lbl) {
        lbl.addEventListener("click", (e) => {
          e.preventDefault();
          trigger.focus();
          openMenu();
        });
      }
    }

    wrap._svuDdClose = closeMenu;
    const instance = { wrap, trigger, valSpan, menu, refresh, open: openMenu, close: closeMenu };
    sel._svuDd = instance;
    refresh();
    return instance;
  }

  function syncCascadeStyles(root = dialog) {
    root.querySelectorAll(".cascade select, .b-course-selects select").forEach(sel => {
      const isEnabled = !sel.disabled && sel.options.length > 1;
      const hasVal = isEnabled && !!sel.value;
      sel.classList.toggle("is-open", isEnabled);
      sel.classList.toggle("has-val", hasVal);
      if (sel.id) {
        const lbl = root.querySelector("label[for=\"" + sel.id + "\"]");
        if (lbl) {
          lbl.classList.toggle("lbl-disabled", !isEnabled);
          lbl.classList.toggle("lbl-open", isEnabled && !hasVal);
          lbl.classList.toggle("lbl-chosen", hasVal);
        }
      }
      if (sel.closest && sel.closest(".cascade") && !sel.closest(".b-course-selects")) {
        if (!sel._svuDd) {
          initCustomCascadeDropdown(sel);
        } else {
          sel._svuDd.refresh();
        }
      }
    });
  }

  document.addEventListener("click", (e) => {
    document.querySelectorAll(".svu-dd.is-open-menu").forEach(wrap => {
      if (!wrap.contains(e.target)) {
        if (wrap._svuDdClose) wrap._svuDdClose();
      }
    });
  });
  if (dialog) {
    dialog.addEventListener("close", () => {
      document.querySelectorAll(".svu-dd.is-open-menu").forEach(wrap => {
        if (wrap._svuDdClose) wrap._svuDdClose();
      });
    });
  }

  async function fetchBrowse(params) {
    const browsePath = (window.CONFIG && window.CONFIG.api && window.CONFIG.api.browse) || "/api/browse";
    const qs = new URLSearchParams(params).toString();
    const resp = await fetch(browsePath + (qs ? "?" + qs : ""));
    let json = null;
    try {
      json = await resp.json();
    } catch (err) {
      json = null;
    }
    if (!resp.ok) {
      throw new Error((json && json.error) || ("HTTP " + resp.status));
    }
    return json || {};
  }

  const icon = name => "<svg class=\"i\"><use href=\"#i-" + name + "\"/></svg>";
  const iconLabel = (svg, key) => icon(svg) + "<span data-i18n=\"" + key + "\">" + t(key) + "</span>";

  function formatCourseDisplay(courseObj) {
    if (!courseObj) return "";
    const val = String(courseObj.value || "").trim();
    const rawLabel = String(courseObj.label || val).trim();
    if (!window.MaterialsDB || !val) return rawLabel;
    const mat = window.MaterialsDB.get(val);
    if (!mat) return rawLabel;
    const isEn = window.I18N && window.I18N.lang === "en";
    const primary = isEn ? (mat.en || mat.ar) : (mat.ar || mat.en);
    const secondary = isEn ? mat.ar : mat.en;
    if (secondary && secondary !== primary) {
      return mat.code + " — " + primary + " (" + secondary + ")";
    }
    return mat.code + " — " + primary;
  }

  function fillSelect(sel, items, placeholder, current) {
    if (!sel) return;
    sel.innerHTML = "";
    const placeholderOpt = new Option(t(placeholder), "");
    placeholderOpt.dataset.i18n = placeholder;
    sel.add(placeholderOpt);
    const curTrim = current != null ? String(current).trim() : "";
    let matchedVal = "";
    for (const item of items) {
      const displayLabel = (sel.id === "selCourse" && window.MaterialsDB)
        ? formatCourseDisplay(item)
        : item.label;
      sel.add(new Option(displayLabel, item.value));
      if (curTrim && (item.value === current || String(item.value).trim() === curTrim)) {
        matchedVal = item.value;
      }
    }
    sel.value = matchedVal;
    sel.disabled = !items.length;
    syncCascadeStyles();
  }

  function resetCascade(from) {
    for (let i = from; i < CASCADE.length; i++) {
      const sel = byId(CASCADE[i].sel);
      fillSelect(sel, [], CASCADE[i].ph);
      delete selected[CASCADE[i].key];
    }
    fillSelect(byId("selSession"), [], "selSession");
    sessions = [];
    byId("files").innerHTML = "";
    byId("filesBox").hidden = true;
    syncCascadeStyles();
  }

  async function onCascadeChange(index) {
    const stage = CASCADE[index];
    const value = byId(stage.sel).value;
    resetCascade(index + 1);
    if (!value) {
      setStatus("");
      syncCascadeStyles();
      return;
    }
    selected[stage.key] = value;
    if (index === 0) {
      setStudentDefaults(value, null);
    } else if (index === 1) {
      setStudentDefaults(null, value);
    }
    setBusy(true);
    setStatus(t("stLoading"));
    try {
      const json = await fetchBrowse(selected);
      for (let i = index + 1; i < CASCADE.length; i++) {
        const nextStage = CASCADE[i];
        const list = json[nextStage.plural];
        if (!Array.isArray(list)) {
          break;
        }
        const autoVal = json[nextStage.key] || (list.length === 1 ? list[0].value : "");
        fillSelect(byId(nextStage.sel), list, nextStage.ph, autoVal);
        if (!autoVal) {
          setStatus(list.length ? "" : t("stNothing"));
          setBusy(false);
          return;
        }
        selected[nextStage.key] = autoVal;
      }
      if (Array.isArray(json.sessions)) {
        showSessions(json.sessions);
      } else {
        setStatus("");
      }
    } catch (err) {
      setStatus(t("stCouldNotLoad", {
        e: err.message
      }), true);
    }
    setBusy(false);
  }

  function showSessions(items) {
    sessions = items;
    fillSelect(byId("selSession"), items.map(s => ({
      value: String(s.index),
      label: [s.order, s.date].filter(Boolean).join(" · ")
    })), "selSession");
    if (!items.length) {
      setStatus(t("noSessions"));
      return;
    }
    setStatus(t("stChooseSession"));
    if (items.length === 1) {
      byId("selSession").value = String(items[0].index);
      syncCascadeStyles();
      loadFiles(items[0]);
    }
  }

  byId("selSession").addEventListener("change", () => {
    syncCascadeStyles();
    const s = sessions.find(it => String(it.index) === byId("selSession").value);
    if (s) {
      loadFiles(s);
    } else {
      byId("files").innerHTML = "";
      byId("filesBox").hidden = true;
    }
  });

  async function loadFiles(s) {
    byId("files").innerHTML = "";
    byId("filesBox").hidden = true;
    setBusy(true);
    setStatus(t("stLoadingFiles"));
    try {
      const params = {
        ...selected
      };
      params.session = s.index;
      const json = await fetchBrowse(params);
      await refreshSaved();
      renderFiles(json.files || [], s);
      setStatus("");
    } catch (err) {
      setStatus(t("stFilesFail", {
        e: err.message
      }), true);
    }
    setBusy(false);
  }

  function renderFiles(files, s) {
    const box = byId("files");
    box.innerHTML = "";
    byId("filesBox").hidden = false;
    if (!files.length) {
      box.innerHTML = "<div class=\"muted\" data-i18n=\"noFiles\">" + t("noFiles") + "</div>";
      return;
    }
    const label = [s.term, s.program, s.course, s.class, s.order, s.tutor].filter(Boolean).join(" · ");
    const meta = {
      term: s.term,
      college: s.program,
      material: s.course,
      className: s.class,
      lesson: s.order,
      tutor: s.tutor,
      date: s.date,
      rawIds: { ...selected }
    };
    for (const file of files) {
      const row = document.createElement("div");
      row.className = "row-item static";
      row.innerHTML = "<b>" + escapeHtml(file.description || file.name) + "</b><span>" + escapeHtml(file.date) + "</span><span class=\"muted\">" + file.sizeMB + " MB</span><span class=\"grow\"></span>";
      const playBtn = document.createElement("button");
      playBtn.className = "primary";
      const cancelBtn = document.createElement("button");
      cancelBtn.innerHTML = iconLabel("close", "cancel");
      cancelBtn.hidden = true;
      const prog = document.createElement("div");
      prog.className = "rowprog";
      prog.hidden = true;
      prog.innerHTML = "<div class=\"bar\"><i></i></div><div class=\"muted\"></div>";
      const ui = {
        play: playBtn,
        cancel: cancelBtn,
        prog: prog,
        bar: prog.querySelector("i"),
        txt: prog.querySelector(".muted")
      };
      ui.setSaved = saved => {
        playBtn.innerHTML = saved ? iconLabel("play", "playSaved") : iconLabel("download", "downloadPlay");
        playBtn.onclick = () => saved ? playSaved(file.name) : download(file, label, ui, meta);
      };
      ui.setSaved(savedIds.has(file.name));
      cancelBtn.addEventListener("click", () => controller && controller.abort());
      row.append(playBtn, cancelBtn, prog);
      box.appendChild(row);
    }
  }

  function parseSvuUrl(raw) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (err) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== "svuonline.org" && !host.endsWith(".svuonline.org")) {
      return null;
    }
    const rawName = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    if (!rawName || !rawName.toLowerCase().endsWith(".lrec")) {
      return null;
    }
    return {
      url: parsed.toString(),
      name: rawName
    };
  }

  function formatEta(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return "";
    const s = Math.round(seconds);
    if (s < 60) {
      return t("etaSeconds", { s: s });
    }
    const m = Math.floor(s / 60);
    const remS = s % 60;
    return t("etaMinutes", { m: m, s: remS });
  }

  async function exportLrecFile(rec, triggerBtn) {
    try {
      const full = await LibraryDB.get(rec.id);
      if (!full || !full.blob) {
        showToast(t("savedUnavailable") || "Recording file not found in storage.", true);
        return;
      }
      const a = document.createElement("a");
      const blobUrl = URL.createObjectURL(full.blob);
      a.href = blobUrl;
      const fname = rec.name.endsWith(".lrec") ? rec.name : (rec.name + ".lrec");
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      }, 1000);

      if (triggerBtn) {
        triggerBtn.classList.add("is-success");
        const origHtml = triggerBtn.innerHTML;
        triggerBtn.innerHTML = "<svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' stroke-width='2.5'><polyline points='20 6 9 17 4 12'/></svg>";
        setTimeout(() => {
          triggerBtn.innerHTML = origHtml;
          triggerBtn.classList.remove("is-success");
        }, 1800);
      }
      showToast(t("exportLrecSuccess") || "Recording saved to disk");
    } catch (err) {
      console.error("Export .lrec failed:", err);
      showToast(t("savedUnavailable") || "Export failed", true);
    }
  }

  async function loadDemoLecture() {
    const btn = byId("introDemoBtn") || byId("hubDemoBtn");
    try {
      if (btn) btn.disabled = true;
      const res = await fetch("assets/sample.lrec");
      if (!res.ok) throw new Error("Could not load sample.lrec");
      const blob = await res.blob();
      const file = new File([blob], "sample.lrec", { type: "application/octet-stream" });
      if (window.__lrec && window.__lrec.openFile) {
        window.__lrec.openFile(file);
      } else {
        const fileInp = byId("file");
        if (fileInp) {
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInp.files = dt.files;
          fileInp.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    } catch (err) {
      console.error("Demo load error:", err);
      alert((t("openFail") || "Failed to open") + ": " + err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function download(file, label, ui, meta) {
    if (downloading) {
      return;
    }
    const keep = byId("keepOffline").checked && LibraryDB.available;
    controller = new AbortController();
    setStatus("");
    ui.play.hidden = true;
    ui.cancel.hidden = false;
    ui.prog.hidden = false;
    ui.bar.style.width = "0%";
    ui.txt.textContent = t("dlStarting");
    setBusy(true, true);
    const reset = () => {
      ui.prog.hidden = true;
      ui.cancel.hidden = true;
      ui.play.hidden = false;
    };
    try {
      const init = {
        signal: controller.signal
      };
      const dlPath = (window.CONFIG && window.CONFIG.api && window.CONFIG.api.download) || "/api/download";
      const resp = await fetch(dlPath + "?url=" + encodeURIComponent(file.url), init);
      if (!resp.ok) {
        throw new Error("HTTP " + resp.status);
      }
      const total = +resp.headers.get("Content-Length") || (file.sizeMB ? file.sizeMB * 1048576 : 0);
      const reader = resp.body.getReader();
      const parts = [];
      let received = 0;
      let t0 = performance.now();
      while (true) {
        const {
          done: done,
          value: chunk
        } = await reader.read();
        if (done) {
          break;
        }
        parts.push(chunk);
        received += chunk.length;
        const speed = received / 1048576 / Math.max(0.1, (performance.now() - t0) / 1000);
        if (total > 0) {
          ui.bar.style.width = Math.min(100, received * 100 / total).toFixed(1) + "%";
          const remBytes = Math.max(0, total - received);
          const eta = (speed > 0) ? formatEta(remBytes / (speed * 1048576)) : "";
          const etaText = eta ? (" · " + t("etaLabel", { t: eta })) : "";
          ui.txt.textContent = formatSize(received) + " / " + formatSize(total) + " · " + speed.toFixed(1) + " MB/s" + etaText;
        } else {
          ui.bar.style.width = "100%";
          ui.txt.textContent = formatSize(received) + " · " + speed.toFixed(1) + " MB/s";
        }
      }
      const blob = new Blob(parts, {
        type: "application/octet-stream"
      });
      ui.cancel.disabled = true;
      if (keep) {
        ui.txt.textContent = t("dlSaving");
        try {
          await LibraryDB.put({
            id: file.name,
            name: file.name,
            label: label,
            meta: meta || parseLrecNameMeta(file.name),
            watched: !!watchedMap[file.name],
            size: blob.size,
            savedAt: Date.now(),
            url: file.url,
            blob: blob
          });
          LibraryDB.persist();
          ui.setSaved(true);
        } catch (err) {
          setStatus(t("dlSaveFail", {
            e: err.message
          }), true);
        }
      }
      ui.cancel.disabled = false;
      reset();
      dialog.close();
      window.__lrec.openFile(new File([blob], file.name), {
        autoplay: true
      });
    } catch (err) {
      reset();
      setStatus(err.name === "AbortError" ? t("dlCancelled") : t("dlFailed", {
        e: err.message
      }), err.name !== "AbortError");
    }
    controller = null;
    setBusy(false);
    refreshSaved();
  }

  function setBusy(on, lock) {
    downloading = !!lock;
    dialog.querySelectorAll("#cascade select").forEach(sel => sel.disabled = on || sel.options.length <= 1);
    syncCascadeStyles();
    dialog.querySelectorAll("#files .primary").forEach(btn => {
      btn.disabled = downloading;
    });
    byId("pasteUrl").disabled = downloading;
    byId("pasteGo").disabled = downloading;
    byId("keepOffline").disabled = downloading;
    byId("dlspin").hidden = !on;
  }

  /* ====================================================================== *
   * SMART BATCH COURSE DOWNLOADER (#paneBatch)
   * ====================================================================== */
  const BATCH_STATE_BASE_KEY = "svu.batch.state.v2";
  const BATCH_STATE_LEGACY_KEY = "svu.batch.state.v1";
  const BATCH_CACHE_KEY = "svu.batch.cache.v2";

  function getBatchStateKey() {
    const profId = (LibraryDB && LibraryDB.getProfile && LibraryDB.getProfile()) || "default";
    return profId === "default" ? BATCH_STATE_BASE_KEY : (BATCH_STATE_BASE_KEY + "." + profId);
  }

  let batchState = {
    term: "",
    program: "",
    showSelectedOnly: false,
    courses: {} // key: courseValue -> { checked, label, tutor, classVal, lessonSpec, selectedLessons: [] }
  };

  let batchCache = {
    terms: [],
    programs: {}, // termVal -> [{value, label}]
    courses: {},  // "term|prog" -> [{value, label}]
    details: {}   // "term|prog|course" -> { tutors: [], classesByTutor: {}, sessionsByClass: {} }
  };

  function loadBatchStorage() {
    try {
      const rawCache = localStorage.getItem(BATCH_CACHE_KEY);
      if (rawCache) {
        const parsedCache = JSON.parse(rawCache);
        if (parsedCache && typeof parsedCache === "object") {
          batchCache.terms = Array.isArray(parsedCache.terms) ? parsedCache.terms : [];
          batchCache.programs = parsedCache.programs && typeof parsedCache.programs === "object" ? parsedCache.programs : {};
          batchCache.courses = parsedCache.courses && typeof parsedCache.courses === "object" ? parsedCache.courses : {};
          batchCache.details = parsedCache.details && typeof parsedCache.details === "object" ? parsedCache.details : {};
        }
      }
    } catch (err) {}

    batchState = {
      term: "",
      program: "",
      showSelectedOnly: false,
      courses: {}
    };
    try {
      const stateKey = getBatchStateKey();
      const rawState = localStorage.getItem(stateKey) || getPref(stateKey, "") || (stateKey === BATCH_STATE_BASE_KEY ? getPref(BATCH_STATE_LEGACY_KEY, "") : "");
      if (rawState) {
        const parsed = JSON.parse(rawState);
        if (parsed && typeof parsed === "object") {
          batchState.term = parsed.term || "";
          batchState.program = parsed.program || "";
          batchState.showSelectedOnly = !!parsed.showSelectedOnly;
          const cleanCourses = {};
          if (parsed.courses && typeof parsed.courses === "object") {
            for (const [k, v] of Object.entries(parsed.courses)) {
              if (v && (v.checked || v.tutor || v.classVal || v.lessonSpec || (Array.isArray(v.selectedLessons) && v.selectedLessons.length))) {
                cleanCourses[k] = {
                  checked: !!v.checked,
                  label: v.label || k,
                  tutor: v.tutor ? String(v.tutor).trim() : "",
                  classVal: v.classVal ? String(v.classVal).trim() : "",
                  lessonSpec: v.lessonSpec ? String(v.lessonSpec).trim() : "",
                  selectedLessons: Array.isArray(v.selectedLessons) ? v.selectedLessons.map(String) : null
                };
              }
            }
          }
          batchState.courses = cleanCourses;
        }
      }
    } catch (err) {}
  }

  loadBatchStorage();

  function saveBatchState() {
    try {
      const compactCourses = {};
      if (batchState.courses && typeof batchState.courses === "object") {
        for (const [k, v] of Object.entries(batchState.courses)) {
          if (v && (v.checked || v.tutor || v.classVal || v.lessonSpec || (Array.isArray(v.selectedLessons) && v.selectedLessons.length))) {
            compactCourses[k] = {
              checked: !!v.checked,
              label: v.label || k,
              tutor: v.tutor ? String(v.tutor).trim() : "",
              classVal: v.classVal ? String(v.classVal).trim() : "",
              lessonSpec: v.lessonSpec ? String(v.lessonSpec).trim() : "",
              selectedLessons: Array.isArray(v.selectedLessons) ? v.selectedLessons.map(String) : null
            };
          }
        }
      }
      batchState.courses = compactCourses;
      const stateKey = getBatchStateKey();
      const serialized = JSON.stringify(batchState);
      try { localStorage.setItem(stateKey, serialized); } catch (e) {}
      setPref(stateKey, serialized);
    } catch (err) {}
  }

  function saveBatchCache() {
    try {
      localStorage.setItem(BATCH_CACHE_KEY, JSON.stringify(batchCache));
    } catch (err) {}
  }

  function getCourseCacheEntry(termVal, progVal, courseVal) {
    const key = [termVal, progVal, courseVal].join("|");
    if (!batchCache.details[key]) {
      batchCache.details[key] = {
        tutors: [],
        classesByTutor: {},
        sessionsByClass: {}
      };
    }
    return batchCache.details[key];
  }

  // Runtime cache for expanded course cards in Batch tab
  let batchCourseCatalog = []; // [{value, label}]
  let batchRuntime = {}; // courseVal -> { tutors, classes, sessions, loading, error, cardEl, bodyEl, badgeEl }
  let batchQueueRunning = false;
  let batchAbortController = null;

  function hydrateRuntimeFromCache(termVal, progVal, courseVal) {
    const cState = batchState.courses[courseVal];
    const cacheEntry = getCourseCacheEntry(termVal, progVal, courseVal);
    batchRuntime[courseVal] = batchRuntime[courseVal] || {
      tutors: [],
      classes: [],
      sessions: [],
      loadingMeta: false,
      loadingClasses: false,
      loadingSessions: false,
      error: ""
    };
    const rt = batchRuntime[courseVal];
    if (!rt.tutors.length && Array.isArray(cacheEntry.tutors) && cacheEntry.tutors.length) {
      rt.tutors = cacheEntry.tutors;
    }
    if (cState && cState.tutor) {
      const tutorKey = String(cState.tutor).trim();
      const cachedClasses = cacheEntry.classesByTutor && cacheEntry.classesByTutor[tutorKey];
      if (!rt.classes.length && Array.isArray(cachedClasses) && cachedClasses.length) {
        rt.classes = cachedClasses;
      }
      if (cState.classVal) {
        const clsKey = tutorKey + "|" + String(cState.classVal).trim();
        const cachedSessions = cacheEntry.sessionsByClass && cacheEntry.sessionsByClass[clsKey];
        if (!rt.sessions.length && Array.isArray(cachedSessions) && cachedSessions.length) {
          rt.sessions = cachedSessions;
        }
      }
    }
    return rt;
  }

  function isSessionSavedInLib(s, fallbackTermLbl, fallbackProgLbl, fallbackCourseLbl, fallbackClassLbl) {
    const sig = makeLessonSig(
      s.term || fallbackTermLbl,
      s.program || fallbackProgLbl,
      s.course || fallbackCourseLbl,
      s.class || fallbackClassLbl,
      s.order
    );
    return sig && savedSignatures.has(sig);
  }

  function countCheckedCourses() {
    let n = 0;
    if (batchState.courses) {
      for (const c of Object.values(batchState.courses)) {
        if (c && c.checked) n++;
      }
    }
    return n;
  }

  function updateBatchShowSelectedBtn() {
    const btn = byId("batchShowSelectedBtn");
    if (!btn) return;
    const n = countCheckedCourses();
    btn.textContent = t("batchShowSelected", { n });
    btn.title = t("batchShowSelectedTitle");
    btn.classList.toggle("on", !!batchState.showSelectedOnly);
    btn.setAttribute("aria-pressed", String(!!batchState.showSelectedOnly));
  }

  async function initBatchTab(forceRefresh) {
    await refreshSaved();
    updateBatchShowSelectedBtn();

    const defaults = getStudentDefaults();
    if (!batchState.term && defaults.term) {
      batchState.term = defaults.term;
    }
    if (!batchState.program && defaults.program) {
      batchState.program = defaults.program;
    }

    // 1. Restore from local cache immediately if available so UI never blanks out on restart
    if (!forceRefresh && !cachedTerms.length && Array.isArray(batchCache.terms) && batchCache.terms.length) {
      cachedTerms = batchCache.terms;
    }
    if (cachedTerms.length && !forceRefresh) {
      fillSelect(byId("batchTerm"), cachedTerms, "selTerm", batchState.term);
    }

    // 2. Fetch fresh terms if needed or if forced
    if (!termsLoaded || !cachedTerms.length || forceRefresh) {
      try {
        byId("dlspin").hidden = false;
        const json = await fetchBrowse(forceRefresh ? { refresh: "1" } : {});
        if (Array.isArray(json.terms) && json.terms.length) {
          cachedTerms = json.terms;
          batchCache.terms = cachedTerms;
          saveBatchCache();
        }
        fillSelect(byId("selTerm"), cachedTerms, "selTerm", selected.term);
        termsLoaded = true;
        byId("noserver").hidden = true;
      } catch (err) {
        if (!cachedTerms.length) {
          byId("noserver").hidden = false;
        }
      }
      byId("dlspin").hidden = true;
    }

    fillSelect(byId("batchTerm"), cachedTerms, "selTerm", batchState.term);
    if (batchState.term && byId("batchTerm").value === batchState.term) {
      await onBatchTermChange(batchState.program, forceRefresh);
    } else {
      fillSelect(byId("batchProgram"), [], "selProgram");
      updateBatchStepProgression();
      renderBatchCoursesList(false);
    }
    syncCascadeStyles();
    updateBatchSummary();
  }

  async function onBatchTermChange(restoreProgram, forceRefresh) {
    const termVal = byId("batchTerm").value;
    const prevTerm = batchState.term;
    batchState.term = termVal;
    if (termVal) {
      setStudentDefaults(termVal, null);
    }
    if (!restoreProgram && termVal !== prevTerm) {
      batchState.program = "";
    }
    saveBatchState();
    batchCourseCatalog = [];
    if (!termVal) {
      fillSelect(byId("batchProgram"), [], "selProgram");
      updateBatchStepProgression();
      renderBatchCoursesList(false);
      updateBatchSummary();
      return;
    }

    // Use cached programs immediately if available
    let programs = (!forceRefresh && Array.isArray(batchCache.programs[termVal]) && batchCache.programs[termVal].length)
      ? batchCache.programs[termVal]
      : null;

    if (!programs) {
      byId("dlspin").hidden = false;
      try {
        const params = { term: termVal };
        if (forceRefresh) params.refresh = "1";
        const json = await fetchBrowse(params);
        programs = json.programs || [];
        if (programs.length) {
          batchCache.programs[termVal] = programs;
          saveBatchCache();
        }
      } catch (err) {
        programs = batchCache.programs[termVal] || [];
        if (!programs.length) {
          byId("batchCoursesList").innerHTML = "<div class=\"muted bad\" style=\"padding:14px;\">" + escapeHtml(t("stCouldNotLoad", { e: err.message })) + "</div>";
          byId("dlspin").hidden = true;
          return;
        }
      }
      byId("dlspin").hidden = true;
    }

    const targetProg = restoreProgram || batchState.program;
    const progVal = targetProg && programs.some(p => p.value === targetProg || String(p.value).trim() === String(targetProg).trim())
      ? targetProg
      : (programs.length === 1 ? programs[0].value : "");
    fillSelect(byId("batchProgram"), programs, "selProgram", progVal);
    if (byId("batchProgram").value) {
      batchState.program = byId("batchProgram").value;
      saveBatchState();
      await onBatchProgramChange(forceRefresh);
    } else {
      renderBatchCoursesList(false);
    }
    syncCascadeStyles();
    updateBatchSummary();
  }

  async function onBatchProgramChange(forceRefresh) {
    const termVal = byId("batchTerm").value;
    const progVal = byId("batchProgram").value;
    batchState.program = progVal;
    if (progVal) {
      setStudentDefaults(null, progVal);
    }
    saveBatchState();
    batchCourseCatalog = [];
    if (!termVal || !progVal) {
      renderBatchCoursesList(false);
      updateBatchSummary();
      return;
    }

    const cacheKey = termVal + "|" + progVal;
    const cachedList = (!forceRefresh && Array.isArray(batchCache.courses[cacheKey]) && batchCache.courses[cacheKey].length)
      ? batchCache.courses[cacheKey]
      : null;

    if (cachedList) {
      batchCourseCatalog = cachedList;
      renderBatchCoursesList(false);
      await loadCheckedCoursesSequentially(false);
      syncCascadeStyles();
      updateBatchSummary();
      return;
    }

    byId("batchCoursesList").innerHTML = "<div class=\"muted\" style=\"padding:18px;text-align:center;\">" + escapeHtml(t("batchLoadingCourses")) + "</div>";
    byId("dlspin").hidden = false;
    try {
      const params = { term: termVal, program: progVal };
      if (forceRefresh) params.refresh = "1";
      const json = await fetchBrowse(params);
      batchCourseCatalog = json.courses || [];
      if (batchCourseCatalog.length) {
        batchCache.courses[cacheKey] = batchCourseCatalog;
        saveBatchCache();
      }
      renderBatchCoursesList(forceRefresh);
      await loadCheckedCoursesSequentially(!!forceRefresh);
    } catch (err) {
      if (Array.isArray(batchCache.courses[cacheKey]) && batchCache.courses[cacheKey].length) {
        batchCourseCatalog = batchCache.courses[cacheKey];
        renderBatchCoursesList(false);
      } else {
        byId("batchCoursesList").innerHTML = "<div class=\"muted bad\" style=\"padding:14px;\">" + escapeHtml(t("stCouldNotLoad", { e: err.message })) + "</div>";
      }
    }
    byId("dlspin").hidden = true;
    syncCascadeStyles();
    updateBatchSummary();
  }

  async function loadCheckedCoursesSequentially(forceRefresh) {
    const termVal = batchState.term;
    const progVal = batchState.program;
    if (!termVal || !progVal) return;
    for (const c of batchCourseCatalog) {
      const cState = batchState.courses[c.value];
      if (!cState || !cState.checked) continue;
      const rt = hydrateRuntimeFromCache(termVal, progVal, c.value);
      const needsTutors = forceRefresh || !rt.tutors || !rt.tutors.length;
      const needsClasses = cState.tutor && (forceRefresh || !rt.classes || !rt.classes.length);
      const needsSessions = cState.tutor && cState.classVal && (forceRefresh || !rt.sessions || !rt.sessions.length);

      if (needsTutors) {
        await loadBatchCourseDetails(c.value, forceRefresh);
      } else if (needsClasses) {
        renderBatchCourseBody(c.value);
        await loadBatchCourseClasses(c.value, forceRefresh);
      } else if (needsSessions) {
        renderBatchCourseBody(c.value);
        await loadBatchCourseSessions(c.value, forceRefresh);
      } else {
        renderBatchCourseBody(c.value);
      }
    }
    updateBatchSummary();
  }

  function getOrCreateCourseState(courseVal, label) {
    if (!batchState.courses[courseVal]) {
      batchState.courses[courseVal] = {
        checked: false,
        label: label || courseVal,
        tutor: "",
        classVal: "",
        selectedLessons: null
      };
    } else if (label) {
      batchState.courses[courseVal].label = label;
    }
    return batchState.courses[courseVal];
  }

  function renderBatchCoursesList(forceRefresh) {
    const box = byId("batchCoursesList");
    if (!box) return;
    updateBatchShowSelectedBtn();
    const termVal = byId("batchTerm") ? byId("batchTerm").value : "";
    const progVal = byId("batchProgram") ? byId("batchProgram").value : "";
    if (!termVal || !progVal) {
      box.innerHTML = "<div class=\"muted\" data-i18n=\"batchNoCollege\" style=\"padding:18px;text-align:center;\">" + escapeHtml(t("batchNoCollege")) + "</div>";
      return;
    }
    if (!batchCourseCatalog.length) {
      box.innerHTML = "<div class=\"muted\" style=\"padding:18px;text-align:center;\">" + escapeHtml(t("stNothing")) + "</div>";
      return;
    }
    const filterQ = (byId("batchCourseFilter") ? byId("batchCourseFilter").value : "").trim().toLowerCase();
    const onlySelected = !!batchState.showSelectedOnly;
    box.innerHTML = "";
    let renderedCount = 0;

    for (const c of batchCourseCatalog) {
      const existingState = batchState.courses[c.value];
      const isChecked = !!(existingState && existingState.checked);

      if (onlySelected && !isChecked) {
        continue;
      }
      if (filterQ) {
        const mat = (window.MaterialsDB && c.value) ? window.MaterialsDB.get(c.value) : null;
        const matchesVal = c.value.toLowerCase().includes(filterQ);
        const matchesLabel = c.label.toLowerCase().includes(filterQ);
        const matchesAr = !!(mat && mat.ar && mat.ar.toLowerCase().includes(filterQ));
        const matchesEn = !!(mat && mat.en && mat.en.toLowerCase().includes(filterQ));
        const matchesAlts = !!(mat && mat.alts && mat.alts.some(a => a.ar.toLowerCase().includes(filterQ) || a.en.toLowerCase().includes(filterQ)));
        if (!matchesVal && !matchesLabel && !matchesAr && !matchesEn && !matchesAlts) {
          continue;
        }
      }

      renderedCount++;
      const card = document.createElement("div");
      card.className = "b-course-card" + (isChecked ? " checked" : "");
      card.dataset.courseVal = c.value;

      const head = document.createElement("div");
      head.className = "b-course-head";
      const lbl = document.createElement("label");
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = isChecked;
      const titleSpan = document.createElement("span");
      titleSpan.textContent = formatCourseDisplay(c);
      lbl.append(chk, titleSpan);

      const metaBadge = document.createElement("span");
      metaBadge.className = "muted";
      metaBadge.style.fontSize = "11.5px";
      head.append(lbl, metaBadge);

      const body = document.createElement("div");
      body.className = "b-course-body";
      body.hidden = !isChecked;

      card.append(head, body);
      box.appendChild(card);

      const rt = hydrateRuntimeFromCache(termVal, progVal, c.value);
      rt.cardEl = card;
      rt.bodyEl = body;
      rt.badgeEl = metaBadge;

      chk.addEventListener("change", async () => {
        const cState = getOrCreateCourseState(c.value, c.label);
        cState.checked = chk.checked;
        card.classList.toggle("checked", cState.checked);
        body.hidden = !cState.checked;
        saveBatchState();
        updateBatchShowSelectedBtn();
        if (!cState.checked && batchState.showSelectedOnly) {
          renderBatchCoursesList(false);
          return;
        }
        if (cState.checked) {
          hydrateRuntimeFromCache(termVal, progVal, c.value);
          if (!rt.tutors || !rt.tutors.length) {
            await loadBatchCourseDetails(c.value, false);
          } else if (cState.tutor && (!rt.classes || !rt.classes.length)) {
            renderBatchCourseBody(c.value);
            await loadBatchCourseClasses(c.value, false);
          } else if (cState.tutor && cState.classVal && (!rt.sessions || !rt.sessions.length)) {
            renderBatchCourseBody(c.value);
            await loadBatchCourseSessions(c.value, false);
          } else {
            renderBatchCourseBody(c.value);
          }
        }
        updateBatchSummary();
      });

      if (isChecked) {
        getOrCreateCourseState(c.value, c.label);
        renderBatchCourseBody(c.value);
      }
    }

    if (renderedCount === 0) {
      const msgKey = onlySelected ? "batchNoSelectedYet" : "stNothing";
      box.innerHTML = "<div class=\"muted\" style=\"padding:18px;text-align:center;\">" + escapeHtml(t(msgKey)) + "</div>";
    }
    updateBatchSummary();
  }

  async function loadBatchCourseDetails(courseVal, forceRefresh) {
    const termVal = batchState.term;
    const progVal = batchState.program;
    const rt = hydrateRuntimeFromCache(termVal, progVal, courseVal);
    const cState = getOrCreateCourseState(courseVal);
    if (!rt || !rt.bodyEl || !cState) return;

    rt.loadingMeta = true;
    rt.error = "";
    rt.bodyEl.innerHTML = "<div class=\"muted\">" + escapeHtml(t("batchLoadingMeta")) + "</div>";
    try {
      const params = { term: termVal, program: progVal, course: courseVal };
      if (forceRefresh) params.refresh = "1";
      const json = await fetchBrowse(params);
      rt.tutors = json.tutors || [];
      const cacheEntry = getCourseCacheEntry(termVal, progVal, courseVal);
      cacheEntry.tutors = rt.tutors;
      saveBatchCache();

      const curTutorTrim = cState.tutor ? String(cState.tutor).trim() : "";
      const curTutorLow = curTutorTrim.toLowerCase();
      const matchedTutor = curTutorTrim && rt.tutors.find(tu =>
        tu.value === cState.tutor ||
        String(tu.value).trim() === curTutorTrim ||
        String(tu.value).toLowerCase().includes(curTutorLow) ||
        String(tu.label).toLowerCase().includes(curTutorLow)
      );
      if (matchedTutor) {
        cState.tutor = matchedTutor.value;
      } else {
        cState.tutor = json.tutor ? String(json.tutor).trim() : (rt.tutors.length === 1 ? rt.tutors[0].value : "");
      }
      saveBatchState();
      rt.loadingMeta = false;
      renderBatchCourseBody(courseVal);
      if (cState.tutor) {
        await loadBatchCourseClasses(courseVal, forceRefresh);
      }
    } catch (err) {
      rt.loadingMeta = false;
      rt.error = err.message;
      rt.bodyEl.innerHTML = "<div class=\"muted bad\">" + escapeHtml(t("stCouldNotLoad", { e: err.message })) + "</div>";
    }
  }

  function matchClassInList(classesList, rawVal) {
    if (!rawVal || !Array.isArray(classesList)) return null;
    const trimVal = String(rawVal).trim();
    const normVal = normClass(trimVal);
    return classesList.find(cl =>
      cl.value === rawVal ||
      String(cl.value).trim() === trimVal ||
      normClass(cl.value) === normVal ||
      normClass(cl.label) === normVal
    ) || null;
  }

  function resolveLessonsFromSpec(sessionsList, specStr, isSavedFn) {
    const spec = String(specStr || "").trim().toUpperCase();
    if (!spec || spec === "UNSAVED") {
      return sessionsList.filter(s => !isSavedFn(s)).map(s => String(s.index));
    }
    if (spec === "ALL" || spec === "*") {
      return sessionsList.map(s => String(s.index));
    }
    if (spec === "NONE" || spec === "0") {
      return [];
    }
    const wantedNums = new Set();
    for (const part of spec.split(/[\s,;]+/)) {
      if (!part) continue;
      const rangeMatch = part.match(/^S?(\d+)-S?(\d+)$/i);
      if (rangeMatch) {
        const a = parseInt(rangeMatch[1], 10);
        const b = parseInt(rangeMatch[2], 10);
        for (let n = Math.min(a, b); n <= Math.max(a, b); n++) {
          wantedNums.add(String(n));
        }
      } else {
        const num = normLesson(part);
        if (num) wantedNums.add(num);
      }
    }
    if (!wantedNums.size) {
      return sessionsList.map(s => String(s.index));
    }
    return sessionsList
      .filter(s => wantedNums.has(normLesson(s.order || (s.index + 1))))
      .map(s => String(s.index));
  }

  async function loadBatchCourseClasses(courseVal, forceRefresh) {
    const termVal = batchState.term;
    const progVal = batchState.program;
    const rt = hydrateRuntimeFromCache(termVal, progVal, courseVal);
    const cState = batchState.courses[courseVal];
    if (!rt || !cState || !cState.tutor) return;

    const tutorKey = String(cState.tutor).trim();
    const cacheEntry = getCourseCacheEntry(termVal, progVal, courseVal);

    if (!forceRefresh && Array.isArray(cacheEntry.classesByTutor[tutorKey]) && cacheEntry.classesByTutor[tutorKey].length) {
      rt.classes = cacheEntry.classesByTutor[tutorKey];
      const matchedClass = matchClassInList(rt.classes, cState.classVal);
      if (matchedClass) {
        cState.classVal = matchedClass.value;
      } else if (rt.classes.length === 1) {
        cState.classVal = rt.classes[0].value;
      }
      saveBatchState();
      renderBatchCourseBody(courseVal);
      if (cState.classVal) {
        await loadBatchCourseSessions(courseVal, false);
      }
      return;
    }

    rt.loadingClasses = true;
    rt.error = "";
    renderBatchCourseBody(courseVal);
    try {
      const params = {
        term: termVal,
        program: progVal,
        course: courseVal,
        tutor: cState.tutor
      };
      if (forceRefresh) params.refresh = "1";
      const json = await fetchBrowse(params);
      rt.classes = json.classes || [];
      if (rt.classes.length) {
        cacheEntry.classesByTutor[tutorKey] = rt.classes;
        saveBatchCache();
      }
      const matchedClass = matchClassInList(rt.classes, cState.classVal);
      if (matchedClass) {
        cState.classVal = matchedClass.value;
      } else {
        cState.classVal = json.class ? String(json.class).trim() : (rt.classes.length === 1 ? rt.classes[0].value : "");
      }
      rt.loadingClasses = false;
      saveBatchState();
      renderBatchCourseBody(courseVal);
      if (cState.classVal) {
        await loadBatchCourseSessions(courseVal, forceRefresh);
      }
    } catch (err) {
      rt.loadingClasses = false;
      rt.error = err.message;
      renderBatchCourseBody(courseVal);
    }
  }

  async function loadBatchCourseSessions(courseVal, forceRefresh) {
    const termVal = batchState.term;
    const progVal = batchState.program;
    const rt = hydrateRuntimeFromCache(termVal, progVal, courseVal);
    const cState = batchState.courses[courseVal];
    if (!rt || !cState || !cState.tutor || !cState.classVal) return;

    const tutorKey = String(cState.tutor).trim();
    const clsKey = tutorKey + "|" + String(cState.classVal).trim();
    const cacheEntry = getCourseCacheEntry(termVal, progVal, courseVal);

    if (!forceRefresh && Array.isArray(cacheEntry.sessionsByClass[clsKey]) && cacheEntry.sessionsByClass[clsKey].length) {
      rt.sessions = cacheEntry.sessionsByClass[clsKey];
      const termLbl = byId("batchTerm")?.selectedOptions[0]?.textContent || "";
      const progLbl = byId("batchProgram")?.selectedOptions[0]?.textContent || "";
      const clsObj = (rt.classes || []).find(cl => String(cl.value).trim() === String(cState.classVal).trim());
      const clsLbl = clsObj ? clsObj.label : "";
      if (cState.lessonSpec) {
        cState.selectedLessons = resolveLessonsFromSpec(
          rt.sessions,
          cState.lessonSpec,
          s => isSessionSavedInLib(s, termLbl, progLbl, cState.label, clsLbl)
        );
        cState.lessonSpec = "";
      } else if (!Array.isArray(cState.selectedLessons)) {
        cState.selectedLessons = rt.sessions
          .filter(s => !isSessionSavedInLib(s, termLbl, progLbl, cState.label, clsLbl))
          .map(s => String(s.index));
      } else {
        const validSet = new Set(rt.sessions.map(s => String(s.index)));
        cState.selectedLessons = cState.selectedLessons.filter(idx => validSet.has(String(idx)));
      }
      saveBatchState();
      renderBatchCourseBody(courseVal);
      updateBatchSummary();
      return;
    }

    rt.loadingSessions = true;
    rt.error = "";
    const lessonsBox = rt.bodyEl ? rt.bodyEl.querySelector(".b-lessons-wrap") : null;
    if (lessonsBox) {
      lessonsBox.innerHTML = "<div class=\"muted\">" + escapeHtml(t("batchLoadingSessions")) + "</div>";
    }
    try {
      const params = {
        term: termVal,
        program: progVal,
        course: courseVal,
        tutor: cState.tutor,
        class: cState.classVal
      };
      if (forceRefresh) params.refresh = "1";
      const json = await fetchBrowse(params);
      rt.sessions = json.sessions || [];
      cacheEntry.sessionsByClass[clsKey] = rt.sessions;
      saveBatchCache();

      const termLbl = byId("batchTerm")?.selectedOptions[0]?.textContent || "";
      const progLbl = byId("batchProgram")?.selectedOptions[0]?.textContent || "";
      const clsObj = (rt.classes || []).find(cl => String(cl.value).trim() === String(cState.classVal).trim());
      const clsLbl = clsObj ? clsObj.label : "";

      if (cState.lessonSpec) {
        cState.selectedLessons = resolveLessonsFromSpec(
          rt.sessions,
          cState.lessonSpec,
          s => isSessionSavedInLib(s, termLbl, progLbl, cState.label, clsLbl)
        );
        cState.lessonSpec = "";
      } else if (!Array.isArray(cState.selectedLessons) || forceRefresh) {
        cState.selectedLessons = rt.sessions
          .filter(s => !isSessionSavedInLib(s, termLbl, progLbl, cState.label, clsLbl))
          .map(s => String(s.index));
      } else {
        const validSet = new Set(rt.sessions.map(s => String(s.index)));
        cState.selectedLessons = cState.selectedLessons.filter(idx => validSet.has(String(idx)));
      }
      rt.loadingSessions = false;
      saveBatchState();
      renderBatchCourseBody(courseVal);
    } catch (err) {
      rt.loadingSessions = false;
      rt.error = err.message;
      if (lessonsBox) {
        lessonsBox.innerHTML = "<div class=\"muted bad\">" + escapeHtml(t("stCouldNotLoad", { e: err.message })) + "</div>";
      }
    }
    updateBatchSummary();
  }

  function renderBatchCourseBody(courseVal) {
    const rt = batchRuntime[courseVal];
    const cState = batchState.courses[courseVal];
    if (!rt || !rt.bodyEl || !cState) return;
    const body = rt.bodyEl;
    body.innerHTML = "";

    const safeId = String(courseVal).replace(/[^a-zA-Z0-9_-]/g, "_");
    const selectsRow = document.createElement("div");
    selectsRow.className = "b-course-selects cascade";

    const lblTutor = document.createElement("label");
    lblTutor.htmlFor = "bTutor_" + safeId;
    lblTutor.textContent = t("lblTutor");
    const selTutor = document.createElement("select");
    selTutor.id = "bTutor_" + safeId;
    fillSelect(selTutor, rt.tutors || [], "selTutor", cState.tutor);

    const lblClass = document.createElement("label");
    lblClass.htmlFor = "bClass_" + safeId;
    lblClass.textContent = t("lblClass");
    const selClass = document.createElement("select");
    selClass.id = "bClass_" + safeId;
    fillSelect(selClass, rt.classes || [], "selClass", cState.classVal);

    selTutor.addEventListener("change", async () => {
      cState.tutor = selTutor.value;
      cState.classVal = "";
      cState.selectedLessons = null;
      rt.classes = [];
      rt.sessions = [];
      rt.error = "";
      saveBatchState();
      renderBatchCourseBody(courseVal);
      if (cState.tutor) {
        await loadBatchCourseClasses(courseVal, false);
      }
      updateBatchSummary();
    });

    selClass.addEventListener("change", async () => {
      cState.classVal = selClass.value;
      cState.selectedLessons = null;
      rt.sessions = [];
      rt.error = "";
      saveBatchState();
      renderBatchCourseBody(courseVal);
      if (cState.classVal) {
        await loadBatchCourseSessions(courseVal, false);
      }
      updateBatchSummary();
    });

    selectsRow.append(lblTutor, selTutor, lblClass, selClass);
    body.appendChild(selectsRow);
    syncCascadeStyles(selectsRow);

    const lessonsWrap = document.createElement("div");
    lessonsWrap.className = "b-lessons-wrap";
    body.appendChild(lessonsWrap);

    if (rt.loadingMeta || rt.loadingClasses) {
      lessonsWrap.innerHTML = "<div class=\"muted\">" + escapeHtml(t("batchLoadingMeta")) + "</div>";
      return;
    }
    if (rt.loadingSessions) {
      lessonsWrap.innerHTML = "<div class=\"muted\">" + escapeHtml(t("batchLoadingSessions")) + "</div>";
      return;
    }
    if (rt.error) {
      lessonsWrap.innerHTML = "<div class=\"muted bad\">" + escapeHtml(t("stCouldNotLoad", { e: rt.error })) + "</div>";
      return;
    }
    if (!cState.tutor || !cState.classVal) {
      lessonsWrap.innerHTML = "<div class=\"muted\">" + escapeHtml(t("batchSelectTutorClass")) + "</div>";
      return;
    }
    if (!rt.sessions.length) {
      lessonsWrap.innerHTML = "<div class=\"muted\">" + escapeHtml(t("noSessions")) + "</div>";
      return;
    }

    const termLbl = byId("batchTerm")?.selectedOptions[0]?.textContent || "";
    const progLbl = byId("batchProgram")?.selectedOptions[0]?.textContent || "";
    const clsObj = (rt.classes || []).find(cl => String(cl.value).trim() === String(cState.classVal).trim());
    const clsLbl = clsObj ? clsObj.label : "";

    const selSet = new Set((cState.selectedLessons || []).map(String));

    const lHead = document.createElement("div");
    lHead.className = "b-lessons-head";
    const lTitle = document.createElement("span");
    lTitle.textContent = t("batchLessons") + " (" + rt.sessions.length + ")";

    const btnGroup = document.createElement("div");
    btnGroup.className = "b-mini-btns";

    const btnAll = document.createElement("button");
    btnAll.textContent = t("batchAllLessons", { n: rt.sessions.length });
    btnAll.addEventListener("click", () => {
      cState.selectedLessons = rt.sessions.map(s => String(s.index));
      saveBatchState();
      renderBatchCourseBody(courseVal);
      updateBatchSummary();
    });

    const btnUnsaved = document.createElement("button");
    btnUnsaved.textContent = t("batchNewOnly");
    btnUnsaved.addEventListener("click", () => {
      cState.selectedLessons = rt.sessions
        .filter(s => !isSessionSavedInLib(s, termLbl, progLbl, cState.label, clsLbl))
        .map(s => String(s.index));
      saveBatchState();
      renderBatchCourseBody(courseVal);
      updateBatchSummary();
    });

    const btnNone = document.createElement("button");
    btnNone.textContent = t("batchNoneLessons");
    btnNone.addEventListener("click", () => {
      cState.selectedLessons = [];
      saveBatchState();
      renderBatchCourseBody(courseVal);
      updateBatchSummary();
    });

    btnGroup.append(btnAll, btnUnsaved, btnNone);
    lHead.append(lTitle, btnGroup);
    lessonsWrap.appendChild(lHead);

    const grid = document.createElement("div");
    grid.className = "b-lessons-grid";
    grid.style.marginTop = "8px";

    for (const s of rt.sessions) {
      const idxStr = String(s.index);
      const saved = isSessionSavedInLib(s, termLbl, progLbl, cState.label, clsLbl);
      const isOn = selSet.has(idxStr);
      const pill = document.createElement("label");
      pill.className = "l-pill" + (isOn ? " on" : "") + (saved ? " is-saved" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = isOn;
      const txt = document.createElement("span");
      const orderNum = normLesson(s.order || (s.index + 1));
      txt.textContent = t("batchLessonNum", { n: orderNum }) + (s.date ? " · " + s.date : "");
      pill.append(cb, txt);
      if (saved) {
        const sTag = document.createElement("span");
        sTag.className = "saved-tag";
        sTag.textContent = t("batchSavedBadge");
        pill.appendChild(sTag);
      }
      cb.addEventListener("change", () => {
        if (cb.checked) {
          selSet.add(idxStr);
        } else {
          selSet.delete(idxStr);
        }
        cState.selectedLessons = Array.from(selSet);
        pill.classList.toggle("on", cb.checked);
        saveBatchState();
        updateBatchSummary();
      });
      grid.appendChild(pill);
    }
    lessonsWrap.appendChild(grid);
  }

  function collectBatchTasks() {
    const tasks = [];
    let selectedCoursesCount = 0;
    let totalSelectedLessons = 0;
    let alreadySavedCount = 0;

    const termVal = batchState.term;
    const progVal = batchState.program;
    const termLbl = byId("batchTerm")?.selectedOptions[0]?.textContent || "";
    const progLbl = byId("batchProgram")?.selectedOptions[0]?.textContent || "";

    for (const courseVal of Object.keys(batchState.courses)) {
      const cState = batchState.courses[courseVal];
      if (!cState || !cState.checked) continue;
      selectedCoursesCount++;
      const rt = hydrateRuntimeFromCache(termVal, progVal, courseVal);
      if (!rt || !cState.tutor || !cState.classVal || !Array.isArray(rt.sessions)) continue;
      const clsObj = (rt.classes || []).find(cl => String(cl.value).trim() === String(cState.classVal).trim());
      const clsLbl = clsObj ? clsObj.label : "";
      const tutorObj = (rt.tutors || []).find(tu => String(tu.value).trim() === String(cState.tutor).trim());
      const tutorLbl = tutorObj ? tutorObj.label : "";
      const selSet = new Set((cState.selectedLessons || []).map(String));

      for (const s of rt.sessions) {
        if (!selSet.has(String(s.index))) continue;
        totalSelectedLessons++;
        const saved = isSessionSavedInLib(s, termLbl, progLbl, cState.label, clsLbl);
        if (saved) {
          alreadySavedCount++;
        } else {
          tasks.push({
            termVal,
            progVal,
            courseVal,
            tutorVal: cState.tutor,
            classVal: cState.classVal,
            sessionIndex: s.index,
            sessionObj: {
              ...s,
              term: s.term || termLbl,
              program: s.program || progLbl,
              course: s.course || cState.label,
              class: s.class || clsLbl,
              tutor: s.tutor || tutorLbl
            }
          });
        }
      }
    }
    return {
      tasks,
      selectedCoursesCount,
      totalSelectedLessons,
      alreadySavedCount
    };
  }

    function updateBatchStepProgression() {
    const termVal = byId("batchTerm") ? byId("batchTerm").value : "";
    const progVal = byId("batchProgram") ? byId("batchProgram").value : "";
    const step2Box = byId("batchStep2Box");
    const isStep1Done = !!(termVal && progVal);

    if (step2Box) {
      if (!isStep1Done) {
        step2Box.classList.add("is-locked");
        step2Box.setAttribute("aria-disabled", "true");
        if (byId("batchShowSelectedBtn")) byId("batchShowSelectedBtn").disabled = true;
        if (byId("batchSelectAllBtn")) byId("batchSelectAllBtn").disabled = true;
        if (byId("batchClearBtn")) byId("batchClearBtn").disabled = true;
        if (byId("batchCourseFilter")) byId("batchCourseFilter").disabled = true;
      } else {
        step2Box.classList.remove("is-locked");
        step2Box.removeAttribute("aria-disabled");
        if (byId("batchShowSelectedBtn")) byId("batchShowSelectedBtn").disabled = false;
        if (byId("batchSelectAllBtn")) byId("batchSelectAllBtn").disabled = false;
        if (byId("batchClearBtn")) byId("batchClearBtn").disabled = false;
        if (byId("batchCourseFilter")) byId("batchCourseFilter").disabled = false;
      }
    }
  }

  function updateBatchSummary() {
    updateBatchStepProgression();
    updateBatchShowSelectedBtn();
    const { tasks, selectedCoursesCount, totalSelectedLessons, alreadySavedCount } = collectBatchTasks();
    const sumEl = byId("batchSummaryTxt");
    if (sumEl) {
      sumEl.textContent = t("batchSummary", {
        c: selectedCoursesCount,
        l: totalSelectedLessons,
        s: alreadySavedCount,
        d: tasks.length
      });
    }

    // Structured Statistics Badges
    if (byId("statCoursesCount")) byId("statCoursesCount").textContent = selectedCoursesCount;
    if (byId("statLessonsCount")) byId("statLessonsCount").textContent = totalSelectedLessons;
    if (byId("statSavedCount")) byId("statSavedCount").textContent = alreadySavedCount;
    if (byId("statToDlCount")) byId("statToDlCount").textContent = tasks.length;

    // Disabled when queue is running OR no lessons are selected OR 0 to download
    const startBtn = byId("batchStartBtn");
    if (startBtn) {
      startBtn.disabled = batchQueueRunning || totalSelectedLessons === 0 || tasks.length === 0;
    }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function runBatchQueue(customTasks) {
    if (batchQueueRunning) return;
    await refreshSaved();
    const queue = Array.isArray(customTasks) ? customTasks : collectBatchTasks().tasks;
    if (!queue.length) return;

    batchQueueRunning = true;
    batchAbortController = new AbortController();
    byId("batchStartBtn").disabled = true;
    byId("batchStopBtn").hidden = false;
    byId("batchOpenLibBtn").hidden = true;
    byId("batchQueueBox").hidden = false;
    byId("batchQueueBar").style.width = "0%";
    byId("batchFileBar").style.width = "0%";

    let downloadedCount = 0;
    let skippedCount = 0;

    try {
      for (let i = 0; i < queue.length; i++) {
        if (batchAbortController.signal.aborted) break;
        const item = queue[i];
        const s = item.sessionObj;
        const stepNum = i + 1;

        byId("batchQueueCount").textContent = stepNum + " / " + queue.length;
        byId("batchQueueBar").style.width = ((i / queue.length) * 100).toFixed(1) + "%";
        byId("batchQueueStatus").textContent = t("batchQueuePrep", {
          i: stepNum,
          n: queue.length,
          course: s.course,
          s: normLesson(s.order || (s.index + 1))
        });
        byId("batchFileBar").style.width = "0%";
        byId("batchFileTxt").textContent = "";

        // Double check signature before making request
        if (isSessionSavedInLib(s, s.term, s.program, s.course, s.class)) {
          skippedCount++;
          byId("batchQueueStatus").textContent = t("batchQueueSkip", { name: s.course + " S" + s.order });
          await sleep(250);
          continue;
        }

        // Fetch file URL for this session
        const json = await fetchBrowse({
          term: item.termVal,
          program: item.progVal,
          course: item.courseVal,
          tutor: item.tutorVal,
          class: item.classVal,
          session: item.sessionIndex
        });
        const files = json.files || [];
        if (!files.length) {
          skippedCount++;
          continue;
        }

        for (const file of files) {
          if (batchAbortController.signal.aborted) break;
          if (savedIds.has(file.name)) {
            skippedCount++;
            byId("batchQueueStatus").textContent = t("batchQueueSkip", { name: file.name });
            await sleep(200);
            continue;
          }

          byId("batchQueueStatus").textContent = t("batchQueueDl", {
            i: stepNum,
            n: queue.length,
            name: file.name
          });

          const dlPath = (window.CONFIG && window.CONFIG.api && window.CONFIG.api.download) || "/api/download";
          const resp = await fetch(dlPath + "?url=" + encodeURIComponent(file.url), {
            signal: batchAbortController.signal
          });
          if (!resp.ok) {
            throw new Error("HTTP " + resp.status);
          }
          const total = +resp.headers.get("Content-Length") || (file.sizeMB ? file.sizeMB * 1048576 : 0);
          const reader = resp.body.getReader();
          const parts = [];
          let received = 0;
          const t0 = performance.now();
          while (true) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            parts.push(chunk);
            received += chunk.length;
            const speed = received / 1048576 / Math.max(0.1, (performance.now() - t0) / 1000);
            if (total > 0) {
              byId("batchFileBar").style.width = Math.min(100, received * 100 / total).toFixed(1) + "%";
              const remBytes = Math.max(0, total - received);
              const eta = (speed > 0) ? formatEta(remBytes / (speed * 1048576)) : "";
              const etaText = eta ? (" · " + t("etaLabel", { t: eta })) : "";
              byId("batchFileTxt").textContent = formatSize(received) + " / " + formatSize(total) + " · " + speed.toFixed(1) + " MB/s" + etaText;
            } else {
              byId("batchFileBar").style.width = "100%";
              byId("batchFileTxt").textContent = formatSize(received) + " · " + speed.toFixed(1) + " MB/s";
            }
          }
          const blob = new Blob(parts, { type: "application/octet-stream" });
          const label = [s.term, s.program, s.course, s.class, s.order, s.tutor].filter(Boolean).join(" · ");
          const parsedFromName = parseLrecNameMeta(file.name);
          const meta = {
            term: parsedFromName.term || s.term,
            college: parsedFromName.college || s.program,
            material: parsedFromName.material || s.course,
            className: parsedFromName.className || s.class,
            lesson: parsedFromName.lesson || s.order,
            tutor: s.tutor,
            date: parsedFromName.date || file.date || s.date,
            rawIds: {
              term: item.termVal,
              program: item.progVal,
              course: item.courseVal,
              tutor: item.tutorVal,
              class: item.classVal
            }
          };
          if (LibraryDB.available) {
            await LibraryDB.put({
              id: file.name,
              name: file.name,
              label: label,
              meta: meta,
              watched: false,
              size: blob.size,
              savedAt: Date.now(),
              url: file.url,
              blob: blob
            });
            LibraryDB.persist();
          }
          downloadedCount++;
          await refreshSaved();
          if (batchRuntime[item.courseVal]) {
            renderBatchCourseBody(item.courseVal);
          }
        }

        byId("batchQueueBar").style.width = (((i + 1) / queue.length) * 100).toFixed(1) + "%";

        // Polite anti-ban delay before next lecture in queue (1.3s - 1.8s jitter)
        if (i + 1 < queue.length && !batchAbortController.signal.aborted) {
          byId("batchQueueStatus").textContent = t("batchQueueWait", { i: stepNum + 1, n: queue.length });
          await sleep(1300 + Math.floor(Math.random() * 500));
        }
      }

      if (!batchAbortController.signal.aborted) {
        byId("batchQueueBar").style.width = "100%";
        byId("batchFileBar").style.width = "100%";
        byId("batchQueueStatus").textContent = t("batchQueueDone", {
          d: downloadedCount,
          s: skippedCount
        });
        byId("batchOpenLibBtn").hidden = false;
      } else {
        byId("batchQueueStatus").textContent = t("dlCancelled");
      }
    } catch (err) {
      byId("batchQueueStatus").textContent = err.name === "AbortError"
        ? t("dlCancelled")
        : t("dlFailed", { e: err.message });
    }

    batchQueueRunning = false;
    batchAbortController = null;
    byId("batchStopBtn").hidden = true;
    await refreshSaved();
    updateBatchSummary();
  }

  if (byId("batchTerm")) {
    byId("batchTerm").addEventListener("change", () => onBatchTermChange("", false));
  }
  if (byId("batchProgram")) {
    byId("batchProgram").addEventListener("change", () => onBatchProgramChange(false));
  }
  if (byId("batchCourseFilter")) {
    byId("batchCourseFilter").addEventListener("input", () => renderBatchCoursesList(false));
  }
  if (byId("batchShowSelectedBtn")) {
    byId("batchShowSelectedBtn").addEventListener("click", () => {
      batchState.showSelectedOnly = !batchState.showSelectedOnly;
      saveBatchState();
      renderBatchCoursesList(false);
    });
  }
  if (byId("batchSelectAllBtn")) {
    byId("batchSelectAllBtn").addEventListener("click", async () => {
      const filterQ = (byId("batchCourseFilter")?.value || "").trim().toLowerCase();
      for (const c of batchCourseCatalog) {
        if (filterQ && !c.label.toLowerCase().includes(filterQ) && !c.value.toLowerCase().includes(filterQ)) continue;
        const cState = getOrCreateCourseState(c.value, c.label);
        cState.checked = true;
      }
      saveBatchState();
      renderBatchCoursesList(false);
      await loadCheckedCoursesSequentially(false);
    });
  }
  if (byId("batchClearBtn")) {
    byId("batchClearBtn").addEventListener("click", () => {
      for (const k of Object.keys(batchState.courses)) {
        batchState.courses[k].checked = false;
      }
      batchState.showSelectedOnly = false;
      saveBatchState();
      renderBatchCoursesList(false);
    });
  }
  if (byId("batchCourseDirBtn")) {
    byId("batchCourseDirBtn").addEventListener("click", () => {
      openCourseDirectory();
    });
  }
  if (byId("batchRefreshBtn")) {
    byId("batchRefreshBtn").addEventListener("click", () => initBatchTab(true));
  }
  if (byId("batchStartBtn")) {
    byId("batchStartBtn").addEventListener("click", () => runBatchQueue());
  }
  if (byId("batchStopBtn")) {
    byId("batchStopBtn").addEventListener("click", () => batchAbortController && batchAbortController.abort());
  }
  if (byId("batchOpenLibBtn")) {
    byId("batchOpenLibBtn").addEventListener("click", () => showTab("saved"));
  }

  /* ====================================================================== *
   * ORGANIZED STUDENT LECTURE LIBRARY (#paneSaved)
   * ====================================================================== */
  let libFilterWatched = "all"; // "all" | "unwatched" | "watched"
  let collapsedGroups = new Set();

  async function refreshSaved() {
    if (!LibraryDB.available) {
      byId("saved").innerHTML = "<div class=\"muted\">" + t("savedUnavailable") + "</div>";
      return [];
    }
    let records = [];
    try {
      records = await LibraryDB.list();
    } catch (err) {
      byId("saved").innerHTML = "<div class=\"muted\">" + escapeHtml(t("savedReadFail", {
        e: err.message
      })) + "</div>";
      return [];
    }
    savedRecordsCache = records.map(rec => {
      const parsedMeta = enrichRecordMeta(rec);
      return {
        ...rec,
        parsedMeta,
        watched: isLectureWatched(rec)
      };
    });
    savedIds = new Set(savedRecordsCache.map(r => r.id));
    savedSignatures = new Set();
    for (const r of savedRecordsCache) {
      const m = r.parsedMeta;
      const sig = makeLessonSig(m.term, m.college, m.material, m.className, m.lesson);
      if (sig) savedSignatures.add(sig);
    }

    const countTxt = savedRecordsCache.length ? " (" + savedRecordsCache.length + ")" : "";
    if (byId("tabSavedCount")) byId("tabSavedCount").textContent = countTxt;
    if (byId("libHeaderCount")) byId("libHeaderCount").textContent = countTxt;

    renderLibraryView();

    const usage = await LibraryDB.usage();
    if (byId("usage")) {
      if (usage && usage.quota > 0) {
        const freeBytes = Math.max(0, usage.quota - usage.used);
        const estLectures = Math.floor(freeBytes / (35 * 1048576));
        byId("usage").textContent = t("usage", {
          used: formatSize(usage.used),
          free: formatSize(freeBytes),
          count: estLectures
        });
      } else {
        byId("usage").textContent = "";
      }
    }
    refreshHub();
    return savedRecordsCache;
  }

  function renderLibraryView() {
    const box = byId("saved");
    if (!box) return;

    const total = savedRecordsCache.length;
    const coursesSet = new Set(savedRecordsCache.map(r => r.parsedMeta.material).filter(Boolean));
    const watchedCount = savedRecordsCache.filter(r => r.watched).length;

    if (byId("libStatsSummary")) {
      byId("libStatsSummary").textContent = t("libStatsSummary", {
        total: total,
        courses: coursesSet.size,
        watched: watchedCount
      });
    }

    box.innerHTML = "";
    if (!total) {
      box.innerHTML = "<div class=\"muted\" style=\"padding:24px;text-align:center;\">" + escapeHtml(t("savedNone")) + "</div>";
      return;
    }

    const searchQ = (byId("libSearch")?.value || "").trim().toLowerCase();
    const groupMode = byId("libGroup")?.value || "course";
    const sortMode = byId("libSort")?.value || "lesson_asc";

    // Filter records
    const filtered = savedRecordsCache.filter(rec => {
      if (libFilterWatched === "watched" && !rec.watched) return false;
      if (libFilterWatched === "unwatched" && rec.watched) return false;
      if (searchQ) {
        const m = rec.parsedMeta;
        const mat = (window.MaterialsDB && m.material) ? window.MaterialsDB.get(m.material) : null;
        const hay = [
          rec.name,
          rec.label,
          m.college,
          m.material,
          mat ? mat.ar : "",
          mat ? mat.en : "",
          (mat && mat.alts) ? mat.alts.map(a => a.ar + " " + a.en).join(" ") : "",
          "c" + m.className,
          m.className,
          m.term,
          "s" + m.lesson,
          m.lesson,
          m.tutor,
          m.date
        ].join(" ").toLowerCase();
        if (!hay.includes(searchQ)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      box.innerHTML = "<div class=\"muted\" style=\"padding:24px;text-align:center;\">" + escapeHtml(t("libNoMatch")) + "</div>";
      return;
    }

    // Sort comparator
    const compareRecs = (a, b) => {
      const ma = a.parsedMeta;
      const mb = b.parsedMeta;
      if (sortMode === "lesson_asc") {
        if (ma.lessonNum !== mb.lessonNum) return ma.lessonNum - mb.lessonNum;
        return String(ma.date).localeCompare(String(mb.date));
      }
      if (sortMode === "lesson_desc") {
        if (ma.lessonNum !== mb.lessonNum) return mb.lessonNum - ma.lessonNum;
        return String(mb.date).localeCompare(String(ma.date));
      }
      if (sortMode === "date_desc") {
        return String(mb.date).localeCompare(String(ma.date)) || (mb.lessonNum - ma.lessonNum);
      }
      if (sortMode === "date_asc") {
        return String(ma.date).localeCompare(String(mb.date)) || (ma.lessonNum - mb.lessonNum);
      }
      return (b.savedAt || 0) - (a.savedAt || 0);
    };

    if (groupMode === "none") {
      const sorted = filtered.slice().sort(compareRecs);
      for (const rec of sorted) {
        box.appendChild(createLectureRowEl(rec, false));
      }
      return;
    }

    // Group records
    const groupsMap = new Map();
    for (const rec of filtered) {
      const m = rec.parsedMeta;
      const gKey = m.localGroup
        ? "__LOCAL_FILES__"
        : groupMode === "college"
          ? (m.college || "OTHER")
          : groupMode === "term"
            ? (m.term || "OTHER")
            : (m.material || "OTHER");
      if (!groupsMap.has(gKey)) {
        groupsMap.set(gKey, []);
      }
      groupsMap.get(gKey).push(rec);
    }

    const sortedGroupKeys = Array.from(groupsMap.keys()).sort((a, b) => {
      if (a === "__LOCAL_FILES__") return 1;
      if (b === "__LOCAL_FILES__") return -1;
      return a.localeCompare(b);
    });
    let themeIdx = 0;
    for (const gKey of sortedGroupKeys) {
      const items = groupsMap.get(gKey).slice().sort(compareRecs);
      const sample = items[0].parsedMeta;
      const gWatched = items.filter(r => r.watched).length;
      const pct = Math.round((gWatched / items.length) * 100);
      const isLocal = gKey === "__LOCAL_FILES__";
      const themeClass = isLocal ? "mat-theme-local" : ("mat-theme-" + (themeIdx++ % 6));

      const gCard = document.createElement("div");
      gCard.className = "lib-group-card " + themeClass + (collapsedGroups.has(gKey) ? " collapsed" : "");

      const gHead = document.createElement("div");
      gHead.className = "lib-group-head";

      const gTitle = document.createElement("div");
      gTitle.className = "lib-group-title";
      if (isLocal) {
        gTitle.innerHTML =
          "<div class=\"lib-course-head-info\"><h4 class=\"lib-course-title\">" + escapeHtml(t("localFilesGroup")) + "</h4><div class=\"lib-course-meta-line\">" + items.length + " " + escapeHtml(t("sessions")) + "</div></div>";
      } else if (groupMode === "course") {
        const mat = (window.MaterialsDB && gKey !== "OTHER") ? window.MaterialsDB.get(gKey) : null;
        const isEn = window.I18N && window.I18N.lang === "en";
        const primary = mat ? (isEn ? (mat.en || mat.ar) : (mat.ar || mat.en)) : "";
        const tooltip = mat ? window.MaterialsDB.getTooltip(gKey) : "";
        const courseTitle = gKey + (primary ? (" — " + primary) : "");
        const metaParts = [];
        if (sample.college) metaParts.push(sample.college);
        if (sample.term) metaParts.push(sample.term);
        if (sample.className) metaParts.push(t("metaClass") + " " + sample.className);
        if (sample.tutor) metaParts.push(sample.tutor);
        const metaLine = metaParts.map(escapeHtml).join(" • ");
        gTitle.innerHTML =
          "<div class=\"lib-course-head-info\" title=\"" + escapeHtml(tooltip) + "\">" +
            "<h4 class=\"lib-course-title\">" + escapeHtml(courseTitle) + "</h4>" +
            (metaLine ? ("<div class=\"lib-course-meta-line\">" + metaLine + "</div>") : "") +
          "</div>";
      } else {
        gTitle.innerHTML =
          "<div class=\"lib-course-head-info\"><h4 class=\"lib-course-title\">" + escapeHtml(gKey) + "</h4><div class=\"lib-course-meta-line\">" + items.length + " " + escapeHtml(t("sessions")) + "</div></div>";
      }

      const gProg = document.createElement("div");
      gProg.className = "lib-group-prog";
      gProg.innerHTML =
        "<span>" + escapeHtml(t("libCourseProgress", { w: gWatched, t: items.length })) + "</span>" +
        "<div class=\"lib-mini-bar\"><i style=\"width:" + pct + "%\"></i></div>" +
        "<span style=\"font-size:10px;opacity:.7\">▾</span>";

      gHead.append(gTitle, gProg);

      const gList = document.createElement("div");
      gList.className = "lib-group-list";
      for (const rec of items) {
        gList.appendChild(createLectureRowEl(rec, !isLocal && groupMode === "course"));
      }

      gHead.addEventListener("click", () => {
        if (collapsedGroups.has(gKey)) {
          collapsedGroups.delete(gKey);
          gCard.classList.remove("collapsed");
        } else {
          collapsedGroups.add(gKey);
          gCard.classList.add("collapsed");
        }
      });

      gCard.append(gHead, gList);
      box.appendChild(gCard);
    }
  }

  function createLectureRowEl(rec, insideMaterialWindow) {
    const m = rec.parsedMeta;
    const row = document.createElement("div");
    row.className = "lec-row" + (rec.watched ? " is-watched" : "");

    // 1-Click Watched Toggle (clean circular checkmark button)
    const watchBtn = document.createElement("button");
    watchBtn.className = "watch-btn" + (rec.watched ? " on" : "");
    watchBtn.setAttribute("aria-label", rec.watched ? t("libWatched") : t("libUnwatched"));
    watchBtn.title = rec.watched ? t("libWatched") : t("libUnwatched");
    watchBtn.innerHTML = rec.watched
      ? "<svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' stroke-width='2.5'><polyline points='20 6 9 17 4 12'/></svg>"
      : "<svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='9'/></svg>";
    watchBtn.addEventListener("click", () => {
      setLectureWatched(rec.id, !rec.watched);
    });

    const info = document.createElement("div");
    info.className = "lec-info";

    const titleRow = document.createElement("div");
    titleRow.className = "lec-title-row";
    const lessonTitle = m.lesson ? t("batchLessonNum", { n: m.lesson }) : rec.name;
    titleRow.innerHTML = "<b>" + escapeHtml(lessonTitle) + "</b>";

    if (!insideMaterialWindow && m.material && m.material !== "__LOCAL_FILES__") {
      const mat = (window.MaterialsDB) ? window.MaterialsDB.get(m.material) : null;
      const isEn = window.I18N && window.I18N.lang === "en";
      const mName = mat ? (isEn ? (mat.en || mat.ar) : (mat.ar || mat.en)) : "";
      titleRow.innerHTML += "<span class=\"lec-course-tag\">" + escapeHtml(m.material + (mName ? " · " + mName : "")) + "</span>";
    }

    const sub = document.createElement("div");
    sub.className = "lec-sub";
    const subParts = [];
    if (m.date) subParts.push(m.date);
    subParts.push(formatSize(rec.size || 0));
    sub.innerHTML = "<span>" + subParts.map(escapeHtml).join(" • ") + "</span>";

    info.append(titleRow, sub);

    const playBtn = document.createElement("button");
    playBtn.className = "primary lec-play-btn";
    playBtn.innerHTML = "<svg viewBox='0 0 24 24' width='14' height='14' fill='currentColor'><polygon points='6 3 20 12 6 21 6 3'/></svg><span>" + escapeHtml(t("play")) + "</span>";
    playBtn.addEventListener("click", () => playSaved(rec.id));

    const delBtn = document.createElement("button");
    delBtn.className = "lec-del-btn";
    delBtn.title = t("del");
    delBtn.setAttribute("aria-label", t("del"));
    delBtn.innerHTML = "<svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' stroke-width='2'><polyline points='3 6 5 6 21 6'/><path d='M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'/></svg>";
    delBtn.addEventListener("click", async () => {
      if (confirm(t("confirmDelete", { name: rec.name }))) {
        await LibraryDB.remove(rec.id);
        refreshSaved();
      }
    });

    const exportBtn = document.createElement("button");
    exportBtn.className = "lec-export-btn";
    exportBtn.title = t("exportLrec");
    exportBtn.setAttribute("aria-label", t("exportLrec"));
    exportBtn.innerHTML = "<svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' stroke-width='2'><path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/><polyline points='7 10 12 15 17 10'/><line x1='12' y1='15' x2='12' y2='3'/></svg>";
    exportBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await exportLrecFile(rec, exportBtn);
    });

    const actions = document.createElement("div");
    actions.className = "lec-actions";
    actions.append(playBtn, exportBtn, delBtn);
    row.append(watchBtn, info, actions);
    return row;
  }

  // Check for New Lectures across all saved courses & batch subscriptions
  async function checkLibraryForNewLectures() {
    const banner = byId("libSyncBanner");
    const syncTxt = byId("libSyncTxt");
    const syncDlBtn = byId("libSyncDlBtn");
    if (!banner || !syncTxt || !syncDlBtn) return;

    banner.hidden = false;
    syncDlBtn.hidden = true;
    syncTxt.textContent = t("libCheckingNew");
    byId("dlspin").hidden = false;

    await refreshSaved();

    // Gather unique course subscriptions with known rawIds from saved records + batchState
    const subsMap = new Map();
    for (const rec of savedRecordsCache) {
      const raw = rec.parsedMeta?.rawIds;
      if (raw && raw.term && raw.program && raw.course && raw.tutor && raw.class) {
        const key = [raw.term, raw.program, raw.course, raw.tutor, raw.class].join("|");
        subsMap.set(key, raw);
      }
    }
    if (batchState.term && batchState.program && batchState.courses) {
      for (const [courseVal, cState] of Object.entries(batchState.courses)) {
        if (cState && cState.checked && cState.tutor && cState.classVal) {
          const raw = {
            term: batchState.term,
            program: batchState.program,
            course: courseVal,
            tutor: cState.tutor,
            class: cState.classVal
          };
          const key = [raw.term, raw.program, raw.course, raw.tutor, raw.class].join("|");
          subsMap.set(key, raw);
        }
      }
    }

    const newTasks = [];
    try {
      for (const raw of subsMap.values()) {
        const json = await fetchBrowse({ ...raw, refresh: "1" });
        const remoteSessions = json.sessions || [];
        for (const s of remoteSessions) {
          if (!isSessionSavedInLib(s, s.term, s.program, s.course, s.class)) {
            newTasks.push({
              termVal: raw.term,
              progVal: raw.program,
              courseVal: raw.course,
              tutorVal: raw.tutor,
              classVal: raw.class,
              sessionIndex: s.index,
              sessionObj: s
            });
          }
        }
        await sleep(500);
      }

      if (newTasks.length > 0) {
        syncTxt.textContent = t("libFoundNew", { n: newTasks.length });
        syncDlBtn.textContent = t("libDownloadNewNow", { n: newTasks.length });
        syncDlBtn.hidden = false;
        syncDlBtn.onclick = () => {
          banner.hidden = true;
          showTab("batch");
          runBatchQueue(newTasks);
        };
      } else {
        syncTxt.textContent = t("libUpToDate");
      }
    } catch (err) {
      syncTxt.textContent = t("stCouldNotLoad", { e: err.message });
    }
    byId("dlspin").hidden = true;
  }

  if (byId("libSearch")) {
    byId("libSearch").addEventListener("input", renderLibraryView);
  }
  if (byId("libGroup")) {
    byId("libGroup").addEventListener("change", renderLibraryView);
  }
  if (byId("libSort")) {
    byId("libSort").addEventListener("change", renderLibraryView);
  }
  document.querySelectorAll(".lib-fpill[data-wfilter]").forEach(btn => {
    btn.addEventListener("click", () => {
      libFilterWatched = btn.dataset.wfilter;
      document.querySelectorAll(".lib-fpill[data-wfilter]").forEach(b => b.classList.toggle("on", b === btn));
      renderLibraryView();
    });
  });
  if (byId("libCheckNewBtn")) {
    byId("libCheckNewBtn").addEventListener("click", checkLibraryForNewLectures);
  }
  if (byId("libGoBatchBtn")) {
    byId("libGoBatchBtn").addEventListener("click", () => {
      showTab("batch");
      initBatchTab(false);
    });
  }

  async function playSaved(id) {
    const rec = await LibraryDB.get(id);
    if (!rec) {
      refreshSaved();
      return;
    }
    dialog.close();
    window.__lrec.openFile(new File([rec.blob], rec.name), {
      autoplay: true
    });
  }

  function showTab(name) {
    byId("tabFile").classList.toggle("on", name === "file");
    byId("paneFile").hidden = name !== "file";
    byId("tabRemote").classList.toggle("on", name === "remote");
    if (byId("tabBatch")) {
      byId("tabBatch").classList.toggle("on", name === "batch");
    }
    if (byId("tabLink")) {
      byId("tabLink").classList.toggle("on", name === "link");
    }
    byId("tabSaved").classList.toggle("on", name === "saved");
    byId("paneRemote").hidden = name !== "remote";
    if (byId("paneBatch")) {
      byId("paneBatch").hidden = name !== "batch";
    }
    if (byId("paneLink")) {
      byId("paneLink").hidden = name !== "link";
    }
    byId("paneSaved").hidden = name !== "saved";
    if (byId("keepWrap")) {
      byId("keepWrap").hidden = name !== "remote" && name !== "link";
    }
    if (name === "saved") {
      refreshSaved();
    }
  }

  byId("tabFile").addEventListener("click", () => showTab("file"));
  byId("tabRemote").addEventListener("click", () => {
    showTab("remote");
    loadTerms();
  });
  if (byId("tabBatch")) {
    byId("tabBatch").addEventListener("click", () => {
      showTab("batch");
      initBatchTab(false);
    });
  }
  if (byId("tabLink")) {
    byId("tabLink").addEventListener("click", () => {
      showTab("link");
      setTimeout(() => byId("pasteUrl") && byId("pasteUrl").focus(), 40);
    });
  }
  byId("tabSaved").addEventListener("click", () => showTab("saved"));
  byId("dlgClose").addEventListener("click", () => {
    if (controller) {
      controller.abort();
    }
    dialog.close();
  });
  dialog.addEventListener("click", event => {
    if (event.target === dialog && !downloading && !batchQueueRunning) {
      dialog.close();
    }
  });

  async function openDialog(tab) {
    window.openBrowseDialog = openDialog;
    showTab(tab);
    syncCascadeStyles();
    dialog.showModal();
    await refreshSaved();
    if (tab === "remote") {
      await loadTerms();
      if (!termsLoaded && savedIds.size) {
        showTab("saved");
      }
    } else if (tab === "batch") {
      await initBatchTab(false);
    }
  }

  // Top "Open file" button opens the Open File tab directly
  byId("openBtn").addEventListener("click", () => openDialog("file"));
  if (byId("libHeaderBtn")) {
    byId("libHeaderBtn").addEventListener("click", () => openDialog("saved"));
  }
  if (byId("dropBrowseBtn")) {
    byId("dropBrowseBtn").addEventListener("click", () => openDialog("remote"));
  }
  if (byId("dropBatchBtn")) {
    byId("dropBatchBtn").addEventListener("click", () => openDialog("batch"));
  }
  if (byId("dropLibBtn")) {
    byId("dropLibBtn").addEventListener("click", () => openDialog("saved"));
  }

  /* ====================================================================== *
   * LOCAL FILE OPEN PROMPT (#localSaveDlg) — Merge vs Separate Local Group
   * ====================================================================== */
  const localSaveDlg = byId("localSaveDlg");
  let pendingLocalFile = null;

  async function saveLocalFileToLibrary(file, asSeparateLocalGroup) {
    if (!file || !LibraryDB.available) return;
    try {
      const parsed = parseLrecNameMeta(file.name);
      const label = [
        parsed.term,
        parsed.college,
        parsed.material,
        parsed.className ? ("C" + parsed.className) : "",
        parsed.lesson ? ("S" + parsed.lesson) : ""
      ].filter(Boolean).join(" · ") || file.name;

      await LibraryDB.put({
        id: file.name,
        name: file.name,
        label: label,
        meta: {
          college: parsed.college || "",
          material: parsed.material || "OTHER",
          className: parsed.className || "",
          term: parsed.term || "",
          lesson: parsed.lesson || "",
          date: parsed.date || new Date().toISOString().slice(0, 10),
          localGroup: !!asSeparateLocalGroup
        },
        watched: false,
        size: file.size || 0,
        savedAt: Date.now(),
        url: "",
        blob: file
      });
      LibraryDB.persist();
      await refreshSaved();
    } catch (err) {}
  }

  window.__svuHandleLocalFileOpen = async function (file) {
    if (!file) return;
    await refreshSaved();
    // If already saved in active profile library or IndexedDB unavailable, just play
    if (!LibraryDB.available || savedIds.has(file.name) || !localSaveDlg) {
      window.__lrec.openFile(file, { autoplay: true });
      return;
    }
    pendingLocalFile = file;
    const parsed = parseLrecNameMeta(file.name);
    if (byId("localSaveFileName")) {
      byId("localSaveFileName").textContent = file.name + " (" + formatSize(file.size || 0) + ")";
    }
    const tagsEl = byId("localSaveTags");
    if (tagsEl) {
      let html = "";
      if (parsed.college) html += "<span class=\"mtag mtag-college\"><b>" + escapeHtml(t("metaCollege")) + " :</b> " + escapeHtml(parsed.college) + "</span>";
      if (parsed.material) {
        if (window.MaterialsDB) {
          html += window.MaterialsDB.getBadgeHtml(parsed.material);
        } else {
          html += "<span class=\"mtag mtag-material\"><b>" + escapeHtml(t("metaMaterial")) + " :</b> " + escapeHtml(parsed.material) + "</span>";
        }
      }
      if (parsed.className) html += "<span class=\"mtag mtag-class\"><b>" + escapeHtml(t("metaClass")) + " :</b> " + escapeHtml(parsed.className) + "</span>";
      if (parsed.term) html += "<span class=\"mtag mtag-term\"><b>" + escapeHtml(t("metaTerm")) + " :</b> " + escapeHtml(parsed.term) + "</span>";
      if (parsed.lesson) html += "<span class=\"mtag mtag-lesson\"><b>" + escapeHtml(t("metaLesson")) + " :</b> " + escapeHtml(parsed.lesson) + "</span>";
      if (parsed.date) html += "<span class=\"mtag mtag-date\"><b>" + escapeHtml(t("metaDate")) + " :</b> " + escapeHtml(parsed.date) + "</span>";
      tagsEl.innerHTML = html;
    }
    localSaveDlg.showModal();
  };

  if (byId("localSaveMergeBtn")) {
    byId("localSaveMergeBtn").addEventListener("click", async () => {
      const f = pendingLocalFile;
      pendingLocalFile = null;
      localSaveDlg.close();
      if (f) {
        window.__lrec.openFile(f, { autoplay: true });
        await saveLocalFileToLibrary(f, false);
      }
    });
  }
  if (byId("localSaveSeparateBtn")) {
    byId("localSaveSeparateBtn").addEventListener("click", async () => {
      const f = pendingLocalFile;
      pendingLocalFile = null;
      localSaveDlg.close();
      if (f) {
        window.__lrec.openFile(f, { autoplay: true });
        await saveLocalFileToLibrary(f, true);
      }
    });
  }
  if (byId("localSavePlayOnlyBtn")) {
    byId("localSavePlayOnlyBtn").addEventListener("click", () => {
      const f = pendingLocalFile;
      pendingLocalFile = null;
      localSaveDlg.close();
      if (f) {
        window.__lrec.openFile(f, { autoplay: true });
      }
    });
  }
  if (byId("localSaveClose")) {
    byId("localSaveClose").addEventListener("click", () => {
      const f = pendingLocalFile;
      pendingLocalFile = null;
      localSaveDlg.close();
      if (f) {
        window.__lrec.openFile(f, { autoplay: true });
      }
    });
  }

  /* ====================================================================== *
   * MULTI-PROFILE WORKSPACE & ISOLATED STORAGE MANAGER (#profileDlg)
   * ====================================================================== */
  const PROFILES_LIST_KEY = "svu.profiles.list.v1";
  const ACTIVE_PROFILE_KEY = "svu.activeProfile.v1";
  const profileDlg = byId("profileDlg");
  let profilesList = [];
  let activeProfileId = "default";
  let editingProfileId = null;

  function loadProfilesFromStorage() {
    try {
      const rawAct = localStorage.getItem(ACTIVE_PROFILE_KEY) || getPref(ACTIVE_PROFILE_KEY, "default") || "default";
      activeProfileId = String(rawAct).trim() || "default";
    } catch (e) {
      activeProfileId = "default";
    }
    try {
      const rawList = localStorage.getItem(PROFILES_LIST_KEY) || getPref(PROFILES_LIST_KEY, "");
      if (rawList) {
        const parsed = JSON.parse(rawList);
        if (Array.isArray(parsed) && parsed.length) {
          profilesList = parsed;
        }
      }
    } catch (e) {}

    if (!profilesList.some(p => p && p.id === "default")) {
      const curTh = window.__svuGetTheme ? window.__svuGetTheme() : { theme: "default", mode: "dark" };
      const defaultMats = [];
      if (batchState && batchState.courses) {
        for (const [cVal, cSt] of Object.entries(batchState.courses)) {
          if (cSt && cSt.checked) {
            defaultMats.push({
              course: cVal,
              classVal: cSt.classVal || "",
              tutor: cSt.tutor || "",
              lessons: cSt.lessonSpec || "ALL"
            });
          }
        }
      }
      profilesList.unshift({
        id: "default",
        name: "",
        theme: curTh.theme || "default",
        mode: curTh.mode || "dark",
        lang: (window.I18N && window.I18N.lang) || "ar",
        term: batchState.term || "F25",
        program: batchState.program || "ITE",
        materials: defaultMats
      });
    }
    if (!profilesList.some(p => p && p.id === activeProfileId)) {
      activeProfileId = "default";
    }
    if (LibraryDB && LibraryDB.setProfile) {
      LibraryDB.setProfile(activeProfileId);
    }
  }

  function saveProfilesToStorage() {
    try {
      const s = JSON.stringify(profilesList);
      try { localStorage.setItem(PROFILES_LIST_KEY, s); } catch (e) {}
      setPref(PROFILES_LIST_KEY, s);
      try { localStorage.setItem(ACTIVE_PROFILE_KEY, activeProfileId); } catch (e) {}
      setPref(ACTIVE_PROFILE_KEY, activeProfileId);
    } catch (err) {}
  }

  function getProfileDisplayName(prof) {
    if (!prof) return t("profileDefaultName");
    if (prof.name && prof.name.trim()) return prof.name.trim();
    if (prof.id === "default") return t("profileDefaultName");
    return prof.id;
  }

  function updateProfileHeaderBtn() {
    const lbl = byId("activeProfileLbl");
    if (!lbl) return;
    const activeProf = profilesList.find(p => p.id === activeProfileId) || profilesList[0];
    lbl.removeAttribute("data-i18n");
    lbl.textContent = getProfileDisplayName(activeProf);
  }

  function applyProfileMaterialsToBatchState(prof) {
    if (!prof) return;
    if (prof.term) {
      const termCode = normCode(prof.term);
      const matchedTerm = (batchCache.terms || []).find(tm =>
        normCode(tm.value) === termCode || normCode(tm.label) === termCode
      );
      batchState.term = matchedTerm ? matchedTerm.value : prof.term.trim();
    }
    if (prof.program) {
      const progCode = normCode(prof.program);
      const termProgs = (batchCache.programs && batchCache.programs[batchState.term]) || [];
      const matchedProg = termProgs.find(pr =>
        normCode(pr.value) === progCode || normCode(pr.label) === progCode
      );
      batchState.program = matchedProg ? matchedProg.value : prof.program.trim();
    }
    if (Array.isArray(prof.materials) && prof.materials.length) {
      const newCourses = {};
      const cacheKey = batchState.term + "|" + batchState.program;
      const catList = (batchCache.courses && batchCache.courses[cacheKey]) || batchCourseCatalog || [];
      for (const m of prof.materials) {
        if (!m || !m.course) continue;
        const cCode = normCode(m.course);
        const catItem = catList.find(c =>
          normCode(c.value) === cCode ||
          normCode(c.label) === cCode ||
          normCode(c.label).includes(cCode)
        );
        const key = catItem ? catItem.value : m.course.trim().toUpperCase();
        const label = catItem ? catItem.label : key;
        let cls = m.classVal ? String(m.classVal).trim().toUpperCase() : "";
        if (/^\d+$/.test(cls)) cls = "C" + cls;
        newCourses[key] = {
          checked: true,
          label: label,
          tutor: m.tutor ? String(m.tutor).trim() : "",
          classVal: cls,
          lessonSpec: m.lessons ? String(m.lessons).trim() : "ALL",
          selectedLessons: null
        };
      }
      batchState.courses = newCourses;
    }
    saveBatchState();
  }

  async function activateProfile(profId, openBatchAfter) {
    const prof = profilesList.find(p => p.id === profId);
    if (!prof) return;
    activeProfileId = prof.id;
    if (LibraryDB && LibraryDB.setProfile) {
      LibraryDB.setProfile(activeProfileId);
    }
    saveProfilesToStorage();

    // Apply profile Theme, Mode & Language
    if (window.__svuApplyTheme) {
      window.__svuApplyTheme(prof.theme || "default", prof.mode || "dark");
    }
    if (window.I18N && prof.lang && window.I18N.lang !== prof.lang) {
      window.I18N.setLang(prof.lang);
    }

    // Reload isolated storage for this profile
    loadWatchedMap();
    loadBatchStorage();
    if (prof.term || prof.program || (Array.isArray(prof.materials) && prof.materials.length)) {
      applyProfileMaterialsToBatchState(prof);
    }
    batchRuntime = {};
    updateProfileHeaderBtn();
    await refreshSaved();
    renderProfilesList();

    if (openBatchAfter) {
      if (profileDlg && profileDlg.open) profileDlg.close();
      await openDialog("batch");
    }
  }

  function formatMaterialsToText(mats) {
    if (!Array.isArray(mats) || !mats.length) return "";
    return mats
      .filter(m => m && m.course)
      .map(m => [
        m.course.trim(),
        m.classVal ? m.classVal.trim() : "",
        m.tutor ? m.tutor.trim() : "",
        m.lessons ? m.lessons.trim() : "ALL"
      ].join(" | "))
      .join("\n");
  }

  function parseMaterialsFromText(text) {
    const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const result = [];
    for (const line of lines) {
      if (line.includes("|")) {
        const parts = line.split("|").map(s => s.trim());
        if (parts[0]) {
          result.push({
            course: parts[0].toUpperCase(),
            classVal: parts[1] || "",
            tutor: parts[2] || "",
            lessons: parts[3] || "ALL"
          });
        }
      } else {
        const tokens = line.split(/[\s,]+/).filter(Boolean);
        if (!tokens.length) continue;
        const course = tokens[0].toUpperCase();
        let classVal = "";
        let tutor = "";
        let lessons = "ALL";
        for (let i = 1; i < tokens.length; i++) {
          const tk = tokens[i];
          if (/^C?\d+$/i.test(tk) && !classVal) {
            classVal = /^C/i.test(tk) ? tk.toUpperCase() : ("C" + tk);
          } else if (/^(ALL|UNSAVED|NONE|\d+(-\d+)?)$/i.test(tk)) {
            lessons = tk.toUpperCase();
          } else if (!tutor) {
            tutor = tk;
          }
        }
        result.push({ course, classVal, tutor, lessons });
      }
    }
    return result;
  }

  function collectMatRowsFromDom() {
    const container = byId("profMatRows");
    if (!container) return [];
    const rows = [];
    container.querySelectorAll(".prof-mat-row").forEach(rowEl => {
      const course = rowEl.querySelector(".pm-course")?.value.trim() || "";
      const classVal = rowEl.querySelector(".pm-class")?.value.trim() || "";
      const tutor = rowEl.querySelector(".pm-tutor")?.value.trim() || "";
      const lessons = rowEl.querySelector(".pm-lessons")?.value.trim() || "ALL";
      if (course) {
        rows.push({ course: course.toUpperCase(), classVal, tutor, lessons });
      }
    });
    return rows;
  }

  function addMatRowEl(mat = { course: "", classVal: "", tutor: "", lessons: "ALL" }) {
    const container = byId("profMatRows");
    if (!container) return;
    const row = document.createElement("div");
    row.className = "prof-mat-row";

    const inCourse = document.createElement("input");
    inCourse.type = "text";
    inCourse.className = "pm-course";
    inCourse.setAttribute("list", "profCourseDatalist");
    inCourse.placeholder = t("profileMatCoursePh");
    inCourse.value = mat.course || "";

    const inClass = document.createElement("input");
    inClass.type = "text";
    inClass.className = "pm-class";
    inClass.placeholder = t("profileMatClassPh");
    inClass.value = mat.classVal || "";

    const inTutor = document.createElement("input");
    inTutor.type = "text";
    inTutor.className = "pm-tutor";
    inTutor.placeholder = t("profileMatTutorPh");
    inTutor.value = mat.tutor || "";

    const inLessons = document.createElement("input");
    inLessons.type = "text";
    inLessons.className = "pm-lessons";
    inLessons.placeholder = t("profileMatLessonsPh");
    inLessons.value = mat.lessons || "ALL";

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "iconbtn";
    delBtn.style.width = "30px";
    delBtn.style.height = "30px";
    delBtn.innerHTML = "<svg class=\"i\"><use href=\"#i-close\"/></svg>";
    delBtn.addEventListener("click", () => {
      row.remove();
      if (byId("profMatText")) {
        byId("profMatText").value = formatMaterialsToText(collectMatRowsFromDom());
      }
    });

    [inCourse, inClass, inTutor, inLessons].forEach(inp => {
      inp.addEventListener("input", () => {
        if (byId("profMatText")) {
          byId("profMatText").value = formatMaterialsToText(collectMatRowsFromDom());
        }
      });
    });

    row.append(inCourse, inClass, inTutor, inLessons, delBtn);
    container.appendChild(row);
  }

  function populateProfileDatalists() {
    const termDl = byId("profTermDatalist");
    if (termDl) {
      termDl.innerHTML = "";
      (batchCache.terms || []).forEach(tm => {
        const opt = document.createElement("option");
        opt.value = tm.value;
        opt.label = tm.label;
        termDl.appendChild(opt);
      });
    }
    const progDl = byId("profProgDatalist");
    if (progDl) {
      progDl.innerHTML = "";
      const seenProgs = new Set();
      Object.values(batchCache.programs || {}).forEach(list => {
        (list || []).forEach(pr => {
          if (!seenProgs.has(pr.value)) {
            seenProgs.add(pr.value);
            const opt = document.createElement("option");
            opt.value = pr.value;
            opt.label = pr.label;
            progDl.appendChild(opt);
          }
        });
      });
    }
    const courseDl = byId("profCourseDatalist");
    if (courseDl) {
      courseDl.innerHTML = "";
      const seenCourses = new Set();
      if (window.MaterialsDB) {
        const isEn = window.I18N && window.I18N.lang === "en";
        window.MaterialsDB.all().forEach(m => {
          seenCourses.add(m.code);
          const opt = document.createElement("option");
          opt.value = m.code;
          const name = isEn ? (m.en || m.ar) : (m.ar || m.en);
          opt.label = m.code + " — " + name;
          courseDl.appendChild(opt);
        });
      }
      Object.values(batchCache.courses || {}).forEach(list => {
        (list || []).forEach(c => {
          if (!seenCourses.has(c.value)) {
            seenCourses.add(c.value);
            const opt = document.createElement("option");
            opt.value = c.value;
            opt.label = c.label;
            courseDl.appendChild(opt);
          }
        });
      });
    }
  }

  function openProfileEditor(prof) {
    const editor = byId("profEditor");
    if (!editor) return;
    populateProfileDatalists();
    editingProfileId = prof ? prof.id : null;
    byId("profEditorTitle").textContent = prof ? t("profileFormEditTitle") : t("profileFormNewTitle");

    const curTh = window.__svuGetTheme ? window.__svuGetTheme() : { theme: "default", mode: "dark" };
    byId("profNameInput").value = prof ? getProfileDisplayName(prof) : "";
    byId("profThemeInput").value = (prof && prof.theme) || curTh.theme || "default";
    byId("profModeInput").value = (prof && prof.mode) || curTh.mode || "dark";
    byId("profLangInput").value = (prof && prof.lang) || (window.I18N && window.I18N.lang) || "ar";
    byId("profTermInput").value = (prof && prof.term) || batchState.term || "F25";
    byId("profProgInput").value = (prof && prof.program) || batchState.program || "ITE";

    const rowsBox = byId("profMatRows");
    rowsBox.innerHTML = "";
    const mats = (prof && Array.isArray(prof.materials) && prof.materials.length)
      ? prof.materials
      : [{ course: "", classVal: "", tutor: "", lessons: "ALL" }];
    mats.forEach(m => addMatRowEl(m));
    byId("profMatText").value = formatMaterialsToText(prof ? prof.materials : []);
    editor.hidden = false;
    byId("profNameInput").focus();
  }

  function saveProfileFromEditor(andOpenBatch) {
    // If the user typed in the Quick Text Box and rows are empty or text has more lines, sync text first
    let mats = collectMatRowsFromDom();
    const textMats = parseMaterialsFromText(byId("profMatText")?.value || "");
    if (textMats.length && (!mats.length || textMats.length >= mats.length)) {
      mats = textMats;
    }

    const nameVal = byId("profNameInput").value.trim() || t("profileDefaultName");
    const themeVal = byId("profThemeInput").value || "default";
    const modeVal = byId("profModeInput").value || "dark";
    const langVal = byId("profLangInput").value || "ar";
    const termVal = byId("profTermInput").value.trim().toUpperCase();
    const progVal = byId("profProgInput").value.trim().toUpperCase();

    let targetId = editingProfileId;
    if (targetId) {
      const existing = profilesList.find(p => p.id === targetId);
      if (existing) {
        existing.name = nameVal;
        existing.theme = themeVal;
        existing.mode = modeVal;
        existing.lang = langVal;
        existing.term = termVal;
        existing.program = progVal;
        existing.materials = mats;
      }
    } else {
      targetId = "prof_" + Date.now();
      profilesList.push({
        id: targetId,
        name: nameVal,
        theme: themeVal,
        mode: modeVal,
        lang: langVal,
        term: termVal,
        program: progVal,
        materials: mats
      });
    }
    byId("profEditor").hidden = true;
    editingProfileId = null;
    saveProfilesToStorage();
    activateProfile(targetId, !!andOpenBatch);
  }

  function renderProfilesList() {
    const box = byId("profList");
    if (!box) return;
    box.innerHTML = "";
    for (const prof of profilesList) {
      const isAct = prof.id === activeProfileId;
      const card = document.createElement("div");
      card.className = "prof-card" + (isAct ? " active" : "");

      const info = document.createElement("div");
      info.className = "prof-info";

      const nameRow = document.createElement("div");
      nameRow.className = "prof-name-row";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = getProfileDisplayName(prof);
      nameRow.appendChild(nameSpan);
      if (isAct) {
        const pill = document.createElement("span");
        pill.className = "prof-active-pill";
        pill.textContent = t("profileActiveBadge");
        nameRow.appendChild(pill);
      }

      const metaRow = document.createElement("div");
      metaRow.className = "prof-meta-row";
      const matList = Array.isArray(prof.materials) ? prof.materials.filter(m => m && m.course) : [];
      metaRow.innerHTML =
        (prof.program ? "<span class=\"mtag mtag-college\">" + escapeHtml(prof.program) + "</span>" : "") +
        (prof.term ? "<span class=\"mtag mtag-term\">" + escapeHtml(prof.term) + "</span>" : "") +
        "<span class=\"mtag mtag-date\">" + escapeHtml(prof.theme || "default") + " · " + escapeHtml(prof.mode || "dark") + " · " + escapeHtml((prof.lang || "ar").toUpperCase()) + "</span>" +
        matList.map(m => {
          const name = window.MaterialsDB ? window.MaterialsDB.getName(m.course) : "";
          const tip = window.MaterialsDB ? window.MaterialsDB.getTooltip(m.course) : "";
          const display = escapeHtml(m.course + (name ? " · " + name : "") + (m.classVal ? " (" + m.classVal + ")" : ""));
          return "<span class=\"mtag mtag-material\" title=\"" + escapeHtml(tip) + "\">" + display + "</span>";
        }).join("");

      info.append(nameRow, metaRow);

      const actions = document.createElement("div");
      actions.className = "prof-actions";

      if (!isAct) {
        const swBtn = document.createElement("button");
        swBtn.className = "primary";
        swBtn.textContent = t("profileSwitchBtn");
        swBtn.addEventListener("click", () => activateProfile(prof.id, false));
        actions.appendChild(swBtn);
      }

      const loadBatchBtn = document.createElement("button");
      if (isAct) loadBatchBtn.className = "primary";
      loadBatchBtn.innerHTML = "<svg class=\"i\"><use href=\"#i-download\"/></svg><span>" + escapeHtml(t("profileLoadBatchBtn")) + "</span>";
      loadBatchBtn.addEventListener("click", () => activateProfile(prof.id, true));
      actions.appendChild(loadBatchBtn);

      const editBtn = document.createElement("button");
      editBtn.textContent = t("profileEditBtn");
      editBtn.addEventListener("click", () => openProfileEditor(prof));
      actions.appendChild(editBtn);

      const exportBtn = document.createElement("button");
      exportBtn.className = "prof-export-btn";
      exportBtn.title = t("profExportTooltip");
      exportBtn.innerHTML = "<svg class=\"i\"><use href=\"#i-download\"/></svg><span>" + escapeHtml(t("profExportBtnShort")) + "</span>";
      exportBtn.addEventListener("click", () => openProfileExportModal(prof.id));
      actions.appendChild(exportBtn);

      if (prof.id !== "default") {
        const delBtn = document.createElement("button");
        delBtn.innerHTML = "<svg class=\"i\"><use href=\"#i-trash\"/></svg><span>" + escapeHtml(t("profileDeleteBtn")) + "</span>";
        delBtn.addEventListener("click", () => {
          if (confirm(t("profileConfirmDel", { name: getProfileDisplayName(prof) }))) {
            profilesList = profilesList.filter(p => p.id !== prof.id);
            saveProfilesToStorage();
            if (activeProfileId === prof.id) {
              activateProfile("default", false);
            } else {
              renderProfilesList();
            }
          }
        });
        actions.appendChild(delBtn);
      }

      card.append(info, actions);
      box.appendChild(card);
    }
  }

  loadProfilesFromStorage();
  updateProfileHeaderBtn();

  if (byId("profileBtn") && profileDlg) {
    byId("profileBtn").addEventListener("click", () => {
      byId("profEditor").hidden = true;
      renderProfilesList();
      profileDlg.showModal();
    });
  }
  if (byId("profileClose") && profileDlg) {
    byId("profileClose").addEventListener("click", () => profileDlg.close());
  }
  if (profileDlg) {
    profileDlg.addEventListener("click", e => {
      if (e.target === profileDlg) profileDlg.close();
    });
  }
  if (byId("profNewBtn")) {
    byId("profNewBtn").addEventListener("click", () => openProfileEditor(null));
  }
  if (byId("profAddMatRowBtn")) {
    byId("profAddMatRowBtn").addEventListener("click", () => addMatRowEl());
  }
  if (byId("profParseTextBtn")) {
    byId("profParseTextBtn").addEventListener("click", () => {
      const parsed = parseMaterialsFromText(byId("profMatText")?.value || "");
      const rowsBox = byId("profMatRows");
      if (rowsBox && parsed.length) {
        rowsBox.innerHTML = "";
        parsed.forEach(m => addMatRowEl(m));
      }
    });
  }
  if (byId("profSyncToTextBtn")) {
    byId("profSyncToTextBtn").addEventListener("click", () => {
      if (byId("profMatText")) {
        byId("profMatText").value = formatMaterialsToText(collectMatRowsFromDom());
      }
    });
  }
  if (byId("profCancelBtn")) {
    byId("profCancelBtn").addEventListener("click", () => {
      byId("profEditor").hidden = true;
      editingProfileId = null;
    });
  }
  if (byId("profSaveBtn")) {
    byId("profSaveBtn").addEventListener("click", () => saveProfileFromEditor(false));
  }
  if (byId("profSaveAndLoadBtn")) {
    byId("profSaveAndLoadBtn").addEventListener("click", () => saveProfileFromEditor(true));
  }

  /* ====================================================================== *
   * PROFILE HIGH-CAPACITY BACKUP & RESTORE CONTROLLER (EXPORT / IMPORT)
   * Binary Container Format "SVUBACK1" (supports 100+ lectures & multi-GBs)
   * ====================================================================== */
  const profExportDlg = byId("profExportDlg");
  const profImportDlg = byId("profImportDlg");
  const profImportFileInput = byId("profImportFileInput");
  let currentExportProfId = null;
  let pendingImportBundle = null;
  let pendingImportSource = null;

  function getBackupFileName(profName) {
    const safeName = (profName || "Profile")
      .trim()
      .replace(/[\\/:*?"<>|\s]+/g, "_")
      .replace(/^_+|_+$/g, "") || "Profile";
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return "SVU_Profile_" + safeName + "_" + yyyy + "-" + mm + "-" + dd + ".svubackup";
  }

  function getDbNameForProf(profId) {
    if (!profId || profId === "default") return "lrec-library";
    return "lrec-library-" + profId.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function openProfIndexedDB(profId) {
    return new Promise((resolve, reject) => {
      const dbName = getDbNameForProf(profId);
      const req = indexedDB.open(dbName, 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
        if (!db.objectStoreNames.contains("transcripts")) db.createObjectStore("transcripts", { keyPath: "id" });
        if (!db.objectStoreNames.contains("enhanced")) db.createObjectStore("enhanced", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllRecordsFromProfDB(profId) {
    const db = await openProfIndexedDB(profId);
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(["files", "transcripts", "enhanced"], "readonly");
        const filesStore = tx.objectStore("files");
        const transStore = tx.objectStore("transcripts");
        const enhStore = tx.objectStore("enhanced");

        const reqFiles = filesStore.getAll();
        const reqTrans = transStore.getAll();
        const reqEnh = enhStore.getAll();

        tx.oncomplete = () => {
          db.close();
          resolve({
            files: reqFiles.result || [],
            transcripts: reqTrans.result || [],
            enhanced: reqEnh.result || []
          });
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      } catch (e) {
        db.close();
        resolve({ files: [], transcripts: [], enhanced: [] });
      }
    });
  }

  async function dataUrlToBlob(dataUrl, defaultType) {
    if (!dataUrl) return null;
    try {
      const res = await fetch(dataUrl);
      return await res.blob();
    } catch (e) {
      const comma = dataUrl.indexOf(",");
      const header = comma >= 0 ? dataUrl.slice(0, comma) : "";
      const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      const match = header.match(/:(.*?);/);
      const mime = (match && match[1]) || defaultType || "application/octet-stream";
      const binStr = atob(b64);
      const len = binStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      return new Blob([bytes], { type: mime });
    }
  }

  function formatBackupBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
  }

  async function openProfileExportModal(profId) {
    currentExportProfId = profId || activeProfileId || "default";
    const prof = profilesList.find(p => p.id === currentExportProfId) || profilesList[0];
    if (!prof) return;

    if (window.I18N && window.I18N.apply) window.I18N.apply();

    const profName = getProfileDisplayName(prof);
    if (byId("exportProfName")) byId("exportProfName").textContent = profName;
    if (byId("exportProfSub")) {
      byId("exportProfSub").textContent = (prof.program || "SVU") + " · " + (prof.term || "Term") + " · " + (prof.theme || "default");
    }
    const genFileName = getBackupFileName(profName);
    if (byId("exportFileNamePreview")) byId("exportFileNamePreview").textContent = genFileName;

    // Reset options
    if (byId("exportOptSettings")) byId("exportOptSettings").checked = true;
    if (byId("exportOptHistory")) byId("exportOptHistory").checked = true;
    if (byId("exportOptBatch")) byId("exportOptBatch").checked = true;
    if (byId("exportOptVideos")) byId("exportOptVideos").checked = true;

    // Reset progress
    const progressWrap = byId("exportProgressWrap");
    if (progressWrap) progressWrap.style.display = "none";
    const startBtn = byId("profExportStartBtn");
    if (startBtn) startBtn.disabled = false;

    // Calculate lectures count & size
    try {
      const records = await getAllRecordsFromProfDB(prof.id);
      const fileCount = records.files.length;
      let totalSize = 0;
      for (const f of records.files) totalSize += (f.size || 0);

      const countBadge = byId("exportLecturesCountBadge");
      if (countBadge) {
        countBadge.textContent = fileCount + " " + (fileCount === 1 ? t("profExportLecOne") : t("profExportLecMany")) + (totalSize > 0 ? " (" + formatBackupBytes(totalSize) + ")" : "");
      }
      const desc = byId("exportOptVideosDesc");
      if (desc) {
        desc.textContent = t("profExportOptVideosDesc") + " (" + fileCount + " " + (fileCount === 1 ? t("profExportLecOne") : t("profExportLecMany")) + ", " + formatBackupBytes(totalSize) + ")";
      }
    } catch (e) {
      if (byId("exportLecturesCountBadge")) byId("exportLecturesCountBadge").textContent = "0";
    }

    if (profExportDlg) {
      profExportDlg.showModal();
    }
  }

  async function executeProfileExport() {
    const prof = profilesList.find(p => p.id === currentExportProfId) || profilesList[0];
    if (!prof) return;

    const optSettings = byId("exportOptSettings")?.checked;
    const optHistory = byId("exportOptHistory")?.checked;
    const optBatch = byId("exportOptBatch")?.checked;
    const optVideos = byId("exportOptVideos")?.checked;

    const progressWrap = byId("exportProgressWrap");
    const progressFill = byId("exportProgressFill");
    const progressStatus = byId("exportProgressStatus");
    const startBtn = byId("profExportStartBtn");

    if (progressWrap) progressWrap.style.display = "flex";
    if (startBtn) startBtn.disabled = true;

    try {
      if (progressStatus) progressStatus.textContent = t("profExportStatusPreparing");
      if (progressFill) progressFill.style.width = "10%";

      // 1. Settings
      const profileData = optSettings ? { ...prof } : { id: prof.id, name: prof.name };

      // 2. Watched history
      let watchedData = {};
      if (optHistory) {
        const wk = prof.id === "default" ? "svu.watched.v1" : ("svu.watched.v1." + prof.id);
        try {
          watchedData = JSON.parse(localStorage.getItem(wk) || getPref(wk, "{}") || "{}");
        } catch (e) {}
      }

      // 3. Batch state
      let batchStateData = {};
      if (optBatch) {
        const bk = prof.id === "default" ? "svu.batch.state.v2" : ("svu.batch.state.v2." + prof.id);
        try {
          batchStateData = JSON.parse(localStorage.getItem(bk) || getPref(bk, "{}") || "{}");
        } catch (e) {}
      }

      // 4. Library (Videos & Transcripts)
      const libraryMeta = { files: [], transcripts: [], enhanced: [] };
      const rawBlobs = [];

      if (optVideos) {
        const records = await getAllRecordsFromProfDB(prof.id);
        libraryMeta.transcripts = records.transcripts || [];
        libraryMeta.enhanced = records.enhanced || [];

        const totalFiles = records.files.length;
        for (let i = 0; i < totalFiles; i++) {
          const f = records.files[i];
          const pct = Math.round(15 + ((i + 1) / Math.max(1, totalFiles)) * 75);
          if (progressFill) progressFill.style.width = pct + "%";
          if (progressStatus) {
            progressStatus.textContent = t("profExportStatusPacking", {
              current: i + 1,
              total: totalFiles,
              name: f.name || ("Lec " + (i + 1))
            });
          }

          let fileBlob = f.blob;
          if (!fileBlob && f.dataUrl) {
            fileBlob = await dataUrlToBlob(f.dataUrl, f.type);
          }
          const blobSize = fileBlob ? fileBlob.size : (f.size || 0);

          libraryMeta.files.push({
            id: f.id,
            name: f.name,
            size: blobSize,
            type: f.type || "application/octet-stream",
            savedAt: f.savedAt || Date.now(),
            meta: f.meta || {}
          });

          if (fileBlob) {
            rawBlobs.push(fileBlob);
          } else {
            rawBlobs.push(new Blob([], { type: "application/octet-stream" }));
          }
        }
      }

      if (progressFill) progressFill.style.width = "92%";
      if (progressStatus) progressStatus.textContent = t("profExportStatusGenerating");

      const bundleMeta = {
        format: "svu-profile-backup",
        version: 2,
        exportedAt: new Date().toISOString(),
        appVersion: (window.__svu_version && window.__svu_version.version) || "2.7.7",
        profile: profileData,
        watched: watchedData,
        batchState: batchStateData,
        library: libraryMeta
      };

      // Construct High-Capacity Binary Bundle "SVUBACK1"
      const metaUtf8 = new TextEncoder().encode(JSON.stringify(bundleMeta));
      const headerBuf = new ArrayBuffer(12);
      const headView = new DataView(headerBuf);
      const magicStr = "SVUBACK1";
      for (let i = 0; i < 8; i++) headView.setUint8(i, magicStr.charCodeAt(i));
      headView.setUint32(8, metaUtf8.byteLength, true);

      const blobParts = [headerBuf, metaUtf8, ...rawBlobs];
      const finalBackupBlob = new Blob(blobParts, { type: "application/octet-stream" });

      const downloadUrl = URL.createObjectURL(finalBackupBlob);
      const fileName = getBackupFileName(getProfileDisplayName(prof));

      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(downloadUrl);
        a.remove();
      }, 5000);

      if (progressFill) progressFill.style.width = "100%";
      if (progressStatus) progressStatus.textContent = t("profExportStatusDone");

      setTimeout(() => {
        if (profExportDlg) profExportDlg.close();
        alert(t("profExportSuccess", { filename: fileName }));
      }, 500);

    } catch (err) {
      console.error("Profile export error:", err);
      alert(t("profExportError") + ": " + (err.message || err));
      if (progressWrap) progressWrap.style.display = "none";
      if (startBtn) startBtn.disabled = false;
    }
  }

  function openImportModal(bundle, fileName, sourceFile) {
    pendingImportBundle = bundle;
    pendingImportSource = sourceFile || null;
    if (!bundle) return;

    if (window.I18N && window.I18N.apply) window.I18N.apply();

    const prof = bundle.profile || {};
    const profName = (prof.name && prof.name.trim()) || fileName.replace(/\.[^/.]+$/, "") || t("profileImportedDefaultName");

    if (byId("importProfFileName")) byId("importProfFileName").textContent = profName;
    if (byId("importProfMeta")) {
      const dateStr = bundle.exportedAt ? bundle.exportedAt.slice(0, 10) : "--";
      byId("importProfMeta").textContent = t("profImportMetaSub", { date: dateStr, ver: bundle.version || 1 });
    }

    // Default to 'new' profile
    const radioNew = document.querySelector('input[name="profImportDest"][value="new"]');
    if (radioNew) radioNew.checked = true;

    // Check available sections in bundle
    const hasSettings = !!bundle.profile;
    const hasHistory = bundle.watched && Object.keys(bundle.watched).length > 0;
    const hasBatch = bundle.batchState && Object.keys(bundle.batchState).length > 0;
    const libFiles = (bundle.library && Array.isArray(bundle.library.files)) ? bundle.library.files : [];
    const hasVideos = libFiles.length > 0;

    let totalSize = 0;
    libFiles.forEach(f => { totalSize += (f.size || 0); });

    if (byId("importOptSettings")) {
      byId("importOptSettings").checked = hasSettings;
      byId("importOptSettings").disabled = !hasSettings;
    }
    if (byId("importOptHistory")) {
      byId("importOptHistory").checked = hasHistory;
      byId("importOptHistory").disabled = !hasHistory;
    }
    if (byId("importOptBatch")) {
      byId("importOptBatch").checked = hasBatch;
      byId("importOptBatch").disabled = !hasBatch;
    }
    if (byId("importOptVideos")) {
      byId("importOptVideos").checked = hasVideos;
      byId("importOptVideos").disabled = !hasVideos;
    }

    if (byId("importLecturesCountBadge")) {
      byId("importLecturesCountBadge").textContent = libFiles.length + " " + (libFiles.length === 1 ? t("profExportLecOne") : t("profExportLecMany")) + (totalSize > 0 ? " (" + formatBackupBytes(totalSize) + ")" : "");
    }

    const progressWrap = byId("importProgressWrap");
    if (progressWrap) progressWrap.style.display = "none";
    const startBtn = byId("profImportStartBtn");
    if (startBtn) startBtn.disabled = false;

    if (profImportDlg) profImportDlg.showModal();
  }

  async function executeProfileImport() {
    if (!pendingImportBundle) return;
    const bundle = pendingImportBundle;
    const sourceFile = pendingImportSource;

    const destChoice = document.querySelector('input[name="profImportDest"]:checked')?.value || "new";
    const optSettings = byId("importOptSettings")?.checked;
    const optHistory = byId("importOptHistory")?.checked;
    const optBatch = byId("importOptBatch")?.checked;
    const optVideos = byId("importOptVideos")?.checked;

    const progressWrap = byId("importProgressWrap");
    const progressFill = byId("importProgressFill");
    const progressStatus = byId("importProgressStatus");
    const startBtn = byId("profImportStartBtn");

    if (progressWrap) progressWrap.style.display = "flex";
    if (startBtn) startBtn.disabled = true;

    try {
      if (progressStatus) progressStatus.textContent = t("profImportStatusPreparing");
      if (progressFill) progressFill.style.width = "10%";

      let targetProfId = activeProfileId;

      if (destChoice === "new") {
        const newId = "prof_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        let baseName = (bundle.profile && bundle.profile.name && bundle.profile.name.trim()) || t("profileImportedDefaultName");
        if (profilesList.some(p => p.name === baseName)) {
          baseName = baseName + " (1)";
        }
        const newProf = {
          id: newId,
          name: baseName,
          theme: (bundle.profile && bundle.profile.theme) || "default",
          mode: (bundle.profile && bundle.profile.mode) || "dark",
          lang: (bundle.profile && bundle.profile.lang) || "ar",
          term: (bundle.profile && bundle.profile.term) || "F25",
          program: (bundle.profile && bundle.profile.program) || "ITE",
          materials: (bundle.profile && Array.isArray(bundle.profile.materials)) ? bundle.profile.materials : []
        };
        profilesList.push(newProf);
        saveProfilesToStorage();
        targetProfId = newId;
      } else {
        const activeProf = profilesList.find(p => p.id === activeProfileId);
        if (activeProf && optSettings && bundle.profile) {
          if (bundle.profile.theme) activeProf.theme = bundle.profile.theme;
          if (bundle.profile.mode) activeProf.mode = bundle.profile.mode;
          if (bundle.profile.lang) activeProf.lang = bundle.profile.lang;
          if (bundle.profile.term) activeProf.term = bundle.profile.term;
          if (bundle.profile.program) activeProf.program = bundle.profile.program;
          if (Array.isArray(bundle.profile.materials) && bundle.profile.materials.length) {
            const existingCourses = new Set((activeProf.materials || []).map(m => normCode(m.course)));
            activeProf.materials = activeProf.materials || [];
            for (const m of bundle.profile.materials) {
              if (m && m.course && !existingCourses.has(normCode(m.course))) {
                activeProf.materials.push(m);
              }
            }
          }
          saveProfilesToStorage();
        }
      }

      if (progressFill) progressFill.style.width = "30%";

      // 2. Watched History
      if (optHistory && bundle.watched) {
        const wk = targetProfId === "default" ? "svu.watched.v1" : ("svu.watched.v1." + targetProfId);
        let existingWatched = {};
        if (destChoice === "merge") {
          try {
            existingWatched = JSON.parse(localStorage.getItem(wk) || getPref(wk, "{}") || "{}");
          } catch (e) {}
        }
        const mergedWatched = Object.assign({}, existingWatched, bundle.watched);
        const s = JSON.stringify(mergedWatched);
        try { localStorage.setItem(wk, s); } catch (e) {}
        setPref(wk, s);
      }

      if (progressFill) progressFill.style.width = "45%";

      // 3. Batch State
      if (optBatch && bundle.batchState) {
        const bk = targetProfId === "default" ? "svu.batch.state.v2" : ("svu.batch.state.v2." + targetProfId);
        let targetBatchState = bundle.batchState;
        if (destChoice === "merge") {
          let existingBatch = {};
          try {
            existingBatch = JSON.parse(localStorage.getItem(bk) || getPref(bk, "{}") || "{}");
          } catch (e) {}
          targetBatchState = Object.assign({}, existingBatch, bundle.batchState);
          if (existingBatch.courses && bundle.batchState.courses) {
            targetBatchState.courses = Object.assign({}, existingBatch.courses, bundle.batchState.courses);
          }
        }
        const s = JSON.stringify(targetBatchState);
        try { localStorage.setItem(bk, s); } catch (e) {}
        setPref(bk, s);
      }

      if (progressFill) progressFill.style.width = "55%";

      // 4. Offline Saved Lectures (.lrec files to IndexedDB)
      if (optVideos && bundle.library && Array.isArray(bundle.library.files) && bundle.library.files.length) {
        const filesToSave = [];
        const totalFiles = bundle.library.files.length;
        const isBinaryContainer = (bundle._isBinaryContainer && sourceFile);
        let fileOffset = isBinaryContainer ? bundle._fileOffsetStart : 0;

        for (let i = 0; i < totalFiles; i++) {
          const item = bundle.library.files[i];
          const pct = Math.round(55 + ((i + 1) / Math.max(1, totalFiles)) * 40);
          if (progressFill) progressFill.style.width = pct + "%";
          if (progressStatus) {
            progressStatus.textContent = t("profImportStatusWriting", {
              current: i + 1,
              total: totalFiles,
              name: item.name || ("Lec " + (i + 1))
            });
          }

          let blob = null;
          if (isBinaryContainer) {
            const itemSize = item.size || 0;
            blob = sourceFile.slice(fileOffset, fileOffset + itemSize, item.type || "application/octet-stream");
            fileOffset += itemSize;
          } else if (item.dataUrl) {
            blob = await dataUrlToBlob(item.dataUrl, item.type);
          }

          filesToSave.push({
            id: item.id,
            name: item.name,
            size: item.size || (blob ? blob.size : 0),
            type: item.type || "application/octet-stream",
            savedAt: item.savedAt || Date.now(),
            meta: item.meta || {},
            blob: blob
          });
        }

        const db = await openProfIndexedDB(targetProfId);
        await new Promise((resolve, reject) => {
          try {
            const tx = db.transaction(["files", "transcripts", "enhanced"], "readwrite");
            const filesStore = tx.objectStore("files");
            const transStore = tx.objectStore("transcripts");
            const enhStore = tx.objectStore("enhanced");

            if (Array.isArray(bundle.library.transcripts)) {
              for (const tRec of bundle.library.transcripts) {
                if (tRec && tRec.id) transStore.put(tRec);
              }
            }
            if (Array.isArray(bundle.library.enhanced)) {
              for (const eRec of bundle.library.enhanced) {
                if (eRec && eRec.id) enhStore.put(eRec);
              }
            }
            for (const fRec of filesToSave) {
              if (fRec && fRec.id) filesStore.put(fRec);
            }

            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
          } catch (err) {
            db.close();
            reject(err);
          }
        });
      }

      if (progressFill) progressFill.style.width = "100%";
      if (progressStatus) progressStatus.textContent = t("profImportStatusDone");

      // Activate target profile
      await activateProfile(targetProfId, false);
      renderProfilesList();

      setTimeout(() => {
        if (profImportDlg) profImportDlg.close();
        alert(t("profImportSuccess"));
      }, 500);

    } catch (err) {
      console.error("Profile import error:", err);
      alert(t("profImportError") + ": " + (err.message || err));
      if (progressWrap) progressWrap.style.display = "none";
      if (startBtn) startBtn.disabled = false;
    }
  }

  // Backup Events & Listeners
  if (profImportFileInput) {
    profImportFileInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      try {
        const headBuf = await file.slice(0, 12).arrayBuffer();
        const headView = new DataView(headBuf);
        let magic = "";
        for (let i = 0; i < 8; i++) magic += String.fromCharCode(headView.getUint8(i));

        if (magic === "SVUBACK1") {
          const metaLen = headView.getUint32(8, true);
          const metaBuf = await file.slice(12, 12 + metaLen).arrayBuffer();
          const metaText = new TextDecoder("utf-8").decode(metaBuf);
          const json = JSON.parse(metaText);
          json._isBinaryContainer = true;
          json._fileOffsetStart = 12 + metaLen;
          openImportModal(json, file.name, file);
        } else {
          // Legacy JSON backup fallback
          const text = await file.text();
          const json = JSON.parse(text);
          json._isBinaryContainer = false;
          openImportModal(json, file.name, file);
        }
      } catch (err) {
        console.error("Profile import read error:", err);
        alert(t("profImportInvalidFile"));
      } finally {
        profImportFileInput.value = "";
      }
    });
  }

  if (byId("profImportBtn")) {
    byId("profImportBtn").addEventListener("click", () => {
      if (profImportFileInput) profImportFileInput.click();
    });
  }

  if (byId("mobileExportProfileBtn")) {
    byId("mobileExportProfileBtn").addEventListener("click", () => {
      const sheet = byId("mobileMenuSheet");
      if (sheet && sheet.classList.contains("open")) {
        const closeBtn = byId("mobileSheetClose");
        if (closeBtn) closeBtn.click();
      }
      openProfileExportModal(activeProfileId);
    });
  }

  if (byId("mobileImportProfileBtn")) {
    byId("mobileImportProfileBtn").addEventListener("click", () => {
      const sheet = byId("mobileMenuSheet");
      if (sheet && sheet.classList.contains("open")) {
        const closeBtn = byId("mobileSheetClose");
        if (closeBtn) closeBtn.click();
      }
      if (profImportFileInput) profImportFileInput.click();
    });
  }

  if (byId("profExportClose") && profExportDlg) {
    byId("profExportClose").addEventListener("click", () => profExportDlg.close());
  }
  if (byId("profExportCancelBtn") && profExportDlg) {
    byId("profExportCancelBtn").addEventListener("click", () => profExportDlg.close());
  }
  if (byId("profExportStartBtn")) {
    byId("profExportStartBtn").addEventListener("click", () => executeProfileExport());
  }

  if (byId("profImportClose") && profImportDlg) {
    byId("profImportClose").addEventListener("click", () => profImportDlg.close());
  }
  if (byId("profImportCancelBtn") && profImportDlg) {
    byId("profImportCancelBtn").addEventListener("click", () => profImportDlg.close());
  }
  if (byId("profImportStartBtn")) {
    byId("profImportStartBtn").addEventListener("click", () => executeProfileImport());
  }


  const pasteUi = {
    play: byId("pasteGo"),
    cancel: byId("pasteCancel"),
    prog: byId("pasteProg"),
    bar: byId("pasteFill"),
    txt: byId("pasteTxt"),
    setSaved: () => {}
  };

  function startPasteDownload() {
    const raw = byId("pasteUrl").value.trim();
    if (!raw) {
      return;
    }
    const info = parseSvuUrl(raw);
    if (!info) {
      setStatus(t("dlFailed", { e: "URL must be a .lrec link from svuonline.org" }), true);
      return;
    }
    if (savedIds.has(info.name)) {
      playSaved(info.name);
      return;
    }
    const file = {
      name: info.name,
      url: info.url,
      sizeMB: 0,
      description: info.name,
      date: ""
    };
    download(file, info.name, pasteUi, parseLrecNameMeta(info.name));
  }

  byId("pasteGo").addEventListener("click", startPasteDownload);
  byId("pasteUrl").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      startPasteDownload();
    }
  });
  byId("pasteCancel").addEventListener("click", () => controller && controller.abort());
  byId("dropzone").addEventListener("click", () => byId("file").click());

  async function loadTerms() {
    if (termsLoaded) {
      syncCascadeStyles();
      return;
    }
    setBusy(true);
    setStatus(t("stTerms"));
    try {
      const json = await fetchBrowse({});
      cachedTerms = json.terms || [];
      const defaults = getStudentDefaults();
      const targetTerm = (defaults.term && cachedTerms.some(t => t.value === defaults.term)) ? defaults.term : "";
      fillSelect(byId("selTerm"), cachedTerms, "selTerm", targetTerm);
      termsLoaded = true;
      byId("noserver").hidden = true;
      byId("cascade").hidden = false;
      setStatus("");
      if (targetTerm) {
        onCascadeChange(0);
      }
    } catch (err) {
      byId("noserver").hidden = false;
      setStatus("");
    }
    setBusy(false);
  }

  // SVU Course Directory Modal Manager
  const courseDirModal = byId("courseDirModal");
  const courseDirSearch = byId("courseDirSearch");
  const courseDirClearSearch = byId("courseDirClearSearch");
  const courseDirGrid = byId("courseDirGrid");
  const courseDirStatus = byId("courseDirStatus");
  const courseDirFaculties = byId("courseDirFaculties");
  let activeDirPrefix = "ALL";
  let dirSearchDebounce = null;

  function renderCourseDirectory() {
    if (!courseDirGrid || !window.MaterialsDB) return;
    const query = (courseDirSearch ? courseDirSearch.value : "").trim();
    if (courseDirClearSearch) {
      courseDirClearSearch.hidden = !query;
    }
    const all = window.MaterialsDB.all();
    let results = query ? window.MaterialsDB.search(query, 500) : all;
    if (activeDirPrefix && activeDirPrefix !== "ALL") {
      results = results.filter(item => item.code.toUpperCase().startsWith(activeDirPrefix));
    }

    if (courseDirStatus) {
      courseDirStatus.textContent = t("courseDirCountSummary", { n: results.length, total: all.length });
    }

    courseDirGrid.innerHTML = "";
    if (!results.length) {
      courseDirGrid.innerHTML = "<div class=\"muted\" style=\"grid-column: 1 / -1; padding: 32px 16px; text-align: center;\">" + escapeHtml(t("courseDirNoMatch")) + "</div>";
      return;
    }

    const isEn = window.I18N && window.I18N.lang === "en";
    const frag = document.createDocumentFragment();

    for (let i = 0; i < results.length; i++) {
      const it = results[i];
      const card = document.createElement("div");
      card.className = "dir-card";

      const top = document.createElement("div");
      top.className = "dir-card-top";
      const codeSpan = document.createElement("span");
      codeSpan.className = "dir-code-badge";
      codeSpan.textContent = it.code;
      top.appendChild(codeSpan);

      const copyBtn = document.createElement("button");
      copyBtn.className = "iconbtn";
      copyBtn.style.width = "26px";
      copyBtn.style.height = "26px";
      copyBtn.title = t("courseDirCopyCode");
      copyBtn.innerHTML = "<svg class=\"i\" style=\"width:14px;height:14px;\"><use href=\"#i-copy\"/></svg>";
      copyBtn.addEventListener("click", () => {
        try {
          navigator.clipboard.writeText(it.code);
          copyBtn.title = t("courseDirCopied");
          copyBtn.style.color = "var(--blue)";
          setTimeout(() => {
            copyBtn.title = t("courseDirCopyCode");
            copyBtn.style.color = "";
          }, 1500);
        } catch (e) {}
      });
      top.appendChild(copyBtn);

      const names = document.createElement("div");
      names.className = "dir-card-names";
      const arName = document.createElement("div");
      arName.className = "dir-name-ar";
      arName.textContent = it.ar || it.en;
      const enName = document.createElement("div");
      enName.className = "dir-name-en";
      enName.textContent = it.en || it.ar;
      names.append(arName, enName);

      if (it.alts && it.alts.length) {
        const altBox = document.createElement("div");
        altBox.className = "dir-card-alts";
        altBox.textContent = (isEn ? "Also: " : "أيضاً: ") + it.alts.map(a => (isEn ? (a.en || a.ar) : (a.ar || a.en))).join(" | ");
        names.appendChild(altBox);
      }

      const savedCount = savedRecordsCache.filter(r => r.parsedMeta && r.parsedMeta.material && r.parsedMeta.material.toUpperCase() === it.code.toUpperCase()).length;

      const actions = document.createElement("div");
      actions.className = "dir-card-actions";

      if (savedCount > 0) {
        const libBtn = document.createElement("button");
        libBtn.className = "dir-btn is-saved";
        libBtn.innerHTML = "<svg class=\"i\" style=\"width:12px;height:12px;\"><use href=\"#i-save\"/></svg><span>" + escapeHtml(t("courseDirSavedCount", { n: savedCount })) + "</span>";
        libBtn.title = t("courseDirFindInLib");
        libBtn.addEventListener("click", async () => {
          if (courseDirModal) courseDirModal.close();
          await openDialog("saved");
          if (byId("libSearch")) {
            byId("libSearch").value = it.code;
            renderLibraryView();
          }
        });
        actions.appendChild(libBtn);
      }

      const batchBtn = document.createElement("button");
      batchBtn.className = "dir-btn is-primary-action";
      batchBtn.innerHTML = "<svg class=\"i\" style=\"width:12px;height:12px;\"><use href=\"#i-download\"/></svg><span>" + escapeHtml(t("courseDirBrowseDownload")) + "</span>";
      batchBtn.addEventListener("click", async () => {
        if (courseDirModal) courseDirModal.close();
        await openDialog("batch");
        if (byId("batchCourseFilter")) {
          byId("batchCourseFilter").value = it.code;
          renderBatchCoursesList(false);
        }
        const cState = getOrCreateCourseState(it.code, it.code + " — " + (isEn ? (it.en || it.ar) : (it.ar || it.en)));
        cState.checked = true;
        saveBatchState();
        renderBatchCoursesList(false);
        loadCheckedCoursesSequentially(false);
      });
      actions.appendChild(batchBtn);
      card.append(top, names, actions);
      frag.appendChild(card);
    }
    courseDirGrid.appendChild(frag);
  }

  function openCourseDirectory() {
    if (!courseDirModal) return;
    if (courseDirSearch) courseDirSearch.value = "";
    activeDirPrefix = "ALL";
    if (courseDirFaculties) {
      courseDirFaculties.querySelectorAll(".dir-chip").forEach(c => {
        c.classList.toggle("on", c.dataset.prefix === "ALL");
      });
    }
    renderCourseDirectory();
    courseDirModal.showModal();
    if (courseDirSearch) setTimeout(() => courseDirSearch.focus(), 100);
  }

  if (byId("headerCourseDirBtn")) {
    byId("headerCourseDirBtn").addEventListener("click", openCourseDirectory);
  }
  if (byId("libCourseDirBtn")) {
    byId("libCourseDirBtn").addEventListener("click", openCourseDirectory);
  }
  if (byId("mobileCourseDirBtn")) {
    byId("mobileCourseDirBtn").addEventListener("click", () => {
      const sheet = byId("mobileMenuSheet");
      if (sheet) {
        sheet.classList.remove("open");
        sheet.setAttribute("aria-hidden", "true");
      }
      openCourseDirectory();
    });
  }
  if (byId("courseDirClose") && courseDirModal) {
    byId("courseDirClose").addEventListener("click", () => courseDirModal.close());
  }
  if (courseDirModal) {
    courseDirModal.addEventListener("click", (e) => {
      if (e.target === courseDirModal) courseDirModal.close();
    });
  }
  if (courseDirSearch) {
    courseDirSearch.addEventListener("input", () => {
      clearTimeout(dirSearchDebounce);
      dirSearchDebounce = setTimeout(renderCourseDirectory, 150);
    });
  }
  if (courseDirClearSearch) {
    courseDirClearSearch.addEventListener("click", () => {
      if (courseDirSearch) {
        courseDirSearch.value = "";
        courseDirSearch.focus();
      }
      renderCourseDirectory();
    });
  }
  if (courseDirFaculties) {
    courseDirFaculties.addEventListener("click", e => {
      const chip = e.target.closest(".dir-chip");
      if (!chip) return;
      courseDirFaculties.querySelectorAll(".dir-chip").forEach(c => c.classList.remove("on"));
      chip.classList.add("on");
      activeDirPrefix = chip.dataset.prefix || "ALL";
      renderCourseDirectory();
    });
  }

  CASCADE.forEach((stage, index) => byId(stage.sel).addEventListener("change", () => onCascadeChange(index)));
  syncCascadeStyles();
  updateBatchShowSelectedBtn();
  refreshSaved();

  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }
  document.addEventListener("langchange", () => {
    updateProfileHeaderBtn();
    renderProfilesList();
    updateBatchShowSelectedBtn();
    renderLibraryView();
    syncCascadeStyles();
    if (typeof refreshHub === "function") {
      refreshHub();
    }
    if (courseDirModal && courseDirModal.open) {
      renderCourseDirectory();
    }
    if (dialog.open && !byId("paneBatch").hidden) {
      renderBatchCoursesList(false);
      updateBatchSummary();
    }
  });

  /* ====================================================================== *
   * SMART STUDENT HUB LOGIC (#studentHub) - INSIDE IIFE
   * ====================================================================== */
  function refreshHub() {
    const hub = byId("studentHub");
    if (!hub) return;

    // 1. Update Library Tile Count Badge
    const libBadge = byId("hubLibCountBadge");
    if (libBadge) {
      libBadge.textContent = savedRecordsCache.length;
    }

    // 2. Control Onboarding Studio Card (#hubIntroCard)
    // Default always to opened full details unless user explicitly clicked hide details
    const introCard = byId("hubIntroCard");
    const introMini = byId("introMini");
    const introFull = byId("introFull");
    if (introCard && introMini && introFull) {
      let isCollapsed = false;
      try {
        isCollapsed = localStorage.getItem("svu_intro_collapsed") === "1";
      } catch (_) {}

      if (isCollapsed) {
        introCard.classList.add("is-compact");
        introCard.classList.remove("is-expanded");
        introMini.style.display = "flex";
        introFull.style.display = "none";
      } else {
        introCard.classList.remove("is-compact");
        introCard.classList.add("is-expanded");
        introMini.style.display = "none";
        introFull.style.display = "";
      }
    }

    // 3. Resume Last Played Card (#hubResumeCard)
    const resumeCard = byId("hubResumeCard");
    const resumeDivider = byId("hubResumeDivider");
    if (resumeCard) {
      let lastPlayed = null;
      try {
        const raw = localStorage.getItem("svu_last_played");
        if (raw) lastPlayed = JSON.parse(raw);
      } catch (_) {}

      // If no lastPlayed in localStorage, but lectures exist, fallback to most recently saved
      if ((!lastPlayed || !lastPlayed.name) && savedRecordsCache.length > 0) {
        const first = savedRecordsCache[0];
        const fm = first.parsedMeta;
        lastPlayed = {
          name: first.name,
          id: first.id,
          material: fm.material || "",
          lesson: fm.lesson || "",
          college: fm.college || "",
          term: fm.term || "",
          className: fm.className || "",
          date: fm.date || ""
        };
      }

      if (lastPlayed && lastPlayed.name) {
        const titleEl = byId("hubResumeTitle");
        const metaEl = byId("hubResumeMeta");
        const lessonTxt = lastPlayed.lesson ? t("batchLessonNum", { n: lastPlayed.lesson }) : "";
        const mat = (window.MaterialsDB && lastPlayed.material) ? window.MaterialsDB.get(lastPlayed.material) : null;
        const isEn = window.I18N && window.I18N.lang === "en";
        const mName = mat ? (isEn ? (mat.en || mat.ar) : (mat.ar || mat.en)) : "";
        const matTxt = lastPlayed.material ? (lastPlayed.material + (mName ? (" — " + mName) : "")) : "";
        if (titleEl) {
          titleEl.textContent = (matTxt ? matTxt + " · " : "") + (lessonTxt || lastPlayed.name);
        }
        if (metaEl) {
          const mParts = [];
          if (lastPlayed.college) mParts.push(lastPlayed.college);
          if (lastPlayed.term) mParts.push(lastPlayed.term);
          if (lastPlayed.className) mParts.push(t("metaClass") + " " + lastPlayed.className);
          if (lastPlayed.date) mParts.push(lastPlayed.date);
          metaEl.textContent = mParts.join(" • ");
        }

        const resumeBtn = byId("hubResumeBtn");
        if (resumeBtn) {
          resumeBtn.onclick = () => {
            const match = savedRecordsCache.find(r => r.name === lastPlayed.name || r.id === lastPlayed.name || (lastPlayed.id && r.id === lastPlayed.id));
            if (match) {
              playSaved(match.id);
            } else if (savedRecordsCache.length > 0) {
              playSaved(savedRecordsCache[0].id);
            } else {
              showTab("saved");
              dialog.showModal();
            }
          };
        }
        resumeCard.hidden = false;
        if (resumeDivider) resumeDivider.hidden = false;
      } else {
        resumeCard.hidden = true;
        if (resumeDivider) resumeDivider.hidden = true;
      }
    }

    // 4. Populate All Saved Lectures Grouped by Material in Hub
    const recentList = byId("hubRecentList");
    if (recentList) {
      recentList.innerHTML = "";
      if (!savedRecordsCache.length) {
        recentList.innerHTML = "<div class=\"hub-empty-msg\" data-i18n=\"hubNoSavedHint\">" + escapeHtml(t("hubNoSavedHint")) + "</div>";
      } else {
        const groupsMap = new Map();
        for (const rec of savedRecordsCache) {
          const m = rec.parsedMeta;
          const gKey = m.localGroup ? "__LOCAL_FILES__" : (m.material || "OTHER");
          if (!groupsMap.has(gKey)) groupsMap.set(gKey, []);
          groupsMap.get(gKey).push(rec);
        }

        const sortedGroupKeys = Array.from(groupsMap.keys()).sort((a, b) => {
          if (a === "__LOCAL_FILES__") return 1;
          if (b === "__LOCAL_FILES__") return -1;
          return a.localeCompare(b);
        });

        for (const gKey of sortedGroupKeys) {
          const items = groupsMap.get(gKey).slice().sort((a, b) => {
            const ma = a.parsedMeta, mb = b.parsedMeta;
            if (ma.lessonNum !== mb.lessonNum) return ma.lessonNum - mb.lessonNum;
            return String(ma.date).localeCompare(String(mb.date));
          });
          const isLocal = gKey === "__LOCAL_FILES__";
          const mat = (window.MaterialsDB && gKey !== "OTHER" && !isLocal) ? window.MaterialsDB.get(gKey) : null;
          const isEn = window.I18N && window.I18N.lang === "en";
          const matName = mat ? (isEn ? (mat.en || mat.ar) : (mat.ar || mat.en)) : "";
          const courseHeading = isLocal ? t("localFilesGroup") : ((gKey !== "OTHER" ? (gKey + " — ") : "") + (matName || gKey));
          const watchedCount = items.filter(r => r.watched).length;

          const groupEl = document.createElement("div");
          groupEl.className = "hub-course-group";

          const headEl = document.createElement("div");
          headEl.className = "hub-course-head";
          headEl.innerHTML =
            "<div class=\"hub-course-head-info\">" +
              "<div class=\"hub-course-title\">" + escapeHtml(courseHeading) + "</div>" +
              "<div class=\"hub-course-count\">" + escapeHtml(t("hubCourseLectures", { n: items.length })) + " " + escapeHtml(t("hubCourseWatched", { w: watchedCount })) + "</div>" +
            "</div>";

          const listEl = document.createElement("div");
          listEl.className = "hub-course-list";

          for (const rec of items) {
            const m = rec.parsedMeta;
            const row = document.createElement("div");
            row.className = "hub-lec-row" + (rec.watched ? " is-watched" : "");

            const watchBtn = document.createElement("button");
            watchBtn.className = "watch-btn hub-watch-btn" + (rec.watched ? " on" : "");
            watchBtn.setAttribute("aria-label", rec.watched ? t("libWatched") : t("libUnwatched"));
            watchBtn.title = rec.watched ? t("libWatched") : t("libUnwatched");
            watchBtn.innerHTML = rec.watched
              ? "<svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' stroke-width='2.5'><polyline points='20 6 9 17 4 12'/></svg>"
              : "<svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='9'/></svg>";
            watchBtn.onclick = (e) => {
              e.stopPropagation();
              setLectureWatched(rec.id, !rec.watched);
            };

            const info = document.createElement("div");
            info.className = "hub-lec-info";
            const lessonTitle = m.lesson ? t("batchLessonNum", { n: m.lesson }) : rec.name;
            const metaParts = [];
            if (m.date) metaParts.push(m.date);
            metaParts.push(formatSize(rec.size || 0));
            if (rec.watched) metaParts.push("✓ " + t("libWatched"));

            info.innerHTML =
              "<div class=\"hub-lec-title\">" + escapeHtml(lessonTitle) + "</div>" +
              "<div class=\"hub-lec-meta\">" + metaParts.map(escapeHtml).join(" • ") + "</div>";

            const actions = document.createElement("div");
            actions.className = "hub-lec-actions";

            const playBtn = document.createElement("button");
            playBtn.className = "primary hub-lec-play-btn";
            playBtn.innerHTML = "<svg viewBox='0 0 24 24' width='13' height='13' fill='currentColor'><polygon points='6 3 20 12 6 21 6 3'/></svg><span>" + escapeHtml(t("play")) + "</span>";
            playBtn.onclick = (e) => {
              e.stopPropagation();
              playSaved(rec.id);
            };

            const delBtn = document.createElement("button");
            delBtn.className = "hub-lec-del-btn";
            delBtn.title = t("del");
            delBtn.setAttribute("aria-label", t("del"));
            delBtn.innerHTML = "<svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' stroke-width='2'><polyline points='3 6 5 6 21 6'/><path d='M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'/></svg>";
            delBtn.onclick = async (e) => {
              e.stopPropagation();
              if (confirm(t("confirmDelete", { name: rec.name }))) {
                await LibraryDB.remove(rec.id);
                refreshSaved();
              }
            };

            const exportBtn = document.createElement("button");
            exportBtn.className = "hub-lec-export-btn";
            exportBtn.title = t("exportLrec");
            exportBtn.setAttribute("aria-label", t("exportLrec"));
            exportBtn.innerHTML = "<svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' stroke-width='2'><path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/><polyline points='7 10 12 15 17 10'/><line x1='12' y1='15' x2='12' y2='3'/></svg>";
            exportBtn.onclick = async (e) => {
              e.stopPropagation();
              await exportLrecFile(rec, exportBtn);
            };

            actions.append(playBtn, exportBtn, delBtn);
            row.append(watchBtn, info, actions);
            listEl.appendChild(row);
          }

          groupEl.append(headEl, listEl);
          recentList.appendChild(groupEl);
        }
      }
    }

    const viewAllBtn = byId("hubViewAllSavedBtn");
    if (viewAllBtn) {
      viewAllBtn.textContent = t("hubViewAllSavedCount", { n: savedRecordsCache.length });
    }

    I18N.apply(hub);
  }

  function initStudentHub() {
    const batchTile = byId("hubBatchTile");
    if (batchTile) {
      batchTile.addEventListener("click", () => openDialog("batch"));
    }
    const libTile = byId("hubLibTile");
    if (libTile) {
      libTile.addEventListener("click", () => openDialog("saved"));
    }
    const browseTile = byId("hubBrowseTile");
    if (browseTile) {
      browseTile.addEventListener("click", () => openDialog("remote"));
    }
    const fileTile = byId("hubFileTile");
    if (fileTile) {
      fileTile.addEventListener("click", () => {
        byId("file").click();
      });
    }

    // Bug 8: Course Directory featured tile
    const courseDirTile = byId("hubCourseDirTile");
    if (courseDirTile) {
      courseDirTile.addEventListener("click", () => {
        openCourseDirectory();
      });
    }

    const viewAllBtn = byId("hubViewAllSavedBtn");
    if (viewAllBtn) {
      viewAllBtn.addEventListener("click", () => openDialog("saved"));
    }

    const demoBtn = byId("introDemoBtn");
    if (demoBtn) {
      demoBtn.addEventListener("click", loadDemoLecture);
    }
    const heroDemoBtn = byId("hubDemoBtn");
    if (heroDemoBtn) {
      heroDemoBtn.addEventListener("click", loadDemoLecture);
    }

    // Bug 7: Intro Card Expand / Collapse with LocalStorage persistence
    const introCard = byId("hubIntroCard");
    const introMini = byId("introMini");
    const introFull = byId("introFull");
    const introMiniToggle = byId("introMiniToggleBtn");
    const introCollapse = byId("introCollapseBtn");

    function collapseIntroCard(e) {
      if (e) e.stopPropagation();
      if (!introCard || !introFull || !introMini) return;
      introCard.classList.add("is-compact");
      introCard.classList.remove("is-expanded");
      introMini.style.display = "flex";
      introFull.style.display = "none";
      try { localStorage.setItem("svu_intro_collapsed", "1"); } catch (_) {}
    }

    function expandIntroCard(e) {
      if (e) e.stopPropagation();
      if (!introCard || !introFull || !introMini) return;
      introCard.classList.remove("is-compact");
      introCard.classList.add("is-expanded");
      introMini.style.display = "none";
      introFull.style.display = "";
      try { localStorage.removeItem("svu_intro_collapsed"); } catch (_) {}
    }

    if (introMini) introMini.addEventListener("click", expandIntroCard);
    if (introMiniToggle) introMiniToggle.addEventListener("click", expandIntroCard);
    if (introCollapse) introCollapse.addEventListener("click", collapseIntroCard);
    const introInstallBtn = byId("introInstallBtn");
    if (introInstallBtn) {
      introInstallBtn.addEventListener("click", () => {
        if (byId("aboutInstallBtn")) byId("aboutInstallBtn").click();
      });
    }
    const introAboutBtn = byId("introAboutBtn");
    if (introAboutBtn) {
      introAboutBtn.addEventListener("click", () => {
        byId("about").showModal();
      });
    }

    // Top Header Help & Back Buttons
    const headerHelpBtn = byId("headerHelpBtn");
    if (headerHelpBtn) {
      headerHelpBtn.addEventListener("click", () => {
        if (window.__lrec && window.__lrec.showTour) {
          window.__lrec.showTour();
        } else if (byId("welcome")) {
          byId("welcome").showModal();
        }
      });
    }
    const headerBackToHubBtn = byId("headerBackToHubBtn");
    if (headerBackToHubBtn) {
      headerBackToHubBtn.addEventListener("click", () => {
        if (window.__closeActiveSession) {
          window.__closeActiveSession();
        }
      });
    }

    window.__refreshHub = refreshHub;
    refreshHub();
  }

  initStudentHub();


})();
} catch (err) {
  console.error("[SVU] module 08-browse.js failed to initialise:", err);
}
;
try {
(function () {
  "use strict";
  const byId = id => document.getElementById(id);
  const ccBtn = byId("ccBtn");
  const caption = byId("caption");
  const ccStatus = byId("ccStatus");
  const CC_KEY = "lrec.captions";
  let segments = null;
  let sessionKey = null;
  let enabled = false;
  let activeIdx = -2;
  const storedOn = () => {
    try {
      return localStorage.getItem(CC_KEY) === "1";
    } catch (err) {
      return false;
    }
  };
  const storeOn = on => {
    try {
      localStorage.setItem(CC_KEY, on ? "1" : "0");
    } catch (err) {}
  };
  function syncButton() {
    ccBtn.classList.toggle("on", enabled && !!segments);
    ccBtn.setAttribute("aria-pressed", String(enabled && !!segments));
    if (!enabled || !segments) {
      caption.hidden = true;
      activeIdx = -2;
    }
  }
  const setStatus = (text, bad) => {
    ccStatus.textContent = text || "";
    ccStatus.classList.toggle("bad", !!bad);
  };
  async function loadCaptions(session) {
    segments = null;
    activeIdx = -2;
    sessionKey = session ? session.key : null;
    setStatus("");
    syncButton();
    if (!session || !LibraryDB.available) {
      return;
    }
    try {
      const cached = await LibraryDB.getTranscript(sessionKey);
      if (cached && session === window.__lrec.session) {
        segments = cached.segments;
        enabled = storedOn();
        syncButton();
      }
    } catch (err) {}
  }
  ccBtn.addEventListener("click", () => {
    const session = window.__lrec.session;
    if (!session) {
      return;
    }
    if (segments) {
      enabled = !enabled;
      storeOn(enabled);
      syncButton();
      return;
    }
    setStatus(t("ccNotSet"), true);
  });
  function showCaption(ms) {
    if (!enabled || !segments || !segments.length) {
      return;
    }
    const sec = ms / 1000;
    let lo = 0;
    let hi = segments.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      if (segments[mid].s <= sec) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found >= 0 && sec > segments[found].e + 0.4) {
      found = -1;
    }
    if (found === activeIdx) {
      return;
    }
    activeIdx = found;
    if (found < 0) {
      caption.hidden = true;
    } else {
      caption.textContent = segments[found].t;
      caption.hidden = false;
    }
  }
  window.__lrec.onTick = showCaption;
  window.__lrec.onSession = loadCaptions;
  window.__lrec.onClose = () => {
    segments = null;
    sessionKey = null;
    syncButton();
    setStatus("");
  };
})();
;

;
} catch (err) {
  console.error("[SVU] module 09-captions.js failed to initialise:", err);
}
;
try {
(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const enhBtn = byId("enhBtn");
  const ccStatus = byId("ccStatus");
  const audioEl  = byId("audio");
  const ENH_KEY = "lrec.enhance";
  let enhUrl = null;
  let sessionKey = null;
  let active = false;
  let job = null;
  const storedOn = () => {
    try {
      return localStorage.getItem(ENH_KEY) !== "0";
    } catch (err) {
      return true;
    }
  };
  const storeOn = on => {
    try {
      localStorage.setItem(ENH_KEY, on ? "1" : "0");
    } catch (err) {}
  };
  const setStatus = (text, bad) => {
    ccStatus.textContent = text || "";
    ccStatus.classList.toggle("bad", !!bad);
  };
  function syncEnhLabel() {
    const span = enhBtn && enhBtn.querySelector("span");
    if (!span) {
      return;
    }
    const key = active ? "enhanceOn" : "enhance";
    span.dataset.i18n = key;
    span.textContent = t(key);
    if (enhBtn) {
      const titleKey = active ? "enhanceTitleActive" : "enhanceTitle";
      enhBtn.dataset.i18nTitle = titleKey;
      enhBtn.title = t(titleKey);
    }
  }
  function swapSource(url) {
    const time = audioEl.currentTime;
    const playing = !audioEl.paused;
    const rate = audioEl.playbackRate;
    audioEl.src = url;
    audioEl.playbackRate = rate;
    audioEl.addEventListener("loadedmetadata", () => {
      audioEl.currentTime = time;
      if (playing) {
        audioEl.play().catch(() => {});
      }
    }, {
      once: true
    });
  }
  function applyEnhanced(on) {
    const session = window.__lrec.session;
    if (!session || !enhUrl || on === active) {
      return;
    }
    active = on;
    swapSource(active ? enhUrl : session.wavUrl);
    enhBtn.classList.toggle("on", active);
    enhBtn.setAttribute("aria-pressed", String(active));
    syncEnhLabel();
  }
  async function enhanceAudio(audioData) {
    const {
      pcm: pcm,
      rate: rate
    } = audioData;
    setStatus(t("enhProgress", { p: 0 }));
    await new Promise(resolve => setTimeout(resolve, 10));
    const out = Dsp.enhance(pcm, rate);
    setStatus(t("enhProgress", { p: 100 }));
    return new Blob([LREC.pcmToWav(out, rate)], {
      type: "audio/wav"
    });
  }
  async function runEnhance(audioData) {
    if (job === audioData) {
      return;
    }
    job = audioData;
    enhBtn.classList.add("busy");
    try {
      const blob = await enhanceAudio(audioData);
      if (!window.__lrec.session || audioData !== window.__lrec.session.audio) {
        return;
      }
      if (LibraryDB.available) {
        LibraryDB.putEnhanced({
          id: sessionKey,
          blob: blob,
          savedAt: Date.now()
        }).catch(() => {});
      }
      enhUrl = URL.createObjectURL(blob);
      setStatus("");
      applyEnhanced(true);
      storeOn(true);
    } catch (err) {
      const params = {
        e: err.message
      };
      setStatus(t("enhFail", params), true);
    } finally {
      if (job === audioData) {
        job = null;
        enhBtn.classList.remove("busy");
      }
    }
  }
  enhBtn.addEventListener("click", () => {
    const session = window.__lrec.session;
    if (!session || job === session.audio) {
      return;
    }
    if (enhUrl) {
      applyEnhanced(!active);
      storeOn(active);
      return;
    }
    runEnhance(session.audio);
  });
  function resetEnhance() {
    if (enhUrl) {
      URL.revokeObjectURL(enhUrl);
    }
    enhUrl = null;
    active = false;
    enhBtn.classList.remove("on", "busy");
    enhBtn.setAttribute("aria-pressed", "false");
    syncEnhLabel();
  }
  document.addEventListener("langchange", syncEnhLabel);
  const prevSession = window.__lrec.onSession;
  const prevClose = window.__lrec.onClose;
  window.__lrec.onSession = async session => {
    if (prevSession) {
      prevSession(session);
    }
    resetEnhance();
    sessionKey = session.key + ":dsp-v2";
    if (!LibraryDB.available) {
      if (storedOn()) {
        runEnhance(session.audio);
      }
      return;
    }
    try {
      const cached = await LibraryDB.getEnhanced(sessionKey);
      if (cached && session === window.__lrec.session) {
        enhUrl = URL.createObjectURL(cached.blob);
        if (storedOn()) {
          applyEnhanced(true);
        }
        return;
      }
    } catch (err) {}
    if (storedOn() && session === window.__lrec.session) {
      runEnhance(session.audio);
    }
  };
  window.__lrec.onClose = () => {
    if (prevClose) {
      prevClose();
    }
    resetEnhance();
  };
})();
;

;
} catch (err) {
  console.error("[SVU] module 10-enhance.js failed to initialise:", err);
}
;
try {
(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const welcome = byId("welcome");
  if (!welcome) return;

  const TOUR_KEY = "svu.welcome.v4";

  /* ==========================================================================
     VISUAL TOP SLIDER / CAROUSEL CONTROLLER
     ========================================================================== */
  let currentSlide = 0;
  const totalSlides = 6;
  let sliderTimer = null;

  function showSlide(index) {
    currentSlide = (index + totalSlides) % totalSlides;
    const slides = document.querySelectorAll("#guideSlides .guide-slide");
    const dots = document.querySelectorAll("#sliderDots .dot");
    const navItems = document.querySelectorAll(".guide-nav-item");

    slides.forEach((slide, i) => {
      slide.classList.toggle("active", i === currentSlide);
    });
    dots.forEach((dot, i) => {
      dot.classList.toggle("active", i === currentSlide);
    });
    navItems.forEach((item, i) => {
      const isActive = (i === currentSlide);
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-selected", String(isActive));
    });

    const stepEl = byId("guideCurrentStep");
    if (stepEl) stepEl.textContent = String(currentSlide + 1);

    const titleEl = byId("guideCurrentTitle");
    if (titleEl) {
      titleEl.dataset.i18n = "slide" + (currentSlide + 1) + "Nav";
      const activeNav = navItems[currentSlide];
      const titleSpan = activeNav ? activeNav.querySelector(".nav-title") : null;
      if (titleSpan) {
        titleEl.textContent = titleSpan.textContent;
      }
    }
  }

  function nextSlide() {
    showSlide(currentSlide + 1);
  }

  function prevSlide() {
    showSlide(currentSlide - 1);
  }

  function startSliderTimer() {
    stopSliderTimer();
    // Desktop users need calm, undisturbed reading time; only auto-slide on mobile
    if (window.innerWidth > 768) return;
    sliderTimer = setInterval(nextSlide, 5500);
  }

  function stopSliderTimer() {
    if (sliderTimer) {
      clearInterval(sliderTimer);
      sliderTimer = null;
    }
  }

  function initSlider() {
    const prevBtn = byId("sliderPrevBtn");
    const nextBtn = byId("sliderNextBtn");
    if (prevBtn) prevBtn.onclick = () => { prevSlide(); stopSliderTimer(); };
    if (nextBtn) nextBtn.onclick = () => { nextSlide(); stopSliderTimer(); };

    const dots = document.querySelectorAll("#sliderDots .dot");
    dots.forEach(dot => {
      dot.onclick = () => {
        const s = parseInt(dot.dataset.slide, 10);
        if (!isNaN(s)) {
          showSlide(s);
          stopSliderTimer();
        }
      };
    });

    // Desktop master-detail navigation tabs
    const navItems = document.querySelectorAll(".guide-nav-item");
    navItems.forEach(item => {
      item.onclick = () => {
        const s = parseInt(item.dataset.nav, 10);
        if (!isNaN(s)) {
          showSlide(s);
          stopSliderTimer();
        }
      };
    });

    // Desktop footer prev / next buttons
    const deskPrev = byId("guideDesktopPrev");
    const deskNext = byId("guideDesktopNext");
    if (deskPrev) deskPrev.onclick = () => { prevSlide(); stopSliderTimer(); };
    if (deskNext) deskNext.onclick = () => { nextSlide(); stopSliderTimer(); };

    // Keyboard navigation when guide modal is open
    welcome.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        nextSlide();
        stopSliderTimer();
        e.preventDefault();
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        prevSlide();
        stopSliderTimer();
        e.preventDefault();
      } else if (e.key >= "1" && e.key <= "6") {
        showSlide(parseInt(e.key, 10) - 1);
        stopSliderTimer();
        e.preventDefault();
      }
    };

    const slider = byId("guideSlider");
    if (slider) {
      slider.onmouseenter = stopSliderTimer;
      slider.ontouchstart = stopSliderTimer;
      slider.onpointerdown = stopSliderTimer;

      // 1-Finger touch swipe gesture for mobile UI
      let touchStartX = 0;
      let touchStartY = 0;
      let touchEndX = 0;
      let touchEndY = 0;

      const onTouchStart = (e) => {
        stopSliderTimer();
        if (e.touches && e.touches.length === 1) {
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
          touchEndX = touchStartX;
          touchEndY = touchStartY;
        }
      };

      const onTouchMove = (e) => {
        if (e.touches && e.touches.length === 1) {
          touchEndX = e.touches[0].clientX;
          touchEndY = e.touches[0].clientY;
        }
      };

      const onTouchEnd = () => {
        const dx = touchEndX - touchStartX;
        const dy = touchEndY - touchStartY;
        if (Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          if (dx < 0) {
            nextSlide();
          } else {
            prevSlide();
          }
        }
      };

      slider.addEventListener("touchstart", onTouchStart, { passive: true });
      slider.addEventListener("touchmove", onTouchMove, { passive: true });
      slider.addEventListener("touchend", onTouchEnd, { passive: true });

      if (welcome) {
        welcome.addEventListener("touchstart", onTouchStart, { passive: true });
        welcome.addEventListener("touchmove", onTouchMove, { passive: true });
        welcome.addEventListener("touchend", onTouchEnd, { passive: true });
      }
    }

    showSlide(0);
  }

  /* ==========================================================================
     GUIDE MODAL OPEN / CLOSE CONTROLLER
     ========================================================================== */
  function showTour() {
    if (welcome.open) return;
    I18N.apply(welcome);
    welcome.showModal();
    initSlider();
    startSliderTimer();
  }

  function closeTour() {
    stopSliderTimer();
    try { localStorage.setItem(TOUR_KEY, "1"); } catch (_) {}
    if (welcome.open) {
      welcome.close();
    }
  }

  const startBtn = byId("welcomeStart");
  if (startBtn) startBtn.addEventListener("click", closeTour);

  const closeBtn = byId("welcomeClose");
  if (closeBtn) closeBtn.addEventListener("click", closeTour);

  const welcomeLangBtn = byId("welcomeLangBtn");
  if (welcomeLangBtn) {
    const syncWLang = () => {
      const isAr = I18N.lang === "ar";
      welcomeLangBtn.classList.toggle("is-ar", isAr);
      welcomeLangBtn.setAttribute("aria-checked", String(isAr));
    };
    syncWLang();
    document.addEventListener("langchange", syncWLang);
    welcomeLangBtn.addEventListener("click", () => {
      I18N.toggle();
    });
  }

  welcome.addEventListener("close", () => {
    stopSliderTimer();
    try { localStorage.setItem(TOUR_KEY, "1"); } catch (_) {}
  });

  welcome.addEventListener("click", event => {
    if (event.target === welcome) {
      closeTour();
      return;
    }
    const actionBtn = event.target.closest("[data-guide-action]");
    if (actionBtn) {
      const act = actionBtn.dataset.guideAction;
      closeTour();
      if (act === "remote") {
        const tile = byId("hubBrowseTile");
        if (tile) tile.click();
        else if (window.openBrowseDialog) window.openBrowseDialog("remote");
      } else if (act === "batch") {
        const tile = byId("hubBatchTile");
        if (tile) tile.click();
        else if (window.openBrowseDialog) window.openBrowseDialog("batch");
      } else if (act === "saved") {
        const tile = byId("hubLibTile");
        if (tile) tile.click();
        else if (window.openBrowseDialog) window.openBrowseDialog("saved");
      } else if (act === "file") {
        const fileEl = byId("file");
        if (fileEl) fileEl.click();
      } else if (act === "demo") {
        const demoBtn = byId("introDemoBtn") || byId("hubDemoBtn");
        if (demoBtn) demoBtn.click();
      }
    }
  });

  document.addEventListener("langchange", () => {
    if (welcome.open) {
      I18N.apply(welcome);
      showSlide(currentSlide);
    }
  });

  const tourBtn = byId("tourBtn");
  if (tourBtn) {
    tourBtn.addEventListener("click", () => {
      const about = byId("about");
      if (about && about.open) {
        about.close();
      }
      showTour();
    });
  }

  const headerHelpBtn = byId("headerHelpBtn");
  if (headerHelpBtn) {
    headerHelpBtn.addEventListener("click", (e) => {
      e.preventDefault();
      showTour();
    });
  }

  const mobileGuideBtn = byId("mobileGuideBtn");
  if (mobileGuideBtn) {
    mobileGuideBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const sheet = byId("mobileMenuSheet");
      if (sheet) sheet.classList.remove("open");
      showTour();
    });
  }

  // Show the help guide automatically only on genuine first visit (or when invoked manually via tour button)
  if (!document.body.classList.contains("has-session")) {
    try {
      if (!localStorage.getItem(TOUR_KEY)) {
        setTimeout(showTour, 450);
      }
    } catch (_) {}
  }

  if (!window.__lrec) window.__lrec = {};
  window.__lrec.showTour = showTour;
  window.__lrec.showSlide = showSlide;
})();
} catch (err) {
  console.error("[SVU] module 11-tour.js failed to initialise:", err);
}
;
try {
(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const buildMeta = document.querySelector("meta[name=\"build\"]");
  const buildId = buildMeta ? buildMeta.content : "";
  if (byId("buildId")) {
    byId("buildId").textContent = buildId || "local";
  }
  async function reloadLatest() {
    try {
      if ("serviceWorker" in navigator) {
        for (const reg of await navigator.serviceWorker.getRegistrations()) {
          await reg.unregister();
        }
      }
      if (window.caches) {
        for (const name of await caches.keys()) {
          await caches.delete(name);
        }
      }
    } catch (err) {}
    const url = new URL(location.href);
    url.searchParams.set("r", Date.now().toString(36));
    location.replace(url.toString());
  }
  if (byId("reloadLatestBtn")) {
    byId("reloadLatestBtn").addEventListener("click", reloadLatest);
  }
})();
} catch (err) {
  console.error("[SVU] module 12-updates.js failed to initialise:", err);
}
