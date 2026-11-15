'use strict';
/**
 * archiver.js — retention logic, cold-storage backup construction, backup
 * verification and the backup-before-archive plan.
 *
 * PURE MODULE: no require(), no I/O, deterministic for a given input.
 * Inlined (together with hash.js) into the n8n Code nodes by
 * scripts/build-workflow.js; test/workflow.test.js proves parity with the CLI.
 */

const DAY_MS = 86400000;
const BACKUP_SCHEMA = 'hubspot-retention-archive/v1';
const SEARCH_PAGE_SIZE = 100;
const MAX_CELL_CHARS = 40000; // Google Sheets allows 50,000 characters per cell

const LEDGER_COLUMNS = [
  'run_id', 'run_at', 'object_type', 'record_id', 'created_at', 'last_modified_at', 'last_activity_at',
  'record_sha256', 'manifest_sha256', 's3_json_key', 'properties_json', 'properties_truncated', 'status',
];
const LEDGER_STATUS = 'backed-up-pending-archive';

// ---------------------------------------------------------------------------
// Retention cutoff and staleness
// ---------------------------------------------------------------------------

/**
 * Cutoff = start of the current UTC day minus RETENTION_DAYS. Anchoring to the
 * UTC day makes every run on the same day use the same cutoff.
 */
function computeCutoff(now, retentionDays) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('Invalid "now" timestamp for retention cutoff');
  if (!(Number.isInteger(retentionDays) && retentionDays > 0)) throw new Error('retentionDays must be a positive integer');
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const cutoffMs = dayStart - retentionDays * DAY_MS;
  return { cutoffMs, cutoffIso: new Date(cutoffMs).toISOString(), retentionDays };
}

