'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const a = require('../src/archiver');
const fixtures = require('./fixtures/custom-objects.json');

const criteria = (cutoffMs, extra) => Object.assign({
  cutoffMs, dateProperty: 'hs_lastmodifieddate', activityDateProperty: 'last_engagement_date',
  legalHoldProperty: 'retention_hold', maxArchivePerRun: 500,
}, extra || {});
const CUTOFF = a.computeCutoff('2026-06-30T15:00:00Z', 365);
const ctxFor = (extra) => Object.assign({
  runAt: '2026-07-01T07:00:00.000Z', objectType: 'p_mock_subscriptions', portalId: '12345678', retentionDays: 365,
  cutoffIso: CUTOFF.cutoffIso, dateProperty: 'hs_lastmodifieddate', activityDateProperty: 'last_engagement_date',
  legalHoldProperty: 'retention_hold', s3Prefix: 'hubspot-retention-archive',
}, extra || {});

test('retention cutoff: start of the UTC day minus RETENTION_DAYS', () => {
  assert.equal(CUTOFF.cutoffIso, '2025-06-30T00:00:00.000Z');
  // Same day, different times -> same cutoff (stable reruns).
  assert.equal(a.computeCutoff('2026-06-30T00:00:00Z', 365).cutoffMs, a.computeCutoff('2026-06-30T23:59:59.999Z', 365).cutoffMs);
  // Leap year: 365 days before 2024-03-01 is 2023-03-02; before 2025-03-01 it is 2024-03-01.
  assert.equal(a.computeCutoff('2024-03-01T12:00:00Z', 365).cutoffIso, '2023-03-02T00:00:00.000Z');
  assert.equal(a.computeCutoff('2025-03-01T12:00:00Z', 365).cutoffIso, '2024-03-01T00:00:00.000Z');
  assert.equal(a.computeCutoff(new Date('2026-01-31T05:00:00Z'), 30).cutoffIso, '2026-01-01T00:00:00.000Z');
  assert.throws(() => a.computeCutoff('not a date', 365), /Invalid/);
  assert.throws(() => a.computeCutoff('2026-01-01', 0), /positive integer/);
});

test('HubSpot date parsing: ISO, date-only and epoch milliseconds', () => {
  assert.equal(a.parseHubSpotDate('2025-06-30T00:00:00.000Z'), Date.UTC(2025, 5, 30));
  assert.equal(a.parseHubSpotDate('2025-06-30'), Date.UTC(2025, 5, 30));
  assert.equal(a.parseHubSpotDate('1751241600000'), 1751241600000);
  for (const v of [null, undefined, '', 'garbage']) assert.equal(a.parseHubSpotDate(v), null);
});

test('search body filters on the date property and the activity date (or its absence)', () => {
  const body = a.buildSearchBody(Object.assign({ properties: ['subscription_name'] }, criteria(CUTOFF.cutoffMs)));
  assert.equal(body.filterGroups.length, 2);
  assert.deepEqual(body.filterGroups[0].filters[0], { propertyName: 'hs_lastmodifieddate', operator: 'LT', value: String(CUTOFF.cutoffMs) });
  assert.equal(body.filterGroups[1].filters[1].operator, 'NOT_HAS_PROPERTY');
  assert.deepEqual(body.sorts, [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }]);
  assert.ok(body.properties.includes('retention_hold') && body.properties.includes('subscription_name'));
  assert.equal(body.limit, 100);
  assert.equal(a.buildSearchBody(criteria(1, { activityDateProperty: null, maxArchivePerRun: 20, after: 40 })).limit, 20);
  assert.equal(a.buildSearchBody(criteria(1, { activityDateProperty: null, after: 40 })).after, '40');
  assert.equal(a.buildSearchBody(criteria(1, { activityDateProperty: null })).filterGroups.length, 1);
});

test('client-side staleness re-check excludes protected, fresh and undated records', () => {
  const sel = a.selectStaleRecords(fixtures.results, criteria(CUTOFF.cutoffMs));
  assert.deepEqual(sel.selected.map((r) => r.id), ['1009', '1001', '1002', '1010', '1007']); // oldest first
  assert.deepEqual(sel.excluded, { 'recent-activity': 1, 'within-retention': 2, 'legal-hold': 1, 'missing-date': 1 });
  // Exactly at the cutoff is NOT stale; one second before is.
  const ids = sel.selected.map((r) => r.id);
  assert.ok(ids.includes('1007') && !ids.includes('1008'));
});

