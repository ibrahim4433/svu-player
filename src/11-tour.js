(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const welcome = byId("welcome");
  if (!welcome) return;

  const TOUR_KEY = "svu.welcome.v4";

  function showTour() {
    if (welcome.open) return;
    I18N.apply(welcome);
    welcome.showModal();
  }

  function closeTour() {
    if (window.SVU_PREFS) {
      window.SVU_PREFS.set(TOUR_KEY, "1");
    } else {
      try { localStorage.setItem(TOUR_KEY, "1"); } catch (_) {}
    }
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
    if (window.SVU_PREFS) {
      window.SVU_PREFS.set(TOUR_KEY, "1");
    } else {
      try { localStorage.setItem(TOUR_KEY, "1"); } catch (_) {}
    }
  });

  welcome.addEventListener("click", event => {
    if (event.target === welcome) {
      closeTour();
    }
  });

  document.addEventListener("langchange", () => {
    if (welcome.open) {
      I18N.apply(welcome);
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

  let seen = false;
  if (window.SVU_PREFS) {
    seen = !!window.SVU_PREFS.get(TOUR_KEY, "");
  } else {
    try { seen = !!localStorage.getItem(TOUR_KEY); } catch (_) {}
  }
  if (!seen) {
    setTimeout(showTour, 400);
  }

  if (!window.__lrec) window.__lrec = {};
  window.__lrec.showTour = showTour;
})();
