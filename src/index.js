#!/usr/bin/env node
'use strict';
/**
 * index.js — CLI mirror of the n8n workflow.
 *
 *   node src/index.js                         # uses .env; DRY_RUN and SANDBOX_MODE default to true
 *   node src/index.js --dry-run               # force a dry run regardless of env
 *   node src/index.js --input objects.json --as-of 2026-06-30 --output preview.json --csv preview.csv
 *
 * Exit codes: 0 ok · 1 runtime error or partial archive failure · 2 config / safety-gate error
 *             3 backup verification failed (archiving aborted, nothing archived)
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadDotEnv, loadConfig, secretValues } = require('./config');
const { assertSandbox, assertWithinBatchCap, maskError, maskSecrets } = require('./safety');
const { getAccountInfo, listPropertyNames, searchStaleRecords, archiveObject } = require('./hubspot');
const { computeCutoff, buildSearchBody, selectStaleRecords, buildBackup, planArchive, summarizeArchive, buildDryRunPreview } = require('./archiver');
const { BackupError, uploadBackupToS3, appendLedgerToSheets, writeBackupFiles } = require('./storage');

class SafetyError extends Error {
  constructor(message) { super(message); this.name = 'SafetyError'; }
}

const HELP = `n8n-hubspot-custom-object-retention-archiver (CLI mirror)

Usage: node src/index.js [options]

Options:
  --dry-run               Force DRY_RUN=true: zero storage writes, zero HubSpot DELETE calls
  --input <file>          Offline mode: read records from JSON ({ "objectType", "results": [...] } or an array).
                          Never touches the network; always a dry run.
  --output <file>         Write the full JSON preview / run report
  --csv <file>            Write the CSV audit ledger for this run
  --retention-days <n>    Override RETENTION_DAYS (live runs: may only RAISE it)
  --max-archive <n>       Override MAX_ARCHIVE_PER_RUN (live runs: may only LOWER it)
  --as-of <date>          Evaluate retention as of this date (offline / dry runs only)
  --env-file <file>       Load variables from this file instead of ./.env
  --quiet                 Only print errors
  -h, --help              Show this help

Safety: DRY_RUN and SANDBOX_MODE default to true and can only be turned off
through environment variables. Records are archived only after every
configured cold-storage target has verified this run's backup.`;

function parseArgs(argv) {
  const out = { dryRun: false, quiet: false, help: false };
  const needsValue = {
    '--input': 'inputFile', '--output': 'output', '--csv': 'csv', '--retention-days': 'retentionDays',
    '--max-archive': 'maxArchive', '--env-file': 'envFile', '--as-of': 'asOf',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (needsValue[a]) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new SafetyError('Option ' + a + ' needs a value');
      out[needsValue[a]] = v;
    } else throw new SafetyError('Unknown option: ' + a + ' (see --help)');
  }
  return out;
}

function createLogger(config, quiet, extraSecrets) {
  const write = (level, msg) => {
    if (quiet && level !== 'error') return;
    const secrets = secretValues(config, extraSecrets());
    process.stderr.write('[' + new Date().toISOString() + '] ' + level.toUpperCase() + ' ' + maskSecrets(msg, secrets) + '\n');
  };
  return { info: (m) => write('info', m), warn: (m) => write('warn', m), error: (m) => write('error', m) };
}

function readInputFile(file) {
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (Array.isArray(data)) return { objectType: null, results: data };
  if (data && Array.isArray(data.results)) return { objectType: data.objectType || null, results: data.results };
  throw new SafetyError('Input file must be a JSON array of records or an object with a "results" array');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One archiver run. Dependencies are injectable for tests:
 * { fetch, now, wait, log, requestIntervalMs, archiveIntervalMs, asOf }
 */
