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
;
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
;
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
      usage: "Using {used} of {quota} available to this site.",
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
      aboutServerSub: "To browse the live SVU session catalog and download .lrec files directly from sessions.svuonline.org, run the local server in your project directory:",
      copyCmd: "Copy",
      copiedCmd: "Copied!",
      tabBatch: "Batch download",
      studentLibBtn: "Student library",
      batchTitle: "Smart Batch Course Downloader",
      batchSub: "Select your Term & College, check the materials you study, pick Tutor, Class & Lessons (or ALL), and download everything safely with one click. Already downloaded lectures are skipped automatically.",
      batchStep1: "1. Select Term & College (Program)",
      batchStep2: "2. Select Materials & Configure Classes / Lessons",
      batchFilterPh: "Search materials (e.g. BPG401)…",
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
      langSwitch: "Switch to Arabic"
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
      usage: "المستخدم {used} من أصل {quota} متاحة لهذا الموقع.",
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
      langSwitch: "التبديل إلى الإنجليزية"
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
;
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
;
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
;
(function () {
  'use strict';

  document.addEventListener("contextmenu", event => event.preventDefault());
  document.addEventListener("dragstart", event => event.preventDefault());
  document.addEventListener("selectstart", event => event.preventDefault());
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
    if (info.material) tags.push("<span class=\"mtag mtag-material\" title=\"" + escHtml(t("metaMaterial")) + "\"><b>" + escHtml(info.material) + "</b></span>");
    if (info.cls) tags.push("<span class=\"mtag mtag-class\">" + escHtml(t("metaClass")) + " " + escHtml(info.cls) + "</span>");
    if (info.term) tags.push("<span class=\"mtag mtag-term\">" + escHtml(info.term) + "</span>");
    if (info.lesson) tags.push("<span class=\"mtag mtag-lesson\">" + escHtml(t("metaLesson")) + " " + escHtml(info.lesson) + "</span>");
    if (info.date) tags.push("<span class=\"mtag mtag-date\">" + escHtml(info.date) + "</span>");
    tags.push("<span class=\"mtag mtag-file\" dir=\"ltr\" title=\"" + escHtml(name) + "\">" + escHtml(name) + "</span>");
    metaEl.innerHTML = tags.join("");
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
    document.title = file.name + " | SVU Player";
    byId("vnotice").hidden = parsed.videoOk !== false;
    renderChat();
    renderTicks();
    seek.setAttribute("aria-valuemax", Math.floor(parsed.durationMs / 1000));
    controls.classList.remove("disabled");
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
    if (!chat.length) {
      msgs.innerHTML = "<div class=\"empty\" data-i18n=\"chatNone\"></div>";
      I18N.apply(msgs);
      return;
    }
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
    clearTimeout(msgs._t);
    msgs._t = setTimeout(() => userScrolled = false, 4000);
  }, PASSIVE));
  byId("showAll").addEventListener("change", () => {
    const lbl = byId("showAll").closest("label");
    if (lbl) {
      lbl.classList.toggle("on", byId("showAll").checked);
    }
    if (session) {
      updateChat(audio.currentTime * 1000, true);
    }
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
  byId("back").addEventListener("click", () => session && seekTo(audio.currentTime - 10));
  byId("fwd").addEventListener("click", () => session && seekTo(audio.currentTime + 10));
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
  const toggleChat = () => {
    const hidden = document.body.classList.toggle("nochat");
    byId("chatToggle").classList.toggle("on", !hidden);
    byId("chatToggle").setAttribute("aria-pressed", String(!hidden));
  };
  byId("chatToggle").addEventListener("click", toggleChat);
  if (byId("chatClose")) {
    byId("chatClose").addEventListener("click", toggleChat);
  }

  // Pin / Auto-hide bottom controls + 3-second mouse movement visibility inside player window
  let mouseIdleTimer = null;
  let isHoveringControls = false;
  const stageWrap = stage.closest(".stage-wrap") || stage;

  function showControlsOnMouseActivity() {
    controls.classList.add("mouse-active");
    if (mouseIdleTimer) {
      clearTimeout(mouseIdleTimer);
    }
    mouseIdleTimer = setTimeout(() => {
      if (!isHoveringControls && !controls.classList.contains("pinned")) {
        controls.classList.remove("mouse-active");
      }
    }, 3000);
  }

  stageWrap.addEventListener("mousemove", showControlsOnMouseActivity, { passive: true });
  stageWrap.addEventListener("pointermove", showControlsOnMouseActivity, { passive: true });
  stageWrap.addEventListener("mouseleave", () => {
    if (mouseIdleTimer) {
      clearTimeout(mouseIdleTimer);
      mouseIdleTimer = null;
    }
    if (!controls.classList.contains("pinned")) {
      controls.classList.remove("mouse-active");
    }
  });
  controls.addEventListener("mouseenter", () => {
    isHoveringControls = true;
    controls.classList.add("mouse-active");
    if (mouseIdleTimer) {
      clearTimeout(mouseIdleTimer);
    }
  });
  controls.addEventListener("mouseleave", () => {
    isHoveringControls = false;
    showControlsOnMouseActivity();
  });

  const setPinned = on => {
    controls.classList.toggle("pinned", !!on);
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
      document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    }
  }
  document.addEventListener("fullscreenchange", () => document.body.classList.toggle("fs", !!document.fullscreenElement));
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
  window.__svuApplyTheme = applyTheme;
  window.__svuGetTheme = () => ({ theme: curTheme, mode: curMode });
    if (session && session.key) {
      renderSessionMeta(session.key);
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
  window.__lrec = {
    get session() {
      return session;
    },
    audio: audio,
    seekTo: seekTo,
    openFile: openFile
  };
})();
;

