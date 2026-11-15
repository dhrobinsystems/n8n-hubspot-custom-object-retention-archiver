'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { buildWorkflow, serialize, OUT, NODE_NAMES: N } = require('../scripts/build-workflow');
const { resolveConfig } = require('../src/safety');
const a = require('../src/archiver');
const { buildS3PutRequest } = require('../src/sigv4');
const { nodeCryptoImpl } = require('../src/storage');
const fixtures = require('./fixtures/custom-objects.json');

const workflow = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const ENV = {
  HUBSPOT_ACCESS_TOKEN: 'mock-hubspot-credential-string', CUSTOM_OBJECT_TYPE: 'p_mock_subscriptions',
  ACTIVITY_DATE_PROPERTY: 'last_engagement_date', LEGAL_HOLD_PROPERTY: 'retention_hold', STORAGE_TARGETS: 's3,sheets',
  AWS_S3_BUCKET: 'mock-archive-bucket', AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'MOCKACCESSKEYID000000',
  AWS_SECRET_ACCESS_KEY: 'mock-secret-access-key-0000000000000000', GOOGLE_SHEETS_ID: 'mock-sheet-id-000000',
  GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.mock-oauth-token', DRY_RUN: 'false',
};
const STARTED_AT = '2026-07-01T07:00:00.000Z';
const config = resolveConfig(ENV, { runtime: 'n8n' }).settings;
const portal = { portalId: '12345678', accountType: 'SANDBOX' };

/** Minimal n8n runtime: $env, $input, $('Node'), $prevNode and this.helpers. */
function runCodeNode(name, ctx) {
  const c = ctx || {};
  const nodes = c.nodes || {};
  const $ = (n) => {
    if (!(n in nodes)) return { isExecuted: false, first: () => { throw new Error('not executed: ' + n); }, all: () => [] };
    const items = Array.isArray(nodes[n]) ? nodes[n] : [nodes[n]];
    return { isExecuted: true, first: () => ({ json: items[0] }), all: () => items.map((json) => ({ json })) };
  };
  const inputItems = (c.input || []).map((x) => (x && x.json ? x : { json: x }));
  const $input = { all: () => inputItems, first: () => inputItems[0] || { json: {} } };
  const fn = new AsyncFunction('$env', '$input', '$', '$prevNode', byName[name].parameters.jsCode);
  return fn.call({ helpers: c.helpers || {} }, c.env || ENV, $input, $, c.prevNode || { name: 'Test Node' });
}

async function prepared() {
  const criteria = {
    cutoffMs: a.computeCutoff(new Date(STARTED_AT), 365).cutoffMs, dateProperty: 'hs_lastmodifieddate',
    activityDateProperty: 'last_engagement_date', legalHoldProperty: 'retention_hold', maxArchivePerRun: 500,
  };
  const cutoff = a.computeCutoff(new Date(STARTED_AT), 365);
  const pages = [fixtures.results.slice(0, 5), fixtures.results.slice(5)].map((results) => ({ results }));
  const out = await runCodeNode(N.PREPARE, { nodes: { [N.BUILD_SEARCH]: { config, portal, cutoff, criteria, startedAt: STARTED_AT } }, input: pages });
  return out[0].json;
}

test('committed workflow JSON is in sync with src/ (npm run build:workflow)', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8'), serialize(buildWorkflow()));
});

test('workflow structure: required nodes, unique names, valid connections, inactive on import', () => {
  const names = workflow.nodes.map((n) => n.name);
  assert.equal(new Set(names).size, names.length);
  for (const [from, conn] of Object.entries(workflow.connections)) {
    assert.ok(byName[from], 'unknown source ' + from);
    for (const out of conn.main) for (const c of out) assert.ok(byName[c.node], from + ' -> ' + c.node);
  }
  for (const n of Object.values(N)) assert.ok(byName[n], 'missing node ' + n);
  assert.equal(byName[N.SCHEDULE].type, 'n8n-nodes-base.scheduleTrigger');
  assert.equal(byName[N.ROUTER].type, 'n8n-nodes-base.switch');
  assert.equal(byName[N.STOP].type, 'n8n-nodes-base.stopAndError');
  assert.equal(byName[N.ARCHIVE].parameters.method, 'DELETE');
  assert.equal(workflow.active, false);
});

