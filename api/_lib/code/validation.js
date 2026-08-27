const crypto = require('node:crypto');
const { CmsError } = require('../cms/core');
const { requireUuid } = require('./security');

const ACTIONS = new Set(['prompt', 'checks', 'preview', 'publish']);
const MODES = new Set(['edit', 'plan']);
const PROVIDERS = new Set(['auto', 'codex', 'kimi', 'local', 'claude', 'fugu']);

function cleanPrompt(value, required) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new CmsError(400, 'INVALID_PROMPT', 'La instrucción no es válida.');
  const prompt = value
    .normalize('NFC')
    .replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if ((required && !prompt) || prompt.length > 12000) {
    throw new CmsError(400, 'INVALID_PROMPT', 'Escribe una instrucción de hasta 12,000 caracteres.');
  }
  return prompt;
}

function validateJobInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CmsError(400, 'INVALID_JOB', 'La solicitud no es válida.');
  }
  const action = String(input.action || 'prompt');
  const mode = String(input.mode || 'edit');
  const provider = String(input.provider || 'auto');
  if (!ACTIONS.has(action)) throw new CmsError(400, 'INVALID_ACTION', 'La acción no es válida.');
  if (!MODES.has(mode)) throw new CmsError(400, 'INVALID_MODE', 'El modo no es válido.');
  if (!PROVIDERS.has(provider)) throw new CmsError(400, 'INVALID_PROVIDER', 'El proveedor no es válido.');
  return {
    id: crypto.randomUUID(),
    conversationId: input.conversationId ? requireUuid(input.conversationId, 'chat') : crypto.randomUUID(),
    action,
    mode: action === 'prompt' ? mode : 'edit',
    provider,
    prompt: cleanPrompt(input.prompt, action === 'prompt'),
    createdAt: new Date().toISOString()
  };
}

function cleanEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CmsError(400, 'INVALID_EVENT', 'El avance no es válido.');
  const type = String(input.type || 'status');
  if (!['status', 'assistant', 'log', 'result', 'error'].includes(type)) throw new CmsError(400, 'INVALID_EVENT', 'El tipo de avance no es válido.');
  const seq = Number(input.seq);
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > 999999999) throw new CmsError(400, 'INVALID_EVENT', 'El orden del avance no es válido.');
  const text = String(input.text || '').normalize('NFC').replace(/\u0000/g, '').slice(0, 30000);
  if (!text) throw new CmsError(400, 'INVALID_EVENT', 'El avance está vacío.');
  return { seq, type, text, at: new Date().toISOString(), meta: cleanMeta(input.meta) };
}

function cleanMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 12)) {
    if (/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof item)) {
      result[key] = typeof item === 'string' ? item.slice(0, 500) : item;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

module.exports = { ACTIONS, MODES, PROVIDERS, cleanEvent, validateJobInput };
