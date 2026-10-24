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
