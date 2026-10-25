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
  const totalSlides = 5;
  let sliderTimer = null;

  function showSlide(index) {
    currentSlide = (index + totalSlides) % totalSlides;
    const slides = document.querySelectorAll("#guideSlides .guide-slide");
    const dots = document.querySelectorAll("#sliderDots .dot");

    slides.forEach((slide, i) => {
      slide.classList.toggle("active", i === currentSlide);
    });
    dots.forEach((dot, i) => {
      dot.classList.toggle("active", i === currentSlide);
    });
  }

  function nextSlide() {
    showSlide(currentSlide + 1);
  }

  function prevSlide() {
    showSlide(currentSlide - 1);
  }

  function startSliderTimer() {
    stopSliderTimer();
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

    const slider = byId("guideSlider");
    if (slider) {
      slider.onmouseenter = stopSliderTimer;
      slider.onmouseleave = startSliderTimer;
      slider.ontouchstart = stopSliderTimer;
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

  // Requirement 7: Every time the app reloads to the main student hub, show the help guide window pop-up
  if (!document.body.classList.contains("has-session")) {
    setTimeout(showTour, 450);
  }

  if (!window.__lrec) window.__lrec = {};
  window.__lrec.showTour = showTour;
})();
