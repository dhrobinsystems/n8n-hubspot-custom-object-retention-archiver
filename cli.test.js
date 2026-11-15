'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, parseArgs, SafetyError } = require('../src/index');
const { loadConfig } = require('../src/config');
const { BackupError } = require('../src/storage');
const fixtures = require('./fixtures/custom-objects.json');

const FAKE_TOKEN = 'mock-hubspot-credential-string';
const BASE = {
  HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, CUSTOM_OBJECT_TYPE: 'p_mock_subscriptions',
  ACTIVITY_DATE_PROPERTY: 'last_engagement_date', LEGAL_HOLD_PROPERTY: 'retention_hold',
};
const S3_ENV = { AWS_S3_BUCKET: 'mock-archive-bucket', AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'MOCKACCESSKEYID000000', AWS_SECRET_ACCESS_KEY: 'mock-secret-access-key-0000000000000000' };
const SHEETS_ENV = { GOOGLE_SHEETS_ID: 'mock-sheet-id-000000', GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.mock-oauth-token' };
const NOW = new Date('2026-06-30T07:00:00.000Z');

function response(status, body, headers) {
  const h = Object.assign({}, headers || {});
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => h[k.toLowerCase()] ?? null, forEach: (fn) => Object.entries(h).forEach(([k, v]) => fn(v, k)) },
    text: async () => text, json: async () => JSON.parse(text || 'null'),
  };
}

/** Fake HubSpot + S3 + Google. Records every call in order. */
function fakeFetch(opts) {
  const o = Object.assign({ accountType: 'SANDBOX', pageSize: 4, s3: 'ok', sheetsRows: null, deleteFail: [], publicKey: null }, opts || {});
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    const method = (init && init.method) || 'GET';
    const body = init && init.body;
    const call = { host: u.host, path: u.pathname, method, headers: (init && init.headers) || {}, body };
    calls.push(call);
    if (u.host === 'api.hubapi.com') {
      if (u.pathname === '/account-info/v3/details') return response(200, { portalId: 12345678, accountType: o.accountType, uiDomain: 'app.hubspot.com' });
      if (u.pathname === '/crm/v3/properties/p_mock_subscriptions') {
        return response(200, { results: Object.keys(fixtures.results[0].properties).map((name) => ({ name })) });
      }
      if (u.pathname === '/crm/v3/objects/p_mock_subscriptions/search') {
        const req = JSON.parse(body);
        call.searchBody = req;
        const start = Number(req.after || 0);
        const size = Math.min(o.pageSize, req.limit);
        const results = fixtures.results.slice(start, start + size);
        const next = start + size < fixtures.results.length ? { next: { after: String(start + size) } } : undefined;
        return response(200, next ? { results, paging: next } : { results });
      }
      const m = u.pathname.match(/^\/crm\/v3\/objects\/p_mock_subscriptions\/(\d+)$/);
      if (m && method === 'DELETE') return o.deleteFail.includes(m[1]) ? response(400, { message: 'mock failure' }) : response(204);
    }
    if (u.host.endsWith('.amazonaws.com')) {
      const sent = call.headers['x-amz-checksum-sha256'];
      const actual = crypto.createHash('sha256').update(body).digest('base64');
      assert.equal(sent, actual, 'client must send the true checksum');
      assert.match(call.headers.Authorization, /^AWS4-HMAC-SHA256 /);
      assert.equal(call.headers['If-None-Match'], '*');
      if (o.s3 === 'error') return response(500, '<Error/>');
      if (o.s3 === 'exists') return response(412, '<Error><Code>PreconditionFailed</Code></Error>');
      if (o.s3 === 'mismatch') return response(200, '', { 'x-amz-checksum-sha256': 'bm90LXRoZS1zYW1lLWNoZWNrc3Vt' });
      if (o.s3 === 'csv-fails' && u.pathname.endsWith('.csv')) return response(500, '<Error/>');
      return response(200, '', { 'x-amz-checksum-sha256': sent, etag: '"mock"' });
    }
    if (u.host === 'oauth2.googleapis.com') {
      const assertion = new URLSearchParams(body).get('assertion');
      const [h, c, sig] = assertion.split('.');
      assert.ok(crypto.createVerify('RSA-SHA256').update(h + '.' + c).verify(o.publicKey, Buffer.from(sig, 'base64url')), 'JWT must verify');
      return response(200, { access_token: 'ya29.minted-mock-token', expires_in: 3600 });
    }
    if (u.host === 'sheets.googleapis.com') {
      const rows = JSON.parse(body).values.length;
      return response(200, { updates: { updatedRows: o.sheetsRows === null ? rows : o.sheetsRows } });
    }
    return response(404, { message: 'not mocked: ' + method + ' ' + url });
  };
  fn.calls = calls;
  fn.deletes = () => calls.filter((c) => c.method === 'DELETE');
  fn.storageWrites = () => calls.filter((c) => c.host.endsWith('.amazonaws.com') || c.host === 'sheets.googleapis.com');
  return fn;
}

