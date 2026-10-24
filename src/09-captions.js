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
