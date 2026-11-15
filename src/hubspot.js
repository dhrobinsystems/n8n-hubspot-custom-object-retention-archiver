'use strict';
/**
 * hubspot.js — HubSpot CRM v3 client (native fetch, Node >= 18).
 * Reads: account info, property list, stale-record search.
 * The only write is archiveObject() (DELETE = move to recycle bin), and
 * src/index.js calls it only after planArchive() confirms a verified backup.
 */

const { maskSecrets } = require('./safety');

class HubSpotError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HubSpotError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hubspotRequest(method, pathName, opts, ctx) {
  const { token, apiBase, fetchImpl, retries = 4, wait = sleep } = ctx;
  const o = opts || {};
  const url = new URL(apiBase.replace(/\/+$/, '') + pathName);
  for (const [k, v] of Object.entries(o.query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; ; attempt++) {
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchImpl(url.toString(), {
      method,
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    if (res.ok) {
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : NaN);
      await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
      continue;
    }
    let body = '';
    try { body = await res.text(); } catch (_) { /* ignore */ }
    const safePath = pathName.replace(/\/crm\/v3\/(objects|properties)\/[^/]+/, '/crm/v3/$1/{objectType}').replace(/\/\d+$/, '/{id}');
    throw new HubSpotError(
      'HubSpot API ' + res.status + ' on ' + method + ' ' + safePath + (body ? ': ' + maskSecrets(body.slice(0, 300), [token]) : ''),
      res.status
    );
  }
}

/** GET /account-info/v3/details — portalId, accountType, uiDomain. */
function getAccountInfo(ctx) {
  return hubspotRequest('GET', '/account-info/v3/details', null, ctx);
}

/** All property names of the custom object, so the backup is complete. */
async function listPropertyNames(objectType, ctx) {
  const body = await hubspotRequest('GET', '/crm/v3/properties/' + encodeURIComponent(objectType), { query: { archived: 'false' } }, ctx);
  return ((body && body.results) || []).map((p) => p.name).filter(Boolean).sort();
}

/** Page through the search API until done or `cap` records are collected. */
async function searchStaleRecords(objectType, buildBody, cap, ctx, options) {
  const o = options || {};
  const out = [];
  let after;
  do {
    const body = await hubspotRequest('POST', '/crm/v3/objects/' + encodeURIComponent(objectType) + '/search', { body: buildBody(after) }, ctx);
    for (const r of (body && body.results) || []) {
      out.push(r);
      if (out.length >= cap) break;
    }
    after = body && body.paging && body.paging.next ? body.paging.next.after : undefined;
    if (after && o.requestIntervalMs) await (ctx.wait || sleep)(o.requestIntervalMs); // search API: ~5 req/s
  } while (after && out.length < cap);
  return out;
}

/** DELETE /crm/v3/objects/{objectType}/{id} — archives (recycle bin, ~90 days). */
function archiveObject(objectType, id, ctx) {
  return hubspotRequest('DELETE', '/crm/v3/objects/' + encodeURIComponent(objectType) + '/' + encodeURIComponent(id), null, ctx);
}

module.exports = { HubSpotError, hubspotRequest, getAccountInfo, listPropertyNames, searchStaleRecords, archiveObject };
