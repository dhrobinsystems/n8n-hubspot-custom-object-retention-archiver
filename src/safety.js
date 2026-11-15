'use strict';
/**
 * safety.js — configuration rules, sandbox gate, batch cap and secret masking.
 *
 * PURE MODULE: no require(), no I/O. Inlined verbatim into the n8n Code nodes
 * by scripts/build-workflow.js so the CLI and the workflow enforce identical
 * rules. resolveConfig() returns `settings` that never contain secret values
 * or sensitive identifiers (object type, bucket, sheet ID): only presence flags.
 */

const ALLOWED_ACCOUNT_TYPES = ['SANDBOX', 'DEVELOPER_TEST'];
const STORAGE_TARGET_VALUES = ['s3', 'sheets', 'file'];
const N8N_STORAGE_TARGETS = ['s3', 'sheets'];
const RETENTION_MIN_DAYS = 30;
const RETENTION_MAX_DAYS = 3650;
const MAX_ARCHIVE_CEILING = 10000; // HubSpot search returns at most 10,000 results per query

const SECRET_ENV_KEYS = [
  'HUBSPOT_ACCESS_TOKEN', 'CUSTOM_OBJECT_TYPE',
  'AWS_S3_BUCKET', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'GOOGLE_SHEETS_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_OAUTH_ACCESS_TOKEN',
];
const CONFIG_ENV_KEYS = SECRET_ENV_KEYS.concat([
  'DRY_RUN', 'SANDBOX_MODE', 'RETENTION_DAYS', 'DATE_PROPERTY', 'ACTIVITY_DATE_PROPERTY', 'LEGAL_HOLD_PROPERTY',
  'MAX_ARCHIVE_PER_RUN', 'STORAGE_TARGETS', 'AWS_S3_PREFIX', 'AWS_S3_ENDPOINT', 'GOOGLE_SHEETS_TAB',
  'BACKUP_DIR', 'HUBSPOT_API_BASE',
]);

/** Unrecognised values fall back to the default, so DRY_RUN=flase stays SAFE. */
function parseBool(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (v === '') return defaultValue;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}

function parseNumber(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : NaN;
}

/** Placeholder values copied from .env.example (YOUR_*) count as unset. */
function cleanSecret(value) {
  if (value === undefined || value === null) return '';
  const s = String(value).trim();
  if (/^YOUR_[A-Z0-9_]+$/.test(s)) return '';
  return s;
}

/** Custom objects only: objectTypeId 2-<n> or fully qualified name p<portal>_<name>. */
function isCustomObjectType(t) {
  return /^2-\d+$/.test(String(t)) || /^p\d*_[a-z0-9_]+$/i.test(String(t));
}

