'use strict';
/**
 * storage.js — cold-storage writers with built-in verification.
 *   - AWS S3: native SigV4 via node:crypto (no aws-sdk), checksum-verified, no overwrite
 *   - Google Sheets: service-account JWT (node:crypto RS256) or OAuth token, row-count verified
 *   - Local files: write-once (wx), read back and hash-verified
 * Every writer returns a verification object consumed by archiver.planArchive().
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildS3PutRequest } = require('./sigv4');
const { base64UrlEncode } = require('./hash');
const {
  verifyS3Put, summarizeS3Verification, verifySheetsAppend, verifyFileWrite, buildGoogleJwtUnsigned, sheetsAppendUrl,
} = require('./archiver');
const { parseServiceAccount } = require('./safety');

class BackupError extends Error {
  constructor(message) { super(message); this.name = 'BackupError'; }
}

const toBuf = (d) => (typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d));

/** SigV4 implementation backed by node:crypto. */
const nodeCryptoImpl = {
  sha256: (data) => new Uint8Array(crypto.createHash('sha256').update(toBuf(data)).digest()),
  hmac: (key, data) => new Uint8Array(crypto.createHmac('sha256', toBuf(key)).update(toBuf(data)).digest()),
};

function headersToObject(h) {
  const out = {};
  if (h && typeof h.forEach === 'function') h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  else if (h) for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/** Upload backup.json and backup.csv; verified only if S3 echoes our SHA-256 for both. */
async function uploadBackupToS3(backup, config, deps) {
  const { fetchImpl, now = () => new Date() } = deps;
  const s = config.secrets;
  const results = [];
  for (const kind of ['json', 'csv']) {
    const req = buildS3PutRequest({
      bucket: s.awsS3Bucket,
      region: s.awsRegion,
      key: backup.keys[kind],
      body: kind === 'json' ? backup.json : backup.csv,
      contentType: kind === 'json' ? 'application/json' : 'text/csv; charset=utf-8',
      accessKeyId: s.awsAccessKeyId,
      secretAccessKey: s.awsSecretAccessKey,
      sessionToken: s.awsSessionToken || undefined,
      endpoint: config.awsS3Endpoint || undefined,
      amzDate: now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''),
    }, nodeCryptoImpl);
    let res;
    try {
      res = await fetchImpl(req.url, { method: 'PUT', headers: Object.assign({ 'Content-Type': req.contentType }, req.headers), body: req.body });
    } catch (err) {
      results.push({ ok: false, target: 's3', kind, key: req.key, reason: 'network-error' });
      break;
    }
    const v = verifyS3Put({ kind, key: req.key, checksumSha256Base64: req.checksumSha256Base64 }, { statusCode: res.status, headers: headersToObject(res.headers) });
    results.push(v);
    if (!v.ok) break; // stop at the first failure
  }
  return summarizeS3Verification(results, backup);
}

async function getGoogleAccessToken(config, deps) {
  const s = config.secrets;
  if (s.googleOauthAccessToken) return s.googleOauthAccessToken;
  const sa = parseServiceAccount(s.googleServiceAccountJson);
  if (!sa || sa.invalid) throw new BackupError('GOOGLE_SERVICE_ACCOUNT_JSON is missing or invalid');
  const unsigned = buildGoogleJwtUnsigned(sa, (deps.now ? deps.now() : new Date()).getTime() / 1000);
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
  const assertion = unsigned + '.' + base64UrlEncode(new Uint8Array(signature));
  const res = await deps.fetchImpl(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(assertion),
  });
  if (!res.ok) throw new BackupError('Google token exchange failed with HTTP ' + res.status);
  const body = await res.json();
  if (!body || !body.access_token) throw new BackupError('Google token exchange returned no access_token');
  return body.access_token;
}

/** Append one ledger row per record; verified when updatedRows equals the rows sent. */
async function appendLedgerToSheets(backup, config, deps) {
  try {
    const token = await getGoogleAccessToken(config, deps);
    const res = await deps.fetchImpl(sheetsAppendUrl(config.secrets.googleSheetsId, config.sheetsTab), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values: backup.ledgerRows }),
    });
    if (!res.ok) return { ok: false, target: 'sheets', runId: backup.runId, reason: 'http-' + res.status };
    return verifySheetsAppend(backup.ledgerRows.length, await res.json(), backup.runId);
  } catch (err) {
    return { ok: false, target: 'sheets', runId: backup.runId, reason: err instanceof BackupError ? err.message : 'request-failed' };
  }
}

/** Write-once local files (refuses to overwrite), then read back and re-hash. */
function writeBackupFiles(backup, config) {
  const dir = path.resolve(config.backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const results = [];
  for (const [kind, content, expected] of [['json', backup.json, backup.jsonSha256Hex], ['csv', backup.csv, backup.csvSha256Hex]]) {
    const file = path.join(dir, backup.runId + '.archive.' + kind);
    try {
      fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
      const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      results.push(verifyFileWrite(kind, file, expected, actual, backup.runId));
    } catch (err) {
      results.push({ ok: false, target: 'file', kind, path: file, runId: backup.runId, reason: err.code === 'EEXIST' ? 'file-exists' : 'write-failed' });
    }
  }
  return { ok: results.every((r) => r.ok), target: 'file', runId: backup.runId, files: results, reason: results.every((r) => r.ok) ? 'verified' : results.find((r) => !r.ok).reason };
}

module.exports = { BackupError, nodeCryptoImpl, uploadBackupToS3, getGoogleAccessToken, appendLedgerToSheets, writeBackupFiles };
