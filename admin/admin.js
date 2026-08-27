const LESSON_ACCEPT = '.pdf,.pages,.ppt,.pptx,.ppsx,application/pdf,application/vnd.apple.pages,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.presentationml.slideshow';
const naturalSort = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

let catalog = null;
let csrfToken = '';
let toastTimer = null;
let courseFormBusy = false;
let coverObjectUrl = '';
let removeCoverRequested = false;

const statusElement = document.getElementById('status');
const manager = document.getElementById('courseManager');

function setStatus(message, error = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle('error', error);
}

function button(label, className, title, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.title = title;
  element.setAttribute('aria-label', title);
  element.onclick = onClick;
  return element;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || 'No se pudo completar la acción.');
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  return data;
}

async function refreshCatalog() {
  catalog = await jsonRequest('/api/catalog');
  render();
}

async function renewEditingSession() {
  const session = await jsonRequest('/api/manage/session');
  csrfToken = session.csrfToken;
}

async function csrfRequest(url, body, retry = true) {
  try {
    return await jsonRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (retry && error.code === 'CSRF_DENIED') {
      await renewEditingSession();
      return csrfRequest(url, body, false);
    }
    throw error;
  }
}

async function mutate(action) {
  setStatus('Guardando cambio...');
  try {
    const result = await csrfRequest('/api/manage/catalog', { ...action, baseRevision: catalog.revision });
    catalog = result.manifest;
    render();
    setStatus('Cambio guardado para todos.');
    if (result.undoTrashId) showUndo(result.undoTrashId, action.type);
    return result;
  } catch (error) {
    if (error.status === 409 && error.code === 'REVISION_CONFLICT') {
      for (const id of ['courseDialog', 'listDialog']) {
        const dialog = document.getElementById(id);
        if (dialog.open) dialog.close();
      }
      await refreshCatalog();
    }
    setStatus(error.message, true);
    throw error;
  }
}

function showUndo(trashId, type) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = 'Se movió a la papelera.';
  const undo = document.getElementById('toastUndo');
  undo.onclick = async () => {
    toast.hidden = true;
    await mutate({ type: type === 'course.remove' ? 'course.restore' : 'lesson.restore', trashId }).catch(() => {});
  };
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 10000);
}

function clearCoverObjectUrl() {
  if (coverObjectUrl) URL.revokeObjectURL(coverObjectUrl);
  coverObjectUrl = '';
}

function showCoverPreview(url) {
  const preview = document.getElementById('coverPreview');
  const image = document.getElementById('coverPreviewImage');
  if (!url) {
    preview.hidden = true;
    image.removeAttribute('src');
    return;
  }
  image.src = url;
  preview.hidden = false;
}

function openCourseDialog(course = null) {
  clearCoverObjectUrl();
  removeCoverRequested = false;
  document.getElementById('courseDialogTitle').textContent = course ? 'Editar curso' : 'Agregar curso';
  document.getElementById('editingCourseId').value = course?.id || '';
  document.getElementById('courseName').value = course?.name || '';
  document.getElementById('courseShort').value = course?.short || '';
  document.getElementById('courseSection').value = course?.section || 'cursos';
  document.getElementById('courseColor').value = course?.color || '#0071E3';
  document.getElementById('courseFiles').value = '';
  document.getElementById('courseCover').value = '';
  document.getElementById('courseFilesLabel').hidden = Boolean(course);
  showCoverPreview(course?.coverUrl || '');
  document.getElementById('courseDialog').showModal();
}

async function removeCourse(course) {
  await mutate({ type: 'course.remove', courseId: course.id }).catch(() => {});
}

async function removeLesson(course, lesson) {
  await mutate({ type: 'lesson.remove', courseId: course.id, lessonId: lesson.id }).catch(() => {});
}

async function renameLesson(course, lesson) {
  const title = prompt('Nuevo título de la lección:', lesson.title);
  if (!title || title.trim() === lesson.title) return;
  await mutate({ type: 'lesson.rename', courseId: course.id, lessonId: lesson.id, title }).catch(() => {});
}

