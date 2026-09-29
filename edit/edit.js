(async () => {
  'use strict';

  const MAX_ATTACHMENTS = 4;
  const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
  const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
  const MAX_STORED_THREADS = 30;
  const MAX_STORED_MESSAGES = 80;
  const THREAD_STORAGE = 'cb_code_threads_v2';
  const ACTIVE_THREAD_STORAGE = 'cb_code_active_thread_v2';
  const JOB_STORAGE = 'cb_code_jobs_v2';
  const CLIENT_SCOPE_STORAGE = 'cb_code_client_scope_v1';
  const LEGACY_CONVERSATION_STORAGE = 'cb_code_conversation_v1';
  const LEGACY_MESSAGE_STORAGE = 'cb_code_messages_v1';
  const RICH_MISSING_STATUSES = new Set([404, 405, 501]);
  const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf', 'ppt', 'pptx', 'ppsx', 'txt', 'md', 'csv', 'json']);
  const MIME_BY_EXTENSION = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    pdf: 'application/pdf',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json'
  };

  const byId = id => document.getElementById(id);
  const appShell = byId('appShell');
  const editorScroll = byId('editorScroll');
  const conversation = byId('conversation');
  const welcome = byId('welcome');
  const prompt = byId('prompt');
  const mode = byId('mode');
  const composerForm = byId('composerForm');
  const sendButton = byId('sendButton');
  const stopButton = byId('stopButton');
  const attachButton = byId('attachButton');
  const attachmentInput = byId('attachmentInput');
  const attachmentList = byId('attachmentList');
  const threadList = byId('threadList');
  const threadSidebar = byId('threadSidebar');
  const threadToggle = byId('threadToggle');
  const threadCloseButton = byId('threadCloseButton');
  const sidebarScrim = byId('sidebarScrim');
  const newThreadButton = byId('newThreadButton');
  const hostStatus = byId('hostStatus');
  const hostStatusText = byId('hostStatusText');
  const connectionBanner = byId('connectionBanner');
  const connectionState = byId('connectionState');
  const connectionDetail = byId('connectionDetail');
  const connectionRetryButton = byId('connectionRetryButton');
  const connectionPanel = byId('connectionPanel');
  const progressCard = byId('progressCard');
  const progressTitle = byId('progressTitle');
  const progressSteps = byId('progressSteps');
  const progressTime = byId('progressTime');
  const approvalRegion = byId('approvalRegion');
  const errorCard = byId('errorCard');
  const errorTitle = byId('errorTitle');
  const errorDetail = byId('errorDetail');
  const retryButton = byId('retryButton');
  const reviewPanel = byId('reviewPanel');
  const reviewBadge = byId('reviewBadge');
  const reviewSummary = byId('reviewSummary');
  const changesSummary = byId('changesSummary');
  const changesDetail = byId('changesDetail');
  const testResults = byId('testResults');
  const testsSummary = byId('testsSummary');
  const testsDetail = byId('testsDetail');
  const previewLink = byId('previewLink');
  const diffPanel = byId('diffPanel');
  const diffSummary = byId('diffSummary');
  const diffContent = byId('diffContent');
  const quickActions = byId('quickActions');
  const publishButton = byId('publishButton');
  const publishDialog = byId('publishDialog');
  const publishForm = byId('publishForm');
  const publishDialogTitle = byId('publishDialogTitle');
  const publishDialogSummary = byId('publishDialogSummary');
  const publishWarning = publishDialog.querySelector('.publishWarning');
  const publishAcknowledge = byId('publishAcknowledge');
  const publishAcknowledgeText = publishDialog.querySelector('.publishAcknowledge span');
  const confirmPublishButton = byId('confirmPublishButton');
  const liveAnnouncer = byId('liveAnnouncer');

  let threads = loadThreads();
  const clientScopeId = validUuid(localStorage.getItem(CLIENT_SCOPE_STORAGE))
    ? localStorage.getItem(CLIENT_SCOPE_STORAGE)
    : crypto.randomUUID();
  let activeThreadId = validUuid(localStorage.getItem(ACTIVE_THREAD_STORAGE))
    ? localStorage.getItem(ACTIVE_THREAD_STORAGE)
    : '';
  let jobs = loadJobs();
  let selectedAttachments = [];
  let connection = { state: 'connecting', lastSeen: null, status: null };
  let sendingThreadId = '';
  let statusTimer = 0;
  let pollTimer = 0;
  let elapsedTimer = 0;
  let threadSyncAttempted = false;
  let threadSyncInFlight = false;
  let publishDialogStage = '';
  let publishDialogThreadId = '';
  const retryByThread = new Map();
  const releaseSessions = new Map();

  migrateLegacyConversation();
  localStorage.setItem(CLIENT_SCOPE_STORAGE, clientScopeId);
  if (!threads.length) threads.push(createThread());
  if (!threads.some(thread => thread.id === activeThreadId)) activeThreadId = threads[0].id;
  saveState();
  configureResponsiveSidebar();
  bindEvents();
  renderAll();
  await refreshStatus();
  resumePendingJobs();
  statusTimer = window.setInterval(refreshStatus, 12000);
  elapsedTimer = window.setInterval(renderElapsedTime, 1000);

  function bindEvents() {
    document.querySelectorAll('[data-suggestion]').forEach(button => {
      button.addEventListener('click', () => {
        prompt.value = button.dataset.suggestion || '';
        resizePrompt();
        updateControls();
        prompt.focus();
      });
    });

    document.querySelectorAll('[data-action]').forEach(button => {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'publish') prepareRelease();
        else submitSimpleAction(action);
      });
    });

    composerForm.addEventListener('submit', event => {
      event.preventDefault();
      submitTurn();
    });
    prompt.addEventListener('input', () => {
      resizePrompt();
      updateControls();
    });
    prompt.addEventListener('keydown', event => {
      const keyboardSend = (event.ctrlKey || event.metaKey || window.innerWidth > 760) && !event.shiftKey;
      if (event.key === 'Enter' && keyboardSend && !event.isComposing) {
        event.preventDefault();
        submitTurn();
      }
    });
    stopButton.addEventListener('click', interruptActiveJob);
    retryButton.addEventListener('click', retryActiveRequest);
    attachButton.addEventListener('click', () => attachmentInput.click());
    attachmentInput.addEventListener('change', () => {
      addAttachments(Array.from(attachmentInput.files || []));
      attachmentInput.value = '';
    });

    newThreadButton.addEventListener('click', startNewThread);
    threadToggle.addEventListener('click', () => setSidebarOpen(!appShell.classList.contains('sidebarOpen')));
    threadCloseButton.addEventListener('click', () => setSidebarOpen(false));
    sidebarScrim.addEventListener('click', () => setSidebarOpen(false));
    window.addEventListener('resize', configureResponsiveSidebar);

    hostStatus.addEventListener('click', () => {
      const nextHidden = !connectionPanel.hidden;
      connectionPanel.hidden = nextHidden;
      hostStatus.setAttribute('aria-expanded', String(!nextHidden));
    });
    connectionRetryButton.addEventListener('click', refreshStatus);
    window.addEventListener('online', refreshStatus);
    window.addEventListener('offline', () => {
      setConnectionState('offline', null, true);
      renderConnection();
    });

    publishAcknowledge.addEventListener('change', () => {
      confirmPublishButton.disabled = !publishAcknowledge.checked;
    });
    publishForm.addEventListener('submit', event => {
      if (event.submitter !== confirmPublishButton) return;
      event.preventDefault();
      if (!publishAcknowledge.checked) return;
      publishDialog.close();
      if (publishDialogStage === 'review') confirmPreparedRelease();
      else if (publishDialogStage === 'publish') publishPreparedRelease();
    });
    publishDialog.addEventListener('close', () => {
      publishAcknowledge.checked = false;
      confirmPublishButton.disabled = true;
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && appShell.classList.contains('sidebarOpen')) setSidebarOpen(false);
    });
  }

  function createThread(input = {}) {
    const now = new Date().toISOString();
    return {
      id: validUuid(input.id) ? input.id : crypto.randomUUID(),
      serverThreadId: safeIdentifier(input.serverThreadId || ''),
      title: safeTitle(input.title || 'Nueva conversación'),
      createdAt: validDate(input.createdAt) || now,
      updatedAt: validDate(input.updatedAt) || now,
      messages: cleanMessages(input.messages),
      progress: cleanProgress(input.progress),
      approvals: cleanApprovals(input.approvals),
      error: cleanError(input.error),
      review: cleanReview(input.review),
      streamText: '',
      turnId: safeIdentifier(input.turnId || '')
    };
  }

  function loadThreads() {
    try {
      const value = JSON.parse(localStorage.getItem(THREAD_STORAGE) || '[]');
      if (!Array.isArray(value)) return [];
      return value.slice(0, MAX_STORED_THREADS).map(createThread);
    } catch {
      return [];
    }
  }

  function loadJobs() {
    try {
      const value = JSON.parse(localStorage.getItem(JOB_STORAGE) || '[]');
      if (!Array.isArray(value)) return new Map();
      const entries = value
        .filter(item => item && validUuid(item.id) && validUuid(item.threadLocalId))
        .map(item => [item.id, {
          id: item.id,
          seq: Math.max(0, Number(item.seq) || 0),
          kind: safeIdentifier(item.kind || 'turn'),
          action: safeIdentifier(item.action || ''),
          mode: item.mode === 'plan' ? 'plan' : 'edit',
          threadLocalId: item.threadLocalId,
          conversationId: validUuid(item.conversationId) ? item.conversationId : item.threadLocalId,
          serverThreadId: safeIdentifier(item.serverThreadId || ''),
          turnId: safeIdentifier(item.turnId || ''),
          startedAt: validDate(item.startedAt) || new Date().toISOString(),
          cancellable: item.cancellable !== false
        }]);
      return new Map(entries);
    } catch {
      return new Map();
    }
  }

  function migrateLegacyConversation() {
    if (threads.length) return;
    try {
      const conversationId = localStorage.getItem(LEGACY_CONVERSATION_STORAGE);
      const legacy = JSON.parse(localStorage.getItem(LEGACY_MESSAGE_STORAGE) || '[]');
      if (!validUuid(conversationId) || !Array.isArray(legacy) || !legacy.length) return;
      const messages = legacy
        .filter(item => item && ['user', 'assistant', 'error'].includes(item.role) && typeof item.text === 'string')
        .map(item => ({
          id: crypto.randomUUID(),
          role: item.role === 'error' ? 'assistant' : item.role,
          text: safeText(item.text, 30000),
          label: item.role === 'user' ? 'Tú' : 'Codex',
          at: Number(item.at) || Date.now(),
          kind: item.role === 'error' ? 'error' : 'message'
        }));
      const firstPrompt = messages.find(item => item.role === 'user');
      threads.push(createThread({
        id: conversationId,
        title: firstPrompt ? titleFromPrompt(firstPrompt.text) : 'Conversación anterior',
        messages
      }));
    } catch {}
  }

  function saveState() {
    threads.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    threads = threads.slice(0, MAX_STORED_THREADS);
    const safeThreads = threads.map(thread => ({
      id: thread.id,
      serverThreadId: thread.serverThreadId,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messages: thread.messages.slice(-MAX_STORED_MESSAGES),
      progress: thread.progress,
      approvals: thread.approvals.slice(-10),
      error: thread.error,
      review: thread.review,
      turnId: thread.turnId
    }));
    try {
      localStorage.setItem(THREAD_STORAGE, JSON.stringify(safeThreads));
      localStorage.setItem(ACTIVE_THREAD_STORAGE, activeThreadId);
      localStorage.setItem(JOB_STORAGE, JSON.stringify(Array.from(jobs.values())));
    } catch {}
  }

  function cleanMessages(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.text === 'string')
      .slice(-MAX_STORED_MESSAGES)
      .map(item => ({
        id: validUuid(item.id) ? item.id : crypto.randomUUID(),
        role: item.role,
        text: safeText(item.text, 30000),
        label: item.role === 'user' ? 'Tú' : 'Codex',
        at: Number(item.at) || Date.now(),
        kind: safeIdentifier(item.kind || 'message'),
        eventKey: safeIdentifier(item.eventKey || ''),
        attachments: Math.max(0, Math.min(MAX_ATTACHMENTS, Number(item.attachments) || 0))
      }));
  }

  function cleanProgress(value) {
    const progress = value && typeof value === 'object' ? value : {};
    return {
      current: safeText(progress.current || '', 500),
      steps: Array.isArray(progress.steps) ? progress.steps.map(item => safeText(item, 500)).filter(Boolean).slice(-6) : [],
      startedAt: validDate(progress.startedAt) || null
    };
  }

  function cleanApprovals(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter(item => item && safeIdentifier(item.id))
      .slice(-10)
      .map(item => ({
        id: safeIdentifier(item.id),
        jobId: validUuid(item.jobId) ? item.jobId : '',
        title: safeText(item.title || 'Necesito tu permiso', 160),
        summary: safeText(item.summary || '', 1200),
        risk: safeText(item.risk || '', 800),
        detail: safeCommandDetail(item.detail || ''),
        status: ['pending', 'sending', 'accepted', 'declined', 'cancelled'].includes(item.status) ? item.status : 'pending'
      }));
  }

  function cleanError(value) {
    if (!value || typeof value !== 'object' || !value.detail) return null;
    return {
      title: safeText(value.title || 'No se pudo terminar', 120),
      detail: safeText(value.detail, 3000),
      kind: ['usage', 'offline', 'safety', 'failed'].includes(value.kind) ? value.kind : 'failed',
      retryable: value.retryable !== false
    };
  }

  function cleanReview(value) {
    if (!value || typeof value !== 'object') return null;
    return {
      summary: safeText(value.summary || '', 8000),
      changeCount: Math.max(0, Math.min(999, Number(value.changeCount) || 0)),
      changeSummary: safeText(value.changeSummary || '', 1000),
      diff: sanitizeDiff(value.diff || ''),
      testsStatus: ['passed', 'failed', 'unknown'].includes(value.testsStatus) ? value.testsStatus : 'unknown',
      testsSummary: safeText(value.testsSummary || '', 500),
      testsDetail: safeText(value.testsDetail || '', 1200),
      previewUrl: safeHttps(value.previewUrl),
      publishedUrl: safeHttps(value.publishedUrl),
      published: Boolean(value.published),
      applied: value.applied !== false,
      releaseId: safeIdentifier(value.releaseId || ''),
      fingerprint: safeIdentifier(value.fingerprint || ''),
      releaseStage: ['prepared', 'confirmed', 'consumed', 'published'].includes(value.releaseStage) ? value.releaseStage : ''
    };
  }

  function activeThread() {
    return threads.find(thread => thread.id === activeThreadId) || threads[0];
  }

  function threadForJob(job) {
    return threads.find(thread => thread.id === job.threadLocalId) || null;
  }

  function activeJob(threadId = activeThreadId) {
    return Array.from(jobs.values()).find(job => job.threadLocalId === threadId && job.kind !== 'threads-list') || null;
  }

  function renderAll() {
    renderThreadList();
    renderActiveThread();
    renderAttachments();
    renderConnection();
    updateControls();
  }

  function renderThreadList() {
    threadList.replaceChildren();
    if (!threads.length) {
      const empty = document.createElement('p');
      empty.className = 'threadEmpty';
      empty.textContent = 'Todavía no hay conversaciones.';
      threadList.append(empty);
      return;
    }
    for (const thread of threads) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'threadItem';
      button.dataset.threadId = thread.id;
      const job = activeJob(thread.id);
      const pendingApproval = thread.approvals.some(item => item.status === 'pending');
      button.dataset.threadStatus = job ? 'working' : pendingApproval || thread.error ? 'attention' : thread.review ? 'ready' : 'idle';
      button.classList.toggle('active', thread.id === activeThreadId);
      button.setAttribute('aria-current', thread.id === activeThreadId ? 'page' : 'false');

      const title = document.createElement('strong');
      title.textContent = thread.title;
      const state = document.createElement('span');
      state.className = 'threadState';
      state.setAttribute('aria-hidden', 'true');
      const time = document.createElement('small');
      time.textContent = job ? 'Trabajando ahora' : relativeTime(thread.updatedAt);
      button.append(title, state, time);
      button.addEventListener('click', () => selectThread(thread.id));
      threadList.append(button);
    }
  }

  function renderActiveThread() {
    const thread = activeThread();
    if (!thread) return;
    const keepBottom = isNearBottom();
    renderConversation(thread);
    renderProgress(thread);
    renderApprovals(thread);
    renderError(thread);
    renderReview(thread);
    const hasWork = thread.messages.length || activeJob(thread.id) || thread.review || thread.approvals.length;
    welcome.hidden = Boolean(hasWork);
    if (keepBottom) scrollToLatest(false);
  }

  function renderConversation(thread) {
    conversation.replaceChildren();
    for (const item of thread.messages) conversation.append(messageElement(item));
    if (thread.streamText) {
      conversation.append(messageElement({
        role: 'assistant',
        text: thread.streamText,
        label: 'Codex',
        kind: 'stream'
      }));
    }
    conversation.dataset.streaming = String(Boolean(thread.streamText || activeJob(thread.id)));
  }

  function messageElement(item) {
    const wrapper = document.createElement('article');
    wrapper.className = 'message';
    wrapper.dataset.messageRole = item.role;
    wrapper.dataset.eventKind = item.kind || 'message';
    const label = document.createElement('span');
    label.className = 'messageLabel';
    label.textContent = item.role === 'user' ? 'Tú' : 'Codex';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    appendLinkedText(bubble, safeText(item.text, 30000));
    if (item.attachments) {
      const summary = document.createElement('div');
      summary.className = 'messageAttachmentSummary';
      summary.textContent = item.attachments === 1 ? '1 archivo adjunto' : String(item.attachments) + ' archivos adjuntos';
      bubble.append(summary);
    }
    wrapper.append(label, bubble);
    return wrapper;
  }

  function renderProgress(thread) {
    const job = activeJob(thread.id);
    progressCard.hidden = !job;
    if (!job) return;
    const waiting = connection.state === 'offline';
    progressCard.dataset.eventStatus = waiting ? 'waiting' : 'working';
    progressTitle.textContent = waiting
      ? 'Esperando a la computadora de edición…'
      : thread.progress.current || jobStartText(job);
    progressSteps.replaceChildren();
    const steps = thread.progress.steps.length ? thread.progress.steps : [jobStartText(job)];
    for (const text of steps.slice(-5)) {
      const item = document.createElement('li');
      item.textContent = text;
      progressSteps.append(item);
    }
    renderElapsedTime();
  }

  function renderElapsedTime() {
    const job = activeJob();
    if (!job || progressCard.hidden) {
      progressTime.textContent = '';
      return;
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(job.startedAt)) / 1000));
    if (elapsed < 5) progressTime.textContent = 'Ahora';
    else if (elapsed < 60) progressTime.textContent = String(elapsed) + ' s';
    else progressTime.textContent = String(Math.floor(elapsed / 60)) + ' min';
  }

  function renderApprovals(thread) {
    approvalRegion.replaceChildren();
    for (const approval of thread.approvals) {
      const card = document.createElement('article');
      card.className = 'approvalCard';
      card.dataset.approvalId = approval.id;
      card.dataset.eventKind = 'approval';
      card.dataset.eventStatus = approval.status === 'pending' || approval.status === 'sending' ? 'pending' : 'resolved';

      const icon = document.createElement('span');
      icon.className = 'approvalIcon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '?';
      const body = document.createElement('div');
      const title = document.createElement('h2');
      title.textContent = approval.title;
      const summary = document.createElement('p');
      summary.textContent = approval.summary || 'Codex necesita tu decisión para continuar.';
      body.append(title, summary);
      if (approval.risk) {
        const risk = document.createElement('p');
        risk.className = 'approvalRisk';
        risk.textContent = approval.risk;
        body.append(risk);
      }
      if (approval.detail) {
        const detail = document.createElement('details');
        detail.className = 'approvalDetail';
        const detailTitle = document.createElement('summary');
        detailTitle.textContent = 'Ver detalle técnico seguro';
        const pre = document.createElement('pre');
        pre.textContent = approval.detail;
        detail.append(detailTitle, pre);
        body.append(detail);
      }
      if (approval.status === 'pending' || approval.status === 'sending') {
        const actions = document.createElement('div');
        actions.className = 'approvalActions';
        const decline = document.createElement('button');
        decline.type = 'button';
        decline.dataset.approvalAction = 'decline';
        decline.textContent = 'No permitir';
        const accept = document.createElement('button');
        accept.type = 'button';
        accept.dataset.approvalAction = 'approve';
        accept.textContent = 'Permitir una vez';
        decline.disabled = approval.status === 'sending';
        accept.disabled = approval.status === 'sending';
        decline.addEventListener('click', () => respondToApproval(approval.id, 'decline'));
        accept.addEventListener('click', () => respondToApproval(approval.id, 'accept'));
        actions.append(decline, accept);
        body.append(actions);
      } else {
        const result = document.createElement('p');
        result.className = 'approvalResolution';
        result.textContent = approval.status === 'accepted' ? 'Permitido solo para esta vez.' : 'No se permitió esta acción.';
        body.append(result);
      }
      card.append(icon, body);
      approvalRegion.append(card);
    }
  }

  function renderError(thread) {
    errorCard.hidden = !thread.error;
    if (!thread.error) return;
    errorCard.dataset.errorKind = thread.error.kind;
    errorTitle.textContent = thread.error.title;
    errorDetail.textContent = thread.error.detail;
    retryButton.hidden = !thread.error.retryable || !retryByThread.has(thread.id);
  }

  function renderReview(thread) {
    const review = thread.review;
    reviewPanel.hidden = !review;
    quickActions.hidden = Boolean(review);
    if (!review) return;

    reviewSummary.textContent = review.summary || 'Codex terminó el trabajo. Revisa los resultados antes de publicar.';
    reviewBadge.textContent = review.published ? 'Publicado' : review.applied === false ? 'Esperando permiso' : review.previewUrl ? 'Vista previa lista' : 'Sin publicar';
    reviewBadge.classList.toggle('published', review.published);

    if (review.changeCount > 0) {
      const noun = review.applied === false ? 'propuesto' : 'preparado';
      changesSummary.textContent = review.changeCount === 1 ? `1 cambio ${noun}` : String(review.changeCount) + ` cambios ${noun}s`;
    } else {
      changesSummary.textContent = 'Cambios revisados';
    }
    changesDetail.textContent = review.changeSummary || (review.diff
      ? 'Puedes abrir la comparación segura debajo.'
      : 'El resumen no incluye rutas internas ni comandos.');

    testResults.dataset.eventStatus = review.testsStatus;
    testsSummary.textContent = review.testsSummary || {
      passed: 'Todas las comprobaciones pasaron',
      failed: 'Hay comprobaciones pendientes',
      unknown: 'Comprobaciones sin confirmar'
    }[review.testsStatus];
    testsDetail.textContent = review.testsDetail || {
      passed: 'La app superó las pruebas informadas por la computadora.',
      failed: 'Nada se publicará mientras exista un error.',
      unknown: 'Pulsa Comprobar para obtener un resultado nuevo.'
    }[review.testsStatus];

    const url = review.publishedUrl || review.previewUrl;
    previewLink.hidden = !url;
    if (url) {
      previewLink.href = url;
      const title = previewLink.querySelector('strong');
      const subtitle = previewLink.querySelector('small');
      title.textContent = review.published ? 'Abrir app publicada' : 'Abrir vista previa';
      subtitle.textContent = review.published ? 'Ver la versión confirmada en vivo' : 'Revisar sin cambiar la app en vivo';
    } else {
      previewLink.removeAttribute('href');
    }

    diffPanel.hidden = !review.diff;
    diffContent.replaceChildren();
    if (review.diff) {
      const lines = review.diff.split('\n').slice(0, 1200);
      diffSummary.textContent = 'Comparación sanitizada: no muestra rutas absolutas, credenciales ni comandos ocultos.';
      for (const line of lines) {
        const span = document.createElement('span');
        span.className = 'diffLine';
        if (line.startsWith('+') && !line.startsWith('+++')) span.classList.add('add');
        else if (line.startsWith('-') && !line.startsWith('---')) span.classList.add('remove');
        else if (line.startsWith('@@')) span.classList.add('hunk');
        span.textContent = line;
        diffContent.append(span);
      }
    }
  }

  function renderAttachments() {
    attachmentList.replaceChildren();
    for (const attachment of selectedAttachments) {
      const item = document.createElement('article');
      item.className = 'attachmentItem';
      item.dataset.attachmentId = attachment.localId;
      item.dataset.uploadStatus = attachment.status || 'ready';
      const thumb = document.createElement('span');
      thumb.className = 'attachmentThumb';
      if (attachment.previewUrl && attachment.mime.startsWith('image/')) {
        const image = document.createElement('img');
        image.src = attachment.previewUrl;
        image.alt = '';
        thumb.append(image);
      } else {
        thumb.textContent = attachment.extension.toUpperCase();
      }
      const text = document.createElement('span');
      text.className = 'attachmentText';
      const name = document.createElement('strong');
      name.textContent = safeFilename(attachment.file.name);
      const size = document.createElement('small');
      size.textContent = attachment.status === 'uploading' ? 'Preparando…' : formatBytes(attachment.file.size);
      text.append(name, size);
      if (attachment.previewUrl && attachment.mime === 'application/pdf') {
        const preview = document.createElement('a');
        preview.className = 'attachmentPreview';
        preview.href = attachment.previewUrl;
        preview.target = '_blank';
        preview.rel = 'noopener noreferrer';
        preview.textContent = 'Ver PDF';
        text.append(preview);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'removeAttachment';
      remove.dataset.removeAttachment = attachment.localId;
      remove.setAttribute('aria-label', 'Quitar ' + safeFilename(attachment.file.name));
      remove.textContent = '×';
      remove.disabled = attachment.status === 'uploading';
      remove.addEventListener('click', () => removeAttachment(attachment.localId));
      item.append(thumb, text, remove);
      attachmentList.append(item);
    }
  }

  function renderConnection() {
    appShell.dataset.connection = connection.state;
    const browserOffline = !navigator.onLine;
    const descriptions = {
      connecting: ['Conectando…', 'Buscando la computadora de edición…', 'Puedes escribir mientras se establece la conexión.'],
      online: ['Lista', 'Computadora lista', 'Puedes enviar cambios y recibir avances en tiempo real.'],
      busy: ['Trabajando', 'Computadora trabajando', 'Codex está atendiendo un pedido de esta app.'],
      reconnecting: ['Reconectando', 'Se interrumpió la conexión', 'Seguiremos buscando avances sin repetir tu pedido.'],
      offline: ['Sin conexión', browserOffline ? 'Este dispositivo no tiene internet' : 'Computadora de edición desconectada', browserOffline
        ? 'Conéctate a internet para enviar o recibir avances.'
        : 'Puedes escribir tu pedido y enviarlo cuando la computadora vuelva a estar lista.']
    };
    const copy = descriptions[connection.state] || descriptions.connecting;
    hostStatusText.textContent = copy[0];
    connectionState.textContent = copy[1];
    connectionDetail.textContent = copy[2];
    connectionRetryButton.hidden = ['online', 'busy'].includes(connection.state);
    byId('computerState').textContent = copy[0];
    byId('computerLastSeen').textContent = connection.lastSeen ? relativeTime(connection.lastSeen) : 'Sin señal reciente';
    byId('computerDetail').textContent = connection.state === 'online' || connection.state === 'busy'
      ? 'La conexión responde y el proyecto se procesa únicamente en la computadora de edición.'
      : copy[2];
  }

  function updateControls() {
    const thread = activeThread();
    const job = thread ? activeJob(thread.id) : null;
    const syncingHistory = threadSyncInFlight || Array.from(jobs.values()).some(item => item.kind === 'threads-list');
    const submitting = Boolean(thread && sendingThreadId === thread.id);
    const busy = Boolean(job || submitting || syncingHistory);
    const canSend = Boolean(prompt.value.trim()) && navigator.onLine && !busy;
    sendButton.disabled = !canSend;
    stopButton.hidden = !job;
    stopButton.disabled = !job || !job.cancellable;
    prompt.disabled = submitting;
    mode.disabled = busy;
    attachButton.disabled = busy || selectedAttachments.length >= MAX_ATTACHMENTS;
    attachmentInput.disabled = busy;
    document.querySelectorAll('[data-action]').forEach(button => {
      button.disabled = busy || !navigator.onLine;
    });
    publishButton.disabled = busy || !navigator.onLine || !thread?.review || thread.review.applied === false;
  }

  function resizePrompt() {
    prompt.style.height = 'auto';
    prompt.style.height = String(Math.min(prompt.scrollHeight, 156)) + 'px';
  }

  function configureResponsiveSidebar() {
    const mobile = window.matchMedia('(max-width: 760px)').matches;
    if (!mobile) {
      appShell.classList.remove('sidebarOpen');
      sidebarScrim.hidden = true;
      threadSidebar.inert = false;
      threadSidebar.setAttribute('aria-hidden', 'false');
      threadToggle.setAttribute('aria-expanded', 'false');
      return;
    }
    const open = appShell.classList.contains('sidebarOpen');
    sidebarScrim.hidden = !open;
    threadSidebar.inert = !open;
    threadSidebar.setAttribute('aria-hidden', String(!open));
    threadToggle.setAttribute('aria-expanded', String(open));
  }

  function setSidebarOpen(open) {
    if (!window.matchMedia('(max-width: 760px)').matches) return;
    appShell.classList.toggle('sidebarOpen', open);
    sidebarScrim.hidden = !open;
    threadSidebar.inert = !open;
    threadSidebar.setAttribute('aria-hidden', String(!open));
    threadToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      const selected = threadList.querySelector('[aria-current="page"]') || newThreadButton;
      window.setTimeout(() => selected.focus(), 40);
    } else {
      threadToggle.focus();
    }
  }

  function startNewThread() {
    const thread = createThread();
    threads.unshift(thread);
    activeThreadId = thread.id;
    clearAttachments();
    saveState();
    renderAll();
    setSidebarOpen(false);
    prompt.value = '';
    resizePrompt();
    prompt.focus();
    announce('Nueva conversación lista.');
  }

  function selectThread(threadId) {
    if (!threads.some(thread => thread.id === threadId)) return;
    activeThreadId = threadId;
    clearAttachments();
    saveState();
    renderAll();
    setSidebarOpen(false);
    const thread = activeThread();
    if (thread.serverThreadId && !thread.messages.length && !activeJob(thread.id)) resumeRemoteThread(thread);
    window.setTimeout(() => prompt.focus(), 40);
  }

  async function resumeRemoteThread(thread) {
    try {
      const result = await postJson('/api/code/threads', {
        operation: 'resume',
        clientId: clientScopeId,
        conversationId: thread.id,
        threadId: thread.serverThreadId
      });
      registerJobResult(result, {
        kind: 'thread-resume',
        action: 'resume',
        threadLocalId: thread.id,
        serverThreadId: thread.serverThreadId,
        cancellable: false
      });
    } catch (error) {
      if (!RICH_MISSING_STATUSES.has(error.status)) setThreadError(thread, error, false);
    }
  }

  async function refreshStatus() {
    if (!navigator.onLine) {
      setConnectionState('offline', null, true);
      renderConnection();
      updateControls();
      return;
    }
    try {
      const status = await requestJson('/api/code/status');
      connection.status = status;
      const next = status.online ? (status.busy ? 'busy' : 'online') : 'offline';
      setConnectionState(next, status.lastSeen || null, false);
      renderConnection();
      updateControls();
      if (status.online && !threadSyncAttempted) syncRemoteThreads();
    } catch {
      setConnectionState(connection.state === 'connecting' ? 'offline' : 'reconnecting', connection.lastSeen, false);
      renderConnection();
      updateControls();
    }
  }

  function setConnectionState(state, lastSeen, browserOffline) {
    connection.state = browserOffline ? 'offline' : state;
    connection.lastSeen = lastSeen || connection.lastSeen;
  }

  async function syncRemoteThreads() {
    threadSyncAttempted = true;
    threadSyncInFlight = true;
    updateControls();
    try {
      const result = await postJson('/api/code/threads', {
        operation: 'list',
        clientId: clientScopeId,
        conversationId: activeThreadId,
        limit: 20
      });
      if (Array.isArray(result.threads)) mergeRemoteThreads(result.threads);
      registerJobResult(result, {
        kind: 'threads-list',
        action: 'list',
        threadLocalId: activeThreadId,
        cancellable: false
      });
    } catch (error) {
      if (!RICH_MISSING_STATUSES.has(error.status)) threadSyncAttempted = false;
    } finally {
      threadSyncInFlight = false;
      updateControls();
    }
  }

  async function submitTurn() {
    const thread = activeThread();
    const text = prompt.value.trim();
    if (!thread || !text || activeJob(thread.id) || sendingThreadId) return;
    if (!navigator.onLine) {
      setThreadError(thread, makeFriendlyError(new Error('offline')), false);
      return;
    }
    sendingThreadId = thread.id;
    thread.error = null;
    renderAll();
    try {
      const uploaded = await uploadSelectedAttachments(thread);
      const requestRecord = {
        kind: 'turn',
        prompt: text,
        mode: mode.value === 'plan' ? 'plan' : 'edit',
        attachmentIds: uploaded.map(item => item.attachmentId),
        attachmentCount: uploaded.length
      };
      await queueTurn(thread, requestRecord, true);
      prompt.value = '';
      resizePrompt();
      clearAttachments();
    } catch (error) {
      const friendly = makeFriendlyError(error);
      setThreadError(thread, friendly, false);
      retryByThread.set(thread.id, { kind: 'composer' });
    } finally {
      sendingThreadId = '';
      renderAll();
    }
  }

  async function queueTurn(thread, requestRecord, addUserMessage) {
    let result;
    try {
      result = await postJson('/api/code/turns', {
        operation: 'start',
        clientId: clientScopeId,
        conversationId: thread.id,
        ...(thread.serverThreadId ? { threadId: thread.serverThreadId } : {}),
        prompt: requestRecord.prompt,
        mode: requestRecord.mode,
        ...(requestRecord.attachmentIds.length ? { attachmentIds: requestRecord.attachmentIds } : {})
      });
    } catch (error) {
      if (!RICH_MISSING_STATUSES.has(error.status)) throw error;
      if (requestRecord.attachmentIds.length) {
        const unsupported = new Error('La computadora de edición necesita actualizarse antes de recibir archivos adjuntos.');
        unsupported.code = 'ATTACHMENTS_UNAVAILABLE';
        throw unsupported;
      }
      result = await postJson('/api/code/message', {
        action: 'prompt',
        clientId: clientScopeId,
        prompt: requestRecord.prompt,
        mode: requestRecord.mode,
        conversationId: thread.id
      });
    }
    if (addUserMessage) {
      addMessage(thread, 'user', requestRecord.prompt, {
        attachments: requestRecord.attachmentCount
      });
      if (thread.title === 'Nueva conversación') thread.title = titleFromPrompt(requestRecord.prompt);
    }
    thread.error = null;
    retryByThread.set(thread.id, requestRecord);
    registerJobResult(result, {
      kind: 'turn',
      action: 'prompt',
      mode: requestRecord.mode,
      threadLocalId: thread.id,
      serverThreadId: thread.serverThreadId,
      turnId: safeIdentifier(result.turnId || ''),
      cancellable: true
    });
    thread.updatedAt = new Date().toISOString();
    saveState();
    announce(connection.state === 'offline' ? 'Pedido guardado en espera.' : 'Pedido enviado a Codex.');
  }

  async function submitSimpleAction(action) {
    if (!['checks', 'preview'].includes(action)) return;
    const thread = activeThread();
    if (!thread || activeJob(thread.id) || sendingThreadId) return;
    const text = action === 'checks'
      ? 'Comprueba que toda la app funcione bien, sin publicar nada.'
      : 'Crea una vista previa segura para revisar los cambios, sin publicarlos.';
    sendingThreadId = thread.id;
    thread.error = null;
    addMessage(thread, 'user', text);
    renderAll();
    try {
      const result = await postJson('/api/code/message', {
        action,
        clientId: clientScopeId,
        prompt: '',
        mode: 'edit',
        conversationId: thread.id
      });
      retryByThread.set(thread.id, { kind: 'action', action });
      registerJobResult(result, {
        kind: action,
        action,
        mode: 'edit',
        threadLocalId: thread.id,
        serverThreadId: thread.serverThreadId,
        cancellable: true
      });
      announce(action === 'checks' ? 'Comprobación iniciada.' : 'Vista previa solicitada.');
    } catch (error) {
      setThreadError(thread, error, false);
    } finally {
      sendingThreadId = '';
      renderAll();
    }
  }

  async function prepareRelease() {
    const thread = activeThread();
    if (!thread || activeJob(thread.id) || sendingThreadId) return;
    sendingThreadId = thread.id;
    thread.error = null;
    renderAll();
    try {
      const result = await postJson('/api/code/release/prepare', {
        clientId: clientScopeId,
        conversationId: thread.id
      });
      retryByThread.set(thread.id, { kind: 'release-prepare' });
      registerJobResult(result, {
        kind: 'release-prepare',
        action: 'prepare',
        threadLocalId: thread.id,
        serverThreadId: thread.serverThreadId,
        cancellable: true
      });
      announce('Preparando un resumen seguro antes de confirmar.');
    } catch (error) {
      setThreadError(thread, error, false);
    } finally {
      sendingThreadId = '';
      renderAll();
    }
  }

  async function confirmPreparedRelease() {
    const thread = threads.find(item => item.id === publishDialogThreadId);
    const session = thread ? releaseSessions.get(thread.id) : null;
    if (!thread || !session || !session.releaseId || !session.confirmationToken || !session.fingerprint) {
      if (thread) setThreadError(thread, new Error('La preparación venció. Vuelve a pulsar Publicar cambios para obtener un resumen nuevo.'), false);
      return;
    }
    activeThreadId = thread.id;
    sendingThreadId = thread.id;
    renderAll();
    try {
      const result = await postJson('/api/code/release/confirm', {
        clientId: clientScopeId,
        conversationId: thread.id,
        releaseId: session.releaseId,
        confirmationToken: session.confirmationToken,
        fingerprint: session.fingerprint,
        confirmation: 'REVISADO'
      });
      retryByThread.set(thread.id, { kind: 'release-confirm' });
      registerJobResult(result, {
        kind: 'release-confirm',
        action: 'confirm',
        threadLocalId: thread.id,
        serverThreadId: thread.serverThreadId,
        cancellable: false
      });
      announce('Primera confirmación recibida. Falta confirmar la publicación.');
    } catch (error) {
      setThreadError(thread, error, false);
    } finally {
      sendingThreadId = '';
      renderAll();
    }
  }

  async function publishPreparedRelease() {
    const thread = threads.find(item => item.id === publishDialogThreadId);
    const session = thread ? releaseSessions.get(thread.id) : null;
    if (!thread || !session || !session.releaseId || !session.publishToken || !session.fingerprint) {
      if (thread) setThreadError(thread, new Error('La confirmación venció. Prepara la publicación otra vez.'), false);
      return;
    }
    activeThreadId = thread.id;
    sendingThreadId = thread.id;
    renderAll();
    try {
      const result = await postJson('/api/code/release/publish', {
        clientId: clientScopeId,
        conversationId: thread.id,
        releaseId: session.releaseId,
        publishToken: session.publishToken,
        fingerprint: session.fingerprint,
        confirmation: 'PUBLICAR'
      });
      retryByThread.set(thread.id, { kind: 'release-publish' });
      registerJobResult(result, {
        kind: 'release-publish',
        action: 'publish',
        threadLocalId: thread.id,
        serverThreadId: thread.serverThreadId,
        cancellable: true
      });
      announce('Segunda confirmación recibida. La computadora hará las comprobaciones finales.');
    } catch (error) {
      setThreadError(thread, error, false);
    } finally {
      sendingThreadId = '';
      renderAll();
    }
  }

  function openPublishDialog(stage, thread) {
    const session = releaseSessions.get(thread.id);
    if (!session) return;
    publishDialogStage = stage;
    publishDialogThreadId = thread.id;
    publishAcknowledge.checked = false;
    confirmPublishButton.disabled = true;
    if (stage === 'review') {
      publishDialogTitle.textContent = 'Primera confirmación: revisado';
      publishDialogSummary.textContent = 'Confirma que revisaste el resumen, las comprobaciones y la comparación preparada por Codex.';
      publishWarning.querySelector('strong').textContent = 'Todavía no se publicará nada.';
      publishWarning.querySelector('span').textContent = 'Esta confirmación solo autoriza pasar al último paso.';
      publishAcknowledgeText.textContent = 'Revisé el resumen y quiero continuar a la confirmación final.';
      confirmPublishButton.textContent = 'Sí, ya revisé';
    } else {
      publishDialogTitle.textContent = 'Segunda confirmación: publicar';
      publishDialogSummary.textContent = 'Este es el último paso. La app solo cambiará si las comprobaciones finales pasan.';
      publishWarning.querySelector('strong').textContent = 'Esto sí cambia la app para todos.';
      publishWarning.querySelector('span').textContent = 'Si algo no coincide, la publicación se detendrá.';
      publishAcknowledgeText.textContent = 'Entiendo que esta acción pondrá los cambios en vivo.';
      confirmPublishButton.textContent = 'Sí, publicar ahora';
    }
    if (typeof publishDialog.showModal === 'function') publishDialog.showModal();
  }

  async function interruptActiveJob() {
    const thread = activeThread();
    const job = thread ? activeJob(thread.id) : null;
    if (!thread || !job || !job.cancellable) return;
    stopButton.disabled = true;
    try {
      if (job.kind === 'turn' && job.serverThreadId && job.turnId) {
        try {
          await postJson('/api/code/turns', {
            operation: 'interrupt',
            clientId: clientScopeId,
            conversationId: thread.id,
            jobId: job.id,
            ...(job.serverThreadId ? { threadId: job.serverThreadId } : {}),
            ...(job.turnId ? { turnId: job.turnId } : {})
          });
        } catch (error) {
          if (!RICH_MISSING_STATUSES.has(error.status) && error.status !== 400) throw error;
          await postJson('/api/code/cancel', { jobId: job.id, clientId: clientScopeId, conversationId: thread.id });
        }
      } else {
        await postJson('/api/code/cancel', { jobId: job.id, clientId: clientScopeId, conversationId: thread.id });
      }
      updateProgress(thread, 'Deteniendo el trabajo de forma segura…');
      announce('Se pidió detener el trabajo.');
    } catch (error) {
      setThreadError(thread, error, false);
    } finally {
      stopButton.disabled = false;
      renderAll();
    }
  }

  async function respondToApproval(approvalId, decision) {
    const thread = activeThread();
    const approval = thread && thread.approvals.find(item => item.id === approvalId);
    if (!thread || !approval || approval.status !== 'pending') return;
    approval.status = 'sending';
    renderApprovals(thread);
    try {
      const result = await postJson('/api/code/approvals', {
        jobId: approval.jobId,
        approvalId: approval.id,
        clientId: clientScopeId,
        conversationId: thread.id,
        decision
      });
      approval.status = decision === 'accept' ? 'accepted' : 'declined';
      if (result && result.jobId) {
        registerJobResult(result, {
          kind: 'approval',
          action: decision,
          threadLocalId: thread.id,
          serverThreadId: thread.serverThreadId,
          cancellable: true
        });
      }
      announce(decision === 'accept' ? 'Permiso dado solo para esta vez.' : 'Acción rechazada.');
    } catch (error) {
      approval.status = 'pending';
      setThreadError(thread, error, false);
    }
    saveState();
    renderAll();
  }

  function retryActiveRequest() {
    const thread = activeThread();
    const retry = thread ? retryByThread.get(thread.id) : null;
    if (!thread || !retry || activeJob(thread.id) || sendingThreadId) return;
    thread.error = null;
    renderAll();
    if (retry.kind === 'composer') submitTurn();
    else if (retry.kind === 'action') submitSimpleAction(retry.action);
    else if (retry.kind === 'release-prepare') prepareRelease();
    else if (retry.kind === 'turn') {
      sendingThreadId = thread.id;
      queueTurn(thread, retry, false)
        .catch(error => setThreadError(thread, error, false))
        .finally(() => {
          sendingThreadId = '';
          renderAll();
        });
    } else if (retry.kind === 'release-confirm') confirmPreparedRelease();
    else if (retry.kind === 'release-publish') publishPreparedRelease();
  }

  function registerJobResult(result, description) {
    if (!result || typeof result !== 'object') throw new Error('La computadora no confirmó el pedido.');
    const thread = threads.find(item => item.id === description.threadLocalId) || activeThread();
    if (result.threadId && thread) thread.serverThreadId = safeIdentifier(result.threadId);
    if (result.turnId && thread) thread.turnId = safeIdentifier(result.turnId);
    if (validUuid(result.jobId)) {
      const job = {
        id: result.jobId,
        seq: 0,
        kind: description.kind,
        action: description.action || '',
        mode: description.mode || 'edit',
        threadLocalId: description.threadLocalId,
        conversationId: validUuid(result.conversationId) ? result.conversationId : description.threadLocalId,
        serverThreadId: safeIdentifier(result.threadId || description.serverThreadId || ''),
        turnId: safeIdentifier(result.turnId || description.turnId || ''),
        startedAt: new Date().toISOString(),
        cancellable: description.cancellable !== false
      };
      jobs.set(job.id, job);
      if (thread && job.kind !== 'threads-list') {
        thread.progress = {
          current: jobStartText(job),
          steps: [jobStartText(job)],
          startedAt: job.startedAt
        };
      }
      saveState();
      schedulePoll(60);
      return;
    }
    const directDone = result.done || result.result || result;
    handleDone({
      id: crypto.randomUUID(),
      seq: 0,
      kind: description.kind,
      action: description.action || '',
      mode: description.mode || 'edit',
      threadLocalId: description.threadLocalId,
      conversationId: validUuid(result.conversationId) ? result.conversationId : description.threadLocalId,
      serverThreadId: safeIdentifier(result.threadId || description.serverThreadId || ''),
      turnId: safeIdentifier(result.turnId || description.turnId || ''),
      startedAt: new Date().toISOString(),
      cancellable: false
    }, directDone, false);
  }

  function resumePendingJobs() {
    if (!jobs.size) return;
    for (const job of jobs.values()) {
      const thread = threadForJob(job);
      if (thread && !thread.progress.current && job.kind !== 'threads-list') {
        thread.progress = {
          current: jobStartText(job),
          steps: [jobStartText(job)],
          startedAt: job.startedAt
        };
      }
    }
    renderAll();
    schedulePoll(80);
  }

  function schedulePoll(delay = 1500) {
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(pollJobs, delay);
  }

  async function pollJobs() {
    if (!jobs.size) return;
    const entries = Array.from(jobs.values());
    for (const job of entries) {
      try {
        const scopedThread = threadForJob(job);
        if (!scopedThread) continue;
        const eventQuery = new URLSearchParams({
          jobId: job.id,
          after: String(job.seq),
          clientId: clientScopeId,
          conversationId: scopedThread.id
        });
        const state = await requestJson('/api/code/events?' + eventQuery.toString());
        for (const event of Array.isArray(state.events) ? state.events : []) {
          const sequence = Number(event.seq) || 0;
          if (sequence <= job.seq) continue;
          job.seq = sequence;
          handleEvent(job, event);
        }
        if (state.done) handleDone(job, state.done, true);
      } catch (error) {
        if (error.status === 404) {
          handleDone(job, {
            status: 'failed',
            error: 'La computadora ya no conserva este trabajo. Intenta enviarlo de nuevo.'
          }, true);
        } else {
          setConnectionState(navigator.onLine ? 'reconnecting' : 'offline', connection.lastSeen, !navigator.onLine);
        }
      }
    }
    saveState();
    renderAll();
    if (jobs.size) schedulePoll(connection.state === 'offline' ? 3500 : 1500);
  }

  function handleEvent(job, event) {
    const thread = threadForJob(job);
    if (!thread || !event || typeof event !== 'object') return;
    const meta = event.meta && typeof event.meta === 'object' ? event.meta : {};
    const kind = safeIdentifier(meta.kind || event.type || 'status');
    const isDelta = kind === 'assistant.delta' || kind === 'agent.message.delta' || meta.delta === true;
    const text = isDelta ? safeStreamText(event.text || '', 30000) : safeText(event.text || '', 30000);
    const eventKey = job.id + '-' + String(event.seq || 0);

    if (isDelta) {
      thread.streamText = safeStreamText(thread.streamText + text, 30000);
    } else if (kind === 'review.proposed') {
      const review = thread.review || cleanReview({});
      review.applied = false;
      review.summary = 'Codex preparó una propuesta y terminó sus comprobaciones. Revisa el diff antes de decidir.';
      review.changeCount = Math.max(0, Math.min(999, Number(meta.changeCount) || 0));
      review.diff = sanitizeDiff(text);
      review.fingerprint = safeIdentifier(meta.fingerprint || '');
      review.testsStatus = meta.testsPassed === true ? 'passed' : 'unknown';
      review.testsSummary = meta.testsPassed === true ? '3 de 3 comprobaciones pasaron' : 'Comprobaciones sin confirmar';
      review.testsDetail = meta.testsPassed === true
        ? 'Pruebas: aprobadas · Revisión general: aprobada · Comparación del cambio: aprobada'
        : 'La computadora todavía no confirmó todas las comprobaciones.';
      thread.review = review;
      updateProgress(thread, 'Propuesta lista para revisar y aprobar.');
    } else if (kind === 'approval.required' || kind === 'command.approval' || kind === 'file.approval') {
      const approvalId = safeIdentifier(meta.approvalId || meta.id);
      if (approvalId && !thread.approvals.some(item => item.id === approvalId)) {
        const approvalKind = safeIdentifier(meta.approvalType || kind);
        thread.approvals.push({
          id: approvalId,
          jobId: job.id,
          title: safeText(meta.title || approvalTitle(approvalKind), 160),
          summary: text || safeText(meta.summary || '', 1200),
          risk: safeText(meta.risk || defaultApprovalRisk(approvalKind), 800),
          detail: safeCommandDetail(meta.detail || meta.command || ''),
          status: 'pending'
        });
        announce('Codex necesita tu permiso para continuar.');
      }
    } else if (kind === 'approval.resolved') {
      const approval = thread.approvals.find(item => item.id === safeIdentifier(meta.approvalId || meta.id));
      if (approval) approval.status = meta.decision === 'accept' ? 'accepted' : 'declined';
    } else if (kind === 'thread.started' || kind === 'thread.resumed' || kind === 'thread.read') {
      if (meta.threadId) {
        thread.serverThreadId = safeIdentifier(meta.threadId);
        job.serverThreadId = thread.serverThreadId;
      }
      if (text) updateProgress(thread, text);
    } else if (kind === 'turn.started') {
      if (meta.turnId) {
        thread.turnId = safeIdentifier(meta.turnId);
        job.turnId = thread.turnId;
      }
      if (text) updateProgress(thread, text);
    } else if (event.type === 'assistant' || kind === 'assistant.message') {
      flushStream(thread, eventKey);
      addMessage(thread, 'assistant', text, { eventKey });
    } else if (event.type === 'result' || kind === 'turn.result') {
      flushStream(thread, eventKey);
      addMessage(thread, 'assistant', text, { eventKey });
    } else if (event.type === 'error' || kind === 'error' || kind === 'usage.limit') {
      const error = new Error(text || 'No se pudo terminar el trabajo.');
      if (kind === 'usage.limit') error.code = 'USAGE_LIMIT';
      setThreadError(thread, error, false);
    } else if (event.type === 'log' || kind.includes('command') || kind.includes('output')) {
      // Developer output stays hidden. Approval cards may show a short sanitized detail.
    } else if (text) {
      updateProgress(thread, text);
    }
    thread.updatedAt = new Date().toISOString();
  }

  function handleDone(job, done, removeRegisteredJob) {
    const thread = threadForJob(job);
    if (!thread || !done || typeof done !== 'object') {
      if (removeRegisteredJob) jobs.delete(job.id);
      return;
    }
    const status = String(done.status || 'completed');
    const data = objectValue(done.data) || {};
    const release = objectValue(done.release)
      || objectValue(data.release)
      || (job.kind.startsWith('release-') && (
        done.releaseId || data.releaseId || done.confirmationToken || data.confirmationToken || done.publishToken || data.publishToken
      )
        ? { ...done, ...data }
        : null);

    flushStream(thread, job.id + '-done');
    applyThreadPayload(thread, data, job);
    const editReview = objectValue(data.review);
    if (editReview) applyReleasePayload(thread, editReview, done);
    if (release) applyReleasePayload(thread, release, done);

    if (status === 'failed') {
      const error = new Error(done.error || data.error || 'No se pudo terminar el trabajo.');
      error.code = done.code || data.code || '';
      if (job.kind === 'release-publish') {
        releaseSessions.delete(thread.id);
        retryByThread.delete(thread.id);
        const friendly = makeFriendlyError(error);
        friendly.title = 'La publicación no quedó verificada';
        friendly.detail = safeText(error.message, 3000) || 'La computadora detuvo la publicación y no la marcó como terminada. Miguel debe revisar el punto de restauración antes de volver a intentar.';
        friendly.kind = 'safety';
        friendly.retryable = false;
        setThreadError(thread, friendly, true);
      } else {
        setThreadError(thread, error, true);
      }
    } else if (status === 'cancelled') {
      thread.error = null;
      addMessage(thread, 'assistant', 'El trabajo se detuvo. No se publicó nada.', {
        eventKey: job.id + '-cancelled'
      });
      announce('Trabajo detenido.');
    } else {
      thread.error = null;
      const summary = safeText(done.summary || data.summary || '', 30000);
      if (summary) addMessage(thread, 'assistant', summary, { eventKey: job.id + '-summary' });
      applySuccessfulJobReview(thread, job, done, data);
      handleCompletedJobFlow(thread, job, done, data, release);
    }

    thread.progress = cleanProgress(null);
    thread.updatedAt = new Date().toISOString();
    if (removeRegisteredJob) jobs.delete(job.id);
    saveState();
    if (thread.id === activeThreadId) {
      renderAll();
      scrollToLatest(true);
    } else {
      renderThreadList();
    }
    refreshStatus();
  }

  function applySuccessfulJobReview(thread, job, done, data) {
    const summary = safeText(done.summary || data.summary || '', 8000);
    if (job.kind === 'turn' && job.mode === 'edit') {
      thread.review = thread.review || cleanReview({});
      thread.review.summary = summary || thread.review.summary;
      if (data.testsPassed === true) {
        thread.review.testsStatus = 'passed';
        thread.review.testsSummary = 'Todas las comprobaciones pasaron';
      }
    }
    if (job.kind === 'checks') {
      thread.review = thread.review || cleanReview({});
      thread.review.summary = summary || 'La comprobación terminó.';
      if (objectValue(data.tests)) applyReleasePayload(thread, { tests: data.tests }, done);
      else {
        thread.review.testsStatus = 'unknown';
        thread.review.testsSummary = 'Resultado detallado no confirmado';
        thread.review.testsDetail = 'El resumen terminó, pero no llegó evidencia separada de las comprobaciones.';
      }
    }
    if (job.kind === 'preview') {
      thread.review = thread.review || cleanReview({});
      thread.review.summary = summary || 'La vista previa está lista.';
      if (objectValue(data.tests)) applyReleasePayload(thread, { tests: data.tests, previewUrl: data.previewUrl }, done);
      else {
        thread.review.testsStatus = 'unknown';
        thread.review.testsSummary = 'Comprobaciones sin detalle confirmado';
      }
      const url = safeHttps(done.url || data.url || data.previewUrl);
      if (url) thread.review.previewUrl = url;
    }
  }

  function handleCompletedJobFlow(thread, job, done, data, release) {
    if (job.kind === 'release-prepare') {
      const session = releaseSessionFrom(release || data || done);
      if (!session.releaseId || !session.confirmationToken || !session.fingerprint) {
        setThreadError(thread, new Error('La preparación no devolvió todas las confirmaciones necesarias. Nada se publicó.'), false);
        return;
      }
      if (thread.review?.testsStatus !== 'passed' || !thread.review.previewUrl) {
        setThreadError(thread, new Error('La preparación no confirmó las tres comprobaciones y una vista previa segura. Nada se publicó.'), false);
        return;
      }
      releaseSessions.set(thread.id, session);
      window.setTimeout(() => openPublishDialog('review', thread), 80);
    } else if (job.kind === 'release-confirm') {
      const current = releaseSessions.get(thread.id) || {};
      const next = {
        ...current,
        ...releaseSessionFrom(release || data || done)
      };
      if (!next.publishToken) {
        setThreadError(thread, new Error('No se recibió la autorización final. Nada se publicó.'), false);
        return;
      }
      releaseSessions.set(thread.id, next);
      window.setTimeout(() => openPublishDialog('publish', thread), 80);
    } else if (job.kind === 'release-publish') {
      if (thread.review?.published && thread.review.publishedUrl) {
        releaseSessions.delete(thread.id);
        announce('Publicación confirmada por la computadora.');
      } else {
        setThreadError(thread, new Error('La computadora no confirmó una versión publicada y una dirección en vivo. No mostraré este trabajo como publicado.'), true);
      }
    }
  }

  function applyThreadPayload(thread, data, job) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.threads)) mergeRemoteThreads(data.threads);
    const remote = objectValue(data.thread);
    if (remote) {
      if (remote.id) thread.serverThreadId = safeIdentifier(remote.id);
      if (remote.name || remote.title) thread.title = safeTitle(remote.name || remote.title);
    }
    if (['thread-resume', 'thread-read'].includes(job.kind) && Array.isArray(data.history)) {
      thread.messages = messagesFromRemote(data.history);
    }
    const turn = objectValue(data.turn);
    if (turn && turn.id) {
      thread.turnId = safeIdentifier(turn.id);
      job.turnId = thread.turnId;
    }
    if (data.threadId) {
      thread.serverThreadId = safeIdentifier(data.threadId);
      job.serverThreadId = thread.serverThreadId;
    }
    if (data.turnId) {
      thread.turnId = safeIdentifier(data.turnId);
      job.turnId = thread.turnId;
    }
  }

  function mergeRemoteThreads(remoteThreads) {
    for (const remote of remoteThreads.slice(0, 30)) {
      if (!remote || typeof remote !== 'object') continue;
      const serverThreadId = safeIdentifier(remote.id || remote.threadId);
      if (!serverThreadId) continue;
      const conversationId = validUuid(remote.conversationId) ? remote.conversationId : '';
      let thread = threads.find(item => item.serverThreadId === serverThreadId || (conversationId && item.id === conversationId));
      if (!thread) {
        thread = createThread({
          id: conversationId,
          title: safeTitle(remote.name || remote.title || 'Conversación anterior'),
          serverThreadId,
          updatedAt: validDate(remote.updatedAt || remote.createdAt) || new Date().toISOString()
        });
        threads.push(thread);
      } else {
        thread.title = safeTitle(remote.name || remote.title || thread.title);
        thread.updatedAt = validDate(remote.updatedAt) || thread.updatedAt;
      }
      if (Array.isArray(remote.messages) && !thread.messages.length) thread.messages = messagesFromRemote(remote.messages);
    }
    saveState();
    renderThreadList();
  }

  function messagesFromRemote(messages) {
    const output = [];
    for (const item of messages.slice(-MAX_STORED_MESSAGES)) {
      if (!item || typeof item !== 'object') continue;
      const role = item.role === 'user' || item.type === 'user' ? 'user' : item.role === 'assistant' || item.type === 'assistant' ? 'assistant' : '';
      const text = safeText(item.text || item.content || item.message || '', 30000);
      if (role && text) output.push({
        id: crypto.randomUUID(),
        role,
        text,
        label: role === 'user' ? 'Tú' : 'Codex',
        at: Date.parse(item.createdAt || item.at) || Date.now(),
        kind: 'history',
        eventKey: '',
        attachments: 0
      });
    }
    return output;
  }

  function applyReleasePayload(thread, release, done) {
    const review = thread.review || cleanReview({});
    review.releaseId = safeIdentifier(release.releaseId || release.id || review.releaseId);
    review.releaseStage = ['prepared', 'confirmed', 'consumed', 'published'].includes(release.stage) ? release.stage : review.releaseStage;
    if (typeof release.applied === 'boolean') review.applied = release.applied;
    review.summary = safeText(release.summary || done.summary || review.summary, 8000);
    const diff = objectValue(release.diff);
    review.fingerprint = safeIdentifier(release.fingerprint || diff?.sha256 || review.fingerprint);
    const pathCount = Array.isArray(release.paths) ? release.paths.length : 0;
    review.changeCount = Math.max(0, Math.min(999, Number(diff?.count ?? pathCount ?? review.changeCount) || 0));
    review.changeSummary = safeText(diff?.summary || review.changeSummary, 1000);
    review.diff = sanitizeDiff(diff?.preview || review.diff);
    const tests = objectValue(release.tests);
    if (tests) {
      const checks = [
        ['Pruebas', tests.test?.ok === true],
        ['Revisión general', tests.check?.ok === true],
        ['Comparación del cambio', tests.diffCheck?.ok === true]
      ];
      const passed = checks.filter(([, ok]) => ok).length;
      review.testsStatus = passed === checks.length ? 'passed' : 'failed';
      review.testsSummary = passed === checks.length ? '3 de 3 comprobaciones pasaron' : String(passed) + ' de 3 comprobaciones pasaron';
      review.testsDetail = checks.map(([label, ok]) => label + ': ' + (ok ? 'aprobada' : 'necesita atención')).join(' · ');
    } else if (!['passed', 'failed'].includes(review.testsStatus)) {
      review.testsStatus = 'unknown';
      review.testsSummary = 'Comprobaciones sin evidencia';
      review.testsDetail = 'La computadora no envió el resultado separado de pruebas, revisión y comparación.';
    }
    review.previewUrl = safeHttps(release.previewUrl || release.url || review.previewUrl);
    if (review.releaseStage === 'published') {
      const publishedUrl = safeHttps(done.url);
      review.published = Boolean(publishedUrl);
      review.publishedUrl = publishedUrl;
    }
    thread.review = review;
  }

  function releaseSessionFrom(value) {
    const source = objectValue(value) || {};
    return {
      releaseId: safeIdentifier(source.releaseId || source.id || ''),
      confirmationToken: safeIdentifier(source.confirmationToken || ''),
      publishToken: safeIdentifier(source.publishToken || ''),
      fingerprint: safeIdentifier(source.fingerprint || '')
    };
  }

  function addMessage(thread, role, text, options = {}) {
    const clean = safeText(text, 30000);
    if (!clean) return;
    if (options.eventKey && thread.messages.some(item => item.eventKey === options.eventKey)) return;
    const previous = thread.messages.at(-1);
    if (role === 'assistant' && previous && previous.role === 'assistant' && previous.text === clean) return;
    thread.messages.push({
      id: crypto.randomUUID(),
      role,
      text: clean,
      label: role === 'user' ? 'Tú' : 'Codex',
      at: Date.now(),
      kind: options.kind || 'message',
      eventKey: options.eventKey || '',
      attachments: options.attachments || 0
    });
    thread.messages = thread.messages.slice(-MAX_STORED_MESSAGES);
    thread.updatedAt = new Date().toISOString();
    saveState();
  }

  function flushStream(thread, eventKey) {
    if (!thread.streamText) return;
    addMessage(thread, 'assistant', thread.streamText, {
      kind: 'stream-complete',
      eventKey: eventKey + '-stream'
    });
    thread.streamText = '';
  }

  function updateProgress(thread, text) {
    const clean = safeText(text, 500);
    if (!clean) return;
    thread.progress.current = clean;
    thread.progress.startedAt ||= new Date().toISOString();
    if (thread.progress.steps.at(-1) !== clean) thread.progress.steps.push(clean);
    thread.progress.steps = thread.progress.steps.slice(-6);
  }

  function setThreadError(thread, error, preserveRetry) {
    const friendly = error && error.kind ? error : makeFriendlyError(error);
    thread.error = {
      title: friendly.title,
      detail: friendly.detail,
      kind: friendly.kind,
      retryable: friendly.retryable
    };
    if (!preserveRetry && !retryByThread.has(thread.id)) retryByThread.set(thread.id, { kind: 'composer' });
    thread.updatedAt = new Date().toISOString();
    saveState();
    if (thread.id === activeThreadId) {
      renderAll();
      scrollToLatest(true);
    }
    announce(friendly.title + '. ' + friendly.detail);
  }

  function makeFriendlyError(error) {
    const status = Number(error && error.status) || 0;
    const code = String(error && error.code || '');
    const raw = safeText(error && error.message || error || '', 3000);
    if (status === 429 || /usage|quota|rate.?limit|too many/i.test(code + ' ' + raw)) {
      return {
        title: 'Límite de uso alcanzado',
        detail: 'Codex no puede empezar otro trabajo en este momento. Nada se publicó. Intenta otra vez más tarde.',
        kind: 'usage',
        retryable: true
      };
    }
    if (!navigator.onLine || /offline|network|fetch|conexión|timeout|timed out/i.test(raw)) {
      return {
        title: 'Se perdió la conexión',
        detail: 'Tu pedido no se repetirá solo. Revisa internet y pulsa Intentar otra vez cuando estés listo.',
        kind: 'offline',
        retryable: true
      };
    }
    if (/credential|secret|protected|permiso|permission|seguridad|safety/i.test(code + ' ' + raw)) {
      return {
        title: 'El trabajo se detuvo por seguridad',
        detail: raw || 'Codex encontró una acción que necesita revisión. Nada se publicó.',
        kind: 'safety',
        retryable: false
      };
    }
    return {
      title: 'No se pudo terminar',
      detail: raw || 'La computadora no confirmó el resultado. Nada nuevo se publicó.',
      kind: 'failed',
      retryable: true
    };
  }

  async function uploadSelectedAttachments(thread) {
    const uploaded = [];
    for (const attachment of selectedAttachments) {
      if (attachment.attachmentId) {
        uploaded.push(attachment);
        continue;
      }
      attachment.status = 'uploading';
      renderAttachments();
      try {
        const data = await fileToBase64(attachment.file);
        const result = await postJson('/api/code/attachments', {
          clientId: clientScopeId,
          conversationId: thread.id,
          name: safeFilename(attachment.file.name),
          mime: attachment.mime,
          data
        });
        const attachmentId = safeIdentifier(result.attachmentId || result.id);
        if (!attachmentId) throw new Error('La computadora no confirmó el archivo adjunto.');
        attachment.attachmentId = attachmentId;
        attachment.status = 'ready';
        uploaded.push(attachment);
      } catch (error) {
        attachment.status = 'failed';
        renderAttachments();
        throw error;
      }
    }
    return uploaded;
  }

  function addAttachments(files) {
    const thread = activeThread();
    if (!thread || !files.length) return;
    const errors = [];
    for (const file of files) {
      if (selectedAttachments.length >= MAX_ATTACHMENTS) {
        errors.push('Puedes adjuntar hasta 4 archivos por pedido.');
        break;
      }
      const extension = fileExtension(file.name);
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        errors.push('“' + safeFilename(file.name) + '” no es un tipo permitido.');
        continue;
      }
      if (!Number.isFinite(file.size) || file.size < 1 || file.size > MAX_ATTACHMENT_BYTES) {
        errors.push('“' + safeFilename(file.name) + '” debe pesar 3 MB o menos para poder enviarse de forma segura.');
        continue;
      }
      const total = selectedAttachments.reduce((sum, item) => sum + item.file.size, 0) + file.size;
      if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
        errors.push('Los archivos juntos deben pesar 12 MB o menos.');
        continue;
      }
      const mime = MIME_BY_EXTENSION[extension];
      if (file.type && !mimeMatches(extension, file.type)) {
        errors.push('“' + safeFilename(file.name) + '” no coincide con su tipo de archivo.');
        continue;
      }
      selectedAttachments.push({
        localId: crypto.randomUUID(),
        file,
        extension,
        mime,
        previewUrl: mime.startsWith('image/') || mime === 'application/pdf' ? URL.createObjectURL(file) : '',
        attachmentId: '',
        status: 'ready'
      });
    }
    renderAttachments();
    updateControls();
    if (errors.length) {
      thread.error = {
        title: 'Revisa los archivos',
        detail: errors.join('\n'),
        kind: 'safety',
        retryable: false
      };
      renderError(thread);
      announce(errors.join(' '));
    } else {
      thread.error = null;
      renderError(thread);
      announce(selectedAttachments.length === 1 ? 'Archivo listo para adjuntar.' : String(selectedAttachments.length) + ' archivos listos para adjuntar.');
    }
  }

  function removeAttachment(localId) {
    const index = selectedAttachments.findIndex(item => item.localId === localId);
    if (index < 0) return;
    const [removed] = selectedAttachments.splice(index, 1);
    if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    renderAttachments();
    updateControls();
    announce('Archivo quitado.');
  }

  function clearAttachments() {
    for (const attachment of selectedAttachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    selectedAttachments = [];
    renderAttachments();
    updateControls();
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('No se pudo leer el archivo adjunto.'));
      reader.onload = () => {
        const value = String(reader.result || '');
        const comma = value.indexOf(',');
        if (comma < 0) reject(new Error('El archivo adjunto no se pudo preparar.'));
        else resolve(value.slice(comma + 1));
      };
      reader.readAsDataURL(file);
    });
  }

  function mimeMatches(extension, mime) {
    const normalized = String(mime || '').toLowerCase();
    const expected = MIME_BY_EXTENSION[extension];
    if (normalized === expected) return true;
    if (['pptx', 'ppsx'].includes(extension) && ['application/zip', 'application/octet-stream'].includes(normalized)) return true;
    if (extension === 'jpg' || extension === 'jpeg') return ['image/jpeg', 'image/jpg'].includes(normalized);
    if (extension === 'md') return ['text/markdown', 'text/plain'].includes(normalized);
    return false;
  }

  async function requestJson(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...options,
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {})
        }
      });
    } catch {
      const error = new Error('No hay conexión con el servicio de edición.');
      error.code = 'NETWORK_ERROR';
      throw error;
    }
    let data = {};
    try {
      data = await response.json();
    } catch {}
    if (!response.ok) {
      const error = new Error(safeText(data.message || data.error || 'No se pudo completar la solicitud.', 3000));
      error.status = response.status;
      error.code = String(data.code || data.error || '');
      error.data = data;
      throw error;
    }
    return data;
  }

  function postJson(path, body) {
    return requestJson(path, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  function appendLinkedText(container, text) {
    const pattern = /https:\/\/[A-Za-z0-9.-]+(?:\/[^\s<]*)?/g;
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      container.append(document.createTextNode(text.slice(start, match.index)));
      const url = safeHttps(match[0]);
      if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = url;
        container.append(link);
      } else {
        container.append(document.createTextNode(match[0]));
      }
      start = match.index + match[0].length;
    }
    container.append(document.createTextNode(text.slice(start)));
  }

  function safeText(value, limit = 30000) {
    return safeStreamText(value, limit).trim();
  }

  function safeStreamText(value, limit = 30000) {
    return String(value || '')
      .normalize('NFC')
      .replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
      .replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, '')
      .replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, 'el proyecto')
      .replace(/\\\\[^\s"'<>]+\\[^\s"'<>]+/g, 'el proyecto')
      .replace(/(^|[\s("'])\/(?:Users|home|workspace|tmp|mnt)\/[^\s)"']+/g, '$1el proyecto')
      .replace(/file:\/\/\/[^\s)"']+/gi, 'el proyecto')
      .replace(/Bearer\s+[A-Za-z0-9._~-]{12,}/gi, 'Bearer [oculto]')
      .replace(/((?:token|secret|password|credential|authorization|api[_-]?key)\s*[=:]\s*)([^\s,;]+)/gi, '$1[oculto]')
      .slice(0, limit);
  }

  function safeCommandDetail(value) {
    return safeText(value, 1200)
      .replace(/(?:^|\s)(?:cd|pwd|dir|ls|cat|type|Get-Content|Set-Content|Remove-Item|rm|del)(?:\s|$)[^\r\n]*/gi, ' [detalle del comando oculto]')
      .trim();
  }

  function sanitizeDiff(value) {
    const clean = safeText(value, 30000);
    if (!clean) return '';
    return clean
      .split('\n')
      .filter(line => !/^diff --git\s/i.test(line))
      .map(line => {
        if (/^(---|\+\+\+)\s/.test(line)) {
          const marker = line.slice(0, 3);
          const filename = safeFilename(line.slice(4).replace(/^[ab]\//, ''));
          return marker + ' ' + filename;
        }
        if (/(?:token|secret|password|credential|authorization|api[_-]?key)\s*[=:]/i.test(line)) {
          return line.slice(0, 1) + '[contenido sensible oculto]';
        }
        return line;
      })
      .join('\n')
      .slice(0, 30000);
  }

  function safeFilename(value) {
    const text = String(value || '').replace(/\\/g, '/').split('/').pop() || 'archivo';
    return safeText(text, 140).replace(/[<>:"|?*]/g, '').trim() || 'archivo';
  }

  function safeTitle(value) {
    return safeText(value || 'Nueva conversación', 80).replace(/[\r\n]+/g, ' ') || 'Nueva conversación';
  }

  function safeIdentifier(value) {
    const text = String(value || '').trim();
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(text) ? text : '';
  }

  function safeHttps(value) {
    const text = String(value || '').trim();
    if (!/^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s<>]*)?$/.test(text)) return '';
    try {
      const url = new URL(text);
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function validUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  }

  function validDate(value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : '';
  }

  function objectValue(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    return null;
  }

  function fileExtension(name) {
    return String(name || '').split('.').pop().toLowerCase();
  }

  function titleFromPrompt(text) {
    const clean = safeText(text, 80).replace(/[\r\n]+/g, ' ');
    return clean.length > 55 ? clean.slice(0, 52).trimEnd() + '…' : clean || 'Nueva conversación';
  }

  function relativeTime(value) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return 'Fecha desconocida';
    const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
    if (seconds < 45) return 'Ahora';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return 'Hace ' + String(minutes) + ' min';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return 'Hace ' + String(hours) + (hours === 1 ? ' hora' : ' horas');
    const days = Math.round(hours / 24);
    if (days < 7) return 'Hace ' + String(days) + (days === 1 ? ' día' : ' días');
    return new Intl.DateTimeFormat('es', { month: 'short', day: 'numeric' }).format(new Date(parsed));
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return String(Math.max(1, Math.round(bytes / 1024))) + ' KB';
    return (bytes / (1024 * 1024)).toLocaleString('es', { maximumFractionDigits: 1 }) + ' MB';
  }

  function normalizeTestStatus(value) {
    const text = String(value || '').toLowerCase();
    if (['passed', 'pass', 'success', 'ok'].includes(text)) return 'passed';
    if (['failed', 'fail', 'error'].includes(text)) return 'failed';
    return 'unknown';
  }

  function humanChangeSummary(changes) {
    if (!Array.isArray(changes) || !changes.length) return '';
    const descriptions = changes
      .map(item => {
        if (typeof item === 'string') return safeText(item, 180);
        if (!item || typeof item !== 'object') return '';
        return safeText(item.summary || item.title || item.description || '', 180);
      })
      .filter(Boolean)
      .slice(0, 4);
    return descriptions.join(' · ');
  }

  function approvalTitle(kind) {
    if (kind.includes('file')) return 'Permiso para cambiar archivos';
    if (kind.includes('command')) return 'Permiso para una comprobación';
    return 'Codex necesita tu permiso';
  }

  function defaultApprovalRisk(kind) {
    if (kind.includes('file')) return 'Permitir puede modificar la copia de trabajo. Nada se publicará todavía.';
    return 'Permitir ejecuta esta acción una sola vez dentro del proyecto protegido.';
  }

  function jobStartText(job) {
    return {
      turn: 'Codex está entendiendo tu pedido…',
      checks: 'Comprobando la app…',
      preview: 'Preparando una vista previa…',
      'release-prepare': 'Preparando pruebas, vista previa y comparación…',
      'release-confirm': 'Confirmando que el resumen fue revisado…',
      'release-publish': 'Haciendo las comprobaciones finales…',
      'thread-resume': 'Abriendo la conversación…',
      approval: 'Continuando después de tu decisión…'
    }[job.kind] || 'Preparando el trabajo…';
  }

  function announce(text) {
    liveAnnouncer.textContent = '';
    window.setTimeout(() => {
      liveAnnouncer.textContent = safeText(text, 500);
    }, 20);
  }

  function isNearBottom() {
    return editorScroll.scrollHeight - editorScroll.scrollTop - editorScroll.clientHeight < 160;
  }

  function scrollToLatest(smooth) {
    window.setTimeout(() => {
      editorScroll.scrollTo({
        top: editorScroll.scrollHeight,
        behavior: smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto'
      });
    }, 30);
  }
})();