const deps = (fetch, extra) => Object.assign({ fetch, now: () => NOW, wait: async () => {}, requestIntervalMs: 0, archiveIntervalMs: 0 }, extra || {});

test('DRY_RUN (default): reads HubSpot, builds payloads, zero storage writes, zero DELETEs', async () => {
  const fetch = fakeFetch();
  const out = await run(loadConfig(Object.assign({ STORAGE_TARGETS: 's3,sheets' }, BASE)), deps(fetch));
  assert.equal(out.meta.dryRun, true);
  assert.equal(out.backup.recordCount, 5);
  assert.equal(out.preview.wouldArchive.count, 5);
  assert.equal(fetch.storageWrites().length, 0);
  assert.equal(fetch.deletes().length, 0);
  assert.ok(fetch.calls.every((c) => c.host === 'api.hubapi.com' && ['GET', 'POST'].includes(c.method)));
  assert.equal(fetch.calls.filter((c) => c.path.endsWith('/search')).length, 3); // paginated: 10 records / 4 per page
});

test('SANDBOX_MODE gate aborts before any record is read', async () => {
  const fetch = fakeFetch({ accountType: 'STANDARD' });
  const config = loadConfig(Object.assign({}, BASE, S3_ENV, { DRY_RUN: 'false' }));
  await assert.rejects(run(config, deps(fetch)), (e) => e instanceof SafetyError && /Sandbox gate blocked/.test(e.message));
  assert.deepEqual(fetch.calls.map((c) => c.path), ['/account-info/v3/details']);
});

test('live run: S3 backup is verified BEFORE the first DELETE, then every stale record is archived', async () => {
  const fetch = fakeFetch();
  const out = await run(loadConfig(Object.assign({}, BASE, S3_ENV, { DRY_RUN: 'false' })), deps(fetch));
  assert.equal(out.archive.archived, 5);
  assert.equal(out.archive.failed, 0);
  assert.equal(out.verifications.s3.ok, true);
  const order = fetch.calls.map((c) => (c.method === 'DELETE' ? 'DELETE' : c.host.endsWith('.amazonaws.com') ? 'S3' : 'HS'));
  assert.ok(order.lastIndexOf('S3') < order.indexOf('DELETE'), 'all S3 writes precede the first DELETE');
  assert.deepEqual(fetch.deletes().map((c) => c.path.split('/').pop()), ['1001', '1002', '1007', '1009', '1010']);
  const s3 = fetch.storageWrites();
  assert.equal(s3.length, 2);
  assert.ok(s3[0].path.endsWith(out.backup.runId + '.json') && s3[1].path.endsWith(out.backup.runId + '.csv'));
});

for (const [mode, why] of [['error', 'HTTP 500'], ['exists', 'object already exists (412)'], ['mismatch', 'checksum mismatch'], ['csv-fails', 'second object fails']]) {
  test('backup-before-archive: S3 ' + why + ' → zero DELETE calls', async () => {
    const fetch = fakeFetch({ s3: mode });
    const config = loadConfig(Object.assign({}, BASE, S3_ENV, { DRY_RUN: 'false' }));
    await assert.rejects(run(config, deps(fetch)), (e) => e instanceof BackupError && /no HubSpot records were archived/.test(e.message));
    assert.equal(fetch.deletes().length, 0);
  });
}

test('backup-before-archive: Sheets row-count mismatch after a good S3 upload → zero DELETE calls', async () => {
  const fetch = fakeFetch({ sheetsRows: 4 });
  const config = loadConfig(Object.assign({}, BASE, S3_ENV, SHEETS_ENV, { DRY_RUN: 'false', STORAGE_TARGETS: 's3,sheets' }));
  await assert.rejects(run(config, deps(fetch)), (e) => e instanceof BackupError && /Google Sheets/.test(e.message));
  assert.equal(fetch.deletes().length, 0);
  assert.equal(fetch.storageWrites().length, 3); // 2 S3 objects + 1 Sheets append, then stop
});

