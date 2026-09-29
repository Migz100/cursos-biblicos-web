const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '../edit/index.html'), 'utf8');
const script = fs.readFileSync(path.resolve(__dirname, '../edit/edit.js'), 'utf8');
const styles = fs.readFileSync(path.resolve(__dirname, '../edit/edit.css'), 'utf8');

function hasId(id) {
  assert.match(html, new RegExp(`\\bid=["']${id}["']`), `missing #${id}`);
}

function endpointBlocks(endpoint, length = 500) {
  const marker = `postJson('${endpoint}'`;
  const blocks = [];
  let from = 0;
  while (true) {
    const index = script.indexOf(marker, from);
    if (index < 0) return blocks;
    blocks.push(script.slice(index, index + length));
    from = index + marker.length;
  }
}

function functionBlock(name, length = 2400) {
  const marker = `function ${name}(`;
  const index = script.indexOf(marker);
  assert.notEqual(index, -1, `missing ${name}`);
  return script.slice(index, index + length);
}

test('editor exposes stable accessible controls for threads, conversation, status, review, and recovery', () => {
  for (const id of [
    'appShell', 'threadList', 'newThreadButton', 'conversation', 'connectionBanner', 'connectionState',
    'prompt', 'attachmentInput', 'attachmentList', 'sendButton', 'stopButton', 'retryButton',
    'reviewPanel', 'diffPanel', 'testResults', 'previewLink', 'publishButton', 'publishDialog',
    'confirmPublishButton', 'approvalRegion', 'liveAnnouncer'
  ]) hasId(id);

  assert.match(html, /id="conversation"[^>]*role="log"[^>]*aria-live="polite"[^>]*data-streaming="false"/);
  assert.match(html, /id="connectionBanner"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="errorCard"[^>]*role="alert"/);
  assert.match(html, /id="sendButton"[^>]*disabled/);
  assert.match(html, /id="stopButton"[^>]*hidden/);
  assert.match(html, /id="confirmPublishButton"[^>]*disabled/);
  assert.match(html, /id="testResults"[^>]*data-event-kind="tests"[^>]*data-event-status="unknown"/);
  assert.match(html, /id="previewLink"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*hidden/);
});

