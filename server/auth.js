/* Passwords, sessions and roles */
'use strict';

const crypto = require('crypto');

const ROLES = ['Admin', 'Supervisor', 'User'];
const SESSION_HOURS = 12;
const COOKIE = 'cs_session';

// ---------- passwords (scrypt, built into Node - nothing extra to install) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 6) return 'Password must be at least 6 characters';
  if (pw.length > 100) return 'Password is too long';
  return null;
}

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (const b of crypto.randomBytes(10)) s += chars[b % chars.length];
  return s;
}

// ---------- session token: payload.signature, kept in an HttpOnly cookie ----------
let secret;
function setSecret(s) { secret = s; }

const b64url = buf => Buffer.from(buf).toString('base64url');
const sign = data => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function makeToken(user) {
  const payload = b64url(JSON.stringify({
    uid: user.UserId,
    tv: user.TokenVersion,
    exp: Date.now() + SESSION_HOURS * 3600 * 1000
  }));
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const good = sign(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch (e) { return null; }
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ---------- login attempt limiting (5 wrong passwords -> wait 5 minutes) ----------
const attempts = new Map();
const LOCK_AFTER = 5, LOCK_MS = 5 * 60 * 1000;

function loginLocked(key) {
  const a = attempts.get(key);
  if (!a) return 0;
  if (a.until && a.until > Date.now()) return Math.ceil((a.until - Date.now()) / 60000);
  if (a.until) attempts.delete(key);
  return 0;
}
function loginFailed(key) {
  const a = attempts.get(key) || { n: 0 };
  a.n++;
  if (a.n >= LOCK_AFTER) { a.until = Date.now() + LOCK_MS; a.n = 0; }
  attempts.set(key, a);
}
function loginOk(key) { attempts.delete(key); }

// ---------- what each role may do ----------
const can = {
  viewAll: role => role === 'Admin' || role === 'Supervisor',        // all scans on the dashboard
  deleteAnyScan: role => role === 'Admin' || role === 'Supervisor',
  manageUsers: role => role === 'Admin'
};

module.exports = {
  ROLES, COOKIE, SESSION_HOURS,
  hashPassword, verifyPassword, passwordProblem, randomPassword,
  setSecret, makeToken, readToken, getCookie, setSessionCookie, clearSessionCookie,
  loginLocked, loginFailed, loginOk, can
};