test('batch cap truncates selection to MAX_ARCHIVE_PER_RUN, oldest first', () => {
  const sel = a.selectStaleRecords(fixtures.results, criteria(CUTOFF.cutoffMs, { maxArchivePerRun: 2 }));
  assert.deepEqual(sel.selected.map((r) => r.id), ['1009', '1001']);
  assert.equal(sel.eligible, 5);
  assert.equal(sel.truncatedAtCap, true);
});

test('canonical JSON and record checksums are independent of key order', () => {
  assert.equal(a.canonicalStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  const recs = fixtures.results.slice(0, 2);
  const shuffled = recs.map((r) => ({ id: r.id, properties: Object.fromEntries(Object.entries(r.properties).reverse()) }));
  const b1 = a.buildBackup(recs, ctxFor());
  const b2 = a.buildBackup(shuffled.reverse(), ctxFor());
  assert.equal(b1.manifestSha256, b2.manifestSha256);
  assert.equal(b1.runId, b2.runId);
});

test('backup document, checksums and S3 key layout', () => {
  const sel = a.selectStaleRecords(fixtures.results, criteria(CUTOFF.cutoffMs));
  const b = a.buildBackup(sel.selected, ctxFor());
  assert.match(b.runId, /^run-20260701T070000Z-[0-9a-f]{12}$/);
  assert.equal(b.keys.json, 'hubspot-retention-archive/p_mock_subscriptions/2026/07/01/' + b.runId + '.json');
  assert.equal(b.keys.csv, b.keys.json.replace(/\.json$/, '.csv'));
  const doc = JSON.parse(b.json);
  assert.equal(doc.schema, a.BACKUP_SCHEMA);
  assert.equal(doc.recordCount, 5);
  assert.equal(doc.retention.cutoff, '2025-06-30T00:00:00.000Z');
  assert.deepEqual(b.recordIds, ['1001', '1002', '1007', '1009', '1010']);
  assert.equal(b.jsonSha256Hex, crypto.createHash('sha256').update(b.json).digest('hex'));
  assert.equal(b.csvSha256Base64, crypto.createHash('sha256').update(b.csv).digest('base64'));
  for (const rec of doc.records) {
    assert.equal(rec.sha256, crypto.createHash('sha256').update(a.canonicalStringify({ id: rec.id, properties: rec.properties })).digest('hex'));
  }
  assert.deepEqual(b.ledgerHeader, a.LEDGER_COLUMNS);
  assert.equal(b.ledgerRows.length, 5);
  assert.equal(b.ledgerRows[0].length, a.LEDGER_COLUMNS.length);
  assert.equal(a.buildS3Keys('', '2-9999999', '2026-01-05T00:00:00Z', 'run-x').json, '2-9999999/2026/01/05/run-x.json');
});

test('CSV and Sheets cells neutralise formula injection', () => {
  for (const evil of ['=HYPERLINK("https://attacker.example")', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) {
    assert.ok(a.csvCell(evil).replace(/^"/, '').startsWith("'"), evil);
    assert.ok(a.sheetCell(evil).startsWith("'"), evil);
  }
  assert.equal(a.csvCell('a,"b"'), '"a,""b"""');
  assert.equal(a.csvCell(null), '');
  assert.equal(a.sheetCell('Acme Example Corp'), 'Acme Example Corp');
  const b = a.buildBackup([{ id: '1', properties: { name: '=1+1', hs_createdate: '-3' } }], ctxFor({ activityDateProperty: null }));
  for (const row of b.ledgerRows) for (const cell of row) assert.ok(!/^[=+\-@\t\r]/.test(cell), cell);
  for (const line of b.csv.trim().split('\n').slice(1)) {
    for (const cell of line.split(',')) assert.ok(!/^[=+\-@]/.test(cell), cell);
  }
});

test('S3, Sheets and file verification', () => {
  const exp = { kind: 'json', key: 'k.json', checksumSha256Base64: 'abc=' };
  assert.equal(a.verifyS3Put(exp, { statusCode: 200, headers: { 'X-Amz-Checksum-Sha256': 'abc=' } }).ok, true);
  assert.equal(a.verifyS3Put(exp, { statusCode: 200, headers: { 'x-amz-checksum-sha256': 'zzz=' } }).reason, 'checksum-mismatch');
  assert.equal(a.verifyS3Put(exp, { statusCode: 412, headers: {} }).reason, 'http-412');
  const backup = { runId: 'run-1', keys: { json: 'k.json', csv: 'k.csv' } };
  assert.equal(a.summarizeS3Verification([{ kind: 'json', key: 'k.json', ok: true }], backup).ok, false);
  assert.equal(a.summarizeS3Verification([{ kind: 'json', key: 'k.json', ok: true }, { kind: 'csv', key: 'k.csv', ok: true }], backup).ok, true);
  assert.equal(a.verifySheetsAppend(3, { updates: { updatedRows: 3 } }, 'run-1').ok, true);
  assert.equal(a.verifySheetsAppend(3, { updates: { updatedRows: 2 } }, 'run-1').ok, false);
  assert.equal(a.verifySheetsAppend(3, {}, 'run-1').ok, false);
  assert.equal(a.verifyFileWrite('json', 'x', 'aa', 'aa', 'run-1').ok, true);
});

test('planArchive enforces backup-before-archive for every configured target', () => {
  const backup = { runId: 'run-1', manifestSha256: 'm', recordIds: ['1', '2'] };
  const settings = { storageTargets: ['s3', 'sheets'], maxArchivePerRun: 500 };
  const ok = { s3: { ok: true, runId: 'run-1' }, sheets: { ok: true, runId: 'run-1' } };
  assert.deepEqual(a.planArchive(backup, ok, settings).recordIds, ['1', '2']);
  assert.throws(() => a.planArchive(backup, { s3: ok.s3 }, settings), /sheets: not executed.*no HubSpot records were archived/);
  assert.throws(() => a.planArchive(backup, { s3: { ok: false, reason: 'http-500' }, sheets: ok.sheets }, settings), /s3: http-500/);
  assert.throws(() => a.planArchive(backup, { s3: { ok: true, runId: 'old-run' }, sheets: ok.sheets }, settings), /different run/);
  assert.throws(() => a.planArchive(backup, ok, { storageTargets: [], maxArchivePerRun: 500 }), /without a backup/);
  assert.throws(() => a.planArchive(backup, ok, { storageTargets: ['s3', 'sheets'], maxArchivePerRun: 1 }), /Batch cap exceeded/);
});

test('Google JWT claims and Sheets append URL', () => {
  const jwt = a.buildGoogleJwtUnsigned({ client_email: 'archiver@mock-project.example' }, 1767596400);
  const [header, claims] = jwt.split('.').map((p) => JSON.parse(Buffer.from(p, 'base64url').toString('utf8')));
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(claims.scope, a.GOOGLE_SHEETS_SCOPE);
  assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(
    a.sheetsAppendUrl('mock-sheet-id', 'archive ledger'),
    "https://sheets.googleapis.com/v4/spreadsheets/mock-sheet-id/values/'archive%20ledger'!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=false".replace("'archive%20ledger'!A1", encodeURIComponent("'archive ledger'!A1"))
  );
});

test('dry-run preview reports what would be written and archived', () => {
  const sel = a.selectStaleRecords(fixtures.results, criteria(CUTOFF.cutoffMs));
  const b = a.buildBackup(sel.selected, ctxFor());
  const p = a.buildDryRunPreview(sel, b, { storageTargets: ['s3', 'sheets'], storeS3: true, storeSheets: true, storeFile: false, sheetsTab: 'archive_ledger' }, {});
  assert.equal(p.dryRun, true);
  assert.equal(p.wouldArchive.count, 5);
  assert.equal(p.wouldWrite.s3.objects.length, 2);
  assert.equal(p.wouldWrite.sheets.rows, 5);
  assert.equal(p.wouldWrite.file, null);
});
