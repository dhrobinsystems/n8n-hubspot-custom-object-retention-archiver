'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/safety');
const { parseDotEnv, loadConfig } = require('../src/config');

const FAKE_TOKEN = 'mock-hubspot-credential-string';
// Built at runtime so no HubSpot-token-shaped string appears in source; used only to test pattern masking.
const TOKEN_SHAPED = ['pat', 'na1', 'mock0000-0000-0000-0000-000000000000'].join('-');
const BASE = { HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, CUSTOM_OBJECT_TYPE: 'p_mock_subscriptions' };
const LIVE_S3 = Object.assign({}, BASE, {
  DRY_RUN: 'false', AWS_S3_BUCKET: 'mock-archive-bucket', AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'MOCKACCESSKEYID000000', AWS_SECRET_ACCESS_KEY: 'mock-secret-access-key-0000000000000000',
});

test('DRY_RUN, SANDBOX_MODE, RETENTION_DAYS and MAX_ARCHIVE_PER_RUN have safe defaults', () => {
  const { settings, errors } = s.resolveConfig(BASE);
  assert.deepEqual(errors, []);
  assert.equal(settings.dryRun, true);
  assert.equal(settings.sandboxMode, true);
  assert.equal(settings.retentionDays, 365);
  assert.equal(settings.maxArchivePerRun, 500);
  assert.deepEqual(settings.storageTargets, ['s3']);
});

test('only an explicit false disables a gate; typos stay safe', () => {
  for (const [v, expected] of [['false', false], ['0', false], ['OFF', false], ['flase', true], ['', true], ['nope', true]]) {
    assert.equal(s.resolveConfig(Object.assign({ DRY_RUN: v }, BASE)).settings.dryRun, expected, v);
    assert.equal(s.resolveConfig(Object.assign({ SANDBOX_MODE: v }, BASE)).settings.sandboxMode, expected, v);
  }
});

