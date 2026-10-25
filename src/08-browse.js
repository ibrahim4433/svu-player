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

    const actions = document.createElement("div");
    actions.className = "lec-actions";
    actions.append(playBtn, delBtn);
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

      const actions = document.createElement("div");
      actions.className = "dir-card-actions";

      const libBtn = document.createElement("button");
      libBtn.className = "dir-btn";
      libBtn.innerHTML = "<svg class=\"i\" style=\"width:12px;height:12px;\"><use href=\"#i-save\"/></svg><span>" + escapeHtml(t("courseDirFindInLib")) + "</span>";
      libBtn.addEventListener("click", () => {
        if (courseDirModal) courseDirModal.close();
        if (byId("tabSaved")) byId("tabSaved").click();
        if (byId("libSearch")) {
          byId("libSearch").value = it.code;
          renderLibraryView();
        }
      });

      const batchBtn = document.createElement("button");
      batchBtn.className = "dir-btn";
      batchBtn.innerHTML = "<svg class=\"i\" style=\"width:12px;height:12px;\"><use href=\"#i-download\"/></svg><span>" + escapeHtml(t("courseDirBatchSelect")) + "</span>";
      batchBtn.addEventListener("click", () => {
        if (courseDirModal) courseDirModal.close();
        if (byId("tabBatch")) byId("tabBatch").click();
        if (byId("batchCourseFilter")) {
          byId("batchCourseFilter").value = it.code;
          renderBatchCoursesList(false);
        }
      });

      actions.append(libBtn, batchBtn);
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
    const introCard = byId("hubIntroCard");
    const introMini = byId("introMini");
    const introFull = byId("introFull");
    if (introCard && introMini && introFull) {
      if (savedRecordsCache.length === 0) {
        introCard.classList.remove("is-compact");
        introCard.classList.remove("is-expanded");
        introMini.style.display = "none";
        introFull.style.display = "";
      } else {
        introCard.classList.add("is-compact");
        introMini.style.display = "flex";
        // If not explicitly toggled by student, keep full body hidden
        if (!introCard.classList.contains("is-expanded")) {
          introFull.style.display = "none";
        } else {
          introFull.style.display = "";
        }
      }
    }

    // 3. Resume Last Played Card (#hubResumeCard)
    const resumeCard = byId("hubResumeCard");
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
      } else {
        resumeCard.hidden = true;
      }
    }

    // 4. Populate Recent Offline Lectures (Up to 5)
    const recentList = byId("hubRecentList");
    if (recentList) {
      recentList.innerHTML = "";
      if (!savedRecordsCache.length) {
        recentList.innerHTML = "<div class=\"hub-empty-msg\">" + escapeHtml(t("hubNoSavedHint")) + "</div>";
      } else {
        const recentItems = savedRecordsCache.slice(0, 5);
        for (const rec of recentItems) {
          const m = rec.parsedMeta;
          const item = document.createElement("div");
          item.className = "hub-recent-item";

          const mat = (window.MaterialsDB && m.material) ? window.MaterialsDB.get(m.material) : null;
          const isEn = window.I18N && window.I18N.lang === "en";
          const mName = mat ? (isEn ? (mat.en || mat.ar) : (mat.ar || mat.en)) : "";
          const lessonTxt = m.lesson ? t("batchLessonNum", { n: m.lesson }) : rec.name;
          const fullTitle = (m.material ? m.material + " · " : "") + (mName ? mName + " — " : "") + lessonTxt;

          const info = document.createElement("div");
          info.className = "hub-recent-item-info";
          const metaParts = [];
          if (m.date) metaParts.push(m.date);
          metaParts.push(formatSize(rec.size || 0));
          if (rec.watched) metaParts.push("✓ " + t("libWatched"));

          info.innerHTML =
            "<div class=\"hub-recent-item-title\">" + escapeHtml(fullTitle) + "</div>" +
            "<div class=\"hub-recent-item-meta\">" + metaParts.map(escapeHtml).join(" • ") + "</div>";

          const playBtn = document.createElement("button");
          playBtn.className = "primary hub-recent-play-btn";
          playBtn.innerHTML = "<svg viewBox='0 0 24 24' width='13' height='13' fill='currentColor'><polygon points='6 3 20 12 6 21 6 3'/></svg><span>" + escapeHtml(t("play")) + "</span>";
          playBtn.onclick = (e) => {
            e.stopPropagation();
            playSaved(rec.id);
          };

          item.style.cursor = "pointer";
          item.onclick = () => playSaved(rec.id);
          item.append(info, playBtn);
          recentList.appendChild(item);
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
      batchTile.addEventListener("click", () => {
        showTab("batch");
        dialog.showModal();
      });
    }
    const libTile = byId("hubLibTile");
    if (libTile) {
      libTile.addEventListener("click", () => {
        showTab("saved");
        dialog.showModal();
      });
    }
    const browseTile = byId("hubBrowseTile");
    if (browseTile) {
      browseTile.addEventListener("click", () => {
        showTab("remote");
        dialog.showModal();
      });
    }
    const fileTile = byId("hubFileTile");
    if (fileTile) {
      fileTile.addEventListener("click", () => {
        byId("file").click();
      });
    }
    const viewAllBtn = byId("hubViewAllSavedBtn");
    if (viewAllBtn) {
      viewAllBtn.addEventListener("click", () => {
        showTab("saved");
        dialog.showModal();
      });
    }

    // Intro Card Toggle
    const introMini = byId("introMini");
    if (introMini) {
      introMini.addEventListener("click", () => {
        const introCard = byId("hubIntroCard");
        const introFull = byId("introFull");
        if (introCard && introFull) {
          const isExp = introCard.classList.toggle("is-expanded");
          introFull.style.display = isExp ? "" : "none";
        }
      });
    }
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
        byId("welcome").showModal();
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