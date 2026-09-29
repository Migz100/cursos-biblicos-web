const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scriptsRoot = path.resolve(__dirname, '../scripts');
const entry = fs.readFileSync(path.join(scriptsRoot, 'code-host.mjs'), 'utf8');
const runtime = fs.readFileSync(path.join(scriptsRoot, 'code-host-runtime.mjs'), 'utf8');
const installer = fs.readFileSync(path.join(scriptsRoot, 'install-code-host.ps1'), 'utf8');
const starter = fs.readFileSync(path.join(scriptsRoot, 'start-code-host.ps1'), 'utf8');
const testRunner = fs.readFileSync(path.join(scriptsRoot, 'run-tests.mjs'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));

function functionBlock(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = nextName ? source.indexOf(`function ${nextName}(`, start + 1) : -1;
  return source.slice(start, next > start ? next : start + 8000);
}

test('installed production entrypoint runs the real App Server runtime and copies every module', () => {
  assert.match(entry, /from ['"]\.\/code-host-runtime\.mjs['"]/);
  assert.match(entry, /runCodeHost\(\{\s*selfTest:/);
  assert.doesNotMatch(entry, /fake-codex-app-server|test[\\/]fixtures|CODE_PROVIDER_ORDER|\bkimi\b|\bollama\b/i);

  assert.match(installer, /foreach\s*\(\$RuntimeModule\s+in\s+@\([\s\S]{0,300}\)\)\s*\{/i);
  for (const filename of ['code-host.mjs', 'code-host-runtime.mjs', 'code-host-lib.mjs']) {
    const escaped = filename.replaceAll('.', '\\.');
    assert.match(installer, new RegExp(`['"]${escaped}['"]`, 'i'), `installer omits ${filename}`);
  }
  assert.match(
    installer,
    /Copy-Item\s+-LiteralPath\s+\$RuntimeSource\s+-Destination\s+\(Join-Path\s+\$RuntimeRoot\s+\$RuntimeModule\)\s+-Force/i,
    'installer does not copy each allowlisted runtime module'
  );
  assert.match(starter, /code-host\.mjs/);
  assert.doesNotMatch(runtime, /fake-codex-app-server|test[\\/]fixtures/i);
});

test('npm test runs only test files and never discovers the long-lived fake server fixture', () => {
  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.mjs');
  assert.match(testRunner, /entry\.isFile\(\)\s*&&\s*entry\.name\.endsWith\('\.test\.js'\)/);
  assert.match(testRunner, /spawn\(process\.execPath,[\s\S]*'--test'[\s\S]*\.\.\.files/);
  assert.match(testRunner, /setTimeout\([\s\S]*terminate\(\)/);
  assert.match(testRunner, /taskkill\.exe[\s\S]*'\/T'[\s\S]*'\/F'/);
});

test('production launches pinned Codex 0.149.1 App Server over stdio with the required profile', () => {
  assert.match(runtime, /CodexAppServerClient[\s\S]*from ['"]\.\/code-host-lib\.mjs['"]/);
  assert.match(runtime, /new CodexAppServerClient\(\{/);
  assert.match(runtime, /args:\s*\[\.\.\.CODEX\.args,\s*'app-server',\s*'--listen',\s*'stdio:\/\/'\]/);
  assert.match(runtime, /codex-cli\\s\+0\\\.149\\\.1/);
  assert.match(runtime, /appServer\.request\('model\/list'/);
  assert.match(runtime, /const MODEL\s*=\s*'gpt-5\.6-sol'/);
  assert.match(runtime, /const EFFORT\s*=\s*'max'/);
  assert.match(runtime, /const SERVICE_TIER\s*=\s*'priority'/);
});

test('host activation establishes fresh App Server sandbox evidence before polling', () => {
  const runHost = functionBlock(runtime, 'runCodeHost', 'runSelfTest');
  const isolationIndex = runHost.indexOf('ensureHostIsolation(');
  assert.ok(isolationIndex >= 0, 'runCodeHost does not require host read isolation');
  for (const startup of ['process.on(', 'ensureAppServer(', 'sendHeartbeat(', "relay('/api/code/host/poll'"]) {
    const index = runHost.indexOf(startup);
    if (index >= 0) assert.ok(isolationIndex < index, `host reaches ${startup} before isolation is proven`);
  }
  const isolation = functionBlock(runtime, 'ensureHostIsolation', 'ensureAppServer');
  assert.match(isolation, /await ensureAppServer\(\)/);
  assert.match(isolation, /await verifySandboxCanaries\(appServer,\s*workspace\)/);
  assert.match(isolation, /outsideReadDenied/);
  assert.match(isolation, /workspaceImageReadable/);
  assert.match(isolation, /workspacePdfReadable/);
  const canaries = functionBlock(runtime, 'verifySandboxCanaries', 'requiredEnv');
  assert.doesNotMatch(canaries, /outputBytesCap/, 'Windows sandbox canaries cannot use a custom output cap');
  assert.match(canaries, /type:\s*'workspaceWrite'[\s\S]*writableRoots:\s*\[workspace\][\s\S]*networkAccess:\s*false/);
  assert.doesNotMatch(runtime, /ISOLATION_PROOF_FILE|testDependencies|runtimeTestDependencies|freshIsolation|assertEphemeralRuntimeTestBoundary|cursos-editor-real-runtime-smoke/i);
  assert.doesNotMatch(runHost, /readPrivateJson|proof/);
});

test('the first hola creates a scoped thread before starting a turn and returns both IDs', () => {
  const executeTurn = functionBlock(runtime, 'executeTurnJob', 'executeChecksJob');
  const threadStart = functionBlock(runtime, 'startThread', 'resumeThread');
  const turnStart = functionBlock(runtime, 'runAppServerTurn', 'buildTurnInputs');

  assert.match(executeTurn, /if\s*\(job\.threadId\)[\s\S]*?else\s*\{/);
  assert.match(executeTurn, /ensureDraft\(job\.clientId,\s*job\.conversationId\)/);
  assert.match(executeTurn, /await startThread\(job,\s*draft,\s*sink\)/);
  assert.ok(
    executeTurn.indexOf('await startThread(job, draft, sink)') < executeTurn.indexOf('await runAppServerTurn('),
    'turn/start can run before thread/start'
  );
  assert.match(executeTurn, /data:\s*\{[\s\S]*thread:\s*threadRegistry\.public\([\s\S]*turn:\s*\{\s*id:\s*turn\.turnId/);

  assert.match(threadStart, /appServer\.request\('thread\/start'/);
  assert.match(threadStart, /threadRegistry\.register\(\{/);
  assert.match(threadStart, /clientId:\s*job\.clientId/);
  assert.match(threadStart, /conversationId:\s*job\.conversationId/);
  assert.match(turnStart, /appServer\.request\('turn\/start',\s*params/);
  assert.match(turnStart, /threadId:\s*registered\.threadId/);
  assert.match(turnStart, /input:\s*inputs/);
});

test('ordinary edit completion returns diff and check evidence before release preparation', () => {
  const executeTurn = functionBlock(runtime, 'executeTurnJob', 'executeChecksJob');
  assert.match(executeTurn, /new OneFileProposalGate\(\{[\s\S]*changes,[\s\S]*persistentBefore,[\s\S]*proposedAfter/);
  assert.match(executeTurn, /review\s*=\s*\{\s*diff:\s*await buildDiff\(changes,\s*turnWorkspace,\s*persistentDraft\),\s*tests:\s*checks,\s*applied:\s*false\s*\}/);
  assert.match(executeTurn, /data:\s*\{[\s\S]{0,500}\breview\b/);
  assert.ok(executeTurn.indexOf('await buildDiff(') < executeTurn.indexOf('return {'), 'review diff is not ready at completion');
  assert.match(executeTurn, /kind:\s*'review\.proposed'/);
  assert.match(executeTurn, /kind:\s*'approval\.required'/);
  assert.ok(executeTurn.indexOf("kind: 'review.proposed'") < executeTurn.indexOf('proposalGate.resolve('));
  assert.ok(executeTurn.indexOf('waitForApproval(') < executeTurn.indexOf('proposalGate.resolve('));
  assert.match(executeTurn, /apply:\s*approvedChanges\s*=>\s*applyWorkspaceChanges\(persistentDraft,\s*turnWorkspace,\s*approvedChanges/);
  assert.match(executeTurn, /const resolution\s*=\s*await proposalGate\.resolve\(decision\)/);
});

test('thread history is scoped and App Server lifecycle methods use the generated contract', () => {
  assert.match(runtime, /threadRegistry\.list\(job\.clientId\)/);
  assert.match(runtime, /threadRegistry\.require\(job\.threadId,\s*job\.clientId,\s*job\.conversationId\)/);
  assert.match(runtime, /appServer\.request\('thread\/resume'/);
  assert.match(runtime, /appServer\.request\('thread\/read',[\s\S]{0,180}includeTurns:\s*true/);
  assert.match(runtime, /history:\s*extractThreadHistory\(response\?\.thread\)/);
  assert.match(runtime, /appServer\.request\('turn\/interrupt'/);
  assert.match(runtime, /appServer\.request\('turn\/steer'/);
});

test('turns stay in one workspace without network and approvals remain fail closed', () => {
  const turnStart = functionBlock(runtime, 'runAppServerTurn', 'buildTurnInputs');
  const attachmentInputs = functionBlock(runtime, 'buildTurnInputs', 'handleAppServerNotification');
  const approvals = functionBlock(runtime, 'handleAppServerRequest', 'waitForApproval');
  assert.match(turnStart, /type:\s*'workspaceWrite'/);
  assert.match(turnStart, /writableRoots:\s*\[workspace\]/);
  assert.match(turnStart, /networkAccess:\s*false/);
  assert.match(turnStart, /effort:\s*EFFORT/);
  assert.match(turnStart, /serviceTier:\s*SERVICE_TIER/);
  assert.match(attachmentInputs, /stageAttachment\([\s\S]*inputs\.push\(attachmentUserInput\(staged\)\)/);
  assert.doesNotMatch(attachmentInputs, /type:\s*'text'[\s\S]{0,160}staged\.path/);
  assert.match(turnStart, /kind:\s*'attachments\.accepted'[\s\S]*inputKinds:\s*inputs\.slice\(1\)\.map\(item => item\.type\)\.join\(','\)/);
  assert.match(approvals, /evaluateApprovalRequest\(message,\s*\{\s*workspaceRoot:\s*context\.workspace\s*\}\)/);
  assert.match(approvals, /if\s*\(!policy\.browserMayAccept\)[\s\S]*return\s*\{\s*decision:\s*'decline'\s*\}/);
  assert.match(approvals, /kind:\s*'proposal\.internal\.approved'[\s\S]*return\s*\{\s*decision:\s*'accept'\s*\}/);
  assert.doesNotMatch(approvals, /kind:\s*'approval\.required'/);
  assert.doesNotMatch(approvals, /acceptForSession|grantRoot|networkApprovalContext|proposed.*Amendment/i);
});

test('host rechecks browser scope on approval and control records before acting', () => {
  const approvalWait = functionBlock(runtime, 'waitForApproval', 'startControlMonitor');
  const controls = functionBlock(runtime, 'startControlMonitor', 'executeReleasePrepareJob');
  assert.match(approvalWait, /decision\.clientId\s*===\s*job\.clientId/);
  assert.match(approvalWait, /decision\.conversationId\s*===\s*job\.conversationId/);
  assert.match(controls, /control\.clientId\s*!==\s*job\.clientId/);
  assert.match(controls, /control\.conversationId\s*!==\s*job\.conversationId/);
  assert.match(controls, /control\.threadId\s*!==\s*context\.threadId/);
  assert.match(controls, /control\.turnId\s*!==\s*context\.turnId/);
});

test('release runtime wires checks, readable diff, preview, two confirmations, and no chat publish', () => {
  const prepare = functionBlock(runtime, 'executeReleasePrepareJob', 'executeReleaseConfirmJob');
  const confirm = functionBlock(runtime, 'executeReleaseConfirmJob', 'executeReleasePublishJob');
  const publish = functionBlock(runtime, 'executeReleasePublishJob', 'requireReleaseContext');
  const diff = functionBlock(runtime, 'buildDiff', 'draftKey');

  assert.match(prepare, /runChecks\(/);
  assert.match(prepare, /tests\.diffCheck\s*=\s*\{\s*ok:\s*true\s*\}/);
  assert.match(prepare, /releaseGate\.prepare\(\{[\s\S]*diff,[\s\S]*tests,[\s\S]*previewUrl:/);
  assert.match(confirm, /releaseGate\.confirm\(\{[\s\S]*confirmation:\s*job\.confirmation[\s\S]*fingerprint:\s*diff\.sha256/);
  assert.match(publish, /releaseGate\.consume\(\{[\s\S]*confirmation:\s*job\.confirmation[\s\S]*fingerprint:\s*diff\.sha256/);
  assert.match(diff, /return\s*\{\s*sha256,\s*files,\s*count:[\s\S]*summary:[\s\S]*preview:/);
  assert.match(runtime, /case 'publish':\s*throw new HostProtocolError\(HOST_ERROR_CODES\.RELEASE_PREPARE_REQUIRED/);
  assert.match(publish, /createReleaseWorktree\(draft\.baseCommit,\s*job\.releaseId\)/);
  assert.match(publish, /applyWorkspaceChanges\(releaseWorkspace,\s*draft\.workspace,\s*changes/);
  assert.match(publish, /gitAt\(releaseWorkspace,\s*\['push',\s*'origin'/);
  assert.match(publish, /cleanupReleaseWorktree\(releaseWorkspace\)/);
  const preview = functionBlock(runtime, 'deployPreview', 'runChecks');
  assert.match(preview, /await verifyUrl\(url\)/);
});
