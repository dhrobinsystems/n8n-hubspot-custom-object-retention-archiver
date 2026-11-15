#!/usr/bin/env node
'use strict';
/**
 * Generates workflows/n8n-hubspot-custom-object-retention-archiver.json.
 *
 * Every n8n Code node is assembled from the pure modules in src/ (hash.js,
 * sigv4.js, safety.js, archiver.js) plus a short glue block, so the workflow
 * and the CLI share one implementation. Edit src/, then `npm run build:workflow`.
 * `npm run check:workflow` and the test suite fail if the JSON is stale.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'workflows', 'n8n-hubspot-custom-object-retention-archiver.json');
const WORKFLOW_NAME = 'HubSpot Custom Object Retention Archiver (weekly)';

function pureSource(file) {
  const src = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
  const stripped = src.replace(/\/\/ @n8n-exclude-start[\s\S]*?\/\/ @n8n-exclude-end\n?/g, '');
  if (/\brequire\s*\(\s*['"`]/.test(stripped)) throw new Error(file + ' must stay pure (no require) to be inlined into n8n');
  return '// ===== inlined from src/' + file + ' (generated — edit the source file, not this node) =====\n' +
    stripped.replace(/^'use strict';\n/, '').trim() + '\n';
}

function code(files, glue) {
  return files.map(pureSource).join('\n') + '\n// ===== n8n glue =====\n' + glue.trim() + '\n';
}

function uuidFor(name) {
  const hex = [0x811c9dc5, 0x01000193, 0x2f2f2f2f, 0x5bd1e995].map((seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-a' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

const N = {
  SCHEDULE: 'Weekly Schedule',
  MANUAL: 'Manual Trigger',
  GATE: 'Config & Safety Gate',
  VERIFY: 'HubSpot: Verify Portal',
  SANDBOX: 'Sandbox Verification',
  PROPS: 'HubSpot: List Properties',
  BUILD_SEARCH: 'Build Search Request',
  SEARCH: 'HubSpot: Search Stale Custom Objects',
  PREPARE: 'Prepare Cold-Storage Backup',
  ANY: 'Any Stale Records?',
  NOTHING: 'Nothing To Archive',
  DRY: 'Dry Run?',
  PREVIEW: 'Dry Run Preview',
  ROUTER: 'Cold-Storage Router',
  SIGN: 'Sign S3 PutObject',
  S3_PUT: 'S3: PutObject',
  VERIFY_S3: 'Verify S3 Upload',
  NEEDS_SHEETS: 'Also Google Sheets?',
  SHEETS: 'Sheets: Append Audit Rows',
  PLAN: 'Verify Backup & Plan Archive',
  ARCHIVE: 'HubSpot: Archive Record',
  SUMMARY: 'Archive Summary',
  LOGGER: 'Masked Error Logger',
  STOP: 'Stop: Run Failed',
};

const GLUE = {
  gate: `
const env = {};
for (const key of CONFIG_ENV_KEYS) {
  let value;
  try {
    value = $env[key];
  } catch (e) {
    throw new Error('This workflow reads its configuration from environment variables. Set N8N_BLOCK_ENV_ACCESS_IN_NODE=false on the n8n instance (see README).');
  }
  if (value !== undefined && value !== null) env[key] = String(value);
}
const { settings, errors } = resolveConfig(env, { runtime: 'n8n' });
if (errors.length) throw new Error('Configuration invalid: ' + errors.join('; '));
// Only non-secret settings and presence flags enter item data; HTTP nodes read secrets from $env.
return [{ json: { config: settings, startedAt: new Date().toISOString() } }];`,

  sandbox: `
const config = $('${N.GATE}').first().json.config;
const info = $input.first().json || {};
const gate = assertSandbox(info, config.sandboxMode);
return [{
  json: {
    config,
    portal: {
      portalId: info.portalId === undefined || info.portalId === null ? null : String(info.portalId),
      accountType: info.accountType || null,
    },
    sandboxGate: gate,
  },
}];`,

  buildSearch: `
const { config, portal } = $('${N.SANDBOX}').first().json;
const startedAt = $('${N.GATE}').first().json.startedAt;
const propertyNames = (($input.first().json || {}).results || []).map((p) => p.name).filter(Boolean).sort();
const cutoff = computeCutoff(new Date(startedAt), config.retentionDays);
const criteria = {
  cutoffMs: cutoff.cutoffMs,
  dateProperty: config.dateProperty,
  activityDateProperty: config.activityDateProperty,
  legalHoldProperty: config.legalHoldProperty,
  maxArchivePerRun: config.maxArchivePerRun,
};
const searchBody = buildSearchBody(Object.assign({ properties: propertyNames }, criteria));
return [{ json: { config, portal, cutoff, criteria, searchBody, startedAt } }];`,

  prepare: `
const { config, portal, cutoff, criteria, startedAt } = $('${N.BUILD_SEARCH}').first().json;
const records = [];
for (const item of $input.all()) {
  const body = item.json || {};
  if (Array.isArray(body.results)) records.push(...body.results);
  else if (body.id) records.push(body);
}
let objectType;
try { objectType = cleanSecret($env.CUSTOM_OBJECT_TYPE); } catch (e) { objectType = ''; }
const selection = selectStaleRecords(records, criteria);
const backup = buildBackup(selection.selected, {
  runAt: startedAt,
  objectType,
  portalId: portal.portalId,
  retentionDays: config.retentionDays,
  cutoffIso: cutoff.cutoffIso,
  dateProperty: config.dateProperty,
  activityDateProperty: config.activityDateProperty,
  legalHoldProperty: config.legalHoldProperty,
  s3Prefix: config.s3Prefix,
});
const meta = {
  runAt: startedAt, evaluatedAsOf: startedAt, cutoff: cutoff.cutoffIso, retentionDays: config.retentionDays,
  maxArchivePerRun: config.maxArchivePerRun, source: 'hubspot', accountType: portal.accountType,
  dryRun: config.dryRun, sandboxMode: config.sandboxMode,
};
return [{
  json: {
    config,
    meta,
    selection: {
      totalInput: selection.totalInput,
      eligible: selection.eligible,
      truncatedAtCap: selection.truncatedAtCap,
      excluded: selection.excluded,
      selected: selection.selected.map((r) => r.id),
    },
    backup,
  },
}];`,

  preview: `
const { config, meta, selection, backup } = $('${N.PREPARE}').first().json;
return [{ json: buildDryRunPreview(selection, backup, config, meta) }];`,

  sign: `
const { backup } = $('${N.PREPARE}').first().json;
const read = (k) => { try { return cleanSecret($env[k]); } catch (e) { return ''; } };
const endpoint = read('AWS_S3_ENDPOINT');
const sessionToken = read('AWS_SESSION_TOKEN');
const amzDate = toAmzDate(new Date());
return ['json', 'csv'].map((kind) => {
  const req = buildS3PutRequest({
    bucket: read('AWS_S3_BUCKET'),
    region: read('AWS_REGION'),
    key: backup.keys[kind],
    body: kind === 'json' ? backup.json : backup.csv,
    contentType: kind === 'json' ? 'application/json' : 'text/csv; charset=utf-8',
    accessKeyId: read('AWS_ACCESS_KEY_ID'),
    secretAccessKey: read('AWS_SECRET_ACCESS_KEY'),
    sessionToken: sessionToken || undefined,
    endpoint: endpoint || undefined,
    amzDate,
  });
  // The session token is signed here but added to the request from $env by the HTTP node,
  // so it never appears in item data. The signature itself is not a secret.
  const headers = Object.assign({}, req.headers);
  delete headers['x-amz-security-token'];
  return { json: { kind, key: req.key, url: req.url, headers, addSessionToken: Boolean(sessionToken), contentType: req.contentType, body: req.body, checksumSha256Base64: req.checksumSha256Base64 } };
});`,

  verifyS3: `
const { backup } = $('${N.PREPARE}').first().json;
const signed = $('${N.SIGN}').all();
const responses = $input.all();
const results = responses.map((item, i) => {
  const pi = item.pairedItem && typeof item.pairedItem.item === 'number' ? item.pairedItem.item : i;
  const req = (signed[pi] || signed[i]).json;
  return verifyS3Put({ kind: req.kind, key: req.key, checksumSha256Base64: req.checksumSha256Base64 }, item.json || {});
});
const s3Verification = summarizeS3Verification(results, backup);
if (!s3Verification.ok) {
  throw new Error('S3 backup could not be verified (' + s3Verification.objects.map((o) => o.kind + ': ' + o.reason).join(', ') + '). Archiving aborted: no HubSpot records were archived.');
}
return [{ json: { s3Verification } }];`,

  sheets: `
const { config, backup } = $('${N.PREPARE}').first().json;
const read = (k) => { try { return cleanSecret($env[k]); } catch (e) { return ''; } };
let token = read('GOOGLE_OAUTH_ACCESS_TOKEN');
if (!token) {
  const sa = parseServiceAccount(read('GOOGLE_SERVICE_ACCOUNT_JSON'));
  if (!sa || sa.invalid) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing or invalid. Archiving aborted: no HubSpot records were archived.');
  let nodeCrypto;
  try { nodeCrypto = require('crypto'); } catch (e) {
    throw new Error('Signing the Google service-account JWT needs NODE_FUNCTION_ALLOW_BUILTIN=crypto on the n8n instance (or set GOOGLE_OAUTH_ACCESS_TOKEN). Archiving aborted.');
  }
  const unsigned = buildGoogleJwtUnsigned(sa, Date.now() / 1000);
  const signature = nodeCrypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
  const assertion = unsigned + '.' + base64UrlEncode(new Uint8Array(signature));
  const tokenResponse = await this.helpers.httpRequest({
    method: 'POST',
    url: sa.token_uri || 'https://oauth2.googleapis.com/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(assertion),
    json: true,
  });
  token = tokenResponse && tokenResponse.access_token;
  if (!token) throw new Error('Google token exchange returned no access_token. Archiving aborted.');
}
// The access token stays inside this node; only the verification result is output.
const response = await this.helpers.httpRequest({
  method: 'POST',
  url: sheetsAppendUrl(read('GOOGLE_SHEETS_ID'), config.sheetsTab),
  headers: { Authorization: 'Bearer ' + token },
  body: { majorDimension: 'ROWS', values: backup.ledgerRows },
  json: true,
});
const sheetsVerification = verifySheetsAppend(backup.ledgerRows.length, response, backup.runId);
if (!sheetsVerification.ok) {
  throw new Error('Google Sheets backup could not be verified (' + sheetsVerification.reason + '). Archiving aborted: no HubSpot records were archived.');
}
return [{ json: { sheetsVerification } }];`,

  plan: `
const { config, backup } = $('${N.PREPARE}').first().json;
const read = (nodeName, key) => {
  try {
    const node = $(nodeName);
    if (node.isExecuted === false) return null;
    const j = node.first().json;
    return j && j[key] ? j[key] : null;
  } catch (e) {
    return null;
  }
};
const verifications = {};
if (config.storeS3) verifications.s3 = read('${N.VERIFY_S3}', 's3Verification');
if (config.storeSheets) verifications.sheets = read('${N.SHEETS}', 'sheetsVerification');
// Throws, and therefore archives nothing, unless every configured target verified THIS run.
const plan = planArchive(backup, verifications, config);
assertWithinBatchCap(plan.recordIds.length, config.maxArchivePerRun);
return plan.recordIds.map((id) => ({ json: { id, runId: plan.runId } }));`,

  summary: `
const { config, backup } = $('${N.PREPARE}').first().json;
const planItems = $('${N.PLAN}').all();
const plan = {
  runId: backup.runId,
  manifestSha256: backup.manifestSha256,
  verifiedTargets: config.storageTargets,
  recordIds: planItems.map((i) => i.json.id),
};
const archivedIds = $input.all().map((item, i) => {
  const pi = item.pairedItem && typeof item.pairedItem.item === 'number' ? item.pairedItem.item : i;
  return planItems[pi] ? planItems[pi].json.id : null;
}).filter(Boolean);
const done = new Set(archivedIds);
const failed = plan.recordIds.filter((id) => !done.has(id)).map((id) => ({ id, status: null }));
return [{ json: summarizeArchive(plan, { archivedIds, failed }) }];`,

  logger: `
const env = {};
for (const key of SECRET_ENV_KEYS) {
  try { const v = $env[key]; if (v !== undefined && v !== null) env[key] = String(v); } catch (e) { /* env access blocked */ }
}
const secretValues = collectSecretValues(resolveConfig(env, { runtime: 'n8n' }).secrets);
try { const p = $('${N.SANDBOX}').first().json.portal; if (p && p.portalId) secretValues.push(String(p.portalId)); } catch (e) { /* not reached */ }
let source = 'unknown node';
try { source = $prevNode.name; } catch (e) { /* not available */ }
return $input.all().map((item) => {
  const j = item.json || {};
  const masked = maskError(j.error !== undefined ? j.error : j, secretValues);
  return { json: Object.assign({ level: 'error', node: source, at: new Date().toISOString() }, masked) };
});`,
};

const ERR = { onError: 'continueErrorOutput' };
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };
const HUBSPOT_AUTH = [
  { name: 'Authorization', value: '=Bearer {{ $env.HUBSPOT_ACCESS_TOKEN }}' },
  { name: 'Accept', value: 'application/json' },
];
const IF_OPTS = { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 };

function codeNode(name, position, files, glue, extra) {
  return Object.assign({
    parameters: { jsCode: code(files, glue) },
    id: uuidFor(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position,
  }, extra || {});
}

function http(name, position, parameters, extra) {
  return Object.assign({ parameters, id: uuidFor(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position }, ERR, RETRY, extra || {});
}

function ifNode(name, position, leftValue, operator, rightValue) {
  const condition = { id: uuidFor(name + ':cond'), leftValue, operator };
  if (rightValue !== undefined) condition.rightValue = rightValue;
  return {
    parameters: { conditions: { options: IF_OPTS, conditions: [condition], combinator: 'and' }, options: {} },
    id: uuidFor(name), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position,
  };
}

const BOOL_TRUE = { type: 'boolean', operation: 'true', singleValue: true };
const prepRef = "$('" + N.PREPARE + "').first().json";

function buildWorkflow() {
  const nodes = [
    {
      parameters: {
        content: '## HubSpot custom object retention archiver\n' +
          'Weekly hygiene job: finds custom object records untouched for RETENTION_DAYS, writes an immutable, checksum-verified backup to S3 and/or Google Sheets, then archives (DELETE → recycle bin) only the verified records.\n\n' +
          '**Safe by default:** DRY_RUN=true, SANDBOX_MODE=true, MAX_ARCHIVE_PER_RUN=500. No DELETE runs unless every storage target verified this run.\n\n' +
          '**Instance settings:** N8N_BLOCK_ENV_ACCESS_IN_NODE=false · NODE_FUNCTION_ALLOW_BUILTIN=crypto only if Sheets uses a service account.\n\n' +
          'Code nodes are generated from `src/` — edit there and run `npm run build:workflow`.',
        height: 320, width: 560,
      },
      id: uuidFor('Sticky: Overview'), name: 'Sticky: Overview', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-40, -300],
    },
    {
      parameters: { rule: { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [0], triggerAtHour: 3 }] } },
      id: uuidFor(N.SCHEDULE), name: N.SCHEDULE, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 200],
    },
    { parameters: {}, id: uuidFor(N.MANUAL), name: N.MANUAL, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 400] },
    codeNode(N.GATE, [240, 300], ['safety.js'], GLUE.gate, ERR),
    http(N.VERIFY, [480, 300], {
      url: '={{ $json.config.hubspotApiBase }}/account-info/v3/details',
      sendHeaders: true, headerParameters: { parameters: HUBSPOT_AUTH },
      options: { timeout: 30000 },
    }),
    codeNode(N.SANDBOX, [720, 300], ['safety.js'], GLUE.sandbox, ERR),
    http(N.PROPS, [960, 300], {
      url: '={{ $json.config.hubspotApiBase }}/crm/v3/properties/{{ $env.CUSTOM_OBJECT_TYPE }}',
      sendQuery: true, queryParameters: { parameters: [{ name: 'archived', value: 'false' }] },
      sendHeaders: true, headerParameters: { parameters: HUBSPOT_AUTH },
      options: { timeout: 30000 },
    }),
    codeNode(N.BUILD_SEARCH, [1200, 300], ['hash.js', 'archiver.js'], GLUE.buildSearch, ERR),
    http(N.SEARCH, [1440, 300], {
      method: 'POST',
      url: '={{ $json.config.hubspotApiBase }}/crm/v3/objects/{{ $env.CUSTOM_OBJECT_TYPE }}/search',
      sendHeaders: true, headerParameters: { parameters: HUBSPOT_AUTH },
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.searchBody) }}',
      options: {
        pagination: {
          pagination: {
            paginationMode: 'updateAParameterInEachRequest',
            parameters: { parameters: [{ type: 'body', name: 'after', value: '={{ $response.body.paging?.next?.after }}' }] },
            paginationCompleteWhen: 'other',
            completeExpression: '={{ !$response.body.paging?.next?.after }}',
            limitPagesFetched: true,
            maxRequests: "={{ Math.ceil($('" + N.BUILD_SEARCH + "').first().json.config.maxArchivePerRun / $('" + N.BUILD_SEARCH + "').first().json.searchBody.limit) }}",
            requestInterval: 250,
          },
        },
        timeout: 30000,
      },
    }),
    codeNode(N.PREPARE, [1680, 300], ['hash.js', 'safety.js', 'archiver.js'], GLUE.prepare, ERR),
    ifNode(N.ANY, [1920, 300], '={{ $json.backup.recordCount }}', { type: 'number', operation: 'gt' }, 0),
    { parameters: {}, id: uuidFor(N.NOTHING), name: N.NOTHING, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [2160, 480] },
    ifNode(N.DRY, [2160, 200], '={{ $json.config.dryRun }}', BOOL_TRUE),
    codeNode(N.PREVIEW, [2400, 20], ['hash.js', 'archiver.js'], GLUE.preview),
    {
      parameters: {
        rules: {
          values: [
            {
              conditions: { options: IF_OPTS, conditions: [{ id: uuidFor(N.ROUTER + ':s3'), leftValue: '={{ $json.config.storeS3 }}', rightValue: '', operator: BOOL_TRUE }], combinator: 'and' },
              renameOutput: true, outputKey: 'AWS S3',
            },
            {
              conditions: {
                options: IF_OPTS,
                conditions: [{ id: uuidFor(N.ROUTER + ':sheets'), leftValue: '={{ !$json.config.storeS3 && $json.config.storeSheets }}', rightValue: '', operator: BOOL_TRUE }],
                combinator: 'and',
              },
              renameOutput: true, outputKey: 'Google Sheets',
            },
          ],
        },
        options: {},
      },
      id: uuidFor(N.ROUTER), name: N.ROUTER, type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [2400, 260],
    },
    codeNode(N.SIGN, [2640, 160], ['hash.js', 'safety.js', 'sigv4.js'], GLUE.sign, ERR),
    http(N.S3_PUT, [2880, 160], {
      method: 'PUT',
      url: '={{ $json.url }}',
      sendHeaders: true, specifyHeaders: 'json',
      jsonHeaders: "={{ JSON.stringify(Object.assign({}, $json.headers, $json.addSessionToken ? { 'x-amz-security-token': $env.AWS_SESSION_TOKEN } : {})) }}",
      sendBody: true, contentType: 'raw', rawContentType: '={{ $json.contentType }}', body: '={{ $json.body }}',
      options: { response: { response: { fullResponse: true } }, timeout: 60000 },
    }),
    codeNode(N.VERIFY_S3, [3120, 160], ['hash.js', 'archiver.js'], GLUE.verifyS3, ERR),
    ifNode(N.NEEDS_SHEETS, [3360, 160], '={{ ' + prepRef + '.config.storeSheets }}', BOOL_TRUE),
    codeNode(N.SHEETS, [3600, 360], ['hash.js', 'safety.js', 'archiver.js'], GLUE.sheets, ERR),
    codeNode(N.PLAN, [3840, 160], ['hash.js', 'safety.js', 'archiver.js'], GLUE.plan, ERR),
    http(N.ARCHIVE, [4080, 160], {
      method: 'DELETE',
      url: '={{ ' + prepRef + ".config.hubspotApiBase }}/crm/v3/objects/{{ $env.CUSTOM_OBJECT_TYPE }}/{{ $json.id }}",
      sendHeaders: true, headerParameters: { parameters: HUBSPOT_AUTH },
      options: { batching: { batch: { batchSize: 1, batchInterval: 150 } }, timeout: 30000 },
    }, { maxTries: 4, waitBetweenTries: 3000 }),
    codeNode(N.SUMMARY, [4320, 160], ['hash.js', 'archiver.js'], GLUE.summary),
    codeNode(N.LOGGER, [2160, 760], ['safety.js'], GLUE.logger),
    {
      parameters: { errorMessage: "={{ 'Retention archiver stopped at ' + $json.node + ': ' + $json.message }}" },
      id: uuidFor(N.STOP), name: N.STOP, type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [2400, 760],
    },
  ];

  const to = (node) => ({ node, type: 'main', index: 0 });
  const okErr = (next) => ({ main: [[to(next)], [to(N.LOGGER)]] });
  const connections = {
    [N.SCHEDULE]: { main: [[to(N.GATE)]] },
    [N.MANUAL]: { main: [[to(N.GATE)]] },
    [N.GATE]: okErr(N.VERIFY),
    [N.VERIFY]: okErr(N.SANDBOX),
    [N.SANDBOX]: okErr(N.PROPS),
    [N.PROPS]: okErr(N.BUILD_SEARCH),
    [N.BUILD_SEARCH]: okErr(N.SEARCH),
    [N.SEARCH]: okErr(N.PREPARE),
    [N.PREPARE]: okErr(N.ANY),
    [N.ANY]: { main: [[to(N.DRY)], [to(N.NOTHING)]] },
    [N.DRY]: { main: [[to(N.PREVIEW)], [to(N.ROUTER)]] },
    [N.ROUTER]: { main: [[to(N.SIGN)], [to(N.SHEETS)]] },
    [N.SIGN]: okErr(N.S3_PUT),
    [N.S3_PUT]: okErr(N.VERIFY_S3),
    [N.VERIFY_S3]: okErr(N.NEEDS_SHEETS),
    [N.NEEDS_SHEETS]: { main: [[to(N.SHEETS)], [to(N.PLAN)]] },
    [N.SHEETS]: okErr(N.PLAN),
    [N.PLAN]: okErr(N.ARCHIVE),
    [N.ARCHIVE]: okErr(N.SUMMARY),
    [N.LOGGER]: { main: [[to(N.STOP)]] },
  };

  return {
    name: WORKFLOW_NAME,
    nodes,
    connections,
    pinData: {},
    active: false,
    settings: { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
    tags: [],
  };
}

function serialize(wf) {
  return JSON.stringify(wf, null, 2) + '\n';
}

if (require.main === module) {
  const json = serialize(buildWorkflow());
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== json) {
      process.stderr.write('Workflow JSON is out of date. Run: npm run build:workflow\n');
      process.exit(1);
    }
    process.stdout.write('Workflow JSON is up to date.\n');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, json);
    process.stdout.write('Wrote ' + path.relative(ROOT, OUT) + '\n');
  }
}

module.exports = { buildWorkflow, serialize, OUT, NODE_NAMES: N };
