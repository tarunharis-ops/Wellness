// Password hashing (Node's built-in scrypt — no native deps) and small
// cookie helpers. Sessions themselves live in Postgres (see db/repo.js) so
// they survive restarts/deploys and can be revoked.

'use strict';

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SESSION_COOKIE = 'wct_session';
const SESSION_DAYS = 90;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(':') === -1) return false;
  const parts = stored.split(':');
  const salt = parts[0], hash = parts[1];
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sessionExpiry() {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(function (pair) {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, token, secure) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const parts = [
    SESSION_COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'Max-Age=' + maxAge,
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, secure) {
  const parts = [SESSION_COOKIE + '=', 'Path=/', 'HttpOnly', 'Max-Age=0', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

module.exports = {
  hashPassword, verifyPassword, newToken, sessionExpiry,
  parseCookies, setSessionCookie, clearSessionCookie, SESSION_COOKIE,
};