test('Sheets with a service account: JWT signed with node:crypto, then rows appended and verified', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = JSON.stringify({
    type: 'service_account', client_email: 'archiver@mock-project.example', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  const fetch = fakeFetch({ publicKey });
  const config = loadConfig(Object.assign({}, BASE, { DRY_RUN: 'false', STORAGE_TARGETS: 'sheets', GOOGLE_SHEETS_ID: 'mock-sheet-id-000000', GOOGLE_SERVICE_ACCOUNT_JSON: sa }));
  const out = await run(config, deps(fetch));
  assert.equal(out.verifications.sheets.ok, true);
  assert.equal(out.archive.archived, 5);
  const append = fetch.calls.find((c) => c.host === 'sheets.googleapis.com');
  assert.equal(append.headers.Authorization, 'Bearer ya29.minted-mock-token');
  assert.equal(JSON.parse(append.body).values[0].length, 13);
});

test('MAX_ARCHIVE_PER_RUN caps both the search and the archive', async () => {
  const fetch = fakeFetch();
  const out = await run(loadConfig(Object.assign({}, BASE, S3_ENV, { DRY_RUN: 'false', MAX_ARCHIVE_PER_RUN: '3' })), deps(fetch));
  const searches = fetch.calls.filter((c) => c.searchBody);
  assert.equal(searches.length, 1, 'stops paginating once the cap is reached');
  assert.equal(searches[0].searchBody.limit, 3);
  assert.equal(out.selection.totalInput, 3);
  assert.ok(fetch.deletes().length <= 3);
  assert.equal(fetch.deletes().length, out.backup.recordCount);
});

test('a failed DELETE is reported without stopping the others', async () => {
  const fetch = fakeFetch({ deleteFail: ['1007'] });
  const out = await run(loadConfig(Object.assign({}, BASE, S3_ENV, { DRY_RUN: 'false' })), deps(fetch));
  assert.equal(out.archive.archived, 4);
  assert.equal(out.archive.failed, 1);
  assert.deepEqual(out.archive.failures, [{ id: '1007', status: 400 }]);
});

test('local file target: write-once, read back and hash-verified; refuses to overwrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-archiver-'));
  const env = Object.assign({}, BASE, { DRY_RUN: 'false', STORAGE_TARGETS: 'file', BACKUP_DIR: dir });
  const out = await run(loadConfig(env), deps(fakeFetch()));
  assert.equal(out.verifications.file.ok, true);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, [out.backup.runId + '.archive.csv', out.backup.runId + '.archive.json']);
  assert.equal(fs.readFileSync(path.join(dir, files[1]), 'utf8'), out.backup.json);
  const again = fakeFetch();
  await assert.rejects(run(loadConfig(env), deps(again)), /file-exists/);
  assert.equal(again.deletes().length, 0);
});

test('offline --input mode never touches the network', async () => {
  const fetch = fakeFetch();
  const config = loadConfig(Object.assign({ DRY_RUN: 'false' }, BASE), { inputFile: path.join(__dirname, 'fixtures', 'custom-objects.json') });
  const out = await run(config, deps(fetch, { asOf: '2026-06-30T12:00:00Z' }));
  assert.equal(fetch.calls.length, 0);
  assert.equal(out.meta.source, 'file');
  assert.deepEqual(out.backup.recordIds, ['1001', '1002', '1007', '1009', '1010']);
});

test('configuration errors are raised before any network call', async () => {
  const fetch = fakeFetch();
  await assert.rejects(run(loadConfig({}), deps(fetch)), /HUBSPOT_ACCESS_TOKEN/);
  await assert.rejects(run(loadConfig(Object.assign({}, BASE, { CUSTOM_OBJECT_TYPE: 'contacts' })), deps(fetch)), /custom object/);
  await assert.rejects(run(loadConfig(Object.assign({}, BASE, S3_ENV, { DRY_RUN: 'false' }), { retentionDays: '90' }), deps(fetch)), /can only RAISE/);
  await assert.rejects(run(loadConfig(Object.assign({}, BASE, S3_ENV, { DRY_RUN: 'false' })), deps(fetch, { asOf: '2026-01-01' })), /--as-of/);
  assert.equal(fetch.calls.length, 0);
});

test('HubSpot errors never leak the token or the object type', async () => {
  const fetch = async () => response(401, 'invalid token ' + FAKE_TOKEN);
  await assert.rejects(run(loadConfig(BASE), deps(fetch)), (e) => /401/.test(e.message) && !e.message.includes(FAKE_TOKEN));
});

test('parseArgs supports the documented flags only', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--retention-days', '400', '--max-archive', '50', '--csv', 'a.csv', '--quiet']), {
    dryRun: true, quiet: true, help: false, retentionDays: '400', maxArchive: '50', csv: 'a.csv',
  });
  assert.throws(() => parseArgs(['--live']), /Unknown option/);
  assert.throws(() => parseArgs(['--output']), /needs a value/);
});