function parseServiceAccount(json) {
  if (!json) return null;
  try {
    const sa = JSON.parse(json);
    if (!sa || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') return { invalid: true };
    return sa;
  } catch (e) {
    return { invalid: true };
  }
}

/**
 * Resolve runtime configuration.
 * options: { offline, runtime: 'cli' | 'n8n', forceDryRun, retentionOverride, maxArchiveOverride }
 * Returns { settings, secrets, errors }.
 */
function resolveConfig(env, options) {
  const o = options || {};
  const e = env || {};
  const runtime = o.runtime || 'cli';

  const secrets = {};
  const secretMap = {
    hubspotToken: 'HUBSPOT_ACCESS_TOKEN', customObjectType: 'CUSTOM_OBJECT_TYPE',
    awsS3Bucket: 'AWS_S3_BUCKET', awsRegion: 'AWS_REGION', awsAccessKeyId: 'AWS_ACCESS_KEY_ID',
    awsSecretAccessKey: 'AWS_SECRET_ACCESS_KEY', awsSessionToken: 'AWS_SESSION_TOKEN',
    googleSheetsId: 'GOOGLE_SHEETS_ID', googleServiceAccountJson: 'GOOGLE_SERVICE_ACCOUNT_JSON',
    googleOauthAccessToken: 'GOOGLE_OAUTH_ACCESS_TOKEN',
  };
  for (const [k, envKey] of Object.entries(secretMap)) secrets[k] = cleanSecret(e[envKey]);

  const rawTargets = cleanSecret(e.STORAGE_TARGETS) || 's3';
  const targets = rawTargets.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const envRetention = parseNumber(e.RETENTION_DAYS, 365);
  const envCap = parseNumber(e.MAX_ARCHIVE_PER_RUN, 500);

  const settings = {
    runtime,
    dryRun: parseBool(e.DRY_RUN, true),
    sandboxMode: parseBool(e.SANDBOX_MODE, true),
    retentionDays: envRetention,
    maxArchivePerRun: envCap,
    dateProperty: String(e.DATE_PROPERTY || 'hs_lastmodifieddate').trim(),
    activityDateProperty: String(e.ACTIVITY_DATE_PROPERTY || '').trim() || null,
    legalHoldProperty: String(e.LEGAL_HOLD_PROPERTY || '').trim() || null,
    storageTargets: targets,
    storeS3: targets.includes('s3'),
    storeSheets: targets.includes('sheets'),
    storeFile: targets.includes('file'),
    s3Prefix: String(e.AWS_S3_PREFIX || 'hubspot-retention-archive').trim().replace(/^\/+|\/+$/g, ''),
    sheetsTab: String(e.GOOGLE_SHEETS_TAB || 'archive_ledger').trim(),
    backupDir: String(e.BACKUP_DIR || 'reports/cold-storage').trim(),
    hubspotApiBase: String(e.HUBSPOT_API_BASE || 'https://api.hubapi.com').trim().replace(/\/+$/, ''),
    customS3Endpoint: Boolean(String(e.AWS_S3_ENDPOINT || '').trim()),
    present: {
      hubspotToken: secrets.hubspotToken !== '',
      customObjectType: secrets.customObjectType !== '',
      awsS3Bucket: secrets.awsS3Bucket !== '',
      awsRegion: secrets.awsRegion !== '',
      awsCredentials: secrets.awsAccessKeyId !== '' && secrets.awsSecretAccessKey !== '',
      googleSheetsId: secrets.googleSheetsId !== '',
      googleAuth: secrets.googleServiceAccountJson !== '' || secrets.googleOauthAccessToken !== '',
    },
  };

  const errors = [];
  if (o.forceDryRun) settings.dryRun = true;

  // CLI overrides may only make a LIVE run more conservative.
  if (o.retentionOverride !== undefined && o.retentionOverride !== null) {
    const r = parseNumber(o.retentionOverride, NaN);
    if (!settings.dryRun && r < envRetention) errors.push('--retention-days can only RAISE RETENTION_DAYS in a live run (' + envRetention + ')');
    settings.retentionDays = r;
  }
  if (o.maxArchiveOverride !== undefined && o.maxArchiveOverride !== null) {
    const c = parseNumber(o.maxArchiveOverride, NaN);
    if (!settings.dryRun && c > envCap) errors.push('--max-archive can only LOWER MAX_ARCHIVE_PER_RUN in a live run (' + envCap + ')');
    settings.maxArchivePerRun = c;
  }

  const rd = settings.retentionDays;
  if (!(Number.isInteger(rd) && rd >= RETENTION_MIN_DAYS && rd <= RETENTION_MAX_DAYS)) {
    errors.push('RETENTION_DAYS must be an integer from ' + RETENTION_MIN_DAYS + ' to ' + RETENTION_MAX_DAYS);
  }
  const cap = settings.maxArchivePerRun;
  if (!(Number.isInteger(cap) && cap >= 1 && cap <= MAX_ARCHIVE_CEILING)) {
    errors.push('MAX_ARCHIVE_PER_RUN must be an integer from 1 to ' + MAX_ARCHIVE_CEILING);
  }
  for (const [label, v] of [['DATE_PROPERTY', settings.dateProperty], ['ACTIVITY_DATE_PROPERTY', settings.activityDateProperty], ['LEGAL_HOLD_PROPERTY', settings.legalHoldProperty]]) {
    if (v !== null && !/^[a-z0-9_]{1,100}$/.test(v)) errors.push(label + ' must be a HubSpot internal property name (lowercase letters, digits, underscores)');
  }

  const allowedTargets = runtime === 'n8n' ? N8N_STORAGE_TARGETS : STORAGE_TARGET_VALUES;
  if (!targets.length) errors.push('STORAGE_TARGETS must name at least one cold-storage target; archiving without a backup is not supported');
  const badTargets = targets.filter((t) => !allowedTargets.includes(t));
  if (badTargets.length) errors.push('STORAGE_TARGETS contains unsupported value(s) for ' + runtime + ': ' + badTargets.join(', ') + ' (allowed: ' + allowedTargets.join(', ') + ')');

  if (!/^https:\/\//i.test(settings.hubspotApiBase)) errors.push('HUBSPOT_API_BASE must use https://');
  if (!/^[A-Za-z0-9!_.*'()\/-]{0,200}$/.test(settings.s3Prefix) || settings.s3Prefix.includes('..')) errors.push('AWS_S3_PREFIX contains unsupported characters');
  if (!/^[^'!\[\]]{1,100}$/.test(settings.sheetsTab)) errors.push('GOOGLE_SHEETS_TAB must be 1-100 characters without quotes, ! or brackets');
  const endpoint = String(e.AWS_S3_ENDPOINT || '').trim();
  if (endpoint && !/^https:\/\/[^\/?#]+\/?$/i.test(endpoint)) errors.push('AWS_S3_ENDPOINT must look like https://host[:port]');

  if (!o.offline) {
    if (!secrets.hubspotToken) errors.push('HUBSPOT_ACCESS_TOKEN is not set (placeholder values count as unset)');
    if (!secrets.customObjectType) errors.push('CUSTOM_OBJECT_TYPE is not set');
    else if (!isCustomObjectType(secrets.customObjectType)) errors.push('CUSTOM_OBJECT_TYPE must be a custom object (2-<id> or p<portal>_<name>); standard objects are refused');
  }

  if (!settings.dryRun) {
    if (settings.storeS3) {
      if (!secrets.awsS3Bucket) errors.push('AWS_S3_BUCKET is required when STORAGE_TARGETS includes s3');
      if (!secrets.awsRegion) errors.push('AWS_REGION is required when STORAGE_TARGETS includes s3');
      if (!settings.present.awsCredentials) errors.push('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required when STORAGE_TARGETS includes s3');
    }
    if (settings.storeSheets) {
      if (!secrets.googleSheetsId) errors.push('GOOGLE_SHEETS_ID is required when STORAGE_TARGETS includes sheets');
      if (!settings.present.googleAuth) errors.push('GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_OAUTH_ACCESS_TOKEN is required when STORAGE_TARGETS includes sheets');
    }
  }
  if (secrets.googleServiceAccountJson) {
    const sa = parseServiceAccount(secrets.googleServiceAccountJson);
    if (sa && sa.invalid) errors.push('GOOGLE_SERVICE_ACCOUNT_JSON must be valid JSON with client_email and private_key');
  }

  return { settings, secrets, errors };
}

/** Every value that must never appear in a log line, including parts of the service account. */
function collectSecretValues(secrets) {
  const s = secrets || {};
  const values = Object.values(s).filter((v) => typeof v === 'string' && v);
  const sa = parseServiceAccount(s.googleServiceAccountJson);
  if (sa && !sa.invalid) {
    for (const k of ['private_key', 'private_key_id', 'client_email', 'client_id']) if (sa[k]) values.push(String(sa[k]));
  }
  return values;
}

/** Abort unless the HubSpot portal is SANDBOX or DEVELOPER_TEST (when sandboxMode is on). */
function assertSandbox(accountInfo, sandboxMode) {
  const accountType = String((accountInfo && accountInfo.accountType) || '').toUpperCase();
  if (!sandboxMode) return { ok: true, enforced: false, accountType: accountType || 'UNKNOWN' };
  if (ALLOWED_ACCOUNT_TYPES.includes(accountType)) return { ok: true, enforced: true, accountType };
  throw new Error(
    'Sandbox gate blocked this run: SANDBOX_MODE=true but the connected HubSpot portal reports accountType "' +
      (accountType || 'UNKNOWN') + '". Allowed: ' + ALLOWED_ACCOUNT_TYPES.join(', ') +
      '. No records were read or archived. Point the token at a sandbox or developer test account, or set SANDBOX_MODE=false deliberately.'
  );
}

/** Hard batch-cap check, applied again right before archiving. */
function assertWithinBatchCap(count, maxArchivePerRun) {
  if (!(Number.isInteger(count) && count >= 0)) throw new Error('Archive plan size is invalid');
  if (count > maxArchivePerRun) {
    throw new Error('Batch cap exceeded: plan contains ' + count + ' records but MAX_ARCHIVE_PER_RUN=' + maxArchivePerRun + '. Nothing was archived.');
  }
  return true;
}

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***private-key***'],
  [/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer ***'],
  [/\bpat-[a-z0-9]{2,4}-[A-Za-z0-9-]{8,}/gi, 'pat-***'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '***aws-key-id***'],
  [/Credential=[^\s,]+/g, 'Credential=***'],
  [/Signature=[0-9a-f]{64}/gi, 'Signature=***'],
  [/\bya29\.[A-Za-z0-9._-]+/g, '***google-token***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '***jwt***'],
  [/\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi, '***id***'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***'],
];

/** Remove known secret values and secret-shaped strings from any text. */
function maskSecrets(text, secretValues) {
  let s = text === undefined || text === null ? '' : String(text);
  const values = (secretValues || [])
    .filter((v) => typeof v === 'string' && v.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const v of values) s = s.split(v).join('***');
  for (const [re, replacement] of SECRET_PATTERNS) s = s.replace(re, replacement);
  return s;
}

/** Turn any error-like value into a small, masked, log-safe object. */
function maskError(errLike, secretValues) {
  let message;
  let status = null;
  let name = 'Error';
  if (errLike === undefined || errLike === null) message = 'Unknown error';
  else if (typeof errLike === 'string') message = errLike;
  else {
    name = errLike.name || name;
    status = errLike.httpCode || errLike.status || errLike.statusCode || null;
    message = errLike.message || errLike.description || '';
    if (!message) {
      try { message = JSON.stringify(errLike); } catch (_) { message = String(errLike); }
    }
  }
  const masked = maskSecrets(message, secretValues);
  return {
    name: maskSecrets(String(name), secretValues),
    status: status === null ? null : String(status),
    message: masked.length > 1000 ? masked.slice(0, 999) + '…' : masked,
  };
}

// @n8n-exclude-start
module.exports = {
  ALLOWED_ACCOUNT_TYPES,
  CONFIG_ENV_KEYS,
  SECRET_ENV_KEYS,
  RETENTION_MIN_DAYS,
  MAX_ARCHIVE_CEILING,
  parseBool,
  parseNumber,
  cleanSecret,
  isCustomObjectType,
  parseServiceAccount,
  resolveConfig,
  collectSecretValues,
  assertSandbox,
  assertWithinBatchCap,
  maskSecrets,
  maskError,
};
// @n8n-exclude-end
