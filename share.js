(function(root) {
  'use strict';

  const PUBLIC_ORIGIN = 'https://cursosbiblicos.app';
  const SCOPE_ID = /^[a-f0-9]{64}$/;

  function t(es, en, vars = {}) {
    if (root.CourseUI?.t) return root.CourseUI.t(es, en, vars);
    return es.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`));
  }

  function scopeToken(params) {
    if (!params.has('s')) return null;
    const tokens = params.getAll('s');
    if (tokens.length !== 1 || !SCOPE_ID.test(tokens[0])) throw new TypeError('El enlace de selección no es válido.');
    return tokens[0];
  }

  function shareUrl(input) {
    const source = new URL(input == null ? root.location?.href || '/' : input, PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(source.protocol)) throw new TypeError('Solo se pueden compartir páginas públicas.');
    const token = scopeToken(source.searchParams);
    const path = source.pathname === '/index.html' && !token ? '/' : source.pathname;
    if (!['/', '/index.html', '/curso.html', '/leer.html', '/presentacion.html'].includes(path)) {
      throw new TypeError('Solo se pueden compartir cursos y lecciones.');
    }
    const result = new URL(path, PUBLIC_ORIGIN);
    if (path === '/curso.html') {
      const course = source.searchParams.get('c') || (!token && '1');
      if (!course) throw new TypeError('Falta el curso.');
      result.searchParams.set('c', course);
    }
    if (path === '/leer.html' || path === '/presentacion.html') {
      const course = source.searchParams.get('c');
      const lesson = source.searchParams.get('l');
      if (!course || !lesson) throw new TypeError('Falta el curso o la lección.');
      result.searchParams.set('c', course);
      result.searchParams.set('l', lesson);
      if (!token) result.searchParams.set('solo', '1');
    }
    if (token) result.searchParams.set('s', token);
    return result.href;
  }

  function selectionBody(selection, search = '') {
    if (!Array.isArray(selection) || !selection.length) throw new TypeError('Selecciona al menos una lección.');
    const courseIds = new Set();
    const selected = selection.map(item => {
      if (!item || typeof item.courseId !== 'string' || !item.courseId || courseIds.has(item.courseId) ||
          !Array.isArray(item.lessonIds) || !item.lessonIds.length ||
          item.lessonIds.some(id => typeof id !== 'string' || !id) || new Set(item.lessonIds).size !== item.lessonIds.length) {
        throw new TypeError('La selección no es válida.');
      }
      courseIds.add(item.courseId);
      return { courseId: item.courseId, lessonIds: [...item.lessonIds] };
    });
    const body = { selection: selected };
    const params = new URLSearchParams(search);
    if (params.has('s')) body.parentToken = params.getAll('s').length === 1 ? params.get('s') : '';
    return body;
  }

  function selectionUrl(record, selection) {
    const expected = `${PUBLIC_ORIGIN}/index.html?s=${record?.id}`;
    const lessonCount = selection.reduce((sum, course) => sum + course.lessonIds.length, 0);
    if (!record || typeof record.id !== 'string' || !SCOPE_ID.test(record.id) || record.url !== expected ||
        record.courseCount !== selection.length || record.lessonCount !== lessonCount) {
      throw new TypeError('No se pudo verificar el enlace de la selección.');
    }
    return shareUrl(record.url);
  }

  let dialog;
  let elements;
  let current;
  let previousFocus;
  let unlockScroll;
  let version = 0;
  let picker = null;
  let pickerBusy = false;
  let statusMessage = null;

  function status(es = '', en = es) {
    statusMessage = [es, en];
    elements.status.textContent = t(es, en);
  }

  function updateView() {
    elements.footer.hidden = !picker || elements.pickerPanel.hidden;
    elements.all.hidden = !picker?.pageUrl;
    root.requestAnimationFrame?.(() => picker?.sections.forEach(section => section.updateScroll()));
  }

  function refreshLanguage() {
    if (!elements) return;
    elements.heading.textContent = t('¿Quieres compartirlo con alguien?', 'Want to share with someone?');
    elements.close.setAttribute('aria-label', t('Cerrar', 'Close'));
    elements.all.textContent = picker?.scoped ? t('Compartir esta selección', 'Share this selection') : t('Compartir todos los cursos', 'Share all courses');
    elements.hint.textContent = picker?.pageUrl
      ? t('O elige algunos cursos o lecciones.', 'Or choose specific courses or lessons.')
      : t('Elige cursos completos o abre sus lecciones para elegir solo algunas.', 'Choose whole courses or open their lessons to select just a few.');
    elements.canvas.textContent = t('Usa el botón Compartir para enviar el enlace.', 'Use the Share button to send the link.');
    elements.canvas.setAttribute('aria-label', t('Código QR para abrir el enlace', 'QR code to open the link'));
    elements.caption.textContent = t('Escanea para abrir', 'Scan to open');
    elements.native.textContent = t('Compartir', 'Share');
    if (statusMessage) elements.status.textContent = t(...statusMessage);
    for (const section of picker?.sections || []) {
      section.heading.textContent = section.id === 'lafe' ? t('La Fe de Jesús (PowerPoint)', 'La Fe de Jesús (PowerPoint)') : t('Cursos bíblicos', 'Bible courses');
      section.row.setAttribute('aria-label', section.heading.textContent);
      section.previous.setAttribute('aria-label', t('Cursos anteriores: {section}', 'Previous courses: {section}', { section: section.heading.textContent }));
      section.next.setAttribute('aria-label', t('Siguientes cursos: {section}', 'Next courses: {section}', { section: section.heading.textContent }));
    }
    for (const group of picker?.groups || []) {
      for (const row of group.rows) row.label.textContent = t('Lección {number}', 'Lecture {number}', { number: row.number });
      group.checkbox.setAttribute('aria-label', t('Seleccionar todas las lecciones de {name}', 'Select all lessons in {name}', { name: group.name }));
      group.expand.textContent = group.lessons.hidden ? t('Ver lecciones', 'View lessons') : t('Ocultar lecciones', 'Hide lessons');
      group.expand.setAttribute('aria-label', t(group.lessons.hidden ? 'Mostrar lecciones de {name}' : 'Ocultar lecciones de {name}', group.lessons.hidden ? 'Show lessons in {name}' : 'Hide lessons in {name}', { name: group.name }));
    }
    refreshPickerCounts();
  }

  function node(tag, className, text) {
    const element = root.document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function button(className, text, action) {
    const element = node('button', className, text);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  }

  function lockScroll() {
    const document = root.document;
    const x = root.scrollX;
    const y = root.scrollY;
    const gap = root.innerWidth - document.documentElement.clientWidth;
    const padding = parseFloat(root.getComputedStyle(document.body).paddingRight) || 0;
    const properties = [
      [document.documentElement.style, 'overflow', 'hidden'],
      [document.body.style, 'position', 'fixed'],
      [document.body.style, 'top', `-${y}px`],
      [document.body.style, 'left', `-${x}px`],
      [document.body.style, 'width', '100%'],
      [document.body.style, 'overflow', 'hidden']
    ];
    if (gap > 0) properties.push([document.body.style, 'padding-right', `${padding + gap}px`]);
    const saved = properties.map(([style, key]) => [style, key, style.getPropertyValue(key), style.getPropertyPriority(key)]);
    properties.forEach(([style, key, value]) => style.setProperty(key, value));
    return () => {
      saved.forEach(([style, key, value, priority]) => value ? style.setProperty(key, value, priority) : style.removeProperty(key));
      root.scrollTo(x, y);
    };
  }

  function createDialog() {
    if (dialog) return;
    dialog = node('dialog', 'courseShare');
    dialog.setAttribute('aria-labelledby', 'courseShareHeading');
    dialog.setAttribute('aria-describedby', 'courseShareItem');
    const header = node('div', 'courseShareHeader');
    const heading = node('h2');
    heading.id = 'courseShareHeading';
    const close = button('courseShareClose', '×', () => dialog.close());
    header.append(heading, close);
    const title = node('p', 'courseShareItem');
    title.id = 'courseShareItem';
    const mainPanel = node('div', 'courseShareMain');
    const body = node('div', 'courseShareBody');
    const pickerPanel = node('div', 'courseSharePicker');
    const all = button('courseShareButton primary courseShareAll', '', () => {
      if (!picker?.pageUrl || pickerBusy) return;
      version += 1;
      clearResult();
      displayLink({ url: picker.pageUrl, title: picker.title });
      elements.native.focus({ preventScroll: true });
    });
    const hint = node('p', 'courseShareHint');
    const choices = node('div', 'courseShareChoices');
    const footer = node('div', 'courseShareFooter');
    const count = node('p', 'courseShareCount');
    count.id = 'courseShareCount';
    count.setAttribute('role', 'status');
    count.setAttribute('aria-live', 'polite');
    const create = button('courseShareButton primary courseShareCreate', '', () => createSelection({ selection: selectedLessons(), title: picker.title }, true));
    create.setAttribute('aria-describedby', count.id);
    pickerPanel.append(all, hint, choices);
    footer.append(count, create);
    const result = node('div', 'courseShareResult');
    const qr = node('figure', 'courseShareQr');
    const canvas = node('canvas');
    canvas.setAttribute('role', 'img');
    const caption = node('figcaption');
    qr.append(canvas, caption);
    const actions = node('div', 'courseShareActions');
    const native = button('courseShareButton primary courseShareNative', '', nativeShare);
    actions.append(native);
    result.append(qr, actions);
    const statusElement = node('p', 'courseShareStatus');
    statusElement.setAttribute('role', 'status');
    statusElement.setAttribute('aria-live', 'polite');
    statusElement.setAttribute('aria-atomic', 'true');
    mainPanel.append(pickerPanel, result);
    body.append(mainPanel);
    dialog.append(header, title, body, footer, statusElement);
    root.document.body.append(dialog);
    elements = { heading, title, body, all, hint, footer, pickerPanel, choices, count, create, result, qr, canvas, caption, actions, native, status: statusElement, close };
    root.addEventListener?.('course-language-change', refreshLanguage);
    root.addEventListener?.('resize', () => picker?.sections.forEach(section => section.updateScroll()));
    refreshLanguage();
    updateView();
    let beganOutside = false;
    const outside = event => {
      const rect = dialog.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    };
    dialog.addEventListener('pointerdown', event => { beganOutside = event.target === dialog && outside(event); });
    dialog.addEventListener('click', event => {
      if (beganOutside && event.target === dialog && outside(event)) dialog.close();
      beganOutside = false;
    });
    dialog.addEventListener('close', () => {
      version += 1;
      unlockScroll?.();
      unlockScroll = null;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    });
  }

  function renderQr(value) {
    const qr = root.qrcode(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    const count = qr.getModuleCount();
    const quietZone = 4;
    const scale = 8;
    const canvas = elements.canvas;
    canvas.width = canvas.height = (count + quietZone * 2) * scale;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas no disponible.');
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000';
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (qr.isDark(row, column)) context.fillRect((column + quietZone) * scale, (row + quietZone) * scale, scale, scale);
      }
    }
  }

  async function nativeShare() {
    if (!current || elements.native.disabled) return;
    const request = version;
    const item = current;
    elements.native.disabled = true;
    status();
    try {
      if (typeof root.navigator.share === 'function') {
        try {
          await root.navigator.share(item);
          return;
        } catch (error) {
          if (error?.name === 'AbortError' || request !== version || !dialog.open) return;
        }
      }
      if (!root.navigator.clipboard?.writeText) throw new Error('Portapapeles no disponible.');
      await root.navigator.clipboard.writeText(item.url);
      if (request === version && dialog.open) status('Enlace copiado. Pégalo en tu mensaje.', 'Link copied. Paste it into your message.');
    } catch {
      if (request === version && dialog.open) {
        if (elements.qr.hidden) status('No se pudo compartir. Recarga la página e inténtalo de nuevo.', 'Could not share. Reload the page and try again.');
        else status('Escanea el código QR para abrir y compartir desde otro dispositivo.', 'Scan the QR code to open and share from another device.');
      }
    } finally {
      if (request === version) elements.native.disabled = false;
    }
  }

  function clearResult() {
    current = null;
    elements.result.hidden = true;
    elements.canvas.width = elements.canvas.height = 0;
  }

  function showDialog() {
    if (!dialog.open) {
      previousFocus = root.document.activeElement;
      unlockScroll = lockScroll();
      dialog.showModal();
    }
    dialog.scrollTop = 0;
    elements.body.scrollTop = 0;
    updateView();
    elements.close.focus({ preventScroll: true });
    picker?.sections.forEach(section => section.updateScroll());
    root.requestAnimationFrame?.(() => picker?.sections.forEach(section => section.updateScroll()));
  }

  function displayLink(options) {
    current = { url: shareUrl(options.url), title: String(options.title || root.document.title || 'Cursos Bíblicos') };
    if (options.text) current.text = String(options.text);
    elements.title.textContent = current.title;
    status();
    elements.native.disabled = false;
    elements.pickerPanel.hidden = true;
    elements.result.hidden = elements.qr.hidden = false;
    try {
      renderQr(current.url);
    } catch {
      elements.qr.hidden = true;
      status('No se pudo crear el QR. Usa el botón Compartir.', 'Could not create the QR code. Use the Share button.');
    }
    dialog.scrollTop = 0;
    elements.body.scrollTop = 0;
    updateView();
  }

  function open(options = {}) {
    createDialog();
    version += 1;
    picker = null;
    clearResult();
    elements.pickerPanel.hidden = true;
    updateView();
    elements.title.textContent = String(options.title || root.document.title || 'Cursos Bíblicos');
    try {
      displayLink(options);
    } catch {
      status('No se puede compartir esta página. Abre un curso o una lección e inténtalo de nuevo.', 'This page cannot be shared. Open a course or lesson and try again.');
    }
    showDialog();
    return Boolean(current);
  }

  function selectedLessons() {
    return (picker?.groups || []).map(group => ({ courseId: group.id, lessonIds: group.rows.filter(row => row.input.checked).map(row => row.id) }))
      .filter(group => group.lessonIds.length);
  }

  function setPickerBusy(busy) {
    pickerBusy = busy;
    elements.all.disabled = busy;
    elements.create.disabled = busy || !picker?.lessonCount;
    elements.create.textContent = busy ? t('Creando enlace...', 'Creating link...') : t('Crear enlace', 'Create link');
    for (const group of picker?.groups || []) {
      group.checkbox.disabled = busy || !group.rows.length;
      group.rows.forEach(row => { row.input.disabled = busy; });
    }
  }

  function refreshPickerCounts() {
    const selection = selectedLessons();
    const lessonCount = selection.reduce((sum, course) => sum + course.lessonIds.length, 0);
    if (picker) picker.lessonCount = lessonCount;
    for (const group of picker?.groups || []) {
      const selected = group.rows.filter(row => row.input.checked).length;
      group.checkbox.checked = selected > 0 && selected === group.rows.length;
      group.checkbox.indeterminate = selected > 0 && selected < group.rows.length;
      group.note.textContent = t('{selected} de {total} lecciones', '{selected} of {total} lessons', { selected, total: group.rows.length });
    }
    elements.count.textContent = lessonCount === 0 ? t('0 lecciones seleccionadas', '0 lessons selected') :
      t(lessonCount === 1 ? '{lessons} lección seleccionada' : '{lessons} lecciones seleccionadas', lessonCount === 1 ? '{lessons} lesson selected' : '{lessons} lessons selected', { lessons: lessonCount }) +
      t(selection.length === 1 ? ' en {courses} curso' : ' en {courses} cursos', selection.length === 1 ? ' in {courses} course' : ' in {courses} courses', { courses: selection.length });
    setPickerBusy(pickerBusy);
  }

  function updatePicker() {
    version += 1;
    clearResult();
    pickerBusy = false;
    refreshPickerCounts();
    status();
  }

  function createCourseSection(id) {
    const section = { id, groups: [] };
    const wrap = node('section', 'courseShareSection');
    const header = node('div', 'courseShareSectionHeader');
    section.heading = node('h3');
    const controls = node('div', 'courseShareScrollControls');
    section.row = node('div', 'courseShareCourseRow');
    section.row.id = `courseShareRow-${id}`;
    section.row.tabIndex = 0;
    section.row.setAttribute('role', 'group');
    const scroll = direction => section.row.scrollBy({ left: direction * Math.max(200, section.row.clientWidth * 0.8), behavior: root.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    section.previous = button('courseShareScroll', '', () => scroll(-1));
    section.next = button('courseShareScroll', '', () => scroll(1));
    section.previous.setAttribute('data-direction', 'previous');
    section.next.setAttribute('data-direction', 'next');
    section.previous.disabled = section.next.disabled = true;
    for (const control of [section.previous, section.next]) control.setAttribute('aria-controls', section.row.id);
    section.updateScroll = () => {
      section.previous.disabled = section.row.scrollLeft <= 1;
      section.next.disabled = section.row.scrollLeft + section.row.clientWidth >= section.row.scrollWidth - 1;
    };
    section.row.addEventListener('scroll', section.updateScroll, { passive: true });
    section.row.addEventListener('keydown', event => {
      if (event.target !== section.row || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home' || event.key === 'End') section.row.scrollTo({ left: event.key === 'Home' ? 0 : section.row.scrollWidth, behavior: 'auto' });
      else scroll(event.key === 'ArrowLeft' ? -1 : 1);
    });
    controls.append(section.previous, section.next);
    header.append(section.heading, controls);
    section.details = node('div', 'courseShareSectionDetails');
    wrap.append(header, section.row, section.details);
    elements.choices.append(wrap);
    return section;
  }

  function select(options = {}) {
    createDialog();
    version += 1;
    clearResult();
    picker = null;
    pickerBusy = false;
    elements.choices.replaceChildren();
    elements.pickerPanel.hidden = true;
    elements.title.textContent = String(options.title || root.document.title || 'Cursos Bíblicos');
    status();
    try {
      if (!Array.isArray(options.courses) || !options.courses.length) throw new TypeError('No hay cursos disponibles.');
      const courseIds = new Set();
      const token = options.sharePage ? scopeToken(new URLSearchParams(root.location?.search || '')) : null;
      picker = { title: elements.title.textContent, groups: [], sections: [], lessonCount: 0,
        pageUrl: options.sharePage ? shareUrl(token ? `/index.html?s=${token}` : '/') : null, scoped: Boolean(token) };
      for (const [index, course] of options.courses.entries()) {
        if (!course || typeof course.id !== 'string' || !course.id || courseIds.has(course.id) || !Array.isArray(course.lessons)) throw new TypeError('Curso no válido.');
        courseIds.add(course.id);
        const lessonIds = new Set();
        const sectionId = course.section === 'lafe' ? 'lafe' : 'cursos';
        let section = picker.sections.find(item => item.id === sectionId);
        if (!section) {
          section = createCourseSection(sectionId);
          picker.sections.push(section);
        }
        const group = { id: course.id, name: course.name || t('Curso', 'Course'), checkbox: node('input'), rows: [], note: node('small') };
        const card = node('div', 'courseShareGroup');
        card.setAttribute('role', 'group');
        card.setAttribute('aria-label', group.name);
        const label = node('label', 'courseShareCheck courseShareCourseCheck');
        const name = node('span', 'courseShareCourseName');
        name.append(node('span', '', group.name), group.note);
        group.checkbox.type = 'checkbox';
        label.append(group.checkbox, name);
        group.lessons = node('div', 'courseShareLessons');
        group.lessons.id = `courseShareLessons${index}`;
        group.lessons.hidden = true;
        group.lessons.setAttribute('role', 'group');
        group.lessons.setAttribute('aria-labelledby', `courseShareLessonHeading${index}`);
        const lessonHeading = node('h4', 'courseShareLessonHeading', group.name);
        lessonHeading.id = `courseShareLessonHeading${index}`;
        group.lessons.append(lessonHeading);
        group.expand = button('courseShareExpand', '', () => {
          const opening = group.lessons.hidden;
          for (const other of section.groups) {
            other.lessons.hidden = other !== group || !opening;
            other.expand.setAttribute('aria-expanded', String(!other.lessons.hidden));
            other.card.classList.toggle('expanded', !other.lessons.hidden);
          }
          refreshLanguage();
        });
        group.expand.setAttribute('aria-controls', group.lessons.id);
        group.expand.setAttribute('aria-expanded', 'false');
        for (const [lessonIndex, lesson] of course.lessons.entries()) {
          if (!lesson || typeof lesson.id !== 'string' || !lesson.id || lessonIds.has(lesson.id)) throw new TypeError('Lección no válida.');
          lessonIds.add(lesson.id);
          const row = { id: lesson.id, number: lesson.lessonNumber ?? lessonIndex + 1, input: node('input'), label: node('span') };
          row.input.type = 'checkbox';
          row.input.addEventListener('change', updatePicker);
          const lessonLabel = node('label', 'courseShareCheck');
          lessonLabel.append(row.input, row.label);
          group.lessons.append(lessonLabel);
          group.rows.push(row);
        }
        group.checkbox.addEventListener('change', () => {
          group.rows.forEach(row => { row.input.checked = group.checkbox.checked; });
          updatePicker();
        });
        group.card = card;
        card.append(label, group.expand);
        section.row.append(card);
        section.details.append(group.lessons);
        section.groups.push(group);
        picker.groups.push(group);
      }
      updatePicker();
      refreshLanguage();
      elements.pickerPanel.hidden = false;
    } catch {
      picker = null;
      elements.choices.replaceChildren();
      status('No hay cursos o lecciones disponibles para seleccionar. Recarga la página e inténtalo de nuevo.', 'No courses or lessons are available to select. Reload the page and try again.');
    }
    updateView();
    showDialog();
    return Boolean(picker);
  }

  async function createSelection(options, fromPicker) {
    if (fromPicker && pickerBusy) return false;
    createDialog();
    const request = ++version;
    clearResult();
    elements.pickerPanel.hidden = !fromPicker;
    updateView();
    elements.title.textContent = String(options.title || root.document.title || 'Cursos Bíblicos');
    status('Creando el enlace de tu selección...', 'Creating your selection link...');
    if (fromPicker) setPickerBusy(true);
    showDialog();
    try {
      const body = selectionBody(options.selection, root.location?.search || '');
      const response = await root.fetch('/api/share', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error('No se pudo crear el enlace.');
      const record = await response.json();
      if (request !== version || !dialog.open) return false;
      displayLink({ url: selectionUrl(record, body.selection), title: elements.title.textContent, text: options.text });
      elements.native.focus({ preventScroll: true });
      return true;
    } catch {
      if (request !== version || !dialog.open) return false;
      clearResult();
      status(fromPicker ? 'No se pudo crear el enlace. Tu selección se conserva. Inténtalo de nuevo.' :
        'No se pudo crear el enlace. Cierra esta ventana e inténtalo de nuevo.', fromPicker ? 'Could not create the link. Your selection is saved. Try again.' : 'Could not create the link. Close this window and try again.');
      return false;
    } finally {
      if (request === version && fromPicker) setPickerBusy(false);
    }
  }

  function shareSelection(options = {}) {
    picker = null;
    return createSelection(options, false);
  }

  const api = { url: shareUrl, open, select, shareSelection };
  if (typeof module !== 'undefined' && module.exports) module.exports = { ...api, selectionBody, selectionUrl };
  else root.CourseShare = api;
})(typeof window !== 'undefined' ? window : globalThis);
