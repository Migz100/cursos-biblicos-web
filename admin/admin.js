let catalog = null;
let csrfToken = '';
let toastTimer = null;
let courseFormBusy = false;

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
    if (error.status === 409) {
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

function moveCourse(course, delta) {
  const index = catalog.courses.indexOf(course);
  const target = index + delta;
  if (target < 0 || target >= catalog.courses.length) return;
  mutate({ type: 'course.move', courseId: course.id, toIndex: target }).catch(() => {});
}

function openCourseDialog(course = null) {
  document.getElementById('courseDialogTitle').textContent = course ? 'Editar curso' : 'Agregar curso';
  document.getElementById('editingCourseId').value = course?.id || '';
  document.getElementById('courseName').value = course?.name || '';
  document.getElementById('courseShort').value = course?.short || '';
  document.getElementById('courseSection').value = course?.section || 'cursos';
  document.getElementById('courseColor').value = course?.color || '#0071E3';
  document.getElementById('courseFiles').value = '';
  document.getElementById('courseFilesLabel').hidden = Boolean(course);
  document.getElementById('courseDialog').showModal();
}

async function removeCourse(course) {
  if (!confirm(`¿Quitar el curso "${course.name}"?\n\nIrá a la papelera y se podrá restaurar. Sus archivos no se borrarán.`)) return;
  const typed = prompt(`Para confirmar, escribe exactamente:\n${course.name}`);
  if (typed !== course.name) { setStatus('No se quitó el curso porque el nombre no coincidió.', true); return; }
  await mutate({ type: 'course.remove', courseId: course.id, confirmText: typed }).catch(() => {});
}

async function removeLesson(course, lesson) {
  if (!confirm(`¿Quitar la lección "${lesson.title}"?\n\nIrá a la papelera y se podrá restaurar. El archivo no se borrará.`)) return;
  const typed = prompt(`Para confirmar, escribe exactamente:\n${lesson.title}`);
  if (typed !== lesson.title) { setStatus('No se quitó la lección porque el título no coincidió.', true); return; }
  await mutate({ type: 'lesson.remove', courseId: course.id, lessonId: lesson.id, confirmText: typed }).catch(() => {});
}

async function renameLesson(course, lesson) {
  const title = prompt('Nuevo título de la lección:', lesson.title);
  if (!title || title.trim() === lesson.title) return;
  await mutate({ type: 'lesson.rename', courseId: course.id, lessonId: lesson.id, title }).catch(() => {});
}

function chooseReplacement(course, lesson) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.ppt,.pptx,.ppsx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.presentationml.slideshow';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let upload = null;
    try {
      upload = await uploadFile(file, `Subiendo reemplazo para ${lesson.title}...`);
      await mutate({ type: 'lesson.replace', courseId: course.id, lessonId: lesson.id, assetToken: upload.assetToken });
    } catch (error) {
      await discardUpload(upload?.assetToken);
      setStatus(error.message, true);
    }
  };
  input.click();
}

function moveLesson(course, lesson, delta) {
  const index = course.lessons.indexOf(lesson);
  const target = index + delta;
  if (target < 0 || target >= course.lessons.length) return;
  mutate({ type: 'lesson.move', courseId: course.id, lessonId: lesson.id, toIndex: target }).catch(() => {});
}

async function uploadFile(file, message) {
  setStatus(message || `Subiendo ${file.name}...`);
  const prepared = await csrfRequest('/api/manage/upload', { action: 'prepare', filename: file.name, contentType: file.type, size: file.size });
  const upload = await fetch(prepared.presignedUrl, { method: 'PUT', headers: { 'Content-Type': prepared.contentType }, body: file });
  if (!upload.ok) throw new Error(`No se pudo subir ${file.name}.`);
  return csrfRequest('/api/manage/upload', { action: 'finalize', receipt: prepared.receipt });
}

async function discardUpload(assetToken) {
  if (!assetToken) return;
  await csrfRequest('/api/manage/upload', { action: 'discard', assetToken }).catch(() => {});
}

async function addFiles(course, files) {
  const selected = [...files];
  for (let index = 0; index < selected.length; index++) {
    const file = selected[index];
    const upload = await uploadFile(file, `Subiendo ${index + 1} de ${selected.length}: ${file.name}`);
    try {
      await mutate({ type: 'lesson.add', courseId: course.id, title: upload.suggestedTitle, assetToken: upload.assetToken });
    } catch (error) {
      await discardUpload(upload.assetToken);
      throw error;
    }
  }
  setStatus(`${selected.length} ${selected.length === 1 ? 'lección agregada' : 'lecciones agregadas'} para todos.`);
}

async function uploadFilesOnly(files) {
  const selected = [...files];
  const lessons = [];
  try {
    for (let index = 0; index < selected.length; index++) {
      const file = selected[index];
      const upload = await uploadFile(file, `Preparando curso, archivo ${index + 1} de ${selected.length}: ${file.name}`);
      lessons.push({ title: upload.suggestedTitle, assetToken: upload.assetToken });
    }
  } catch (error) {
    await Promise.all(lessons.map(item => discardUpload(item.assetToken)));
    throw error;
  }
  return lessons;
}