;
;
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

  function fillSelect(sel, items, placeholder, current) {
    if (!sel) return;
    sel.innerHTML = "";
    const placeholderOpt = new Option(t(placeholder), "");
    placeholderOpt.dataset.i18n = placeholder;
    sel.add(placeholderOpt);
    const curTrim = current != null ? String(current).trim() : "";
    let matchedVal = "";
    for (const item of items) {
      sel.add(new Option(item.label, item.value));
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
          ui.txt.textContent = formatSize(received) + " / " + formatSize(total) + " · " + speed.toFixed(1) + " MB/s";
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
      renderBatchCoursesList(false);
    }
    syncCascadeStyles();
    updateBatchSummary();
  }

  async function onBatchTermChange(restoreProgram, forceRefresh) {
    const termVal = byId("batchTerm").value;
    const prevTerm = batchState.term;
    batchState.term = termVal;
    if (!restoreProgram && termVal !== prevTerm) {
      batchState.program = "";
    }
    saveBatchState();
    batchCourseCatalog = [];
    if (!termVal) {
      fillSelect(byId("batchProgram"), [], "selProgram");
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
      if (filterQ && !c.label.toLowerCase().includes(filterQ) && !c.value.toLowerCase().includes(filterQ)) {
        continue;
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
      titleSpan.textContent = c.label;
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

  function updateBatchSummary() {
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
    const startBtn = byId("batchStartBtn");
    if (startBtn) {
      startBtn.disabled = batchQueueRunning || tasks.length === 0;
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
              byId("batchFileTxt").textContent = formatSize(received) + " / " + formatSize(total) + " · " + speed.toFixed(1) + " MB/s";
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
      byId("usage").textContent = usage ? t("usage", {
        used: formatSize(usage.used),
        quota: formatSize(usage.quota)
      }) : "";
    }
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
        const hay = [
          rec.name,
          rec.label,
          m.college,
          m.material,
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
          "<span class=\"mtag mtag-college\"><b>" + escapeHtml(t("localFilesGroup")) + "</b> (" + items.length + ")</span>";
      } else if (groupMode === "course") {
        gTitle.innerHTML =
          "<span class=\"mtag mtag-material\"><b>" + escapeHtml(t("metaMaterial")) + " :</b> " + escapeHtml(gKey) + "</span>" +
          (sample.college ? "<span class=\"mtag mtag-college\"><b>" + escapeHtml(t("metaCollege")) + " :</b> " + escapeHtml(sample.college) + "</span>" : "") +
          (sample.className ? "<span class=\"mtag mtag-class\"><b>" + escapeHtml(t("metaClass")) + " :</b> " + escapeHtml(sample.className) + "</span>" : "") +
          (sample.term ? "<span class=\"mtag mtag-term\"><b>" + escapeHtml(t("metaTerm")) + " :</b> " + escapeHtml(sample.term) + "</span>" : "") +
          (sample.tutor ? "<span class=\"muted\" style=\"font-weight:600;font-size:12px;\">" + escapeHtml(sample.tutor) + "</span>" : "");
      } else {
        gTitle.innerHTML = "<span class=\"mtag mtag-college\">" + escapeHtml(gKey) + "</span> <span class=\"muted\">(" + items.length + ")</span>";
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

    // 1-Click Watched / Unwatched Toggle Button
    const watchBtn = document.createElement("button");
    watchBtn.className = "watch-btn" + (rec.watched ? " on" : "");
    watchBtn.title = t("libMarkWatched");
    watchBtn.innerHTML = rec.watched
      ? "<span>" + escapeHtml(t("libWatched")) + "</span>"
      : "<span>○ " + escapeHtml(t("libUnwatched")) + "</span>";
    watchBtn.addEventListener("click", () => {
      setLectureWatched(rec.id, !rec.watched);
    });

    // Structured Badges + Info (Inside Material Window: ONLY Lesson Number & Date tags!)
    const info = document.createElement("div");
    info.className = "lec-info";
    const tags = document.createElement("div");
    tags.className = "lec-tags";
    if (m.lesson) {
      tags.innerHTML += "<span class=\"mtag mtag-lesson\"><b>" + escapeHtml(t("batchLessonNum", { n: m.lesson })) + "</b></span>";
    }
    if (!insideMaterialWindow) {
      if (m.material && m.material !== "__LOCAL_FILES__") {
        tags.innerHTML += "<span class=\"mtag mtag-material\">" + escapeHtml(m.material) + "</span>";
      }
      if (m.college) {
        tags.innerHTML += "<span class=\"mtag mtag-college\">" + escapeHtml(m.college) + "</span>";
      }
      if (m.className) {
        tags.innerHTML += "<span class=\"mtag mtag-class\">C" + escapeHtml(m.className) + "</span>";
      }
      if (m.term) {
        tags.innerHTML += "<span class=\"mtag mtag-term\">" + escapeHtml(m.term) + "</span>";
      }
    }
    if (m.date) {
      tags.innerHTML += "<span class=\"mtag mtag-date\"><b>" + escapeHtml(t("metaDate")) + " :</b> " + escapeHtml(m.date) + "</span>";
    }

    const sub = document.createElement("div");
    sub.className = "lec-sub";
    sub.innerHTML =
      "<code dir=\"ltr\">" + escapeHtml(rec.name) + "</code>" +
      "<span>· " + formatSize(rec.size || 0) + "</span>";

    info.append(tags, sub);

    const playBtn = document.createElement("button");
    playBtn.className = "primary";
    playBtn.innerHTML = iconLabel("play", "play");
    playBtn.addEventListener("click", () => playSaved(rec.id));

    const delBtn = document.createElement("button");
    delBtn.innerHTML = iconLabel("trash", "del");
    delBtn.addEventListener("click", async () => {
      if (confirm(t("confirmDelete", { name: rec.name }))) {
        await LibraryDB.remove(rec.id);
        refreshSaved();
      }
    });

    row.append(watchBtn, info, playBtn, delBtn);
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
    dialog.showModal();
    await refreshSaved();
    showTab(tab);
    syncCascadeStyles();
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
      if (parsed.material) html += "<span class=\"mtag mtag-material\"><b>" + escapeHtml(t("metaMaterial")) + " :</b> " + escapeHtml(parsed.material) + "</span>";
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
        matList.map(m => "<span class=\"mtag mtag-material\">" + escapeHtml(m.course + (m.classVal ? " (" + m.classVal + ")" : "")) + "</span>").join("");

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
      fillSelect(byId("selTerm"), cachedTerms, "selTerm");
      termsLoaded = true;
      byId("noserver").hidden = true;
      byId("cascade").hidden = false;
      setStatus("");
    } catch (err) {
      byId("noserver").hidden = false;
      setStatus("");
    }
    setBusy(false);
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
    if (dialog.open && !byId("paneBatch").hidden) {
      renderBatchCoursesList(false);
      updateBatchSummary();
    }
  });
})();
;