test('settings never contain secrets or sensitive identifiers', () => {
  const env = Object.assign({ GOOGLE_SHEETS_ID: 'mock-sheet-id-000000', STORAGE_TARGETS: 's3,sheets', GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.mock-token-value' }, LIVE_S3);
  const { settings } = s.resolveConfig(env);
  const text = JSON.stringify(settings);
  for (const v of Object.values(env)) {
    if (['false', 's3,sheets', 'us-east-1'].includes(v)) continue;
    assert.ok(!text.includes(v), 'leaked ' + v);
  }
  assert.equal(settings.present.awsCredentials, true);
});

test('placeholder YOUR_* values count as unset', () => {
  const { errors, settings } = s.resolveConfig({ HUBSPOT_ACCESS_TOKEN: 'YOUR_HUBSPOT_PRIVATE_APP_TOKEN', CUSTOM_OBJECT_TYPE: 'YOUR_CUSTOM_OBJECT_TYPE' });
  assert.equal(settings.present.hubspotToken, false);
  assert.match(errors.join(' '), /HUBSPOT_ACCESS_TOKEN/);
  assert.match(errors.join(' '), /CUSTOM_OBJECT_TYPE is not set/);
});

test('only custom object types are accepted', () => {
  for (const ok of ['2-9999999', 'p_mock_subscriptions', 'p12345_mock_subscriptions']) assert.equal(s.isCustomObjectType(ok), true, ok);
  for (const bad of ['contacts', 'companies', '0-1', '0-2', 'deals', '2-', 'p_', 'p_../x']) {
    assert.equal(s.isCustomObjectType(bad), false, bad);
    assert.match(s.resolveConfig(Object.assign({}, BASE, { CUSTOM_OBJECT_TYPE: bad })).errors.join(' '), /CUSTOM_OBJECT_TYPE/);
  }
});

test('retention and batch cap bounds', () => {
  const errs = (env) => s.resolveConfig(Object.assign({}, BASE, env)).errors.join(' ');
  assert.match(errs({ RETENTION_DAYS: '7' }), /RETENTION_DAYS/);
  assert.match(errs({ RETENTION_DAYS: '365.5' }), /RETENTION_DAYS/);
  assert.match(errs({ RETENTION_DAYS: '99999' }), /RETENTION_DAYS/);
  assert.match(errs({ MAX_ARCHIVE_PER_RUN: '0' }), /MAX_ARCHIVE_PER_RUN/);
  assert.match(errs({ MAX_ARCHIVE_PER_RUN: '20000' }), /MAX_ARCHIVE_PER_RUN/);
  assert.match(errs({ DATE_PROPERTY: 'Bad-Name' }), /DATE_PROPERTY/);
  assert.equal(errs({ RETENTION_DAYS: '30', MAX_ARCHIVE_PER_RUN: '10000' }), '');
});

test('storage targets: a backup target is mandatory and live runs need its credentials', () => {
  const errs = (env, opts) => s.resolveConfig(Object.assign({}, BASE, env), opts).errors.join(' ');
  assert.match(errs({ STORAGE_TARGETS: 'none' }), /unsupported/);
  assert.match(errs({ STORAGE_TARGETS: 'ftp' }), /unsupported/);
  assert.match(errs({ STORAGE_TARGETS: 'file' }, { runtime: 'n8n' }), /unsupported value\(s\) for n8n: file/);
  assert.equal(errs({ STORAGE_TARGETS: 'file' }), '');
  assert.equal(errs({ STORAGE_TARGETS: 's3,sheets' }), ''); // dry run needs no storage credentials
  const live = errs({ DRY_RUN: 'false', STORAGE_TARGETS: 's3,sheets' });
  for (const k of ['AWS_S3_BUCKET', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'GOOGLE_SHEETS_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON']) assert.match(live, new RegExp(k));
  assert.equal(s.resolveConfig(LIVE_S3).errors.length, 0);
  assert.match(errs({ GOOGLE_SERVICE_ACCOUNT_JSON: '{not json' }), /GOOGLE_SERVICE_ACCOUNT_JSON/);
  assert.match(errs({ AWS_S3_ENDPOINT: 'http://insecure.example' }), /AWS_S3_ENDPOINT/);
});

test('CLI overrides may only make a live run more conservative', () => {
  const live = (o) => s.resolveConfig(LIVE_S3, o).errors.join(' ');
  assert.match(live({ retentionOverride: '100' }), /can only RAISE/);
  assert.equal(live({ retentionOverride: '730' }), '');
  assert.match(live({ maxArchiveOverride: '1000' }), /can only LOWER/);
  assert.equal(live({ maxArchiveOverride: '10' }), '');
  const dry = s.resolveConfig(BASE, { retentionOverride: '90', maxArchiveOverride: '2000' });
  assert.deepEqual(dry.errors, []);
  assert.equal(dry.settings.retentionDays, 90);
});

test('sandbox gate allows SANDBOX / DEVELOPER_TEST only', () => {
  assert.equal(s.assertSandbox({ accountType: 'SANDBOX' }, true).ok, true);
  assert.equal(s.assertSandbox({ accountType: 'developer_test' }, true).enforced, true);
  for (const t of ['STANDARD', 'APP_DEVELOPER', '', undefined]) {
    assert.throws(() => s.assertSandbox({ accountType: t }, true), /Sandbox gate blocked.*No records were read or archived/);
  }
  assert.deepEqual(s.assertSandbox({ accountType: 'STANDARD' }, false), { ok: true, enforced: false, accountType: 'STANDARD' });
});

test('batch cap assertion', () => {
  assert.equal(s.assertWithinBatchCap(500, 500), true);
  assert.throws(() => s.assertWithinBatchCap(501, 500), /Batch cap exceeded/);
  assert.throws(() => s.assertWithinBatchCap(-1, 500), /invalid/);
});

test('maskSecrets removes tokens, keys, private keys, signatures, emails and known values', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMOCKMOCKMOCK\n-----END PRIVATE KEY-----';
  const text = [
    'hubspot ' + FAKE_TOKEN, 'shaped ' + TOKEN_SHAPED, 'auth Bearer abc.def-123', 'aws AKIAMOCKMOCKMOCK0000', 'Credential=AKIAMOCK/20260101/us-east-1/s3/aws4_request',
    'Signature=' + 'a'.repeat(64), 'google ya29.mockTokenValue', 'jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJtb2NrIn0.c2ln', pem,
    'contact ops@acme.example', 'bucket mock-archive-bucket', 'portal 12345678',
  ].join(' | ');
  const out = s.maskSecrets(text, [FAKE_TOKEN, 'mock-archive-bucket', '12345678']);
  for (const leaked of [FAKE_TOKEN, TOKEN_SHAPED, 'abc.def-123', 'AKIAMOCKMOCKMOCK0000', 'AKIAMOCK/', 'a'.repeat(64), 'ya29.mock', 'eyJhbGci', 'MOCKMOCKMOCK', 'ops@acme.example', 'mock-archive-bucket', '12345678']) {
    assert.ok(!out.includes(leaked), 'leaked ' + leaked + ' in ' + out);
  }
});

test('collectSecretValues includes service-account internals', () => {
  const sa = JSON.stringify({ client_email: 'archiver@mock-project.example', private_key: 'MOCK-PRIVATE-KEY', private_key_id: 'mock-key-id-0000' });
  const values = s.collectSecretValues({ googleServiceAccountJson: sa, hubspotToken: FAKE_TOKEN });
  for (const v of ['MOCK-PRIVATE-KEY', 'mock-key-id-0000', 'archiver@mock-project.example', FAKE_TOKEN]) assert.ok(values.includes(v), v);
});

test('maskError yields a small, masked object for any error shape', () => {
  const e = new Error('401 for Bearer ' + FAKE_TOKEN);
  e.status = 401;
  const m = s.maskError(e, [FAKE_TOKEN]);
  assert.equal(m.status, '401');
  assert.ok(!m.message.includes(FAKE_TOKEN));
  assert.equal(s.maskError(null).message, 'Unknown error');
  assert.ok(s.maskError({ message: 'x'.repeat(5000) }).message.length <= 1000);
});

test('.env parsing and CLI config loading', () => {
  assert.deepEqual(parseDotEnv('# c\nexport DRY_RUN=false\nA="x # y"\nB=plain # note\nC=\'s\'\nnot a line'), { DRY_RUN: 'false', A: 'x # y', B: 'plain', C: 's' });
  assert.equal(loadConfig(LIVE_S3, {}).dryRun, false);
  assert.equal(loadConfig(LIVE_S3, { dryRun: true }).dryRun, true);
  const offline = loadConfig({ DRY_RUN: 'false' }, { inputFile: 'x.json' });
  assert.equal(offline.dryRun, true);
  assert.deepEqual(offline.errors, []);
});
