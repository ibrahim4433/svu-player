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