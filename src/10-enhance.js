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