async function run(config, deps) {
  const d = deps || {};
  const fetchImpl = d.fetch || globalThis.fetch;
  const log = d.log || { info() {}, warn() {}, error() {} };
  const now = d.now || (() => new Date());
  const wait = d.wait || sleep;
  const portalRef = d.portalRef || {};

  if (config.errors && config.errors.length) throw new SafetyError('Configuration invalid: ' + config.errors.join('; '));
  if (d.asOf && !config.dryRun) throw new SafetyError('--as-of is only allowed for dry runs');

  const runAtDate = now();
  const evalDate = d.asOf ? new Date(d.asOf) : runAtDate;
  if (!Number.isFinite(evalDate.getTime())) throw new SafetyError('--as-of is not a valid date');
  const cutoff = computeCutoff(evalDate, config.retentionDays);
  const criteria = {
    cutoffMs: cutoff.cutoffMs,
    dateProperty: config.dateProperty,
    activityDateProperty: config.activityDateProperty,
    legalHoldProperty: config.legalHoldProperty,
    maxArchivePerRun: config.maxArchivePerRun,
  };

  let records;
  let objectType;
  let portal = { accountType: null, portalId: null };
  let source = 'hubspot';
  const ctx = { token: config.secrets.hubspotToken, apiBase: config.hubspotApiBase, fetchImpl, wait };

  if (config.inputFile) {
    source = 'file';
    const input = readInputFile(config.inputFile);
    objectType = input.objectType || config.secrets.customObjectType || 'p_offline_demo';
    records = input.results;
    portal.accountType = 'OFFLINE';
    log.info('Offline mode: loaded ' + records.length + ' records (dry run enforced, no network).');
  } else {
    if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available (Node >= 18 required)');
    objectType = config.secrets.customObjectType;
    const info = await getAccountInfo(ctx);
    portal = { accountType: info.accountType || null, portalId: info.portalId === undefined ? null : String(info.portalId) };
    portalRef.portalId = portal.portalId;
    try {
      const gate = assertSandbox(info, config.sandboxMode);
      log.info('Sandbox gate: ' + (gate.enforced ? 'passed (' + gate.accountType + ')' : 'not enforced (SANDBOX_MODE=false)'));
    } catch (err) {
      throw new SafetyError(err.message);
    }
    const propertyNames = await listPropertyNames(objectType, ctx);
    records = await searchStaleRecords(
      objectType,
      (after) => buildSearchBody(Object.assign({ properties: propertyNames, after }, criteria)),
      config.maxArchivePerRun,
      ctx,
      { requestIntervalMs: d.requestIntervalMs === undefined ? 250 : d.requestIntervalMs }
    );
    log.info('Search returned ' + records.length + ' candidate record(s) older than ' + cutoff.cutoffIso + '.');
  }

  const selection = selectStaleRecords(records, criteria);
  const backup = buildBackup(selection.selected, {
    runAt: runAtDate.toISOString(),
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
    runAt: runAtDate.toISOString(), evaluatedAsOf: evalDate.toISOString(), cutoff: cutoff.cutoffIso,
    retentionDays: config.retentionDays, maxArchivePerRun: config.maxArchivePerRun, source,
    accountType: portal.accountType, dryRun: config.dryRun, sandboxMode: config.sandboxMode,
  };
  log.info(selection.selected.length + ' stale record(s) selected' + (selection.truncatedAtCap ? ' (capped at MAX_ARCHIVE_PER_RUN)' : '') +
    '; excluded: ' + JSON.stringify(selection.excluded));

  if (config.dryRun) {
    log.info('DRY RUN: zero storage writes and zero HubSpot DELETE calls.');
    return { meta, selection, backup, preview: buildDryRunPreview(selection, backup, config, meta), verifications: null, archive: null };
  }
  if (!backup.recordCount) {
    log.info('Nothing to archive.');
    return { meta, selection, backup, preview: null, verifications: {}, archive: { planned: 0, archived: 0, failed: 0 } };
  }

  // 1) Cold storage first. Any failure aborts before a single DELETE.
  const verifications = {};
  const sdeps = { fetchImpl, now };
  if (config.storeS3) {
    verifications.s3 = await uploadBackupToS3(backup, config, sdeps);
    log.info('S3 backup: ' + (verifications.s3.ok ? 'verified' : 'FAILED'));
    if (!verifications.s3.ok) throw new BackupError('S3 backup could not be verified (' + verifications.s3.objects.map((o) => o.kind + ': ' + o.reason).join(', ') + '). Archiving aborted: no HubSpot records were archived.');
  }
  if (config.storeSheets) {
    verifications.sheets = await appendLedgerToSheets(backup, config, sdeps);
    log.info('Google Sheets ledger: ' + (verifications.sheets.ok ? 'verified' : 'FAILED'));
    if (!verifications.sheets.ok) throw new BackupError('Google Sheets backup could not be verified (' + verifications.sheets.reason + '). Archiving aborted: no HubSpot records were archived.');
  }
  if (config.storeFile) {
    verifications.file = writeBackupFiles(backup, config);
    log.info('Local file backup: ' + (verifications.file.ok ? 'verified' : 'FAILED'));
    if (!verifications.file.ok) throw new BackupError('Local file backup could not be verified (' + verifications.file.reason + '). Archiving aborted: no HubSpot records were archived.');
  }

  // 2) Plan: requires every configured target verified for THIS run, within the batch cap.
  let plan;
  try {
    plan = planArchive(backup, verifications, config);
    assertWithinBatchCap(plan.recordIds.length, config.maxArchivePerRun);
  } catch (err) {
    throw new BackupError(err.message);
  }

  // 3) Archive, rate-limited (retries with backoff happen inside hubspotRequest).
  const archivedIds = [];
  const failed = [];
  for (const id of plan.recordIds) {
    try {
      await archiveObject(objectType, id, ctx);
      archivedIds.push(id);
    } catch (err) {
      failed.push({ id, status: err.status || null });
    }
    await wait(d.archiveIntervalMs === undefined ? 150 : d.archiveIntervalMs);
  }
  const archive = summarizeArchive(plan, { archivedIds, failed });
  log.info('Archived ' + archive.archived + ' of ' + archive.planned + ' record(s); ' + archive.failed + ' failed.');
  return { meta, selection, backup, preview: null, verifications, archive };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(err.message + '\n');
    return 2;
  }
  if (args.help) { process.stdout.write(HELP + '\n'); return 0; }

  loadDotEnv(args.envFile ? path.resolve(args.envFile) : undefined);
  const config = loadConfig(process.env, args);
  const portalRef = {};
  const log = createLogger(config, args.quiet, () => [portalRef.portalId]);

  try {
    log.info('Starting run · DRY_RUN=' + config.dryRun + ' · SANDBOX_MODE=' + config.sandboxMode + ' · RETENTION_DAYS=' +
      config.retentionDays + ' · MAX_ARCHIVE_PER_RUN=' + config.maxArchivePerRun + ' · STORAGE_TARGETS=' + config.storageTargets.join(','));
    const out = await run(config, { log, asOf: args.asOf, portalRef });
    if (args.output) {
      const report = out.preview || { meta: out.meta, selection: Object.assign({}, out.selection, { selected: out.selection.selected.length }), verifications: out.verifications, archive: out.archive, runId: out.backup.runId };
      fs.writeFileSync(path.resolve(args.output), JSON.stringify(report, null, 2));
      log.info('Report written to ' + args.output);
    }
    if (args.csv) {
      fs.writeFileSync(path.resolve(args.csv), out.backup.csv);
      log.info('CSV ledger written to ' + args.csv);
    }
    if (!args.quiet) {
      process.stdout.write(JSON.stringify({
        meta: out.meta,
        runId: out.backup.runId,
        selected: out.selection.selected.length,
        excluded: out.selection.excluded,
        truncatedAtCap: out.selection.truncatedAtCap,
        archive: out.archive,
      }, null, 2) + '\n');
    }
    return out.archive && out.archive.failed ? 1 : 0;
  } catch (err) {
    const masked = maskError(err, secretValues(config, [portalRef.portalId]));
    log.error(masked.name + ': ' + masked.message);
    if (err instanceof SafetyError) return 2;
    if (err instanceof BackupError) return 3;
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { run, main, parseArgs, SafetyError };