;
;
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
;
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
;
(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const welcome = byId("welcome");
  const wstage = byId("wstage");
  const wfit = byId("wfit");
  const warrows = byId("warrows");
  const W_WIDTH = 1040;
  const W_HEIGHT = 690;
  const TOUR_KEY = "svu.welcome.v4";
  const MARKS = [
    ["wm-meta", "wMeta", "top", 252, 10],
    ["wm-open", "wOpen", "top", 472, 10],
    ["wm-themes", "wThemes", "top", 692, 10],
    ["wm-screen", "wScreen", "left", 12, 165],
    ["wm-seek", "wSeek", "left", 12, 315],
    ["wm-play", "wPlay", "left", 12, 445],
    ["wm-chathead", "wChatHead", "right", 823, 155],
    ["wm-chat", "wChat", "right", 823, 295],
    ["wm-pin", "wPin", "right", 823, 445],
    ["wm-enh", "wEnh", "bottom", 252, 596],
    ["wm-vol", "wVol", "bottom", 472, 596],
    ["wm-stretch", "wStr", "bottom", 692, 596]
  ];
  document.querySelectorAll("#welcome [data-clone]").forEach(slot => {
    const src = document.querySelector(slot.dataset.clone);
    if (src) {
      const clone = src.cloneNode(true);
      clone.removeAttribute("id");
      clone.style.display = "";
      slot.appendChild(clone);
    }
  });
  const marks = MARKS.map(([target, key, side, x, y]) => {
    const label = document.createElement("div");
    label.className = "wlabel";
    label.style.left = x + "px";
    label.style.top = y + "px";
    label.innerHTML = "<b data-i18n=\"" + key + "T\"></b><span data-i18n=\"" + key + "D\"></span>";
    wstage.appendChild(label);
    const item = document.createElement("li");
    item.innerHTML = "<b data-i18n=\"" + key + "T\"></b><span data-i18n=\"" + key + "D\"></span>";
    byId("wlist").appendChild(item);
    return {
      target: target,
      side: side,
      el: label
    };
  });
  I18N.apply(welcome);
  function edgePoint(rect, point) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    const tx = dx ? (rect.w / 2 + 4) / Math.abs(dx) : Infinity;
    const ty = dy ? (rect.h / 2 + 4) / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty, 1);
    return {
      x: cx + dx * t,
      y: cy + dy * t
    };
  }
  function layout() {
    if (!welcome.open) {
      return;
    }
    if (getComputedStyle(wfit).display === "none") {
      welcome.style.width = "";
      return;
    }
    const PAD = 28;
    const w = Math.min(1120, window.innerWidth * 0.96) - PAD;
    const h = Math.max(260, window.innerHeight * 0.88 - 220);
    const scale = Math.min(1, w / W_WIDTH, h / W_HEIGHT);
    welcome.style.width = Math.max(600, Math.round(W_WIDTH * scale + PAD)) + "px";
    wfit.style.width = W_WIDTH * scale + "px";
    wfit.style.height = W_HEIGHT * scale + "px";
    wstage.style.transform = "scale(" + scale + ")";
    const stageRect = wstage.getBoundingClientRect();
    const relRect = el => {
      const rect = el.getBoundingClientRect();
      return {
        x: (rect.left - stageRect.left) / scale,
        y: (rect.top - stageRect.top) / scale,
        w: rect.width / scale,
        h: rect.height / scale
      };
    };
    let paths = "";
    for (const {
      target: target,
      side: side,
      el: el
    } of marks) {
      const targetEl = byId(target);
      if (!targetEl) continue;
      const rect = relRect(targetEl);
      const labelRect = relRect(el);
      const anchor = side === "left" ? {
        x: labelRect.x + labelRect.w,
        y: labelRect.y + labelRect.h / 2
      } : side === "right" ? {
        x: labelRect.x,
        y: labelRect.y + labelRect.h / 2
      } : side === "top" ? {
        x: labelRect.x + labelRect.w / 2,
        y: labelRect.y + labelRect.h
      } : {
        x: labelRect.x + labelRect.w / 2,
        y: labelRect.y
      };
      const edge = edgePoint(rect, anchor);
      const vertical = side === "left" || side === "right";
      const ctrl = vertical ? {
        x: (anchor.x + edge.x) / 2,
        y: anchor.y
      } : {
        x: anchor.x,
        y: (anchor.y + edge.y) / 2
      };
      paths += "<path d=\"M" + anchor.x.toFixed(1) + " " + anchor.y.toFixed(1) + " Q" + ctrl.x.toFixed(1) + " " + ctrl.y.toFixed(1) + " " + edge.x.toFixed(1) + " " + edge.y.toFixed(1) + "\" marker-end=\"url(#wtip)\"/>";
    }
    warrows.querySelectorAll("path:not([style])").forEach(path => path.remove());
    warrows.insertAdjacentHTML("beforeend", paths);
  }
  function showTour() {
    if (welcome.open) {
      return;
    }
    welcome.showModal();
    requestAnimationFrame(layout);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(layout);
    }
  }
  function closeTour() {
    if (window.SVU_PREFS) {
      window.SVU_PREFS.set(TOUR_KEY, "1");
    } else {
      try { localStorage.setItem(TOUR_KEY, "1"); } catch (err) {}
    }
    if (welcome.open) {
      welcome.close();
    }
  }
  byId("welcomeStart").addEventListener("click", closeTour);
  byId("welcomeClose").addEventListener("click", closeTour);
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
    if (window.SVU_PREFS) {
      window.SVU_PREFS.set(TOUR_KEY, "1");
    } else {
      try { localStorage.setItem(TOUR_KEY, "1"); } catch (err) {}
    }
  });
  welcome.addEventListener("click", event => {
    if (event.target === welcome) {
      closeTour();
    }
  });
  window.addEventListener("resize", () => requestAnimationFrame(layout));
  document.addEventListener("langchange", () => { I18N.apply(welcome); requestAnimationFrame(layout); });
  byId("tourBtn").addEventListener("click", () => {
    const about = byId("about");
    if (about.open) {
      about.close();
    }
    showTour();
  });
  let seen = false;
  if (window.SVU_PREFS) {
    seen = !!window.SVU_PREFS.get(TOUR_KEY, "");
  } else {
    try { seen = !!localStorage.getItem(TOUR_KEY); } catch (err) {}
  }
  if (!seen) {
    setTimeout(showTour, 350);
  }
  window.__lrec.showTour = showTour;
})();
;

;
;
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
