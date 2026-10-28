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
  let sliderInitialized = false;

  function showSlide(index) {
    currentSlide = (index + totalSlides) % totalSlides;
    const slides = document.querySelectorAll("#guideSlides .guide-slide");
    const dots = document.querySelectorAll("#sliderDots .dot");
    const navItems = document.querySelectorAll(".guide-nav-item");

    slides.forEach((slide, i) => {
      slide.classList.toggle("active", i === currentSlide);
    });
    dots.forEach((dot, i) => {
      const isActive = (i === currentSlide);
      dot.classList.toggle("active", isActive);
      dot.setAttribute("aria-selected", String(isActive));
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
    if (sliderInitialized) return;
    sliderInitialized = true;

    const prevBtn = byId("sliderPrevBtn");
    const nextBtn = byId("sliderNextBtn");
    if (prevBtn) prevBtn.onclick = (e) => { e.stopPropagation(); prevSlide(); stopSliderTimer(); };
    if (nextBtn) nextBtn.onclick = (e) => { e.stopPropagation(); nextSlide(); stopSliderTimer(); };

    const dots = document.querySelectorAll("#sliderDots .dot");
    dots.forEach(dot => {
      dot.onclick = (e) => {
        e.stopPropagation();
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
        touchStartX = 0;
        touchStartY = 0;
        touchEndX = 0;
        touchEndY = 0;

        if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy)) {
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
    }

    showSlide(0);
  }

  /* ==========================================================================
     GUIDE MODAL OPEN / CLOSE CONTROLLER
     ========================================================================== */
  function showTour() {
    if (typeof window.closeMobileSheet === "function") {
      window.closeMobileSheet();
    }
    const sheet = byId("mobileMenuSheet");
    if (sheet) {
      sheet.classList.remove("open");
      sheet.setAttribute("aria-hidden", "true");
      sheet.style.visibility = "hidden";
      sheet.style.pointerEvents = "none";
    }
    const sheetBackdrop = byId("mobileSheetBackdrop");
    if (sheetBackdrop) {
      sheetBackdrop.classList.remove("open");
      sheetBackdrop.setAttribute("aria-hidden", "true");
      sheetBackdrop.style.visibility = "hidden";
      sheetBackdrop.style.pointerEvents = "none";
    }
    document.body.style.overflow = "";

    if (welcome.open) return;
    I18N.apply(welcome);
    welcome.showModal();
    initSlider();
    showSlide(0);
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
      if (typeof window.closeMobileSheet === "function") {
        window.closeMobileSheet();
      }
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
