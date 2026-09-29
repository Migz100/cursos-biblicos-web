import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const THREAD_ID = '01900000-0000-7000-8000-000000000001';
const SESSION_ID = '01900000-0000-7000-8000-000000000002';
const TURN_ID = '01900000-0000-7000-8000-000000000003';
const ITEM_ID = '01900000-0000-7000-8000-000000000004';
const APPROVAL_ID = 'approval-1';

const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const match = argument.match(/^--([^=]+)(?:=(.*))?$/);
  return match ? [match[1], match[2] ?? true] : [argument, true];
}));

let initializeReceived = false;
let initializedReceived = false;
let pendingApproval = false;
let interrupted = false;
let currentInput = [];
const completedTurns = [];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function shouldIgnore(method) {
  return String(options.ignore || '').split(',').includes(method);
}

function record(message) {
  if (!options.log) return;
  fs.mkdirSync(path.dirname(path.resolve(String(options.log))), { recursive: true });
  fs.appendFileSync(path.resolve(String(options.log)), `${JSON.stringify(message)}\n`, 'utf8');
}

function turn(status = 'completed', withMessage = true, input = currentInput) {
  const items = [];
  if (withMessage && Array.isArray(input) && input.length) {
    items.push({
      type: 'userMessage',
      id: `${ITEM_ID}-user`,
      clientId: null,
      content: input
    });
  }
  if (withMessage) items.push({
    type: 'agentMessage',
    id: ITEM_ID,
    text: 'Cambio terminado.',
    phase: null,
    memoryCitation: null,
    delivery: null
  });
  return {
    id: TURN_ID,
    items,
    itemsView: 'full',
    status,
    error: status === 'failed' ? { message: 'Fallo de prueba', codexErrorInfo: null, additionalDetails: null } : null,
    startedAt: 1_700_000_000,
    completedAt: status === 'inProgress' ? null : 1_700_000_001,
    durationMs: status === 'inProgress' ? null : 1000
  };
}

function rememberedTurns() {
  if (completedTurns.length) return completedTurns;
  if (options['disconnect-marker'] && fs.existsSync(path.resolve(String(options['disconnect-marker'])))) {
    return [turn('completed', true, [{ type: 'text', text: 'Primera conexi\u00f3n', text_elements: [] }])];
  }
  return [];
}

function completeTurn(status = 'completed', withMessage = true) {
  const value = turn(status, withMessage);
  completedTurns.push(value);
  write({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: value } });
}

function thread(includeTurns = false) {
  return {
    id: THREAD_ID,
    sessionId: SESSION_ID,
    forkedFromId: null,
    parentThreadId: null,
    preview: 'Cambia el t\u00edtulo',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    modelProvider: 'openai',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_001,
    recencyAt: 1_700_000_001,
    status: { type: 'idle' },
    path: null,
    cwd: process.cwd(),
    cliVersion: '0.149.1',
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: 'Cambio de prueba',
    turns: includeTurns ? rememberedTurns() : []
  };
}

function threadSessionResult(includeTurns = false) {
  return {
    thread: thread(includeTurns),
    model: 'gpt-5',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: process.cwd(),
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite',
      writableRoots: [process.cwd()],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    },
    reasoningEffort: null
  };
}

function protocolError(id, message, code = -32000) {
  write({ id, error: { code, message } });
}

function emitTurnStarted() {
  write({ method: 'turn/started', params: { threadId: THREAD_ID, turn: turn('inProgress', false) } });
}

function emitTurnRemainder() {
  if (interrupted) return;
  write({
    method: 'item/agentMessage/delta',
    params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: ITEM_ID, delta: 'Cambio terminado.' }
  });
  write({
    method: 'turn/diff/updated',
    params: { threadId: THREAD_ID, turnId: TURN_ID, diff: 'diff --git a/index.html b/index.html\n' }
  });

  if (options['disconnect-marker']) {
    const marker = path.resolve(String(options['disconnect-marker']));
    if (!fs.existsSync(marker)) {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, 'disconnected\n', 'utf8');
      process.exitCode = 23;
      process.stdin.destroy();
      return;
    }
  }

  if (options['fail-turn']) {
    write({
      method: 'error',
      params: {
        error: { message: 'Fallo de prueba', codexErrorInfo: null, additionalDetails: null },
        willRetry: false,
        threadId: THREAD_ID,
        turnId: TURN_ID
      }
    });
    completeTurn('failed');
    return;
  }

  completeTurn();
}