test('DELETE is reachable only through Verify Backup & Plan Archive, never from the dry-run branch', () => {
  const parents = {};
  for (const [from, conn] of Object.entries(workflow.connections)) {
    conn.main.forEach((out, idx) => out.forEach((c) => { (parents[c.node] = parents[c.node] || []).push({ from, idx }); }));
  }
  assert.deepEqual(parents[N.ARCHIVE], [{ from: N.PLAN, idx: 0 }]);
  assert.deepEqual(parents[N.PLAN].map((p) => p.from).sort(), [N.NEEDS_SHEETS, N.SHEETS].sort());
  assert.deepEqual(workflow.connections[N.DRY].main[0].map((c) => c.node), [N.PREVIEW]);
  assert.equal(workflow.connections[N.PREVIEW], undefined);
});

test('every HTTP and Code node with an error output routes it to the Masked Error Logger', () => {
  for (const n of workflow.nodes.filter((x) => x.onError === 'continueErrorOutput')) {
    assert.deepEqual(workflow.connections[n.name].main[1], [{ node: N.LOGGER, type: 'main', index: 0 }], n.name);
  }
  assert.deepEqual(workflow.connections[N.LOGGER].main[0], [{ node: N.STOP, type: 'main', index: 0 }]);
});

test('secrets are referenced only through $env, never hard-coded', () => {
  const text = JSON.stringify(workflow);
  for (const k of ['HUBSPOT_ACCESS_TOKEN', 'CUSTOM_OBJECT_TYPE', 'AWS_SESSION_TOKEN']) assert.ok(text.includes('$env.' + k), k);
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_SHEETS_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON']) assert.ok(text.includes("'" + k + "'"), k);
  assert.ok(!/pat-[a-z0-9]{2,4}-[0-9a-f]{8}-/i.test(text));
  assert.ok(!/AKIA[A-Z0-9]{16}/.test(text));
  assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY-----\\n[A-Za-z0-9]/.test(text));
});

test('every Code node compiles', () => {
  for (const n of workflow.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new AsyncFunction('$env', '$input', '$', '$prevNode', n.parameters.jsCode), n.name);
  }
});