function chooseReplacement(course, lesson) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = LESSON_ACCEPT;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let upload = null;
    try {
      upload = await uploadFile(file, `Subiendo reemplazo para ${lesson.title}...`);
      await mutate({ type: 'lesson.replace', courseId: course.id, lessonId: lesson.id, assetToken: upload.assetToken });
      if (upload.conversionStatus === 'needs-pdf') {
        setStatus('El archivo Pages quedó guardado. Para leerlo aquí, reemplázalo después por un PDF exportado desde Pages.');
      }
    } catch (error) {
      await discardUpload(upload?.assetToken);
      setStatus(error.message, true);
    }
  };
  input.click();
}

async function uploadFile(file, message, kind = 'lesson') {
  setStatus(message || `Subiendo ${file.name}...`);
  const prepared = await csrfRequest('/api/manage/upload', {
    action: 'prepare', filename: file.name, contentType: file.type, size: file.size, kind
  });
  const upload = await fetch(prepared.presignedUrl, {
    method: 'PUT', headers: { 'Content-Type': prepared.contentType }, body: file
  });
  if (!upload.ok) throw new Error(`No se pudo subir ${file.name}.`);
  return csrfRequest('/api/manage/upload', { action: 'finalize', receipt: prepared.receipt });
}

async function discardUpload(assetToken) {
  if (!assetToken) return;
  await csrfRequest('/api/manage/upload', { action: 'discard', assetToken }).catch(() => {});
}

function sortedFiles(files) {
  return [...files].sort((a, b) => naturalSort.compare(a.name, b.name));
}

async function addFiles(course, files) {
  const selected = sortedFiles(files);
  if (!selected.length) return;
  let needsPdf = false;
  for (let index = 0; index < selected.length; index += 1) {
    const file = selected[index];
    const upload = await uploadFile(file, `Subiendo ${index + 1} de ${selected.length}: ${file.name}`);
    try {
      await mutate({ type: 'lesson.add', courseId: course.id, title: upload.suggestedTitle, assetToken: upload.assetToken });
      needsPdf ||= upload.conversionStatus === 'needs-pdf';
      course = catalog.courses.find(item => item.id === course.id) || course;
    } catch (error) {
      await discardUpload(upload.assetToken);
      throw error;
    }
  }
  setStatus(needsPdf
    ? 'Lecciones agregadas. Un archivo Pages no traía PDF interno y quedó marcado para reemplazarlo por PDF.'
    : `${selected.length} ${selected.length === 1 ? 'lección agregada' : 'lecciones agregadas'} para todos.`);
}

async function uploadFilesOnly(files) {
  const selected = sortedFiles(files);
  const lessons = [];
  try {
    for (let index = 0; index < selected.length; index += 1) {
      const file = selected[index];
      const upload = await uploadFile(file, `Preparando curso, archivo ${index + 1} de ${selected.length}: ${file.name}`);
      lessons.push({ title: upload.suggestedTitle, assetToken: upload.assetToken, conversionStatus: upload.conversionStatus });
    }
  } catch (error) {
    await Promise.all(lessons.map(item => discardUpload(item.assetToken)));
    throw error;
  }
  return lessons;
}

