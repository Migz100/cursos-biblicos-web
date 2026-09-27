(function () {
  'use strict';

  const storageKey = 'cursos-biblicos-language';
  let language = 'es';
  document.documentElement.lang = language;

  const attributes = ['aria-label', 'title', 'placeholder'];
  let installGuide;
  let installReturnFocus;
  let nativeLanguage = (window.navigator?.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en';
  let installPrompt;
  let installPending = false;
  let installed = Boolean(window.matchMedia?.('(display-mode: standalone)').matches || window.navigator?.standalone);

  const manifest = document.querySelector('link[rel="manifest"]');
  if (manifest) {
    const params = new URLSearchParams(window.location.search);
    const scopes = params.getAll('s');
    manifest.href = params.has('s')
      ? `/api/manifest?s=${encodeURIComponent(scopes.length === 1 ? scopes[0] : '')}`
      : '/api/manifest';
  }

  function t(es, en, values = {}) {
    return String(language === 'en' ? (en ?? es) : es).replace(/\{([\w]+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
  }

  function apply(root = document) {
    const selector = '[data-ui-es], [data-ui-es-aria-label], [data-ui-es-title], [data-ui-es-placeholder]';
    const elements = [...root.querySelectorAll(selector)];
    if (root.matches?.(selector)) elements.unshift(root);
    for (const element of elements) {
      if (element.hasAttribute('data-ui-es')) {
        element.textContent = t(element.getAttribute('data-ui-es'), element.getAttribute('data-ui-en'));
      }
      for (const attribute of attributes) {
        if (element.hasAttribute(`data-ui-es-${attribute}`)) {
          element.setAttribute(attribute, t(element.getAttribute(`data-ui-es-${attribute}`), element.getAttribute(`data-ui-en-${attribute}`)));
        }
      }
    }
  }

  function setLanguage(next) {
    if ((next !== 'es' && next !== 'en') || next === language) return;
    language = next;
    document.documentElement.lang = language;
    try { window.localStorage.setItem(storageKey, language); } catch (_) {}
    apply();
    updateInstallControls();
    window.dispatchEvent(new CustomEvent('course-language-change', { detail: { language } }));
  }

  function installPlatform() {
    const navigator = window.navigator || {};
    const agent = navigator.userAgent || '';
    const tablet = /iPad/.test(agent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const ios = tablet || /iPhone|iPod/.test(agent);
    if (ios && (/FBAN|FBAV|Instagram|Line\/|MicroMessenger|TikTok|GSA\//i.test(agent) || !/Safari|CriOS|FxiOS|EdgiOS|OPiOS/.test(agent))) return 'ios-in-app';
    if (ios && /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(agent)) return 'ios-browser';
    if (ios) return tablet ? 'ios-tablet' : 'ios-phone';
    if (/Macintosh/.test(agent) && /Safari/.test(agent) && !/Chrome|Chromium|Edg/.test(agent)) return 'mac-safari';
    return /Android/.test(agent) ? 'android' : 'desktop';
  }

  const shareIcon = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 12H7v16h18V12h-4M16 21V3m-6 6 6-6 6 6"/></svg>';
  const homeIcon = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="22" height="22" rx="5"/><path d="M16 10v12m-6-6h12"/></svg>';
  const moreIcon = '<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><circle cx="16" cy="8" r="2"/><circle cx="16" cy="16" r="2"/><circle cx="16" cy="24" r="2"/></svg>';
  const safariIcon = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="16" cy="16" r="13"/><path d="m22 10-4 8-8 4 4-8Z"/><path d="m14 14 4 4M16 3v3m13 10h-3M16 29v-3M3 16h3"/></svg>';
  const pointerIcon = '<svg class="uiInstallPointer" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 25V5m-7 7 7-7 7 7"/></svg>';

  function installStep(number, es, en, descriptionEs, descriptionEn, illustration = '') {
    return `<li class="uiInstallGuideStep">
      <span class="uiInstallStepNumber" aria-hidden="true">${number}</span>
      <div class="uiInstallStepContent"><h3 data-ui-es="${es}" data-ui-en="${en}"></h3>
      <p data-ui-es="${descriptionEs}" data-ui-en="${descriptionEn}"></p>${illustration}</div>
    </li>`;
  }

  function installExample(content, extraClass = '') {
    return `<div class="uiInstallExample ${extraClass}" aria-hidden="true">
      <span class="uiInstallExampleLabel" data-ui-es="Ejemplo" data-ui-en="Example"></span>${content}</div>`;
  }

  function installPhoto(source, crop, width, height, es, en, pointer = '') {
    return `<figure class="uiInstallPhoto"><div class="uiInstallPhotoCrop ${crop}">
      <img src="/assets/install-guide/${source}" width="${width}" height="${height}" loading="eager" decoding="async" alt="" aria-hidden="true">${pointer}</div>
      <figcaption data-ui-es="${es}" data-ui-en="${en}"></figcaption></figure>`;
  }

  function installGuideContent(platform) {
    const ios = platform === 'ios-phone' || platform === 'ios-tablet';
    if (ios) {
      const tablet = platform === 'ios-tablet';
      const native = nativeLanguage === 'es'
        ? { share: 'Compartir', addHome: 'Agregar a Inicio', add: 'Agregar', webApp: 'Abrir como app web', more: 'Más', viewMore: 'Ver más' }
        : { share: 'Share', addHome: 'Add to Home Screen', add: 'Add', webApp: 'Open as Web App', more: 'More', viewMore: 'View More' };
      const toolbar = `<div class="uiInstallBrowserBar"><span class="uiInstallAddress">cursosbiblicos.app</span><span class="uiInstallShareSymbol">${shareIcon}${pointerIcon}</span></div>`;
      const page = '<div class="uiInstallBrowserPage"><span></span><span></span></div>';
      const phoneScreenshot = `<figure class="uiInstallPhoto"><div class="uiInstallScreenshotCrop"><img src="/assets/install-guide/safari-modern-toolbar.png" width="608" height="130" loading="eager" decoding="async" alt="" aria-hidden="true"><span class="uiInstallScreenshotRing" aria-hidden="true"></span></div>
        <figcaption data-ui-es="Toca las tres líneas que señala el círculo." data-ui-en="Tap the three lines marked by the circle."></figcaption></figure>`;
      const shareMenuPhoto = installPhoto('safari-share-action-en.png', 'uiInstallShareAction', 365, 269,
        'Toca la fila que señala el círculo. En esta captura, Compartir aparece como Share.',
        'Tap the Share row marked by the circle.', '<span class="uiInstallPhotoRing" aria-hidden="true"></span>');
      const classicToolbar = installPhoto('safari-classic-toolbar.png', 'uiInstallClassicToolbar', 448, 140, 'Safari clásico: toca la flecha del centro.', 'Classic Safari: tap the arrow in the middle.', '<span class="uiInstallPhotoRing" aria-hidden="true"></span>');
      const menuPhoto = installPhoto(`safari-menu-home-${nativeLanguage}.png`, 'uiInstallHomeMenu', nativeLanguage === 'es' ? 534 : 535, 198, `Busca ${native.addHome}. La flecha azul lo señala.`, `Find ${native.addHome}. The blue arrow points to it.`);
      const morePhoto = tablet
        ? installPhoto(`safari-menu-more-${nativeLanguage}.png`, 'uiInstallMoreMenu', 282, 112,
          `Toca ${native.more} o ${native.viewMore}. El círculo señala el botón en Safari para iPad.`,
          `Tap ${native.more} or ${native.viewMore}. The circle marks the button in Safari on iPad.`, '<span class="uiInstallPhotoRing" aria-hidden="true"></span>')
        : installPhoto('safari-phone-more-en.png', 'uiInstallPhoneMore', 512, 170,
          'Toca la flecha hacia abajo que señala el círculo. En esta captura, Ver más aparece como View More.',
          'Tap the downward arrow marked by the circle, labeled View More.', '<span class="uiInstallPhotoRing" aria-hidden="true"></span>');
      const firstSteps = tablet
        ? installStep(1, `Toca ${native.share}`, `Tap ${native.share}`,
          'Busca el cuadrado con la flecha junto a la barra de dirección.',
          'Look for the square with an arrow beside the address bar.',
          installExample(`<div class="uiInstallBrowser uiInstallBrowserTablet">${toolbar + page}</div>`))
        : installStep(1, 'Abre el menú de Safari', 'Open the Safari menu',
          'Toca las tres líneas junto a la dirección de la página.',
          'Tap the three lines beside the page address.',
          phoneScreenshot + `<details class="uiInstallRealExample"><summary data-ui-es="¿Ves un cuadrado con flecha en lugar de tres líneas?" data-ui-en="Do you see a square with an arrow instead of three lines?"></summary>
            <p data-ui-es="En Safari clásico, toca ese cuadrado con flecha y continúa con el paso 3." data-ui-en="In classic Safari, tap that square with an arrow and continue with step 3."></p>${classicToolbar}</details>`)
          + installStep(2, `Toca ${native.share} en el menú`, `Tap ${native.share} in the menu`,
            `Ahora toca ${native.share}, junto al cuadrado con flecha. Si ya abriste la lista para compartir, continúa con el paso 3.`,
            `Now tap ${native.share}, beside the square with an arrow. If the share sheet is already open, continue with step 3.`,
            shareMenuPhoto);
      return `<p class="uiInstallGuideIntro" data-ui-es="Guarda los cursos junto a tus otras apps. Sigue estos ${tablet ? 4 : 5} pasos en Safari." data-ui-en="Keep your courses beside your other apps. Follow these ${tablet ? 4 : 5} steps in Safari."></p>
        <ol class="uiInstallGuideSteps">
          ${firstSteps}
          ${installStep(tablet ? 2 : 3, `Toca ${native.viewMore}`, `Tap ${native.viewMore}`,
            `Está abajo a la derecha. También puede decir ${native.more}. Si ya ves ${native.addHome}, continúa con el paso ${tablet ? 3 : 4}.`,
            `It is at the bottom right. It may also say ${native.more}. If ${native.addHome} is already visible, continue with step ${tablet ? 3 : 4}.`,
            morePhoto)}
          ${installStep(tablet ? 3 : 4, `Toca ${native.addHome}`, `Tap ${native.addHome}`,
            `En la lista que se abre, desliza hacia arriba y busca ${native.addHome}.`,
            `In the list that opens, swipe up and look for ${native.addHome}.`,
            menuPhoto)}
          ${installStep(tablet ? 4 : 5, `Toca ${native.add}`, `Tap ${native.add}`,
            `Si aparece ${native.webApp}, déjalo activado.`, `If ${native.webApp} appears, leave it on.`,
            installExample(`<div class="uiInstallConfirm"><img src="/assets/app-icon-180.png" width="38" height="38" alt=""><span>Cursos Bíblicos</span><span class="uiInstallAddLabel uiInstallTapTarget">${native.add}</span></div>`))}
        </ol>
        <details class="uiInstallGuideHelp"><summary data-ui-es="¿Los botones se ven diferentes?" data-ui-en="Do the buttons look different?"></summary>
          <label class="uiInstallNativeLabel" for="uiInstallNativeLanguage" data-ui-es="Idioma de los botones de tu dispositivo" data-ui-en="Language of your device’s buttons"></label>
          <select id="uiInstallNativeLanguage" data-ui-native-language><option value="es"${nativeLanguage === 'es' ? ' selected' : ''}>Español</option><option value="en"${nativeLanguage === 'en' ? ' selected' : ''}>English</option></select>
          <p data-ui-es="El menú de Safari puede tener tres líneas o tres puntos (...). Puede estar arriba o abajo. Si ya ves el cuadrado con flecha, tócalo directamente." data-ui-en="Safari’s menu may show three lines or three dots (...). It can be at the top or bottom. If you already see the square with an arrow, tap it directly."></p>
          <p data-ui-es="En el menú de compartir, toca Más o Ver más si aparece. También puede llamarse Añadir a pantalla de inicio. Al terminar, toca Agregar o Añadir." data-ui-en="In the Share menu, tap More or View More if shown. Then choose Add to Home Screen and finish with Add."></p>
        </details>`;
    }
    if (platform === 'ios-in-app' || platform === 'ios-browser') {
      return `<p class="uiInstallGuideIntro" data-ui-es="Primero abre esta página en Safari." data-ui-en="First open this page in Safari."></p>
        <ol class="uiInstallGuideSteps">
          ${installStep(1, 'Copia el enlace', 'Copy the link', 'Toca el botón de abajo.', 'Tap the button below.',
            installExample(`<div class="uiInstallMenuRow uiInstallTapTarget">${shareIcon}<span data-ui-es="Copiar enlace" data-ui-en="Copy link"></span></div>`))}
          ${installStep(2, 'Abre Safari', 'Open Safari', 'Pega el enlace en la barra de dirección y ábrelo.', 'Paste the link in the address bar and open it.',
            installExample(`<div class="uiInstallMenuRow">${safariIcon}<span>Safari</span></div><div class="uiInstallBrowserBar"><span class="uiInstallAddress">cursosbiblicos.app</span></div>`))}
          ${installStep(3, 'Toca Añadir a inicio (instrucciones)', 'Tap Add to home screen (instructions)', 'En nuestra página, este botón te mostrará los pasos.', 'On our page, this button will show you the steps.',
            installExample(`<div class="uiInstallMenuRow uiInstallTapTarget">${homeIcon}<span data-ui-es="Añadir a inicio (instrucciones)" data-ui-en="Add to home screen (instructions)"></span></div>`))}
        </ol>
        <div class="uiInstallCopy"><button type="button" class="uiInstallGuideCopy" data-ui-copy-install-link data-ui-es="Copiar enlace" data-ui-en="Copy link"></button>
          <label for="uiInstallCurrentLink" data-ui-es="Enlace de esta página" data-ui-en="Link to this page"></label>
          <input id="uiInstallCurrentLink" data-ui-install-link type="text" readonly spellcheck="false">
          <p data-ui-copy-status role="status" aria-live="polite"></p>
        </div>`;
    }
    if (platform === 'mac-safari') {
      const labels = nativeLanguage === 'es' ? ['Archivo', 'Agregar al Dock', 'Agregar'] : ['File', 'Add to Dock', 'Add'];
      return `<p class="uiInstallGuideIntro" data-ui-es="Guarda los cursos en el Dock de tu Mac." data-ui-en="Keep your courses in your Mac’s Dock."></p>
        <ol class="uiInstallGuideSteps">
          ${installStep(1, `Abre ${labels[0]}`, `Open ${labels[0]}`, 'Está en el menú de Safari, arriba de la pantalla.', 'Find it in Safari’s menu at the top of the screen.',
            installExample(`<div class="uiInstallMacMenu"><span>Safari</span><span class="uiInstallTapTarget">${labels[0]}</span></div>`))}
          ${installStep(2, `Elige ${labels[1]}`, `Choose ${labels[1]}`, 'Esta opción está disponible desde macOS Sonoma.', 'This option is available in macOS Sonoma or later.',
            installExample(`<div class="uiInstallMenuRow uiInstallTapTarget">${homeIcon}<span>${labels[1]}</span></div>`))}
          ${installStep(3, `Haz clic en ${labels[2]}`, `Click ${labels[2]}`, 'Después podrás abrir los cursos desde el Dock.', 'You can then open your courses from the Dock.',
            installExample(`<div class="uiInstallConfirm"><img src="/assets/app-icon-180.png" width="38" height="38" alt=""><span>Cursos Bíblicos</span><span class="uiInstallAddLabel uiInstallTapTarget">${labels[2]}</span></div>`))}
        </ol>`;
    }
    const android = platform === 'android';
    const labels = nativeLanguage === 'es'
      ? { menu: 'Más', group: android ? 'Instalar y crear acceso directo' : 'Enviar, guardar y compartir', item: android ? 'Instalar' : 'Instalar página como aplicación', confirm: 'Instalar' }
      : { menu: 'More', group: android ? 'Install and create shortcut' : 'Cast, save, and share', item: android ? 'Install' : 'Install page as app', confirm: 'Install' };
    return `<p class="uiInstallGuideIntro" data-ui-es="En Chrome, sigue estos 3 pasos. Para un iPhone o iPad, elige su guía arriba." data-ui-en="In Chrome, follow these 3 steps. For an iPhone or iPad, choose its guide above."></p>
      <ol class="uiInstallGuideSteps">
        ${installStep(1, `Abre ${labels.menu}`, `Open ${labels.menu}`, 'Busca los tres puntos junto a la barra de dirección.', 'Look for the three dots beside the address bar.',
          installExample(`<div class="uiInstallBrowser uiInstallBrowserTablet"><div class="uiInstallBrowserBar"><span class="uiInstallAddress">cursosbiblicos.app</span><span class="uiInstallShareSymbol">${moreIcon}${pointerIcon}</span></div><div class="uiInstallBrowserPage"><span></span><span></span></div></div>`))}
        ${installStep(2, `Elige ${labels.item}`, `Choose ${labels.item}`, `Primero abre ${labels.group}.`, `First open ${labels.group}.`,
          installExample(`<div class="uiInstallMenuStack"><div class="uiInstallMenuRow"><span>${labels.group}</span><span class="uiInstallMenuChevron">›</span></div><div class="uiInstallMenuRow uiInstallTapTarget">${homeIcon}<span>${labels.item}</span></div></div>`))}
        ${installStep(3, `Confirma con ${labels.confirm}`, `Confirm with ${labels.confirm}`, 'Si esta opción no aparece, abre el sitio en Chrome. En Safari para Mac, usa Archivo y Agregar al Dock.', 'If this option is missing, open the site in Chrome. In Safari for Mac, use File and Add to Dock.',
          installExample(`<div class="uiInstallConfirm"><img src="/assets/app-icon-180.png" width="38" height="38" alt=""><span>Cursos Bíblicos</span><span class="uiInstallAddLabel uiInstallTapTarget">${labels.confirm}</span></div>`))}
      </ol>`;
  }

  async function copyInstallLink() {
    const input = installGuide.querySelector('[data-ui-install-link]');
    const status = installGuide.querySelector('[data-ui-copy-status]');
    let copied = false;
    try {
      await window.navigator.clipboard.writeText(input.value);
      copied = true;
    } catch (_) {
      input.focus();
      input.select();
      try { copied = document.execCommand('copy'); } catch (_) {}
    }
    status.setAttribute('data-ui-es', copied ? 'Enlace copiado. Ahora abre Safari.' : 'Mantén pulsado el enlace y elige Copiar.');
    status.setAttribute('data-ui-en', copied ? 'Link copied. Now open Safari.' : 'Touch and hold the link, then choose Copy.');
    apply(status);
  }

  function renderInstallGuide(platform) {
    installGuide.setAttribute('data-platform', platform);
    installGuide.querySelector('.uiInstallGuideInstructions').innerHTML = installGuideContent(platform);
    for (const button of installGuide.querySelectorAll('[data-ui-install-platform]')) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-ui-install-platform') === platform));
    }
    apply(installGuide);
    const link = installGuide.querySelector('[data-ui-install-link]');
    if (link) link.value = window.location.href;
  }

  function openInstallGuide() {
    if (!installGuide) {
      const platform = installPlatform();
      const canChooseDevice = platform !== 'ios-phone' && platform !== 'ios-tablet';
      const deviceChoices = canChooseDevice ? `<div class="uiInstallDevices" role="group" aria-label="Guía para tu dispositivo" data-ui-es-aria-label="Guía para tu dispositivo" data-ui-en-aria-label="Guide for your device">
        <button type="button" data-ui-install-platform="${platform}" aria-pressed="true" data-ui-es="Este dispositivo" data-ui-en="This device"></button>
        <button type="button" data-ui-install-platform="ios-phone" aria-pressed="false">iPhone</button>
        <button type="button" data-ui-install-platform="ios-tablet" aria-pressed="false">iPad</button>
      </div>` : '';
      installGuide = document.createElement('dialog');
      installGuide.className = 'uiInstallGuide';
      installGuide.setAttribute('data-platform', platform);
      installGuide.setAttribute('aria-labelledby', 'uiInstallGuideTitle');
      installGuide.innerHTML = `<div class="uiInstallGuideHead">
        <h2 id="uiInstallGuideTitle" tabindex="-1" data-ui-es="Tus cursos a un toque" data-ui-en="Your courses, one tap away"></h2>
        <button class="uiOptionsClose uiInstallGuideClose" type="button" data-ui-es-aria-label="Cerrar ayuda" data-ui-en-aria-label="Close help"><span aria-hidden="true">×</span></button>
        </div>${deviceChoices}<div class="uiInstallGuideInstructions">${installGuideContent(platform)}</div>
        <button class="uiInstallGuideDone" type="button" data-ui-es="Entendido" data-ui-en="Got it"></button>`;
      for (const close of installGuide.querySelectorAll('.uiInstallGuideClose, .uiInstallGuideDone')) close.addEventListener('click', () => installGuide.close());
      installGuide.addEventListener('change', event => {
        if (!event.target.matches('[data-ui-native-language]')) return;
        nativeLanguage = event.target.value === 'es' ? 'es' : 'en';
        const scrollTop = installGuide.scrollTop;
        renderInstallGuide(installGuide.getAttribute('data-platform'));
        installGuide.querySelector('.uiInstallGuideHelp').open = true;
        installGuide.querySelector('[data-ui-native-language]').focus({ preventScroll: true });
        installGuide.scrollTop = scrollTop;
      });
      installGuide.addEventListener('close', () => {
        if (installReturnFocus?.isConnected) installReturnFocus.focus({ preventScroll: true });
      });
      installGuide.addEventListener('click', event => {
        const device = event.target.closest('[data-ui-install-platform]');
        if (device) {
          renderInstallGuide(device.getAttribute('data-ui-install-platform'));
          device.focus({ preventScroll: true });
          installGuide.scrollTop = 0;
          return;
        }
        if (event.target.closest('[data-ui-copy-install-link]')) return copyInstallLink();
        if (event.target !== installGuide) return;
        const bounds = installGuide.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) installGuide.close();
      });
      document.body.appendChild(installGuide);
    }
    apply(installGuide);
    const link = installGuide.querySelector('[data-ui-install-link]');
    if (link) {
      link.value = window.location.href;
      const status = installGuide.querySelector('[data-ui-copy-status]');
      status.textContent = '';
      status.removeAttribute('data-ui-es');
      status.removeAttribute('data-ui-en');
    }
    if (!installGuide.open) {
      installReturnFocus = document.activeElement;
      installGuide.showModal();
      installGuide.querySelector('h2').focus();
      installGuide.scrollTop = 0;
    }
  }

  function updateInstallControls() {
    for (const button of document.querySelectorAll('[data-ui-install]')) {
      button.disabled = installed || installPending;
      button.textContent = installed ? t('App añadida', 'App added') : installPending
        ? t('Instalando...', 'Installing...') : t('Añadir a inicio (instrucciones)', 'Add to home screen (instructions)');
      if (button.hasAttribute('data-ui-install-home')) button.hidden = installed;
    }

  }

  async function install() {
    if (installed || installPending) return;
    if (!installPrompt) { openInstallGuide(); return; }
    const prompt = installPrompt;
    installPrompt = null;
    installPending = true;
    updateInstallControls();
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      installPending = choice?.outcome === 'accepted' && !installed;
    } catch (_) {
      installPending = false;
      openInstallGuide();
    }
    updateInstallControls();
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    installPending = false;
    updateInstallControls();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    installPrompt = null;
    installPending = false;
    updateInstallControls();
  });
  window.CourseUI = { t, apply, setLanguage, get language() { return language; } };
  apply();
  for (const button of document.querySelectorAll('[data-ui-install]')) button.addEventListener('click', install);
  updateInstallControls();
}());