function requestApproval(kind) {
  pendingApproval = true;
  if (kind === 'file') {
    write({
      id: APPROVAL_ID,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: ITEM_ID,
        startedAtMs: 1_700_000_000_000,
        reason: 'Cambiar el archivo solicitado',
        grantRoot: null
      }
    });
    return;
  }
  write({
    id: APPROVAL_ID,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: ITEM_ID,
      startedAtMs: 1_700_000_000_000,
      approvalId: null,
      environmentId: null,
      reason: 'Ejecutar las pruebas',
      command: 'npm test',
      cwd: process.cwd(),
      commandActions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null
    }
  });
}

function handleApprovalResponse(message) {
  if (!pendingApproval || message.id !== APPROVAL_ID || (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))) return false;
  pendingApproval = false;
  record({ approvalResponse: message.result, approvalError: message.error });
  if (message.error) {
    completeTurn('interrupted', false);
    return true;
  }
  const decision = message.result?.decision;
  if (decision === 'accept' || decision === 'acceptForSession') emitTurnRemainder();
  else completeTurn('interrupted', false);
  return true;
}

function requireInitialized(message) {
  if (initializeReceived && initializedReceived) return true;
  protocolError(message.id, 'initialized notification is required before this method', -32002);
  return false;
}

function handleRequest(message) {
  if (handleApprovalResponse(message)) return;

  if (shouldIgnore(message.method)) return;
  if (String(options.error || '') === message.method) {
    protocolError(message.id, `Forced failure for ${message.method}`, -32050);
    return;
  }

  if (message.method === 'initialize') {
    if (initializeReceived) return protocolError(message.id, 'initialize may only be sent once', -32600);
    initializeReceived = true;
    if (options['invalid-json']) {
      process.stdout.write('{not valid json}\n');
      return;
    }
    write({
      id: message.id,
      result: {
        userAgent: 'codex-app-server/0.149.1',
        codexHome: process.cwd(),
        platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
        platformOs: process.platform === 'win32' ? 'windows' : process.platform
      }
    });
    return;
  }

  if (message.method === 'initialized' && !Object.hasOwn(message, 'id')) {
    if (!initializeReceived) return protocolError(null, 'initialize must come first', -32002);
    initializedReceived = true;
    return;
  }

  if (!requireInitialized(message)) return;

  switch (message.method) {
    case 'thread/start':
      write({ id: message.id, result: threadSessionResult(false) });
      break;
    case 'thread/resume':
      write({ id: message.id, result: threadSessionResult(true) });
      break;
    case 'thread/list':
      write({ id: message.id, result: { data: [thread(false)], nextCursor: null, backwardsCursor: 'back-1' } });
      break;
    case 'thread/read':
      write({ id: message.id, result: { thread: thread(Boolean(message.params?.includeTurns)) } });
      break;
    case 'turn/start':
      currentInput = Array.isArray(message.params?.input) ? message.params.input : [];
      interrupted = false;
      write({ id: message.id, result: { turn: turn('inProgress', false) } });
      emitTurnStarted();
      if (options['server-request'] === 'unknown') {
        pendingApproval = true;
        write({ id: APPROVAL_ID, method: 'unknown/request', params: { threadId: THREAD_ID, turnId: TURN_ID } });
      } else if (options.approval) requestApproval(String(options.approval));
      else if (!options['hold-turn']) emitTurnRemainder();
      break;
    case 'turn/interrupt':
      interrupted = true;
      write({ id: message.id, result: {} });
      completeTurn('interrupted', false);
      break;
    default:
      protocolError(message.id, `Unsupported fake method: ${message.method}`, -32601);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const shutdown = () => {
  try { input.close(); } catch {}
  try { process.stdin.destroy(); } catch {}
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    const message = JSON.parse(line);
    record(message);
    handleRequest(message);
  } catch (error) {
    write({ id: null, error: { code: -32700, message: error instanceof Error ? error.message : String(error) } });
  }
}
