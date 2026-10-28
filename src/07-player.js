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
    document.body.classList.remove("chat-drawer-open");
    if (byId("chatToggle")) {
      byId("chatToggle").classList.remove("on");
      byId("chatToggle").setAttribute("aria-pressed", "false");
    }
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
  const isTouchDevice = () => (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(hover: none) and (pointer: coarse)").matches);
  const isMobileViewport = () => (window.innerWidth <= 950 || window.innerHeight <= 640);
  const isMobileUI = () => isTouchDevice() || isMobileViewport();
  const isLandscapeMobile = () => {
    if (!isMobileUI()) return false;
    const isLandscape = window.innerWidth > window.innerHeight;
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.body.classList.contains("fs"));
    return isLandscape || isFs;
  };

  const toggleChat = () => {
    if (isLandscapeMobile()) {
      document.body.classList.remove("nochat");
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
    // Note: When chat is open side-by-side (50%/50%), tapping stage does NOT close chat;
    // it allows normal stage interaction (controls / double-tap seek).
    // Close is handled cleanly by #chatClose and #chatToggle.
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
  const VALID_TERM_COLORS = { green: true, amber: true, cyan: true, crimson: true, violet: true, mono: true };
  const PHOS_SWATCH_COLORS = {
    green: "#00FF41",
    amber: "#FFB000",
    cyan: "#00F0FF",
    crimson: "#FF003C",
    violet: "#BF00FF",
    mono: "#E2E8F0"
  };

  let curTheme = getPref("svu.theme", "default");
  let curMode = getPref("svu.mode", "dark");
  if (!THEME_KEYS[curTheme]) {
    curTheme = "default";
  }
  let curTermColor = getPref("svu.termColor", curTheme === "terminal" ? "amber" : "green");
  if (!VALID_TERM_COLORS[curTermColor]) {
    curTermColor = curTheme === "terminal" ? "amber" : "green";
  }
  let curCrt = getPref("svu.crt", "on");
  if (curCrt !== "off") curCrt = "on";

  function applyTermExtras() {
    const isHacker = curTheme === "hacker";
    const isTerm = curTheme === "terminal";
    const isSpecial = isHacker || isTerm;
    const docEl = document.documentElement;
    if (isSpecial) {
      docEl.dataset.termColor = curTermColor;
      docEl.dataset.crt = curCrt;
      const pcExtras = byId("themeTermExtras");
      if (pcExtras) pcExtras.style.display = "block";
      const mExtras = byId("mobileTermExtras");
      if (mExtras) mExtras.style.display = "block";

      const titleKey = isHacker ? "cyberProtocol" : "phosphorColor";
      const crtKey = isHacker ? "cyberHudEffects" : "crtScanlines";
      const pcHead = byId("termHeadLabel");
      if (pcHead) {
        pcHead.dataset.i18n = titleKey;
        pcHead.textContent = t(titleKey);
      }
      const mHead = byId("mobileTermHeadLabel");
      if (mHead) {
        mHead.dataset.i18n = titleKey;
        mHead.textContent = t(titleKey);
      }
      const pcCrtLbl = byId("crtToggleLabel");
      if (pcCrtLbl) {
        pcCrtLbl.dataset.i18n = crtKey;
        pcCrtLbl.textContent = t(crtKey);
      }
      const mCrtLbl = byId("mobileCrtToggleLabel");
      if (mCrtLbl) {
        mCrtLbl.dataset.i18n = crtKey;
        mCrtLbl.textContent = t(crtKey);
      }
    } else {
      delete docEl.dataset.termColor;
      delete docEl.dataset.crt;
      const pcExtras = byId("themeTermExtras");
      if (pcExtras) pcExtras.style.display = "none";
      const mExtras = byId("mobileTermExtras");
      if (mExtras) mExtras.style.display = "none";
    }

    document.querySelectorAll("[data-term-color]").forEach(el => {
      el.classList.toggle("active", el.dataset.termColor === curTermColor);
    });

    document.querySelectorAll(".term-crt-toggle").forEach(btn => {
      btn.classList.toggle("active", curCrt === "on");
      const sw = btn.querySelector(".crt-toggle-switch");
      if (sw) sw.classList.toggle("active", curCrt === "on");
    });

    const activeColor = PHOS_SWATCH_COLORS[curTermColor] || (curTheme === "terminal" ? "#FFB000" : "#00FF41");
    if (isSpecial) {
      document.querySelectorAll(`.theme-opt[data-theme-opt="${curTheme}"] .theme-dot, .m-theme-opt[data-theme-opt="${curTheme}"] .m-theme-dot`).forEach(dot => {
        dot.style.background = activeColor;
      });
    }
  }

  function setTermColor(color) {
    if (VALID_TERM_COLORS[color]) {
      curTermColor = color;
      setPref("svu.termColor", color);
      applyTermExtras();
    }
  }

  function toggleCrt() {
    curCrt = curCrt === "on" ? "off" : "on";
    setPref("svu.crt", curCrt);
    applyTermExtras();
  }

  function applyTheme(theme, mode) {
    if (theme === "hacker" && curTheme !== "hacker" && curTermColor === "amber") {
      curTermColor = "green";
      setPref("svu.termColor", "green");
    } else if (theme === "terminal" && curTheme !== "terminal" && curTermColor === "violet") {
      curTermColor = "amber";
      setPref("svu.termColor", "amber");
    }
    curTheme = THEME_KEYS[theme] ? theme : "default";
    curMode = mode === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = curTheme;
    document.documentElement.dataset.mode = curMode;
    setPref("svu.theme", curTheme);
    setPref("svu.mode", curMode);

    applyTermExtras();

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
  window.__svuGetTheme = () => ({ theme: curTheme, mode: curMode, termColor: curTermColor, crt: curCrt });
  window.__svuSetTermColor = setTermColor;
  window.__svuToggleCrt = toggleCrt;

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
        const nextTheme = btn.dataset.themeOpt;
        applyTheme(nextTheme, curMode);
        if (nextTheme !== "hacker" && nextTheme !== "terminal") {
          byId("themeDropdown").classList.remove("open");
        }
      });
    });
    document.addEventListener("click", () => {
      byId("themeDropdown").classList.remove("open");
    });
  }

  // Wire Terminal & Hacker Phosphor Colors & CRT Scanlines
  document.querySelectorAll("[data-term-color]").forEach(btn => {
    btn.addEventListener("click", event => {
      event.stopPropagation();
      setTermColor(btn.dataset.termColor);
    });
  });
  document.querySelectorAll(".term-crt-toggle").forEach(btn => {
    btn.addEventListener("click", event => {
      event.stopPropagation();
      toggleCrt();
    });
  });
  const pcTermExtras = byId("themeTermExtras");
  if (pcTermExtras) {
    pcTermExtras.addEventListener("click", event => {
      event.stopPropagation();
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
  window.closeMobileSheet = closeMobileSheet;

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
    const isMobile = isMobileUI();
    const isLandscape = isLandscapeMobile();
    const isPortrait = isMobile && !isLandscape && (window.innerHeight > window.innerWidth);
    document.body.classList.toggle("is-mobile", isMobile);
    document.body.classList.toggle("is-mobile-portrait", isPortrait);
    document.body.classList.toggle("is-mobile-landscape", isLandscape);
    if (!isLandscape && document.body.classList.contains("chat-drawer-open")) {
      document.body.classList.remove("chat-drawer-open");
      if (byId("chatToggle")) {
        byId("chatToggle").classList.remove("on");
        byId("chatToggle").setAttribute("aria-pressed", "false");
      }
    }
  }
  window.addEventListener("resize", handleScreenResize, PASSIVE);
  window.addEventListener("orientationchange", () => setTimeout(handleScreenResize, 150), PASSIVE);
  document.addEventListener("fullscreenchange", handleScreenResize, PASSIVE);
  document.addEventListener("webkitfullscreenchange", handleScreenResize, PASSIVE);
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

