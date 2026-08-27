(async () => {
  'use strict';

  const storage = {
    conversation: 'cb_code_conversation_v1',
    messages: 'cb_code_messages_v1'
  };
  const el = id => document.getElementById(id);
  const gate = el('accessGate');
  const shell = el('appShell');
  const conversation = el('conversation');
  const prompt = el('prompt');
  const sendButton = el('sendButton');
  const cancelButton = el('cancelButton');
  const mode = el('mode');
  const provider = el('provider');
  const hostStatus = el('hostStatus');
  const hostStatusText = el('hostStatusText');
  const computerPanel = el('computerPanel');
  const publishDialog = el('publishDialog');

  const pairingAccess = readPairingAccess();
  let conversationId = validUuid(localStorage.getItem(storage.conversation)) ? localStorage.getItem(storage.conversation) : crypto.randomUUID();
  let activeJob = null;
  let statusTimer = null;
  let eventTimer = null;
  let messages = loadMessages();
  localStorage.setItem(storage.conversation, conversationId);

  if (!await establishPrivateSession(pairingAccess)) {
    gate.hidden = false;
    return;
  }
  shell.hidden = false;
  renderMessages();
  updateEmptyState();
  refreshStatus();
  statusTimer = window.setInterval(refreshStatus, 12000);

  document.querySelectorAll('[data-suggestion]').forEach(button => button.addEventListener('click', () => {
    prompt.value = button.dataset.suggestion;
    resizePrompt();
    prompt.focus();
  }));
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'publish') publishDialog.showModal();
    else submitJob(action);
  }));
  publishDialog.addEventListener('close', () => {
    if (publishDialog.returnValue === 'publish') submitJob('publish');
  });
  el('computerPanel').addEventListener('click', refreshStatus);
  hostStatus.addEventListener('click', () => {
    computerPanel.hidden = !computerPanel.hidden;
    if (!computerPanel.hidden) refreshStatus();
  });
  sendButton.addEventListener('click', () => submitJob('prompt'));
  cancelButton.addEventListener('click', cancelActiveJob);
  prompt.addEventListener('input', () => { resizePrompt(); updateControls(); });
  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && window.innerWidth > 700) {
      event.preventDefault();
      submitJob('prompt');
    }
  });

  function readPairingAccess() {
    localStorage.removeItem('cb_code_access_v1');
    const params = new URLSearchParams(location.hash.slice(1));
    const paired = params.get('access');
    if (paired && /^[A-Za-z0-9_-]{40,180}$/.test(paired)) {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      return paired;
    }
    return '';
  }

  async function establishPrivateSession(pairingKey) {
    try {
      const response = pairingKey
        ? await fetch('/api/code/pair', { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'X-Code-Pairing': pairingKey } })
        : await fetch('/api/code/status', { cache: 'no-store', credentials: 'same-origin' });
      return response.ok;
    } catch { return false; }
  }

  function validUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  }

  function loadMessages() {
    try {
      const value = JSON.parse(localStorage.getItem(storage.messages) || '[]');
      return Array.isArray(value) ? value.filter(item => item && ['user', 'assistant', 'status', 'error'].includes(item.role) && typeof item.text === 'string').slice(-60) : [];
    } catch { return []; }
  }

  function saveMessages() {
    localStorage.setItem(storage.messages, JSON.stringify(messages.slice(-60)));
  }

  function addMessage(role, text, label) {
    if (!text) return;
    messages.push({ role, text: String(text).slice(0, 30000), label: label || '', at: Date.now() });
    saveMessages();
    renderMessages();
    updateEmptyState();
    window.setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 30);
  }

  function renderMessages() {
    conversation.replaceChildren();
    for (const item of messages) {
      const wrapper = document.createElement('article');
      wrapper.className = `message ${item.role}`;
      if (item.label) {
        const label = document.createElement('span');
        label.className = 'messageLabel';
        label.textContent = item.label;
        wrapper.append(label);
      }
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      appendLinkedText(bubble, item.text);
      wrapper.append(bubble);
      conversation.append(wrapper);
    }
    if (activeJob) {
      const wrapper = document.createElement('article');
      wrapper.className = 'message status';
      wrapper.id = 'workingMessage';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = '<span class="typingDots" aria-label="Trabajando"><i></i><i></i><i></i></span>';
      wrapper.append(bubble);
      conversation.append(wrapper);
    }
  }

  function appendLinkedText(container, text) {
    const pattern = /https:\/\/[A-Za-z0-9.-]+(?:\/[^\s<]*)?/g;
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      container.append(document.createTextNode(text.slice(start, match.index)));
      const link = document.createElement('a');
      link.href = match[0];
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = match[0];
      container.append(link);
      start = match.index + match[0].length;
    }
    container.append(document.createTextNode(text.slice(start)));
  }

  function updateEmptyState() {
    el('welcome').hidden = messages.length > 0;
  }

  function resizePrompt() {
    prompt.style.height = 'auto';
    prompt.style.height = `${Math.min(prompt.scrollHeight, 150)}px`;
  }

  function updateControls() {
    const busy = Boolean(activeJob);
    sendButton.disabled = busy || !prompt.value.trim();
    cancelButton.hidden = !busy;
    mode.disabled = busy;
    provider.disabled = busy;
    document.querySelectorAll('[data-action]').forEach(button => { button.disabled = busy; });
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      if (response.status === 403 && data.error === 'EDITOR_ACCESS_DENIED') {
        shell.hidden = true;
        gate.hidden = false;
      }
      throw new Error(data.message || 'No se pudo conectar. Intenta otra vez.');
    }
    return data;
  }

  async function refreshStatus() {
    try {
      const status = await api('/api/code/status');
      hostStatus.classList.toggle('online', status.online && !status.busy);
      hostStatus.classList.toggle('busy', status.online && status.busy);
      hostStatusText.textContent = status.busy ? 'Trabajando' : status.online ? 'Conectada' : 'En espera';
      el('computerTitle').textContent = status.busy ? 'La computadora está trabajando' : status.online ? 'Computadora conectada' : 'Computadora desconectada';
      el('computerDetail').textContent = status.online
        ? 'Lista para revisar todos los archivos y hacer cambios.'
        : `Los pedidos quedarán esperando hasta que la computadora de Miguel esté encendida${status.lastSeen ? ` (última conexión ${relativeTime(status.lastSeen)})` : ''}.`;
      const list = el('providerList');
      list.replaceChildren();
      for (const item of status.providers || []) {
        const pill = document.createElement('span');
        pill.className = `providerPill${item.available ? ' ready' : ''}`;
        pill.textContent = item.name || item.id;
        pill.title = item.available ? 'Disponible' : item.reason || 'No disponible';
        list.append(pill);
      }
    } catch {
      hostStatus.classList.remove('online', 'busy');
      hostStatusText.textContent = 'Sin conexión';
    }
  }

  function relativeTime(value) {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
    if (seconds < 60) return 'hace menos de un minuto';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `hace ${minutes} min`;
    return `hace ${Math.round(minutes / 60)} h`;
  }

  function actionLabel(action) {
    return { checks: 'Comprueba que toda la app funcione bien.', preview: 'Crea una vista previa para que pueda revisar los cambios.', publish: 'Comprueba y publica los cambios en la app.' }[action];
  }

  async function submitJob(action) {
    if (activeJob) return;
    const text = action === 'prompt' ? prompt.value.trim() : actionLabel(action);
    if (!text) return;
    addMessage('user', text, action === 'prompt' ? 'Tú' : 'Acción');
    if (action === 'prompt') { prompt.value = ''; resizePrompt(); }
    activeJob = { id: null, seq: 0 };
    renderMessages();
    updateControls();
    try {
      const result = await api('/api/code/message', {
        method: 'POST',
        body: JSON.stringify({ action, prompt: action === 'prompt' ? text : '', mode: mode.value, provider: provider.value, conversationId })
      });
      activeJob.id = result.jobId;
      conversationId = result.conversationId;
      localStorage.setItem(storage.conversation, conversationId);
      addMessage('status', 'Pedido recibido. La computadora lo empezará en cuanto esté disponible.');
      pollEvents();
      refreshStatus();
    } catch (error) {
      activeJob = null;
      addMessage('error', error.message);
      updateControls();
    }
  }

  async function pollEvents() {
    if (!activeJob?.id) return;
    window.clearTimeout(eventTimer);
    try {
      const state = await api(`/api/code/events?jobId=${encodeURIComponent(activeJob.id)}&after=${activeJob.seq}`);
      for (const event of state.events || []) {
        activeJob.seq = Math.max(activeJob.seq, Number(event.seq) || 0);
        if (event.type === 'assistant' || event.type === 'result') addMessage('assistant', event.text, event.meta?.provider || 'Ayudante');
        else if (event.type === 'error') addMessage('error', event.text);
        else addMessage('status', event.text);
      }
      if (state.done) {
        const done = state.done;
        if (done.url && !messages.some(item => item.text.includes(done.url))) addMessage('assistant', `Listo. Puedes abrirlo aquí:\n${done.url}`, done.provider || 'Ayudante');
        if (done.status === 'failed' && done.error) addMessage('error', done.error);
        else if (done.status === 'cancelled') addMessage('status', 'Trabajo detenido.');
        else if (done.summary && !messages.some(item => item.text === done.summary)) addMessage('assistant', done.summary, done.provider || 'Ayudante');
        activeJob = null;
        renderMessages();
        updateControls();
        refreshStatus();
        return;
      }
    } catch (error) {
      addMessage('status', `Esperando conexión: ${error.message}`);
    }
    eventTimer = window.setTimeout(pollEvents, 1800);
  }

  async function cancelActiveJob() {
    if (!activeJob?.id) return;
    cancelButton.disabled = true;
    try {
      await api('/api/code/cancel', { method: 'POST', body: JSON.stringify({ jobId: activeJob.id }) });
      addMessage('status', 'Se pidió detener el trabajo…');
    } catch (error) { addMessage('error', error.message); }
    cancelButton.disabled = false;
  }

  updateControls();
})();