test('gate node mirrors resolveConfig, keeps secrets out of item data, rejects the file target', async () => {
  const out = await runCodeNode(N.GATE);
  assert.deepEqual(out[0].json.config, config);
  const text = JSON.stringify(out);
  for (const k of ['HUBSPOT_ACCESS_TOKEN', 'CUSTOM_OBJECT_TYPE', 'AWS_S3_BUCKET', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_SHEETS_ID', 'GOOGLE_OAUTH_ACCESS_TOKEN']) {
    assert.ok(!text.includes(ENV[k]), 'leaked ' + k);
  }
  await assert.rejects(runCodeNode(N.GATE, { env: Object.assign({}, ENV, { STORAGE_TARGETS: 'file' }) }), /for n8n: file/);
  await assert.rejects(runCodeNode(N.GATE, { env: {} }), /HUBSPOT_ACCESS_TOKEN/);
});

test('sandbox node blocks non-sandbox portals', async () => {
  const nodes = { [N.GATE]: { config } };
  await assert.rejects(runCodeNode(N.SANDBOX, { nodes, input: [{ portalId: 1, accountType: 'STANDARD' }] }), /Sandbox gate blocked/);
  const ok = await runCodeNode(N.SANDBOX, { nodes, input: [{ portalId: 1, accountType: 'DEVELOPER_TEST' }] });
  assert.equal(ok[0].json.portal.accountType, 'DEVELOPER_TEST');
});

test('search-request node builds the same body as the CLI', async () => {
  const props = Object.keys(fixtures.results[0].properties).map((name) => ({ name }));
  const out = await runCodeNode(N.BUILD_SEARCH, { nodes: { [N.SANDBOX]: { config, portal }, [N.GATE]: { startedAt: STARTED_AT } }, input: [{ results: props }] });
  const cutoff = a.computeCutoff(new Date(STARTED_AT), 365);
  assert.deepEqual(out[0].json.searchBody, a.buildSearchBody({
    properties: props.map((p) => p.name).sort(), cutoffMs: cutoff.cutoffMs, dateProperty: 'hs_lastmodifieddate',
    activityDateProperty: 'last_engagement_date', legalHoldProperty: 'retention_hold', maxArchivePerRun: 500,
  }));
});

test('prepare node produces exactly the CLI backup (same bytes, same checksums)', async () => {
  const p = await prepared();
  const cutoff = a.computeCutoff(new Date(STARTED_AT), 365);
  const sel = a.selectStaleRecords(fixtures.results, {
    cutoffMs: cutoff.cutoffMs, dateProperty: 'hs_lastmodifieddate', activityDateProperty: 'last_engagement_date',
    legalHoldProperty: 'retention_hold', maxArchivePerRun: 500,
  });
  const expected = a.buildBackup(sel.selected, {
    runAt: STARTED_AT, objectType: 'p_mock_subscriptions', portalId: '12345678', retentionDays: 365, cutoffIso: cutoff.cutoffIso,
    dateProperty: 'hs_lastmodifieddate', activityDateProperty: 'last_engagement_date', legalHoldProperty: 'retention_hold', s3Prefix: 'hubspot-retention-archive',
  });
  assert.deepEqual(p.backup, expected);
  assert.deepEqual(p.selection.selected, sel.selected.map((r) => r.id));
});

test('dry-run preview node matches the CLI preview', async () => {
  const p = await prepared();
  const out = await runCodeNode(N.PREVIEW, { nodes: { [N.PREPARE]: p } });
  assert.deepEqual(out[0].json, a.buildDryRunPreview(p.selection, p.backup, p.config, p.meta));
});

test('S3 signing node (pure SHA-256/HMAC) produces the same signature as node:crypto', async () => {
  const p = await prepared();
  const out = await runCodeNode(N.SIGN, { nodes: { [N.PREPARE]: p } });
  assert.equal(out.length, 2);
  for (const item of out) {
    const j = item.json;
    const amzDate = j.headers['x-amz-date'];
    const ref = buildS3PutRequest({
      bucket: ENV.AWS_S3_BUCKET, region: ENV.AWS_REGION, key: j.key, body: j.body, contentType: j.contentType,
      accessKeyId: ENV.AWS_ACCESS_KEY_ID, secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY, amzDate,
    }, nodeCryptoImpl);
    assert.equal(j.headers.Authorization, ref.headers.Authorization);
    assert.equal(j.checksumSha256Base64, crypto.createHash('sha256').update(j.body).digest('base64'));
    assert.ok(!JSON.stringify(j).includes(ENV.AWS_SECRET_ACCESS_KEY));
  }
  const withToken = await runCodeNode(N.SIGN, { nodes: { [N.PREPARE]: p }, env: Object.assign({}, ENV, { AWS_SESSION_TOKEN: 'mock-session-token' }) });
  assert.equal(withToken[0].json.addSessionToken, true);
  assert.ok(!JSON.stringify(withToken).includes('mock-session-token'), 'session token must not enter item data');
});

test('S3 verify node passes on echoed checksums and throws (aborting archive) otherwise', async () => {
  const p = await prepared();
  const signed = (await runCodeNode(N.SIGN, { nodes: { [N.PREPARE]: p } })).map((i) => i.json);
  const nodes = { [N.PREPARE]: p, [N.SIGN]: signed };
  const good = signed.map((s, i) => ({ json: { statusCode: 200, headers: { 'x-amz-checksum-sha256': s.checksumSha256Base64 } }, pairedItem: { item: i } }));
  const ok = await runCodeNode(N.VERIFY_S3, { nodes, input: good });
  assert.equal(ok[0].json.s3Verification.ok, true);
  const bad = [good[0], { json: { statusCode: 500, headers: {} }, pairedItem: { item: 1 } }];
  await assert.rejects(runCodeNode(N.VERIFY_S3, { nodes, input: bad }), /no HubSpot records were archived/);
  await assert.rejects(runCodeNode(N.VERIFY_S3, { nodes, input: [good[0]] }), /csv: missing/);
});

test('Sheets node appends via this.helpers, verifies the row count and never outputs the token', async () => {
  const p = await prepared();
  const requests = [];
  const helpers = { httpRequest: async (opts) => { requests.push(opts); return { updates: { updatedRows: opts.body.values.length } }; } };
  const out = await runCodeNode(N.SHEETS, { nodes: { [N.PREPARE]: p }, helpers });
  assert.equal(out[0].json.sheetsVerification.ok, true);
  assert.equal(requests[0].url, a.sheetsAppendUrl(ENV.GOOGLE_SHEETS_ID, 'archive_ledger'));
  assert.equal(requests[0].headers.Authorization, 'Bearer ' + ENV.GOOGLE_OAUTH_ACCESS_TOKEN);
  assert.deepEqual(requests[0].body.values, p.backup.ledgerRows);
  assert.ok(!JSON.stringify(out).includes(ENV.GOOGLE_OAUTH_ACCESS_TOKEN));
  const short = { httpRequest: async () => ({ updates: { updatedRows: 1 } }) };
  await assert.rejects(runCodeNode(N.SHEETS, { nodes: { [N.PREPARE]: p }, helpers: short }), /Archiving aborted/);
});

test('plan node emits DELETE items only when every target verified this run', async () => {
  const p = await prepared();
  const s3 = { s3Verification: { ok: true, target: 's3', runId: p.backup.runId } };
  const sheets = { sheetsVerification: { ok: true, target: 'sheets', runId: p.backup.runId } };
  const both = await runCodeNode(N.PLAN, { nodes: { [N.PREPARE]: p, [N.VERIFY_S3]: s3, [N.SHEETS]: sheets } });
  assert.deepEqual(both.map((i) => i.json.id), p.backup.recordIds);
  await assert.rejects(runCodeNode(N.PLAN, { nodes: { [N.PREPARE]: p, [N.VERIFY_S3]: s3 } }), /sheets: not executed/);
  await assert.rejects(runCodeNode(N.PLAN, { nodes: { [N.PREPARE]: p } }), /s3: not executed/);
  const capped = JSON.parse(JSON.stringify(p));
  capped.config.maxArchivePerRun = 2;
  await assert.rejects(runCodeNode(N.PLAN, { nodes: { [N.PREPARE]: capped, [N.VERIFY_S3]: s3, [N.SHEETS]: sheets } }), /Batch cap exceeded/);
});

test('summary node matches the CLI summary', async () => {
  const p = await prepared();
  const planItems = p.backup.recordIds.map((id) => ({ id, runId: p.backup.runId }));
  const ids = p.backup.recordIds;
  const kept = ids.map((_, i) => i).filter((i) => i !== 2);
  const input = kept.map((i) => ({ json: {}, pairedItem: { item: i } }));
  const out = await runCodeNode(N.SUMMARY, { nodes: { [N.PREPARE]: p, [N.PLAN]: planItems }, input });
  assert.deepEqual(out[0].json, a.summarizeArchive(
    { runId: p.backup.runId, manifestSha256: p.backup.manifestSha256, verifiedTargets: ['s3', 'sheets'], recordIds: ids },
    { archivedIds: kept.map((i) => ids[i]), failed: [{ id: ids[2], status: null }] }
  ));
});

test('error logger masks secrets, service-account internals and the portal ID', async () => {
  const env = Object.assign({}, ENV, { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'archiver@mock-project.example', private_key: 'MOCK-PRIVATE-KEY-VALUE' }) });
  const msg = 'failed: ' + ENV.HUBSPOT_ACCESS_TOKEN + ' ' + ENV.AWS_SECRET_ACCESS_KEY + ' ' + ENV.AWS_S3_BUCKET + ' MOCK-PRIVATE-KEY-VALUE portal 12345678 p_mock_subscriptions';
  const out = await runCodeNode(N.LOGGER, {
    env,
    nodes: { [N.SANDBOX]: { portal } },
    input: [{ json: { error: { message: msg, httpCode: '403' } } }],
    prevNode: { name: N.S3_PUT },
  });
  const j = out[0].json;
  assert.equal(j.node, N.S3_PUT);
  assert.equal(j.status, '403');
  for (const leaked of [ENV.HUBSPOT_ACCESS_TOKEN, ENV.AWS_SECRET_ACCESS_KEY, ENV.AWS_S3_BUCKET, 'MOCK-PRIVATE-KEY-VALUE', '12345678', 'p_mock_subscriptions']) {
    assert.ok(!j.message.includes(leaked), 'leaked ' + leaked);
  }
});