async function imageFromFile(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file); } catch {}
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('No se pudo leer esta foto. Elige otra desde Fotos o Archivos.'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function normalizedCoverFile(file) {
  const image = await imageFromFile(file);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, 1800 / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  if (typeof image.close === 'function') image.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  if (!blob) throw new Error('No se pudo preparar esta foto. Elige otra imagen.');
  const stem = file.name.replace(/\.[^.]+$/, '').slice(0, 100) || 'portada';
  return new File([blob], `${stem}.jpg`, { type: 'image/jpeg' });
}

function sortableHandle(item, container, selector, label, onDrop) {
  const handle = button('Mover', 'dragHandle', label, () => {});
  let active = false;
  let pointerId = null;
  let originalIndex = -1;
  let startY = 0;
  let timer = null;
  let keyboard = false;
  const items = () => [...container.querySelectorAll(`:scope > ${selector}`)];
  const activate = () => {
    if (active) return;
    active = true;
    item.classList.add('dragging');
    document.body.classList.add('isSorting');
    handle.setAttribute('aria-pressed', 'true');
    setStatus('Arrastra al lugar deseado y suelta.');
  };
  const finish = async (cancel = false) => {
    clearTimeout(timer);
    if (!active && !keyboard) return;
    const newIndex = items().indexOf(item);
    active = false;
    keyboard = false;
    pointerId = null;
    item.classList.remove('dragging');
    document.body.classList.remove('isSorting');
    handle.removeAttribute('aria-pressed');
    if (cancel) {
      render();
      setStatus('Movimiento cancelado.');
      return;
    }
    if (newIndex !== originalIndex) await onDrop(newIndex);
    else setStatus('El orden no cambió.');
  };
  handle.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerId = event.pointerId;
    originalIndex = items().indexOf(item);
    startY = event.clientY;
    handle.setPointerCapture?.(pointerId);
    timer = setTimeout(activate, 180);
  });
  handle.addEventListener('pointermove', event => {
    if (event.pointerId !== pointerId) return;
    if (!active && Math.abs(event.clientY - startY) > 6) activate();
    if (!active) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(selector);
    if (target && target !== item && target.parentElement === container) {
      const rect = target.getBoundingClientRect();
      container.insertBefore(item, event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
    }
    const edge = 90;
    if (event.clientY < edge) window.scrollBy(0, -18);
    else if (event.clientY > window.innerHeight - edge) window.scrollBy(0, 18);
  });
  const pointerFinish = event => {
    if (event.pointerId !== pointerId) return;
    finish(false).catch(error => setStatus(error.message, true));
  };
  handle.addEventListener('pointerup', pointerFinish);
  handle.addEventListener('pointercancel', event => {
    if (event.pointerId === pointerId) finish(true).catch(() => {});
  });
  handle.addEventListener('keydown', event => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (!keyboard) {
        keyboard = true;
        originalIndex = items().indexOf(item);
        activate();
        setStatus('Usa las flechas para mover. Presiona Enter para guardar.');
      } else finish(false).catch(error => setStatus(error.message, true));
      return;
    }
    if (!keyboard) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(true).catch(() => {});
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const list = items();
    const index = list.indexOf(item);
    if (event.key === 'ArrowUp' && index > 0) container.insertBefore(item, list[index - 1]);
    if (event.key === 'ArrowDown' && index < list.length - 1) container.insertBefore(list[index + 1], item);
  });
  return handle;
}

function lessonKind(lesson) {
  if (lesson.sourceType === 'pages') return 'PDF + PAGES';
  if (lesson.type === 'pages') return 'PAGES · FALTA PDF';
  return lesson.type.toUpperCase();
}