test('rendered records keep stable data selectors and use text nodes rather than HTML injection', () => {
  for (const contract of [
    /button\.dataset\.threadId\s*=\s*thread\.id/,
    /wrapper\.dataset\.messageRole\s*=\s*item\.role/,
    /wrapper\.dataset\.eventKind\s*=\s*item\.kind/,
    /conversation\.dataset\.streaming\s*=\s*String\(/,
    /card\.dataset\.approvalId\s*=\s*approval\.id/,
    /decline\.dataset\.approvalAction\s*=\s*'decline'/,
    /accept\.dataset\.approvalAction\s*=\s*'approve'/,
    /item\.dataset\.attachmentId\s*=\s*attachment\.localId/,
    /remove\.dataset\.removeAttachment\s*=\s*attachment\.localId/
  ]) assert.match(script, contract);

  assert.match(script, /bubble\.append\(summary\)/);
  assert.match(script, /span\.textContent\s*=\s*line/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.doesNotMatch(script, /insertAdjacentHTML/);
});

test('thread lifecycle, streaming sequence, reconnect, interruption, and failure states are wired', () => {
  assert.match(script, /postJson\('\/api\/code\/threads',\s*\{\s*operation:\s*'list'/s);
  assert.match(script, /postJson\('\/api\/code\/threads',\s*\{\s*operation:\s*'resume'/s);
  assert.match(script, /postJson\('\/api\/code\/turns',\s*\{\s*operation:\s*'start'/s);
  assert.match(script, /postJson\('\/api\/code\/turns',\s*\{\s*operation:\s*'interrupt'/s);
  assert.match(script, /new URLSearchParams\(\{[\s\S]{0,320}jobId:\s*job\.id[\s\S]{0,320}after:\s*String\(job\.seq\)[\s\S]{0,320}clientId:\s*client\w*Id[\s\S]{0,320}conversationId:\s*(?:validUuid\(job\.conversationId\)[^\n]*scopedThread\.id|scopedThread\.id)/);
  assert.match(script, /requestJson\('\/api\/code\/events\?'\s*\+\s*eventQuery\.toString\(\)\)/);
  assert.match(script, /if\s*\(sequence\s*<=\s*job\.seq\)\s*continue/);
  assert.match(script, /kind\s*===\s*'assistant\.delta'/);
  assert.match(script, /thread\.streamText\s*=\s*safeStreamText\(thread\.streamText\s*\+\s*text/);
  assert.match(script, /setConnectionState\(navigator\.onLine\s*\?\s*'reconnecting'\s*:\s*'offline'/);
  assert.match(script, /schedulePoll\(connection\.state\s*===\s*'offline'\s*\?\s*3500\s*:\s*1500\)/);
  for (const state of ['connecting', 'online', 'busy', 'reconnecting', 'offline']) {
    assert.match(script, new RegExp(`\\b${state}:\\s*\\[`));
  }
  assert.match(script, /retryButton\.hidden\s*=\s*!thread\.error\.retryable/);
  assert.match(script, /sendButton\.disabled\s*=\s*!canSend/);
  assert.match(script, /stopButton\.hidden\s*=\s*!job/);
  assert.match(script, /stopButton\.disabled\s*=\s*!job\s*\|\|\s*!job\.cancellable/);
});

test('an opaque persisted browser UUID scopes thread, turn, upload, and release requests', () => {
  assert.match(script, /localStorage\.getItem\([^)]*CLIENT[^)]*\)/i);
  assert.match(script, /localStorage\.setItem\([^,]*CLIENT[^,]*,\s*client\w*Id\)/i);
  assert.match(script, /const\s+client\w*Id\s*=\s*validUuid\(localStorage\.getItem\([^)]*CLIENT[^)]*\)\)[\s\S]{0,180}crypto\.randomUUID\(\)/i);

  for (const endpoint of [
    '/api/code/threads',
    '/api/code/turns',
    '/api/code/attachments',
    '/api/code/approvals',
    '/api/code/cancel',
    '/api/code/release/prepare',
    '/api/code/release/confirm',
    '/api/code/release/publish'
  ]) {
    const blocks = endpointBlocks(endpoint, 850);
    assert.ok(blocks.length, `missing ${endpoint}`);
    for (const block of blocks) assert.match(block, /\bclientId\b/, `${endpoint} is missing clientId`);
  }
});

test('first turn and attachment binding use one conversation, and resume consumes top-level history', () => {
  const turnBlocks = endpointBlocks('/api/code/turns', 850);
  const start = turnBlocks.find(block => /operation:\s*'start'/.test(block));
  assert.ok(start, 'missing turn.start request');
  assert.match(start, /conversationId:\s*thread\.id/);
  assert.match(start, /\.\.\.\(thread\.serverThreadId\s*\?\s*\{\s*threadId:\s*thread\.serverThreadId\s*\}\s*:\s*\{\}\)/);

  const upload = endpointBlocks('/api/code/attachments', 850)[0];
  assert.match(upload, /conversationId:\s*thread\.id/);
  assert.match(start, /attachmentIds:\s*requestRecord\.attachmentIds/);

  const applyThread = functionBlock('applyThreadPayload');
  assert.match(applyThread, /Array\.isArray\(data\.history\)/);
  assert.match(applyThread, /messagesFromRemote\(data\.history\)/);
});

test('attachments are one upload request per file, bounded to 3 MiB each and four or 12 MiB per turn', () => {
  assert.match(html, /id="attachmentInput"[^>]*type="file"[^>]*multiple[^>]*accept="[^"]*(?:image\/png|\.png)[^"]*application\/pdf/);
  assert.match(script, /const MAX_ATTACHMENTS\s*=\s*4/);
  assert.match(script, /const MAX_ATTACHMENT_BYTES\s*=\s*3\s*\*\s*1024\s*\*\s*1024/);
  assert.match(script, /const MAX_TOTAL_ATTACHMENT_BYTES\s*=\s*12\s*\*\s*1024\s*\*\s*1024/);
  assert.match(script, /for\s*\(const attachment of selectedAttachments\)[\s\S]*?await postJson\('\/api\/code\/attachments'/);
  const uploads = endpointBlocks('/api/code/attachments');
  assert.equal(uploads.length, 1);
  assert.match(uploads[0], /name:\s*safeFilename\(attachment\.file\.name\)/);
  assert.match(uploads[0], /conversationId:\s*thread\.id/);
  assert.match(uploads[0], /mime:\s*attachment\.mime/);
  assert.match(uploads[0], /\bdata\b/);
  assert.doesNotMatch(uploads[0], /files\s*:/);
  assert.match(script, /attachmentIds:\s*uploaded\.map\(item\s*=>\s*item\.attachmentId\)/);
  assert.match(script, /selectedAttachments\.length\s*>=\s*MAX_ATTACHMENTS/);
  assert.match(script, /file\.size\s*>\s*MAX_ATTACHMENT_BYTES/);
  assert.match(script, /total\s*>\s*MAX_TOTAL_ATTACHMENT_BYTES/);
  assert.match(script, /if\s*\(file\.type\s*&&\s*!mimeMatches\(extension,\s*file\.type\)\)/);
});

test('browser approvals are one-shot accept or decline and cannot request expanded capabilities', () => {
  const blocks = endpointBlocks('/api/code/approvals');
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /jobId:\s*approval\.jobId/);
  assert.match(blocks[0], /approvalId:\s*approval\.id/);
  assert.match(blocks[0], /\bdecision\b/);
  assert.doesNotMatch(blocks[0], /grantRoot|network|amendment|acceptForSession/);
  assert.match(script, /respondToApproval\(approval\.id,\s*'decline'\)/);
  assert.match(script, /respondToApproval\(approval\.id,\s*'accept'\)/);
  assert.doesNotMatch(script, /acceptForSession/);
  assert.doesNotMatch(script, /proposedExecpolicyAmendment|proposedNetworkPolicyAmendments|networkApprovalContext|grantRoot/);
});

test('publish is a prepare, REVISADO, then PUBLICAR flow and ordinary chat cannot invoke it', () => {
  const prepare = endpointBlocks('/api/code/release/prepare');
  const confirm = endpointBlocks('/api/code/release/confirm');
  const publish = endpointBlocks('/api/code/release/publish');
  assert.equal(prepare.length, 1);
  assert.equal(confirm.length, 1);
  assert.equal(publish.length, 1);
  assert.match(confirm[0], /confirmationToken:\s*session\.confirmationToken/);
  assert.match(confirm[0], /fingerprint:\s*session\.fingerprint/);
  assert.match(confirm[0], /confirmation:\s*'REVISADO'/);
  assert.match(publish[0], /publishToken:\s*session\.publishToken/);
  assert.match(publish[0], /fingerprint:\s*session\.fingerprint/);
  assert.match(publish[0], /confirmation:\s*'PUBLICAR'/);
  assert.match(script, /if\s*\(publishDialogStage\s*===\s*'review'\)\s*confirmPreparedRelease\(\)/);
  assert.match(script, /else if\s*\(publishDialogStage\s*===\s*'publish'\)\s*publishPreparedRelease\(\)/);
  assert.match(script, /publishAcknowledge\.checked\s*=\s*false/);
  assert.match(script, /confirmPublishButton\.disabled\s*=\s*!publishAcknowledge\.checked/);

  for (const block of endpointBlocks('/api/code/message')) assert.doesNotMatch(block, /action:\s*['"]publish['"]/);
  assert.match(script, /if\s*\(!\['checks',\s*'preview'\]\.includes\(action\)\)\s*return/);
  assert.match(script, /const text\s*=\s*prompt\.value\.trim\(\)/);
  assert.match(script, /await queueTurn\(thread,\s*requestRecord,\s*true\)/);
  assert.doesNotMatch(script, /prompt\.value[^\n]*(?:===|includes|match|test)[^\n]*PUBLICAR/);
});

test('release review renders the shared diff preview and passes only all three gates', () => {
  const applyRelease = functionBlock('applyReleasePayload');
  assert.match(applyRelease, /const diff\s*=\s*objectValue\(release\.diff\)/);
  assert.match(applyRelease, /sanitizeDiff\(diff\?\.preview/);
  assert.match(applyRelease, /diff\?\.count/);
  assert.match(applyRelease, /diff\?\.summary/);
  assert.match(applyRelease, /diff\?\.sha256/);
  for (const gate of ['test', 'check', 'diffCheck']) {
    assert.match(applyRelease, new RegExp(`tests\\.${gate}\\?\\.ok\\s*===\\s*true`));
  }
  assert.match(applyRelease, /testsStatus\s*=\s*passed\s*===\s*checks\.length\s*\?\s*'passed'\s*:\s*'failed'/);
  assert.doesNotMatch(script, /textContent\s*=\s*(?:release\.)?diff\s*(?:;|\n)/);
});

test('ordinary edit completion renders its review before any release preparation', () => {
  const completion = functionBlock('handleDone');
  assert.match(completion, /const editReview\s*=\s*objectValue\(data\.review\)/);
  assert.match(completion, /if\s*\(editReview\)\s*applyReleasePayload\(thread,\s*editReview,\s*done\)/);
  assert.ok(
    completion.indexOf('applyReleasePayload(thread, editReview, done)') < completion.indexOf('handleCompletedJobFlow('),
    'ordinary review is delayed until the release flow'
  );
  assert.match(script, /kind\s*===\s*'review\.proposed'/);
  assert.match(script, /review\.applied\s*=\s*false/);
  assert.match(script, /publishButton\.disabled\s*=\s*busy\s*\|\|\s*!navigator\.onLine\s*\|\|\s*!thread\?\.review\s*\|\|\s*thread\.review\.applied\s*===\s*false/);
});

test('editor CSS preserves safe areas, touch targets, phone, tablet, and reduced-motion behavior', () => {
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    assert.match(styles, new RegExp(`env\\(safe-area-inset-${edge}`));
  }
  assert.match(styles, /min-(?:width|height):\s*44px/);
  assert.match(styles, /@media\s*\(max-width:\s*920px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*760px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*430px\)/);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(script, /window\.matchMedia\('\(max-width:\s*760px\)'\)/);
});