/** HubSpot dates arrive as ISO datetimes, date-only strings or epoch-millisecond strings. */
function parseHubSpotDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (/^\d{10,14}$/.test(s)) return Number(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T00:00:00.000Z');
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function isTruthyFlag(value) {
  return ['true', 'yes', '1', 'on', 'y'].includes(String(value === undefined || value === null ? '' : value).trim().toLowerCase());
}

/** Search API body: stale by DATE_PROPERTY and (optionally) the activity date or its absence. */
function buildSearchBody(opts) {
  const o = opts || {};
  const base = { propertyName: o.dateProperty, operator: 'LT', value: String(o.cutoffMs) };
  let filterGroups;
  if (o.activityDateProperty) {
    filterGroups = [
      { filters: [base, { propertyName: o.activityDateProperty, operator: 'LT', value: String(o.cutoffMs) }] },
      { filters: [base, { propertyName: o.activityDateProperty, operator: 'NOT_HAS_PROPERTY' }] },
    ];
  } else {
    filterGroups = [{ filters: [base] }];
  }
  const properties = Array.from(new Set((o.properties || []).concat(
    [o.dateProperty, o.activityDateProperty, o.legalHoldProperty, 'hs_createdate', 'hs_lastmodifieddate', 'hs_object_id'].filter(Boolean)
  ))).sort();
  const body = {
    filterGroups,
    sorts: [{ propertyName: o.dateProperty, direction: 'ASCENDING' }],
    properties,
    limit: Math.min(SEARCH_PAGE_SIZE, o.maxArchivePerRun || SEARCH_PAGE_SIZE),
  };
  if (o.after) body.after = String(o.after);
  return body;
}

/** Re-check every record client-side (defence in depth against a misconfigured search). */
function evaluateRecord(record, ctx) {
  const r = record || {};
  const p = r.properties || {};
  if (!r.id) return { stale: false, reason: 'missing-id' };
  if (r.archived === true) return { stale: false, reason: 'already-archived' };
  if (ctx.legalHoldProperty && isTruthyFlag(p[ctx.legalHoldProperty])) return { stale: false, reason: 'legal-hold' };
  const last = parseHubSpotDate(p[ctx.dateProperty]);
  if (last === null) return { stale: false, reason: 'missing-date' };
  if (!(last < ctx.cutoffMs)) return { stale: false, reason: 'within-retention' };
  if (ctx.activityDateProperty) {
    const act = parseHubSpotDate(p[ctx.activityDateProperty]);
    if (act !== null && !(act < ctx.cutoffMs)) return { stale: false, reason: 'recent-activity' };
  }
  return { stale: true, reason: 'stale' };
}

function compareIds(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Select stale records, oldest first, capped at maxArchivePerRun.
 * Returns { selected, excluded: { reason: count }, totalInput, eligible, truncatedAtCap }.
 */
function selectStaleRecords(records, ctx) {
  const input = Array.isArray(records) ? records : [];
  const seen = new Set();
  const eligible = [];
  const excluded = {};
  for (const raw of input) {
    const rec = raw && raw.id !== undefined ? Object.assign({}, raw, { id: String(raw.id) }) : raw;
    const verdict = evaluateRecord(rec, ctx);
    if (verdict.stale && seen.has(rec.id)) { excluded['duplicate-id'] = (excluded['duplicate-id'] || 0) + 1; continue; }
    if (!verdict.stale) { excluded[verdict.reason] = (excluded[verdict.reason] || 0) + 1; continue; }
    seen.add(rec.id);
    eligible.push(rec);
  }
  eligible.sort((x, y) =>
    parseHubSpotDate(x.properties[ctx.dateProperty]) - parseHubSpotDate(y.properties[ctx.dateProperty]) || compareIds(x.id, y.id));
  const selected = eligible.slice(0, ctx.maxArchivePerRun);
  return {
    selected,
    excluded,
    totalInput: input.length,
    eligible: eligible.length,
    truncatedAtCap: eligible.length > selected.length,
  };
}

// ---------------------------------------------------------------------------
// Deterministic backup
// ---------------------------------------------------------------------------

/** JSON with recursively sorted keys: same data, same bytes, same checksum. */
function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

/** Neutralise spreadsheet formula injection (= + - @ tab CR) and quote for CSV. */
function csvCell(v) {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Same neutralisation for Google Sheets cells (no CSV quoting needed). */
function sheetCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function compactTimestamp(iso) {
  return String(iso).replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function safeSegment(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '_');
}

/** S3 layout: <prefix>/<objectType>/<YYYY>/<MM>/<DD>/<runId>.json|.csv */
function buildS3Keys(prefix, objectType, runAt, runId) {
  const d = new Date(runAt);
  const parts = [
    d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'),
  ];
  const base = [prefix, safeSegment(objectType)].concat(parts).filter((x) => x !== '' && x !== undefined).join('/') + '/' + runId;
  return { json: base + '.json', csv: base + '.csv' };
}

/**
 * Build the full, immutable cold-storage backup for the selected records.
 * ctx: { runAt, objectType, portalId, retentionDays, cutoffIso, dateProperty, activityDateProperty, legalHoldProperty, s3Prefix }
 */
function buildBackup(records, ctx) {
  const c = ctx || {};
  const entries = (records || []).map((r) => {
    const properties = Object.assign({}, r.properties || {});
    const sha = sha256Hex(canonicalStringify({ id: String(r.id), properties }));
    return {
      id: String(r.id),
      createdAt: r.createdAt || properties.hs_createdate || null,
      updatedAt: r.updatedAt || properties.hs_lastmodifieddate || null,
      properties,
      sha256: sha,
    };
  }).sort((x, y) => compareIds(x.id, y.id));

  const manifestSha256 = sha256Hex(canonicalStringify(entries.map((e) => ({ id: e.id, sha256: e.sha256 }))));
  const runId = 'run-' + compactTimestamp(c.runAt) + '-' + manifestSha256.slice(0, 12);
  const keys = buildS3Keys(c.s3Prefix === undefined ? 'hubspot-retention-archive' : c.s3Prefix, c.objectType, c.runAt, runId);

  const document = {
    schema: BACKUP_SCHEMA,
    runId,
    runAt: c.runAt,
    source: {
      system: 'hubspot',
      portalId: c.portalId === undefined || c.portalId === null ? null : String(c.portalId),
      objectType: c.objectType,
    },
    retention: {
      retentionDays: c.retentionDays,
      cutoff: c.cutoffIso,
      dateProperty: c.dateProperty,
      activityDateProperty: c.activityDateProperty || null,
      legalHoldProperty: c.legalHoldProperty || null,
    },
    recordCount: entries.length,
    manifestSha256,
    records: entries,
  };
  const json = canonicalStringify(document) + '\n';

  const ledgerRows = entries.map((e) => {
    const propsJson = canonicalStringify(e.properties);
    const truncated = propsJson.length > MAX_CELL_CHARS;
    return [
      runId, c.runAt, c.objectType, e.id, e.createdAt, e.updatedAt,
      c.activityDateProperty ? (e.properties[c.activityDateProperty] || '') : '',
      e.sha256, manifestSha256, keys.json,
      truncated ? propsJson.slice(0, MAX_CELL_CHARS) : propsJson,
      truncated ? 'yes' : 'no',
      LEDGER_STATUS,
    ].map(sheetCell);
  });
  const csvLines = [LEDGER_COLUMNS.join(',')].concat(entries.map((e) => [
    runId, c.runAt, c.objectType, e.id, e.createdAt, e.updatedAt,
    c.activityDateProperty ? (e.properties[c.activityDateProperty] || '') : '',
    e.sha256, manifestSha256, keys.json, canonicalStringify(e.properties), 'no', LEDGER_STATUS,
  ].map(csvCell).join(',')));
  const csv = csvLines.join('\n') + '\n';

  return {
    runId,
    runAt: c.runAt,
    recordCount: entries.length,
    recordIds: entries.map((e) => e.id),
    manifestSha256,
    keys,
    json,
    jsonSha256Hex: sha256Hex(json),
    jsonSha256Base64: sha256Base64(json),
    jsonBytes: utf8Bytes(json).length,
    csv,
    csvSha256Hex: sha256Hex(csv),
    csvSha256Base64: sha256Base64(csv),
    ledgerHeader: LEDGER_COLUMNS.slice(),
    ledgerRows,
  };
}

// ---------------------------------------------------------------------------
// Verification and archive plan
// ---------------------------------------------------------------------------

function headerValue(headers, name) {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return headers[k];
  return undefined;
}

/** S3 PutObject is verified only on HTTP 200 AND S3 echoing the exact SHA-256 we sent. */
function verifyS3Put(expected, response) {
  const status = Number(response && (response.statusCode || response.status));
  const echoed = headerValue(response && response.headers, 'x-amz-checksum-sha256');
  const ok = status === 200 && echoed === expected.checksumSha256Base64;
  return {
    ok,
    target: 's3',
    kind: expected.kind,
    key: expected.key,
    status: Number.isFinite(status) ? status : null,
    checksumMatched: echoed === expected.checksumSha256Base64,
    reason: ok ? 'verified' : (status !== 200 ? 'http-' + (Number.isFinite(status) ? status : 'unknown') : 'checksum-mismatch'),
  };
}

/** Collapse the per-object results for one run into a single S3 verification. */
function summarizeS3Verification(results, backup) {
  const needed = ['json', 'csv'];
  const byKind = {};
  for (const r of results || []) byKind[r.kind] = r;
  const ok = needed.every((k) => byKind[k] && byKind[k].ok && byKind[k].key === backup.keys[k]);
  return { ok, target: 's3', runId: backup.runId, objects: needed.map((k) => byKind[k] || { kind: k, ok: false, reason: 'missing' }) };
}

/** Google Sheets append is verified when the API reports exactly the rows we sent. */
function verifySheetsAppend(expectedRows, response, runId) {
  const updates = response && response.updates ? response.updates : {};
  const updatedRows = Number(updates.updatedRows);
  const ok = updatedRows === expectedRows;
  return {
    ok,
    target: 'sheets',
    runId,
    expectedRows,
    updatedRows: Number.isFinite(updatedRows) ? updatedRows : null,
    reason: ok ? 'verified' : 'row-count-mismatch',
  };
}

/** Local file target: verified when the bytes read back hash to the expected value. */
function verifyFileWrite(kind, path, expectedSha256Hex, actualSha256Hex, runId) {
  const ok = expectedSha256Hex === actualSha256Hex;
  return { ok, target: 'file', kind, path, runId, reason: ok ? 'verified' : 'checksum-mismatch' };
}

/**
 * Backup-before-archive enforcement. Returns the record IDs that may be archived
 * only if EVERY configured storage target verified THIS run's backup.
 * Throws (and so archives nothing) otherwise.
 */
function planArchive(backup, verifications, settings) {
  const targets = settings.storageTargets || [];
  if (!targets.length) throw new Error('No cold-storage target configured; refusing to archive without a backup.');
  const failed = [];
  for (const t of targets) {
    const v = verifications ? verifications[t] : null;
    if (!v) failed.push(t + ': not executed');
    else if (!v.ok) failed.push(t + ': ' + (v.reason || 'failed'));
    else if (v.runId !== backup.runId) failed.push(t + ': verification belongs to a different run');
  }
  if (failed.length) {
    throw new Error('Backup verification failed (' + failed.join('; ') + '). Archiving aborted: no HubSpot records were archived.');
  }
  if (backup.recordIds.length > settings.maxArchivePerRun) {
    throw new Error('Batch cap exceeded: backup holds ' + backup.recordIds.length + ' records but MAX_ARCHIVE_PER_RUN=' + settings.maxArchivePerRun + '. Nothing was archived.');
  }
  return {
    runId: backup.runId,
    manifestSha256: backup.manifestSha256,
    verifiedTargets: targets.slice(),
    recordIds: backup.recordIds.slice(),
  };
}

function summarizeArchive(plan, outcome) {
  const archived = outcome && Array.isArray(outcome.archivedIds) ? outcome.archivedIds : [];
  const failed = outcome && Array.isArray(outcome.failed) ? outcome.failed : [];
  return {
    runId: plan.runId,
    manifestSha256: plan.manifestSha256,
    planned: plan.recordIds.length,
    archived: archived.length,
    failed: failed.length,
    failures: failed,
    verifiedTargets: plan.verifiedTargets,
    note: 'Archived records sit in the HubSpot recycle bin for 90 days; the cold-storage backup is the long-term copy.',
  };
}

/** Everything a dry run would write and archive, with nothing written or archived. */
function buildDryRunPreview(selection, backup, settings, meta) {
  return {
    dryRun: true,
    note: 'DRY_RUN is on: zero writes to S3 / Google Sheets / files and zero HubSpot DELETE calls were made.',
    meta,
    selection: {
      totalInput: selection.totalInput,
      eligible: selection.eligible,
      selected: selection.selected.length,
      truncatedAtCap: selection.truncatedAtCap,
      excluded: selection.excluded,
    },
    storageTargets: settings.storageTargets,
    wouldWrite: {
      s3: settings.storeS3 ? {
        objects: [
          { key: backup.keys.json, bytes: backup.jsonBytes, sha256Base64: backup.jsonSha256Base64 },
          { key: backup.keys.csv, bytes: utf8Bytes(backup.csv).length, sha256Base64: backup.csvSha256Base64 },
        ],
      } : null,
      sheets: settings.storeSheets ? { tab: settings.sheetsTab, rows: backup.ledgerRows.length, header: backup.ledgerHeader } : null,
      file: settings.storeFile ? { dir: settings.backupDir, files: [backup.runId + '.json', backup.runId + '.csv'] } : null,
    },
    wouldArchive: { count: backup.recordIds.length, recordIds: backup.recordIds },
    backup: { runId: backup.runId, manifestSha256: backup.manifestSha256, json: backup.json, csv: backup.csv },
  };
}

// ---------------------------------------------------------------------------
// Google Sheets helpers (signing itself happens with crypto in the caller)
// ---------------------------------------------------------------------------

const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Unsigned RS256 JWT (header.claims) for a Google service-account token exchange. */
function buildGoogleJwtUnsigned(serviceAccount, nowSeconds) {
  const sa = serviceAccount || {};
  const iat = Math.floor(nowSeconds);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  };
  return base64UrlEncode(JSON.stringify(header)) + '.' + base64UrlEncode(JSON.stringify(claims));
}

function sheetsAppendUrl(spreadsheetId, tab) {
  return 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) +
    '/values/' + encodeURIComponent("'" + tab + "'!A1") +
    ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=false';
}

// @n8n-exclude-start
const { sha256Hex, sha256Base64, utf8Bytes, base64UrlEncode } = require('./hash');
module.exports = {
  DAY_MS,
  BACKUP_SCHEMA,
  LEDGER_COLUMNS,
  LEDGER_STATUS,
  computeCutoff,
  parseHubSpotDate,
  buildSearchBody,
  evaluateRecord,
  selectStaleRecords,
  canonicalStringify,
  csvCell,
  sheetCell,
  buildS3Keys,
  buildBackup,
  verifyS3Put,
  summarizeS3Verification,
  verifySheetsAppend,
  verifyFileWrite,
  planArchive,
  summarizeArchive,
  buildDryRunPreview,
  GOOGLE_SHEETS_SCOPE,
  buildGoogleJwtUnsigned,
  sheetsAppendUrl,
};
// @n8n-exclude-end