function readableTextColor(background) {
  const match = String(background || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return '#000';
  const channels = [0, 2, 4].map(offset => parseInt(match[1].slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;
  return blackContrast >= whiteContrast ? '#000' : '#fff';
}

function lessonLine(course, lesson, index, container) {
  const line = document.createElement('div');
  line.className = 'lessonLine';
  line.dataset.id = lesson.id;
  const handle = sortableHandle(line, container, '.lessonLine', `Mantén presionado para mover ${lesson.title}`, toIndex =>
    mutate({ type: 'lesson.move', courseId: course.id, lessonId: lesson.id, toIndex })
  );
  const number = document.createElement('span');
  number.className = 'lessonIndex';
  number.textContent = String(index + 1);
  const title = document.createElement('span');
  title.className = 'lessonTitle';
  title.textContent = lesson.title;
  const type = document.createElement('span');
  type.className = `lessonType${lesson.type === 'pages' ? ' warning' : ''}`;
  type.textContent = lessonKind(lesson);
  const actions = document.createElement('div');
  actions.className = 'lessonActions';
  actions.append(
    button('Renombrar', 'smallAction', `Renombrar ${lesson.title}`, () => renameLesson(course, lesson)),
    button('Reemplazar', 'smallAction', `Reemplazar archivo de ${lesson.title}`, () => chooseReplacement(course, lesson)),
    button('Quitar', 'dangerAction smallDanger', `Quitar ${lesson.title}`, () => removeLesson(course, lesson))
  );
  if (lesson.sourceType === 'pages' && lesson.sourceDownloadUrl) {
    const original = document.createElement('a');
    original.className = 'smallAction sourceLink';
    original.href = lesson.sourceDownloadUrl;
    original.textContent = 'Pages original';
    original.setAttribute('download', lesson.sourceOriginalName || 'original.pages');
    actions.prepend(original);
  }
  line.append(handle, number, title, type, actions);
  return line;
}

function courseCard(course) {
  const article = document.createElement('article');
  article.className = 'manageCourse';
  article.dataset.id = course.id;
  const head = document.createElement('div');
  head.className = 'manageCourseHead';
  const handle = sortableHandle(article, manager, '.manageCourse', `Mantén presionado para mover ${course.name}`, toIndex =>
    mutate({ type: 'course.move', courseId: course.id, toIndex })
  );
  const badge = document.createElement('div');
  badge.className = 'manageBadge';
  if (course.coverUrl) {
    badge.classList.add('hasImage');
    badge.style.backgroundImage = `url("${String(course.coverUrl).replace(/"/g, '%22')}")`;
  } else {
    badge.textContent = course.short;
    badge.style.background = course.color;
    badge.style.color = readableTextColor(course.color);
  }
  const copy = document.createElement('div');
  copy.className = 'manageCourseName';
  const name = document.createElement('strong');
  name.textContent = course.name;
  const meta = document.createElement('span');
  meta.textContent = `${course.lessons.length} lecciones · ${course.section === 'lafe' ? 'PowerPoint' : 'Cursos Bíblicos'}`;
  copy.append(name, meta);
  const tools = document.createElement('div');
  tools.className = 'manageTools';
  tools.append(
    button('Editar', 'secondaryAction', `Editar ${course.name}`, () => openCourseDialog(course)),
    button('Quitar', 'dangerAction', `Quitar ${course.name}`, () => removeCourse(course))
  );
  head.append(handle, badge, copy, tools);

  const lessonDetails = document.createElement('details');
  lessonDetails.className = 'lessonDetails';
  const lessonSummary = document.createElement('summary');
  lessonSummary.textContent = `Administrar ${course.lessons.length} ${course.lessons.length === 1 ? 'lección' : 'lecciones'}`;
  const lessons = document.createElement('div');
  lessons.className = 'lessonManager';
  course.lessons.forEach((lesson, lessonIndex) => lessons.appendChild(lessonLine(course, lesson, lessonIndex, lessons)));
  const add = document.createElement('div');
  add.className = 'addLessons';
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.id = `files-${course.id}`;
  input.accept = LESSON_ACCEPT;
  const picker = document.createElement('label');
  picker.className = 'filePickerLabel';
  picker.htmlFor = input.id;
  picker.textContent = 'Agregar PDF, Pages o PowerPoint';
  input.onchange = async () => {
    input.disabled = true;
    try { await addFiles(course, input.files); }
    catch (error) { setStatus(error.message, true); }
    finally { input.disabled = false; input.value = ''; }
  };
  add.append(input, picker);
  lessons.appendChild(add);
  lessonDetails.append(lessonSummary, lessons);
  article.append(head, lessonDetails);
  return article;
}

function render() {
  manager.replaceChildren();
  catalog.courses.forEach(course => manager.appendChild(courseCard(course)));
}

function restoreLine(entry) {
  const line = document.createElement('div');
  line.className = 'restoreLine';
  const copy = document.createElement('div');
  copy.className = 'restoreCopy';
  const name = document.createElement('strong');
  name.textContent = entry.item.name || entry.item.title || entry.item.originalName || 'Portada anterior';
  const detail = document.createElement('span');
  detail.textContent = entry.kind === 'course' ? 'Curso' : entry.kind === 'lesson' ? 'Lección' : entry.kind === 'replaced_cover' ? 'Portada reemplazada' : 'Archivo reemplazado';
  copy.append(name, detail);
  const actionType = entry.kind === 'course' ? 'course.restore' : entry.kind === 'lesson' ? 'lesson.restore' : entry.kind === 'replaced_cover' ? 'cover.restore' : 'asset.restore';
  line.append(copy, button('Restaurar', 'secondaryAction', `Restaurar ${name.textContent}`, () => {
    mutate({ type: actionType, trashId: entry.id }).then(openTrash).catch(() => {});
  }));
  return line;
}

function openTrash() {
  document.getElementById('listDialogTitle').textContent = 'Papelera';
  const body = document.getElementById('listDialogBody');
  body.replaceChildren();
  if (!catalog.trash.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'La papelera está vacía.';
    body.appendChild(empty);
  } else catalog.trash.forEach(entry => body.appendChild(restoreLine(entry)));
  const dialog = document.getElementById('listDialog');
  if (!dialog.open) dialog.showModal();
}

async function openHistory() {
  document.getElementById('listDialogTitle').textContent = 'Historial de cambios';
  const body = document.getElementById('listDialogBody');
  body.replaceChildren();
  const { entries } = await jsonRequest('/api/manage/history');
  entries.forEach((entry, index) => {
    const line = document.createElement('div');
    line.className = 'restoreLine';
    const copy = document.createElement('div');
    copy.className = 'restoreCopy';
    const label = document.createElement('strong');
    label.textContent = entry.label;
    const date = document.createElement('span');
    date.textContent = entry.updatedAt ? new Date(entry.updatedAt).toLocaleString('es') : 'Versión original';
    copy.append(label, date);
    line.appendChild(copy);
    if (index > 0) line.appendChild(button('Volver aquí', 'secondaryAction', `Restaurar ${entry.label}`, async () => {
      const typed = prompt('Esto restaurará todo el catálogo a esta versión. Para confirmar, escribe RESTAURAR:');
      if (typed !== 'RESTAURAR') { setStatus('No se restauró el catálogo.', true); return; }
      await mutate({ type: 'catalog.rollback', targetRevision: entry.revision, confirmText: typed }).catch(() => {});
      document.getElementById('listDialog').close();
    }));
    body.appendChild(line);
  });
  const dialog = document.getElementById('listDialog');
  if (!dialog.open) dialog.showModal();
}

function auditSection(title, items) {
  const section = document.createElement('section');
  section.className = 'auditSection';
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.appendChild(heading);
  items.forEach(item => section.appendChild(item));
  return section;
}

async function openAudit() {
  document.getElementById('listDialogTitle').textContent = 'Revisión del contenido';
  const body = document.getElementById('listDialogBody');
  body.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'empty';
  loading.textContent = 'Revisando archivos y orden...';
  body.appendChild(loading);
  const dialog = document.getElementById('listDialog');
  if (!dialog.open) dialog.showModal();
  const audit = await jsonRequest('/api/manage/audit');
  body.replaceChildren();
  const summary = document.createElement('div');
  summary.className = `auditSummary ${audit.healthy ? 'healthy' : 'needsAttention'}`;
  const summaryTitle = document.createElement('strong');
  summaryTitle.textContent = audit.healthy ? 'Todo está organizado' : 'Hay puntos por revisar';
  const summaryCopy = document.createElement('span');
  summaryCopy.textContent = `${audit.summary.courses} cursos · ${audit.summary.lessons} lecciones · ${audit.summary.fingerprinted} archivos comparados`;
  summary.append(summaryTitle, summaryCopy);
  body.appendChild(summary);

  if (audit.ordering.length) {
    body.appendChild(auditSection('Orden de lecciones', audit.ordering.map(issue => {
      const line = document.createElement('div');
      line.className = 'auditIssue';
      const copy = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = issue.courseName;
      const span = document.createElement('span');
      span.textContent = `Ahora: ${issue.current.join(', ')} · Correcto: ${issue.suggested.join(', ')}`;
      copy.append(strong, span);
      line.append(copy, button('Ordenar ahora', 'primaryAction compactAction', `Ordenar ${issue.courseName}`, async () => {
        await mutate({ type: 'course.reorderLessons', courseId: issue.courseId, lessonIds: issue.suggestedLessonIds });
        await openAudit();
      }));
      return line;
    })));
  }

  if (audit.duplicates.length) {
    body.appendChild(auditSection('Contenido repetido', audit.duplicates.map(group => {
      const line = document.createElement('div');
      line.className = 'auditIssue stacked';
      const strong = document.createElement('strong');
      strong.textContent = group.kind === 'exact' ? 'Archivos idénticos' : 'Mismo texto o contenido';
      const span = document.createElement('span');
      span.textContent = group.lessons.map(item => `${item.courseName}: ${item.title}`).join(' · ');
      line.append(strong, span);
      return line;
    })));
  }

  if (audit.pagesPending.length) {
    body.appendChild(auditSection('Pages que todavía necesitan PDF', audit.pagesPending.map(item => {
      const line = document.createElement('div');
      line.className = 'auditIssue stacked';
      const strong = document.createElement('strong');
      strong.textContent = item.title;
      const span = document.createElement('span');
      span.textContent = item.courseName;
      line.append(strong, span);
      return line;
    })));
  }

  if (audit.healthy) {
    const note = document.createElement('p');
    note.className = 'auditHealthyNote';
    note.textContent = 'No se encontraron duplicados, archivos Pages pendientes ni lecciones fuera de orden.';
    body.appendChild(note);
  }
}

document.getElementById('courseForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (courseFormBusy) return;
  courseFormBusy = true;
  const saveButton = document.getElementById('saveCourse');
  saveButton.disabled = true;
  saveButton.textContent = 'Guardando...';
  const id = document.getElementById('editingCourseId').value;
  const fields = {
    name: document.getElementById('courseName').value,
    short: document.getElementById('courseShort').value,
    section: document.getElementById('courseSection').value,
    color: document.getElementById('courseColor').value
  };
  const files = [...document.getElementById('courseFiles').files];
  const coverInput = document.getElementById('courseCover');
  let uploadedLessons = [];
  let uploadedCover = null;
  try {
    if (coverInput.files?.[0]) {
      const coverFile = await normalizedCoverFile(coverInput.files[0]);
      uploadedCover = await uploadFile(coverFile, 'Preparando la portada...', 'cover');
    }
    if (id) {
      await mutate({
        type: 'course.update', courseId: id, ...fields,
        ...(uploadedCover ? { coverAssetToken: uploadedCover.assetToken } : {}),
        removeCover: removeCoverRequested && !uploadedCover
      });
    } else {
      uploadedLessons = files.length ? await uploadFilesOnly(files) : [];
      await mutate({
        type: 'course.add', ...fields,
        lessons: uploadedLessons,
        ...(uploadedCover ? { coverAssetToken: uploadedCover.assetToken } : {})
      });
    }
    document.getElementById('courseDialog').close();
    if (uploadedLessons.some(item => item.conversionStatus === 'needs-pdf')) {
      setStatus('Curso guardado. Un archivo Pages quedó marcado para reemplazarlo por PDF.');
    }
  } catch (error) {
    await Promise.all([
      ...uploadedLessons.map(item => discardUpload(item.assetToken)),
      discardUpload(uploadedCover?.assetToken)
    ]);
    setStatus(error.message || 'No se pudo guardar el curso.', true);
  } finally {
    courseFormBusy = false;
    saveButton.disabled = false;
    saveButton.textContent = 'Guardar';
  }
});

document.getElementById('courseCover').addEventListener('change', event => {
  clearCoverObjectUrl();
  const file = event.target.files?.[0];
  if (!file) return;
  coverObjectUrl = URL.createObjectURL(file);
  removeCoverRequested = false;
  showCoverPreview(coverObjectUrl);
});

document.getElementById('removeCover').onclick = () => {
  clearCoverObjectUrl();
  document.getElementById('courseCover').value = '';
  removeCoverRequested = true;
  showCoverPreview('');
};

document.getElementById('courseDialog').addEventListener('close', clearCoverObjectUrl);
document.querySelectorAll('[data-close]').forEach(element => {
  element.addEventListener('click', () => document.getElementById(element.dataset.close).close());
});
document.getElementById('addCourse').onclick = () => openCourseDialog();
document.getElementById('openTrash').onclick = openTrash;
document.getElementById('openHistory').onclick = () => openHistory().catch(error => setStatus(error.message, true));
document.getElementById('openAudit').onclick = () => openAudit().catch(error => setStatus(error.message, true));

async function init() {
  await renewEditingSession();
  await refreshCatalog();
  setStatus('Listo para administrar. Mantén presionado “Mover” para cambiar el orden.');
}

init().catch(error => setStatus(error.message, true));
