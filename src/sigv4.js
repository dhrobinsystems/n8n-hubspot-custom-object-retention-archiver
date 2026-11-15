'use strict';
/**
 * sigv4.js — AWS Signature Version 4 request signing for S3 PutObject.
 *
 * PURE MODULE: no require(). The digest/HMAC implementation is injectable:
 * by default it uses the pure functions in hash.js (so the n8n Code node needs
 * no built-in modules), and src/storage.js injects node:crypto. The tests
 * check both against AWS's published signing test vectors.
 */

function pureSigV4Impl() {
  return { sha256: sha256Bytes, hmac: hmacSha256 };
}

/** RFC 3986 encoding as required by SigV4 (unreserved: A-Z a-z 0-9 - _ . ~). */
function sigv4UriEncode(str, encodeSlash) {
  let s = encodeURIComponent(String(str)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (!encodeSlash) s = s.replace(/%2F/g, '/');
  return s;
}

function toAmzDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function deriveSigningKey(secretAccessKey, dateStamp, region, service, impl) {
  const i = impl || pureSigV4Impl();
  const kDate = i.hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = i.hmac(kDate, region);
  const kService = i.hmac(kRegion, service);
  return i.hmac(kService, 'aws4_request');
}

/**
 * Sign a request.
 * req: { method, host, path (canonical, already URI-encoded), query: {}, headers: {} (host excluded),
 *        payloadHash (hex), region, service, amzDate }
 * creds: { accessKeyId, secretAccessKey }
 */
function signSigV4(req, creds, impl) {
  const i = impl || pureSigV4Impl();
  const headers = {};
  headers.host = String(req.host).trim();
  for (const [k, v] of Object.entries(req.headers || {})) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => n + ':' + headers[n] + '\n').join('');
  const signedHeaders = names.join(';');
  const query = req.query || {};
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => sigv4UriEncode(k, true) + '=' + sigv4UriEncode(query[k], true)).join('&');
  const canonicalRequest = [req.method, req.path || '/', canonicalQuery, canonicalHeaders, signedHeaders, req.payloadHash].join('\n');
  const dateStamp = req.amzDate.slice(0, 8);
  const scope = dateStamp + '/' + req.region + '/' + req.service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', req.amzDate, scope, bytesToHex(i.sha256(canonicalRequest))].join('\n');
  const signingKey = deriveSigningKey(creds.secretAccessKey, dateStamp, req.region, req.service, i);
  const signature = bytesToHex(i.hmac(signingKey, stringToSign));
  return {
    authorization: 'AWS4-HMAC-SHA256 Credential=' + creds.accessKeyId + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    signature,
    signedHeaders,
    canonicalRequest,
    stringToSign,
  };
}

/**
 * Build a signed, overwrite-protected S3 PutObject request.
 * - x-amz-checksum-sha256 makes S3 verify the body and echo the checksum back.
 * - If-None-Match: * makes S3 refuse to overwrite an existing object (immutability).
 * Returns { method, url, headers, contentType, body, key, payloadSha256Hex, checksumSha256Base64 }.
 */
function buildS3PutRequest(params, impl) {
  const i = impl || pureSigV4Impl();
  const p = params || {};
  const body = p.body === undefined || p.body === null ? '' : String(p.body);
  const digest = i.sha256(body);
  const payloadSha256Hex = bytesToHex(digest);
  const checksumSha256Base64 = bytesToBase64(digest);
  const encodedKey = String(p.key).split('/').map((seg) => sigv4UriEncode(seg, true)).join('/');
  let host;
  let path;
  if (p.endpoint) {
    const m = String(p.endpoint).match(/^https:\/\/([^\/?#]+)\/?$/i);
    if (!m) throw new Error('AWS_S3_ENDPOINT must look like https://host[:port]');
    host = m[1];
    path = '/' + sigv4UriEncode(p.bucket, true) + '/' + encodedKey; // path-style for custom endpoints
  } else {
    host = p.bucket + '.s3.' + p.region + '.amazonaws.com';
    path = '/' + encodedKey;
  }
  const amzDate = p.amzDate || toAmzDate(new Date());
  const signedInput = {
    'x-amz-checksum-sha256': checksumSha256Base64,
    'x-amz-content-sha256': payloadSha256Hex,
    'x-amz-date': amzDate,
  };
  if (p.sessionToken) signedInput['x-amz-security-token'] = p.sessionToken;
  const sig = signSigV4({
    method: 'PUT', host, path, query: {}, headers: signedInput, payloadHash: payloadSha256Hex,
    region: p.region, service: 's3', amzDate,
  }, { accessKeyId: p.accessKeyId, secretAccessKey: p.secretAccessKey }, i);
  const headers = Object.assign({}, signedInput, { Authorization: sig.authorization });
  if (p.preventOverwrite !== false) headers['If-None-Match'] = '*';
  return {
    method: 'PUT',
    url: 'https://' + host + path,
    headers,
    contentType: p.contentType || 'application/octet-stream',
    body,
    key: p.key,
    payloadSha256Hex,
    checksumSha256Base64,
  };
}

// @n8n-exclude-start
const { sha256Bytes, hmacSha256, bytesToHex, bytesToBase64 } = require('./hash');
module.exports = { pureSigV4Impl, sigv4UriEncode, toAmzDate, deriveSigningKey, signSigV4, buildS3PutRequest };
// @n8n-exclude-end
