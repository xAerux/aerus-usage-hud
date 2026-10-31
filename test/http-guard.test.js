import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest, parseAllowedHosts } from '../src/http-guard.js';

const PORT = 8790;
const check = (headers, extra = {}) => checkRequest({ method: 'GET', pathname: '/api/usage', port: PORT, headers, ...extra });

test('parseAllowedHosts trims, lower-cases and drops empty entries', () => {
  assert.deepEqual(parseAllowedHosts(' Aerus.Local , ,box:8790,'), ['aerus.local', 'box:8790']);
  assert.deepEqual(parseAllowedHosts(undefined), []);
});

test('loopback names are accepted only with the listening port', () => {
  assert.equal(check({ host: `127.0.0.1:${PORT}` }).ok, true);
  assert.equal(check({ host: `localhost:${PORT}` }).ok, true);
  assert.equal(check({ host: '127.0.0.1' }).ok, false);
  assert.equal(check({ host: `127.0.0.1:${PORT + 1}` }).ok, false);
});

test('an extra allowed name without a port matches any port, with a port only that port', () => {
  const extraHosts = parseAllowedHosts('aerus.local,other.local:9000');
  assert.equal(check({ host: `aerus.local:${PORT}` }, { extraHosts }).ok, true);
  assert.equal(check({ host: 'aerus.local:1234' }, { extraHosts }).ok, true);
  assert.equal(check({ host: 'aerus.local' }, { extraHosts }).ok, true);
  assert.equal(check({ host: 'other.local:9000' }, { extraHosts }).ok, true);
  assert.equal(check({ host: 'other.local:9001' }, { extraHosts }).ok, false);
});

test('an allowed name does not match longer names, suffixes or path-like tricks', () => {
  const extraHosts = parseAllowedHosts('aerus.local');
  for (const host of ['aerus.local.evil.test', 'evil-aerus.local', 'aerus.localx:80', 'aerus.local:80x', 'aerus.local:', 'aerus.local@evil.test', 'aerus.local:80:90']) {
    assert.equal(check({ host }, { extraHosts }).ok, false, host);
  }
});

test('the Origin header follows the same host rules', () => {
  const extraHosts = parseAllowedHosts('aerus.local');
  assert.equal(check({ host: `127.0.0.1:${PORT}`, origin: 'http://aerus.local:8790' }, { extraHosts }).ok, true);
  assert.equal(check({ host: `127.0.0.1:${PORT}`, origin: 'http://aerus.local:8790' }).ok, false);
  assert.equal(check({ host: `127.0.0.1:${PORT}`, origin: 'https://127.0.0.1:8790' }).ok, false);
});

test('only GET and HEAD pass, with the right status for the rest', () => {
  const headers = { host: `127.0.0.1:${PORT}` };
  assert.equal(checkRequest({ method: 'HEAD', pathname: '/', port: PORT, headers }).ok, true);
  const refused = checkRequest({ method: 'POST', pathname: '/', port: PORT, headers });
  assert.deepEqual([refused.ok, refused.status], [false, 405]);
});

test('Sec-Fetch-Site is only enforced for /api/', () => {
  const headers = { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'cross-site' };
  assert.equal(checkRequest({ method: 'GET', pathname: '/api/usage', port: PORT, headers }).status, 403);
  assert.equal(checkRequest({ method: 'GET', pathname: '/index.html', port: PORT, headers }).ok, true);
});