function lessonLine(course, lesson, index) {
  const line = document.createElement('div');
  line.className = 'lessonLine';
  const number = document.createElement('span');
  number.className = 'lessonIndex';
  number.textContent = String(index + 1);
  const title = document.createElement('span');
  title.className = 'lessonTitle';
  title.textContent = lesson.title;
  const type = document.createElement('span');
  type.className = 'lessonType';
  type.textContent = lesson.type.toUpperCase();
  const actions = document.createElement('div');
  actions.className = 'lessonActions';
  const up = button('↑', 'iconAction', `Subir ${lesson.title}`, () => moveLesson(course, lesson, -1));
  const down = button('↓', 'iconAction', `Bajar ${lesson.title}`, () => moveLesson(course, lesson, 1));
  up.disabled = index === 0;
  down.disabled = index === course.lessons.length - 1;
  actions.append(
    up,
    down,
    button('✎', 'iconAction', `Renombrar ${lesson.title}`, () => renameLesson(course, lesson)),
    button('↻', 'iconAction', `Reemplazar archivo de ${lesson.title}`, () => chooseReplacement(course, lesson)),
    button('−', 'iconAction', `Quitar ${lesson.title}`, () => removeLesson(course, lesson))
  );
  line.append(number, title, type, actions);
  return line;
}

function courseCard(course, index) {
  const article = document.createElement('article');
  article.className = 'manageCourse';
  const head = document.createElement('div');
  head.className = 'manageCourseHead';
  const badge = document.createElement('div');
  badge.className = 'manageBadge';
  badge.textContent = course.short;
  badge.style.background = course.color;
  const copy = document.createElement('div');
  copy.className = 'manageCourseName';
  const name = document.createElement('strong');
  name.textContent = course.name;
  const meta = document.createElement('span');
  meta.textContent = `${course.lessons.length} lecciones · ${course.section === 'lafe' ? 'PowerPoint' : 'Cursos Bíblicos'}`;
  copy.append(name, meta);
  const tools = document.createElement('div');
  tools.className = 'manageTools';
  const up = button('↑', 'iconAction', `Subir ${course.name}`, () => moveCourse(course, -1));
  const down = button('↓', 'iconAction', `Bajar ${course.name}`, () => moveCourse(course, 1));
  up.disabled = index === 0;
  down.disabled = index === catalog.courses.length - 1;
  tools.append(up, down, button('Editar', 'secondaryAction', `Editar ${course.name}`, () => openCourseDialog(course)), button('Quitar', 'dangerAction', `Quitar ${course.name}`, () => removeCourse(course)));
  head.append(badge, copy, tools);

  const lessonDetails = document.createElement('details');
  lessonDetails.className = 'lessonDetails';
  const lessonSummary = document.createElement('summary');
  lessonSummary.textContent = `Administrar ${course.lessons.length} ${course.lessons.length === 1 ? 'lección' : 'lecciones'}`;
  const lessons = document.createElement('div');
  lessons.className = 'lessonManager';
  course.lessons.forEach((lesson, lessonIndex) => lessons.appendChild(lessonLine(course, lesson, lessonIndex)));
  const add = document.createElement('div');
  add.className = 'addLessons';
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.id = `files-${course.id}`;
  input.accept = '.pdf,.ppt,.pptx,.ppsx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.presentationml.slideshow';
  const picker = document.createElement('label');
  picker.className = 'filePickerLabel';
  picker.htmlFor = input.id;
  picker.textContent = 'Agregar lecciones';
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
  catalog.courses.forEach((course, index) => manager.appendChild(courseCard(course, index)));
}

function restoreLine(entry) {
  const line = document.createElement('div');
  line.className = 'restoreLine';
  const copy = document.createElement('div');
  copy.className = 'restoreCopy';
  const name = document.createElement('strong');
  name.textContent = entry.item.name || entry.item.title;
  const detail = document.createElement('span');
  detail.textContent = entry.kind === 'course' ? 'Curso' : entry.kind === 'lesson' ? 'Lección' : 'Archivo reemplazado';
  copy.append(name, detail);
  const actionType = entry.kind === 'course' ? 'course.restore' : entry.kind === 'lesson' ? 'lesson.restore' : 'asset.restore';
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
  let uploadedLessons = [];
  try {
    if (id) {
      await mutate({ type: 'course.update', courseId: id, ...fields });
    } else {
      uploadedLessons = files.length ? await uploadFilesOnly(files) : [];
      await mutate({ type: 'course.add', ...fields, lessons: uploadedLessons });
    }
    document.getElementById('courseDialog').close();
  } catch (error) {
    await Promise.all(uploadedLessons.map(item => discardUpload(item.assetToken)));
    setStatus(error.message || 'No se pudo guardar el curso.', true);
  }
  finally {
    courseFormBusy = false;
    saveButton.disabled = false;
    saveButton.textContent = 'Guardar';
  }
});

document.querySelectorAll('[data-close]').forEach(element => {
  element.addEventListener('click', () => document.getElementById(element.dataset.close).close());
});
document.getElementById('addCourse').onclick = () => openCourseDialog();
document.getElementById('openTrash').onclick = openTrash;
document.getElementById('openHistory').onclick = () => openHistory().catch(error => setStatus(error.message, true));

async function init() {
  await renewEditingSession();
  await refreshCatalog();
  setStatus('Listo para administrar.');
}

init().catch(error => setStatus(error.message, true));
