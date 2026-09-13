// Loaded by the reader only when diagnostico=toque is explicitly requested.
export default function startTouchDiagnostic() {
  window.__firstTapDiagnosticStop?.();
  if (new URLSearchParams(location.search).get('diagnostico') !== 'toque') return () => {};
  const trace = [];
  const identities = new WeakMap();
  const listeners = [];
  const timers = new Set();
  const transitions = [];
  const received = { keydown: 0, beforeinput: 0, input: 0 };
  let nextIdentity = 0;
  let touched = null;
  let stopped = false;
  const viewport = window.visualViewport;
  const panel = document.createElement('div');
  panel.id = 'readerTouchDiagnostic';
  panel.setAttribute('aria-hidden', 'true');
  panel.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;user-select:none;-webkit-user-select:none;transform-origin:0 0;box-sizing:border-box;margin:0;padding:6px 8px;border-radius:6px;background:rgba(15,23,42,.92);color:#fff;font:11px/1.35 monospace;white-space:pre;overflow:hidden;text-align:left;';
  document.body.appendChild(panel);
  function describe(element) {
    if (!(element instanceof Element)) return null;
    if (!identities.has(element)) identities.set(element, ++nextIdentity);
    return { node: identities.get(element), id: element.dataset.answerId || element.id || element.tagName.toLowerCase(), connected: element.isConnected, focused: element.matches(':focus') };
  }
  function label(element) {
    if (!element) return 'ninguno';
    return `n${element.node} ${element.id} ${element.connected ? 'con' : 'fuera'}${element.focused ? ' FOCO' : ''}`;
  }
  function record(type, target = null) {
    if (stopped) return;
    const area = document.getElementById('pdfArea');
    const rect = touched?.getBoundingClientRect();
    const entry = {
      time: Math.round(performance.now()), type, target: describe(target), active: describe(document.activeElement), touched: describe(touched),
      documentFocused: document.hasFocus(),
      areaWidth: area?.clientWidth ?? null, areaScrollWidth: area?.scrollWidth ?? null,
      fontSize: touched?.isConnected ? getComputedStyle(touched).fontSize : null,
      touchedRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      received: { ...received },
      viewport: viewport ? { width: viewport.width, height: viewport.height, scale: viewport.scale, left: viewport.offsetLeft, top: viewport.offsetTop } : null
    };
    trace.push(entry);
    if (trace.length > 120) trace.splice(0, trace.length - 120);
    if (type === 'focusin' || type === 'focusout' || type === 'nodo-retirado') {
      transitions.push(`${type === 'focusin' ? '+' : type === 'focusout' ? '-' : 'X'}n${entry.target?.node ?? '?'}`);
      if (transitions.length > 6) transitions.shift();
    }
    const scale = Math.max(0.1, viewport?.scale || 1);
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    panel.style.transform = `translate(${left + 6 / scale}px, ${top + 6 / scale}px) scale(${1 / scale})`;
    panel.style.width = `${Math.max(100, Math.min(390, width * scale - 12))}px`;
    panel.textContent = [
      `TOQUE ${type} | tecla ${received.keydown} texto ${received.input}`,
      `Activo: ${label(entry.active)}`,
      `Tocado: ${label(entry.touched)}`,
      `Foco (+entra -sale Xretirado): ${transitions.join(' ') || 'sin cambios'}`,
      `Área: ${entry.areaWidth ?? '?'} / ${entry.areaScrollWidth ?? '?'}px; letra ${entry.fontSize || '?'}`,
      `Vista: ${Math.round(width)}px x${scale.toFixed(2)} (${Math.round(left)},${Math.round(top)}) doc ${entry.documentFocused ? 'sí' : 'no'}`
    ].join('\n');
  }
  function listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    listeners.push(() => target.removeEventListener(type, listener, options));
  }
  for (const type of ['pointerdown', 'touchstart', 'click', 'focusin', 'focusout', 'beforeinput', 'input', 'keydown']) {
    listen(document, type, event => {
      if (type === 'pointerdown' || type === 'touchstart') {
        const target = event.target;
        const candidate = target instanceof Element && target.matches('.answerField') ? target : target?.control;
        if (candidate instanceof Element && candidate.matches('.answerField')) {
          if (candidate !== touched) Object.keys(received).forEach(key => { received[key] = 0; });
          touched = candidate;
          for (const timer of timers) clearTimeout(timer);
          timers.clear();
          for (const delay of [100, 250, 750]) {
            const timer = setTimeout(() => { timers.delete(timer); record(`toque+${delay}ms`); }, delay);
            timers.add(timer);
          }
        }
      }
      if (event.target === touched && Object.hasOwn(received, type)) received[type] += 1;
      // Event type and node identity only. Never read keys, input data or values.
      record(type, event.target);
    }, { capture: true, passive: true });
  }
  listen(window, 'resize', () => record('resize'), { passive: true });
  listen(window, 'focus', () => record('ventana-foco'), { passive: true });
  listen(window, 'blur', () => record('ventana-sin-foco'), { passive: true });
  if (viewport) {
    listen(viewport, 'resize', () => record('vista-resize'), { passive: true });
    listen(viewport, 'scroll', () => record('vista-scroll'), { passive: true });
  }
  const observer = new MutationObserver(records => {
    if (!touched) return;
    const removed = records.some(change => [...change.removedNodes].some(node => node === touched || node.contains(touched)));
    if (removed) record('nodo-retirado', touched);
  });
  const pdfBox = document.getElementById('pdfBox');
  if (pdfBox) observer.observe(pdfBox, { childList: true, subtree: true });
  function stop() {
    if (stopped) return;
    stopped = true;
    listeners.forEach(remove => remove());
    timers.forEach(timer => clearTimeout(timer));
    timers.clear();
    observer.disconnect();
    panel.remove();
    if (window.__firstTapDiagnosticStop === stop) delete window.__firstTapDiagnosticStop;
  }
  window.__firstTapTrace = trace;
  window.__firstTapDiagnosticStop = stop;
  record('listo');
  return stop;
}
