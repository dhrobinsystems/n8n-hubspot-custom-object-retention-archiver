'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('../src/hash');
const s = require('../src/sigv4');
const { nodeCryptoImpl } = require('../src/storage');

// AWS-published documentation test values. These are NOT credentials.
const AWS_DOC_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const AWS_DOC_KEY_ID = 'AKIDEXAMPLE';

const SAMPLES = ['', 'abc', 'Acme Example Corp', 'Café Lumière ☕ 😀', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'w'.repeat(10000)];

test('pure SHA-256 matches the FIPS 180-2 vector and node:crypto', () => {
  assert.equal(h.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(h.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  for (const v of SAMPLES) {
    assert.equal(h.sha256Hex(v), crypto.createHash('sha256').update(v).digest('hex'), JSON.stringify(v.slice(0, 20)));
    assert.equal(h.sha256Base64(v), crypto.createHash('sha256').update(v).digest('base64'));
  }
});

test('pure HMAC-SHA256 matches node:crypto for short and long keys', () => {
  for (const key of ['k', 'key-'.repeat(20)]) {
    for (const v of SAMPLES) {
      assert.equal(h.bytesToHex(h.hmacSha256(key, v)), crypto.createHmac('sha256', key).update(v).digest('hex'));
    }
  }
});

test('UTF-8, base64 and base64url helpers match Buffer', () => {
  for (const v of SAMPLES) {
    assert.deepEqual(Array.from(h.utf8Bytes(v)), Array.from(Buffer.from(v, 'utf8')));
    assert.equal(h.bytesToBase64(h.utf8Bytes(v)), Buffer.from(v).toString('base64'));
    assert.equal(h.base64UrlEncode(v), Buffer.from(v).toString('base64url'));
  }
});

test('SigV4 signing key matches the AWS documentation example', () => {
  const key = s.deriveSigningKey(AWS_DOC_SECRET, '20120215', 'us-east-1', 'iam');
  assert.equal(h.bytesToHex(key), 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
});

test('SigV4 signature matches the AWS test-suite "get-vanilla" vector (pure and node:crypto)', () => {
  const req = {
    method: 'GET', host: 'example.amazonaws.com', path: '/', query: {}, headers: { 'X-Amz-Date': '20150830T123600Z' },
    payloadHash: h.sha256Hex(''), region: 'us-east-1', service: 'service', amzDate: '20150830T123600Z',
  };
  const creds = { accessKeyId: AWS_DOC_KEY_ID, secretAccessKey: AWS_DOC_SECRET };
  const expected = '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31';
  assert.equal(s.signSigV4(req, creds).signature, expected);
  assert.equal(s.signSigV4(req, creds, nodeCryptoImpl).signature, expected);
  assert.match(s.signSigV4(req, creds).authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-date, Signature=/);
});

test('S3 PutObject requests: identical with pure and node:crypto, checksummed, overwrite-protected', () => {
  const params = {
    bucket: 'mock-archive-bucket', region: 'us-east-1', key: 'hubspot-retention-archive/p_mock_subscriptions/2026/01/05/run x.json',
    body: '{"hello":"Café"}', contentType: 'application/json', accessKeyId: AWS_DOC_KEY_ID, secretAccessKey: AWS_DOC_SECRET,
    amzDate: '20260105T070000Z',
  };
  const pure = s.buildS3PutRequest(params);
  const node = s.buildS3PutRequest(params, nodeCryptoImpl);
  assert.deepEqual(pure, node);
  assert.equal(pure.url, 'https://mock-archive-bucket.s3.us-east-1.amazonaws.com/hubspot-retention-archive/p_mock_subscriptions/2026/01/05/run%20x.json');
  assert.equal(pure.headers['x-amz-checksum-sha256'], crypto.createHash('sha256').update(params.body).digest('base64'));
  assert.equal(pure.headers['x-amz-content-sha256'], crypto.createHash('sha256').update(params.body).digest('hex'));
  assert.equal(pure.headers['If-None-Match'], '*');
  assert.match(pure.headers.Authorization, /SignedHeaders=host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date,/);

  const withToken = s.buildS3PutRequest(Object.assign({ sessionToken: 'mock-session-token' }, params));
  assert.match(withToken.headers.Authorization, /x-amz-security-token/);
  const custom = s.buildS3PutRequest(Object.assign({ endpoint: 'https://s3.mock.example:9000' }, params));
  assert.ok(custom.url.startsWith('https://s3.mock.example:9000/mock-archive-bucket/'));
  assert.throws(() => s.buildS3PutRequest(Object.assign({}, params, { endpoint: 'http://insecure.example' })), /AWS_S3_ENDPOINT/);
});

test('SigV4 URI encoding follows RFC 3986', () => {
  assert.equal(s.sigv4UriEncode("a b!'()*~._-/c", false), 'a%20b%21%27%28%29%2A~._-/c');
  assert.equal(s.sigv4UriEncode('a/b', true), 'a%2Fb');
  assert.equal(s.toAmzDate(new Date('2026-01-05T07:08:09.123Z')), '20260105T070809Z');
});
