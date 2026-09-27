(() => {
  const reader = document.querySelector('.reader');
  const enterButton = document.getElementById('fullScreen');
  const exitButton = document.getElementById('exitFullScreen');
  const bar = document.querySelector('.readerFullScreenBar');
  const pdfArea = document.getElementById('pdfArea');
  const slideControls = document.querySelector('.readerSlideControls');
  const previousSlide = document.getElementById('previousSlide');
  const nextSlide = document.getElementById('nextSlide');
  const slideCount = document.getElementById('slideCount');
  const root = document.documentElement;
  let active = false;
  let busy = false;
  let nativeActive = false;
  let page = 1;
  let total = 1;
  let swipe = null;

  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const modalOpen = () => document.querySelector('dialog[open], .verseModal:not([hidden])');
  const interactive = target => target?.closest?.('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="button"], .answerTapTarget, [data-answer-id]');
  const zoomed = () => window.visualViewport?.scale > 1.05;

  function updateControls() {
    previousSlide.disabled = page <= 1;
    nextSlide.disabled = page >= total;
    slideCount.textContent = `${page} de ${total}`;
  }

  function requestPage(detail) {
    const destination = detail.page ?? page + detail.delta;
    if (!active || modalOpen() || destination < 1 || destination > total || destination === page) return;
    window.dispatchEvent(new CustomEvent('reader-page-request', { detail }));
  }

  function setActive(value) {
    if (active === value) return;
    active = value;
    reader.classList.toggle('is-fullscreen', value);
    enterButton.setAttribute('aria-pressed', String(value));
    bar.hidden = !value;
    slideControls.hidden = !value;
    swipe = null;
    (value ? pdfArea : enterButton).focus({ preventScroll: true });
    window.dispatchEvent(new Event('reader-view-change'));
  }

  async function enter() {
    if (active || busy) return;
    setActive(true);
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!request || document.fullscreenEnabled === false || document.webkitFullscreenEnabled === false) return;
    busy = true;
    try {
      await request.call(root);
      nativeActive = fullscreenElement() === root;
    } catch {
      // Keep the distraction-free reader when browser fullscreen is unavailable.
    } finally {
      busy = false;
    }
  }

  async function exit() {
    if (!active || busy) return;
    busy = true;
    try {
      if (fullscreenElement() === root) {
        const leave = document.exitFullscreen || document.webkitExitFullscreen;
        await leave.call(document);
      }
      nativeActive = false;
      setActive(false);
    } catch {
      // Restore the normal controls even if the browser cannot leave fullscreen.
      setActive(false);
    } finally {
      busy = false;
    }
  }

  function syncFullscreen() {
    if (fullscreenElement() === root) nativeActive = true;
    else if (nativeActive) {
      nativeActive = false;
      setActive(false);
    }
  }

  enterButton.addEventListener('click', enter);
  exitButton.addEventListener('click', exit);
  previousSlide.addEventListener('click', () => requestPage({ delta: -1 }));
  nextSlide.addEventListener('click', () => requestPage({ delta: 1 }));
  window.addEventListener('reader-page-change', event => {
    const detail = event.detail;
    if (!Number.isInteger(detail?.total) || detail.total < 1 || !Number.isInteger(detail?.page)) return;
    total = detail.total;
    page = Math.min(total, Math.max(1, detail.page));
    updateControls();
  });
  document.addEventListener('fullscreenchange', syncFullscreen);
  document.addEventListener('webkitfullscreenchange', syncFullscreen);
  document.addEventListener('keydown', event => {
    if (!active || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || modalOpen()) return;
    if (event.key === 'Escape') {
      exit();
      return;
    }
    if (interactive(event.target) || interactive(document.activeElement)) return;
    const directions = { ArrowLeft: -1, PageUp: -1, ArrowRight: 1, PageDown: 1, ' ': 1 };
    if (directions[event.key]) {
      event.preventDefault();
      requestPage({ delta: directions[event.key] });
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      requestPage({ page: event.key === 'Home' ? 1 : total });
    }
  });

  pdfArea.addEventListener('touchstart', event => {
    swipe = null;
    if (!active || event.touches.length !== 1 || zoomed() || modalOpen() || interactive(event.target)) return;
    const touch = event.touches[0];
    swipe = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  pdfArea.addEventListener('touchmove', event => {
    if (event.touches.length !== 1 || zoomed()) swipe = null;
  }, { passive: true });
  pdfArea.addEventListener('touchend', event => {
    const start = swipe;
    swipe = null;
    if (!start || !active || event.touches.length || zoomed() || modalOpen() || interactive(event.target)) return;
    const touch = Array.from(event.changedTouches).find(item => item.identifier === start.id);
    if (!touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) requestPage({ delta: dx < 0 ? 1 : -1 });
  }, { passive: true });
  pdfArea.addEventListener('touchcancel', () => { swipe = null; }, { passive: true });
  updateControls();
})();
