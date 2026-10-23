/* =====================================================================
   Carton Scanner - server
   - Scanner page, dashboard, user admin, login
   - Saves scans to SQL Server: ContainerTracking.dbo.ContainerCartonScan
   - Users and roles (Admin / Supervisor / User) in dbo.AppUsers

   Start:  start-server.bat   (or "npm start" in this folder)
   ===================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const auth = require('./auth');
const db = process.env.CS_FAKE_DB ? require(process.env.CS_FAKE_DB) : require('./db');

const ROOT = path.join(__dirname, '..');           // the site files (index.html, dashboard.html, ...)

// ---------- config ----------
const CONFIG_FILE = process.env.CS_CONFIG || path.join(__dirname, 'config.json');
const ADMIN_FILE = path.join(path.dirname(CONFIG_FILE), 'FIRST-ADMIN-PASSWORD.txt');
const defaults = {
  port: 3000,
  server: 'localhost\\SQLEXPRESS',
  database: 'ContainerTracking',
  auth: 'windows',          // "windows" = same login as SSMS, "sql" = SQL login below
  sqlUser: '',
  sqlPassword: '',
  odbcDriver: ''
};
let fileCfg = {};
if (fs.existsSync(CONFIG_FILE)) {
  try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { console.error('config.json is not valid JSON:', e.message); process.exit(1); }
}
const cfg = { ...defaults, ...fileCfg };
if (!cfg.sessionSecret) {                           // created once, keeps people logged in across restarts
  cfg.sessionSecret = require('crypto').randomBytes(32).toString('hex');
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...defaults, ...fileCfg, sessionSecret: cfg.sessionSecret }, null, 2)); }
  catch (e) { console.warn('Could not save sessionSecret to config.json - users will need to log in again after a restart.'); }
}
auth.setSecret(cfg.sessionSecret);
db.init(cfg);
const PORT = Number(process.env.PORT || cfg.port || 3000);

// ---------- first start: create tables + first admin ----------
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.ensureSchema();
      if ((await db.userCount()) === 0) {
        const pw = auth.randomPassword();
        await db.createUser({ userName: 'admin', fullName: 'Administrator', role: 'Admin',
                              passwordHash: auth.hashPassword(pw), mustChange: true });
        try {
          fs.writeFileSync(ADMIN_FILE,
            `Carton Scanner - first admin login\r\n\r\nUser name: admin\r\nPassword : ${pw}\r\n\r\n` +
            `You will be asked to choose a new password. This file is deleted automatically after that.\r\n`);
        } catch (e) {}
        console.log('');
        console.log('==============================================================');
        console.log('  First admin account created');
        console.log('    User name: admin');
        console.log(`    Password : ${pw}`);
        console.log('  (also saved in server\\FIRST-ADMIN-PASSWORD.txt)');
        console.log('  You will be asked to choose a new password at first login.');
        console.log('==============================================================');
        console.log('');
      }
    })().catch(err => { readyPromise = null; throw err; });
  }
  return readyPromise;
}

// ---------- helpers ----------
const clean = v => (v == null ? '' : String(v)).trim();
const cleanContainer = v => clean(v).toUpperCase();
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

function publicUser(u) {
  return { id: u.UserId, userName: u.UserName, fullName: u.FullName || '', role: u.Role,
           mustChangePassword: !!u.MustChangePassword };
}
const bad = (res, msg, status = 400) => res.status(status).json({ ok: false, error: msg });
function dbFail(res, err) {
  const msg = err && err.message ? err.message : String(err);
  console.error('Database error:', msg);
  return res.status(503).json({ ok: false, error: 'Database error: ' + msg });
}
// wrap async route handlers so database errors become a 503 instead of crashing
const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => dbFail(res, err));

function validateScan(c, k) {
  if (!c) return 'Container number is required';
  if (!k) return 'Carton ID is required';
  if (c.length > 20) return 'Container number is longer than 20 characters';
  if (k.length > 50) return 'Carton ID is longer than 50 characters';
  return null;
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// pages
const page = file => (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(ROOT, file)); };
app.get(['/', '/index.html'], page('index.html'));
app.get(['/login', '/login.html'], page('login.html'));
app.get(['/dashboard', '/dashboard.html'], page('dashboard.html'));
app.get(['/users', '/users.html'], page('users.html'));
app.use('/assets', express.static(path.join(ROOT, 'assets'), { maxAge: '1h' }));

// API: JSON only for anything that changes data (blocks cross-site form posts)
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('application/json')) {
    return bad(res, 'Content-Type must be application/json', 415);
  }
  next();
});

app.get('/api/health', route(async (req, res) => {
  await db.ping();
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => { auth.clearSessionCookie(res); res.json({ ok: true }); });

// who is logged in?
app.use('/api', route(async (req, res, next) => {
  req.user = null;
  const t = auth.readToken(auth.getCookie(req, auth.COOKIE));
  if (t) {
    await ensureReady();
    const u = await db.getUserById(t.uid);
    if (u && u.IsActive && u.TokenVersion === t.tv) req.user = u;
  }
  next();
}));

function requireLogin(opts = {}) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Please log in', login: true });
    if (req.user.MustChangePassword && !opts.allowMustChange) {
      return res.status(403).json({ ok: false, error: 'Please choose a new password first', mustChangePassword: true });
    }
    next();
  };
}
const requireRole = (test, what) => (req, res, next) =>
  test(req.user.Role) ? next() : bad(res, `Only ${what} can do this`, 403);

// ---------- login / logout / me ----------
app.post('/api/login', route(async (req, res) => {
  await ensureReady();
  const userName = clean(req.body.userName);
  const password = String(req.body.password || '');
  if (!userName || !password) return bad(res, 'Enter your user name and password');
  const key = userName.toLowerCase() + '|' + (req.ip || '');
  const wait = auth.loginLocked(key);
  if (wait) return bad(res, `Too many wrong passwords. Try again in ${wait} minute(s).`, 429);
  const u = await db.getUserByName(userName);
  if (!u || !u.IsActive || !auth.verifyPassword(password, u.PasswordHash)) {
    auth.loginFailed(key);
    return bad(res, 'Wrong user name or password', 401);
  }
  auth.loginOk(key);
  await db.touchLogin(u.UserId);
  auth.setSessionCookie(res, auth.makeToken(u));
  res.json({ ok: true, user: publicUser(u) });
}));

app.get('/api/me', requireLogin({ allowMustChange: true }), (req, res) => res.json({ ok: true, user: publicUser(req.user) }));

app.post('/api/me/password', requireLogin({ allowMustChange: true }), route(async (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (!auth.verifyPassword(current, req.user.PasswordHash)) return bad(res, 'Current password is wrong');
  const problem = auth.passwordProblem(next);
  if (problem) return bad(res, problem);
  if (next === current) return bad(res, 'Choose a password different from the current one');
  await db.updateUser(req.user.UserId, { passwordHash: auth.hashPassword(next), mustChange: false });
  const u = await db.getUserById(req.user.UserId);
  auth.setSessionCookie(res, auth.makeToken(u));                 // stay logged in on this device
  if (u.UserName.toLowerCase() === 'admin') { try { fs.unlinkSync(ADMIN_FILE); } catch (e) {} }
  res.json({ ok: true, user: publicUser(u) });
}));

// ---------- scanning (any role) ----------
app.get('/api/containers/:containerNumber/cartons', requireLogin(), route(async (req, res) => {
  const c = cleanContainer(req.params.containerNumber);
  if (!c) return bad(res, 'Container number is required');
  const cartons = await db.containerCartons(c);
  res.json({ ok: true, containerNumber: c, count: cartons.length, cartons });
}));

app.post('/api/scans', requireLogin(), route(async (req, res) => {
  const c = cleanContainer(req.body.containerNumber);
  const k = clean(req.body.cartonId);
  const t = clean(req.body.scannedAt);   // device local time, e.g. 2026-10-22T13:08:05
  const err = validateScan(c, k);
  if (err) return bad(res, err);
  try {
    const saved = await db.insertScan({ containerNumber: c, cartonId: k, userName: req.user.UserName, scannedAt: t });
    res.status(saved ? 201 : 200).json({ ok: true, saved, duplicate: !saved });
  } catch (e) {
    if (/duplicate key|UNIQUE KEY|2627|2601/i.test(String(e && e.message))) {
      return res.json({ ok: true, saved: false, duplicate: true });
    }
    throw e;
  }
}));

// Undo from the scanner: a User may remove only their own scans
app.delete('/api/scans', requireLogin(), route(async (req, res) => {
  const c = cleanContainer(req.body.containerNumber);
  const k = clean(req.body.cartonId);
  const err = validateScan(c, k);
  if (err) return bad(res, err);
  const scan = await db.getScan(c, k);
  if (!scan) return res.json({ ok: true, deleted: 0 });
  if (!auth.can.deleteAnyScan(req.user.Role) &&
      String(scan.UserName || '').toLowerCase() !== req.user.UserName.toLowerCase()) {
    return bad(res, 'You can only remove cartons you scanned yourself', 403);
  }
  res.json({ ok: true, deleted: await db.deleteScanById(scan.Id) });
}));

// ---------- reports / dashboard ----------
function filtersFrom(req) {
  const f = {
    from: isDate(clean(req.query.from)) ? clean(req.query.from) : '',
    to: isDate(clean(req.query.to)) ? clean(req.query.to) : '',
    container: clean(req.query.container).toUpperCase().slice(0, 20),
    carton: clean(req.query.carton).slice(0, 50),
    user: clean(req.query.user).slice(0, 50)
  };
  if (!auth.can.viewAll(req.user.Role)) f.user = req.user.UserName;   // Users only see their own scans
  return f;
}
function paging(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(500, Math.max(10, parseInt(req.query.pageSize, 10) || 50));
  return { page, pageSize, sort: clean(req.query.sort), dir: clean(req.query.dir) === 'asc' ? 'asc' : 'desc' };
}

app.get('/api/report/summary', requireLogin(), route(async (req, res) => {
  res.json({ ok: true, ...(await db.summary(filtersFrom(req))) });
}));

app.get('/api/report/scans', requireLogin(), route(async (req, res) => {
  const p = paging(req);
  res.json({ ok: true, ...p, ...(await db.scans(filtersFrom(req), p)) });
}));

app.get('/api/report/containers', requireLogin(), route(async (req, res) => {
  const p = paging(req);
  res.json({ ok: true, ...p, ...(await db.containers(filtersFrom(req), p)) });
}));

app.get('/api/report/users', requireLogin(), route(async (req, res) => {
  if (!auth.can.viewAll(req.user.Role)) return res.json({ ok: true, users: [req.user.UserName] });
  res.json({ ok: true, users: (await db.scanUserNames()).map(r => r.UserName) });
}));

app.delete('/api/report/scans/:id', requireLogin(), requireRole(auth.can.deleteAnyScan, 'supervisors and admins'),
  route(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return bad(res, 'Invalid id');
    const scan = await db.getScanById(id);
    if (!scan) return bad(res, 'Scan not found', 404);
    await db.deleteScanById(id);
    console.log(`  ${req.user.UserName} deleted scan ${scan.ContainerNumber} / ${scan.CartonId}`);
    res.json({ ok: true, deleted: 1 });
  }));

// downloads
const EXPORT_LIMIT = 200000;
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+@\t\r]/.test(s) || /^-[^0-9]/.test(s)) s = "'" + s;   // stop Excel treating it as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const splitDT = s => (s ? [s.slice(0, 10), s.slice(11, 19)] : ['', '']);

app.get('/api/report/export', requireLogin(), route(async (req, res) => {
  const f = filtersFrom(req);
  const format = clean(req.query.format) === 'csv' ? 'csv' : 'xlsx';
  const view = clean(req.query.view) === 'containers' ? 'containers' : 'scans';
  const stamp = new Date().toISOString().slice(0, 10);
  const range = f.from || f.to ? `_${f.from || 'start'}_to_${f.to || 'today'}` : '';

  const scanRows = view === 'scans' || format === 'xlsx'
    ? (await db.scans(f, { page: 1, sort: 'time', dir: 'desc', limit: EXPORT_LIMIT })).rows : [];
  const contRows = view === 'containers' || format === 'xlsx'
    ? (await db.containers(f, { page: 1, sort: 'last', dir: 'desc', limit: EXPORT_LIMIT })).rows : [];

  if (format === 'csv') {
    const name = `carton-${view}${range}_${stamp}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    const lines = view === 'scans'
      ? [['Container No', 'Carton ID', 'Scan Date', 'Scan Time', 'User'],
         ...scanRows.map(r => [r.ContainerNumber, r.CartonId, ...splitDT(r.ScanDateTime), r.UserName])]
      : [['Container No', 'Cartons', 'First Scan', 'Last Scan', 'Users'],
         ...contRows.map(r => [r.ContainerNumber, r.Cartons, r.FirstScan, r.LastScan, r.Users])];
    return res.send('﻿' + lines.map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n');
  }

  const ExcelJS = require('exceljs');
  const name = `carton-report${range}_${stamp}.xlsx`;
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  wb.creator = 'Carton Scanner';

  const addSheet = (title, columns, data) => {
    const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5B21F' } };
    ws.getRow(1).commit();
    for (const d of data) ws.addRow(d).commit();
    ws.commit();
  };
  const toDate = s => (s ? new Date(`${s.replace(' ', 'T')}Z`) : null);   // shown as-is (no time zone shift)

  addSheet('Scans', [
    { header: 'Container No', key: 'c', width: 16 },
    { header: 'Carton ID', key: 'k', width: 24 },
    { header: 'Scan Date & Time', key: 't', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm:ss' } },
    { header: 'User', key: 'u', width: 16 }
  ], scanRows.map(r => ({ c: r.ContainerNumber, k: r.CartonId, t: toDate(r.ScanDateTime), u: r.UserName || '' })));

  addSheet('Containers', [
    { header: 'Container No', key: 'c', width: 16 },
    { header: 'Cartons', key: 'n', width: 10 },
    { header: 'First Scan', key: 'f', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm:ss' } },
    { header: 'Last Scan', key: 'l', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm:ss' } },
    { header: 'Users', key: 'u', width: 30 }
  ], contRows.map(r => ({ c: r.ContainerNumber, n: r.Cartons, f: toDate(r.FirstScan), l: toDate(r.LastScan), u: r.Users || '' })));

  const ws = wb.addWorksheet('Filters');
  ws.columns = [{ header: 'Filter', key: 'k', width: 16 }, { header: 'Value', key: 'v', width: 30 }];
  ws.getRow(1).font = { bold: true };
  [['From', f.from || '(any)'], ['To', f.to || '(any)'], ['Container', f.container || '(any)'],
   ['Carton', f.carton || '(any)'], ['User', f.user || '(any)'],
   ['Downloaded by', req.user.UserName], ['Downloaded at', new Date().toLocaleString()],
   ['Rows', scanRows.length >= EXPORT_LIMIT ? `${EXPORT_LIMIT} (limit reached - narrow the filters)` : scanRows.length]]
    .forEach(([k, v]) => ws.addRow({ k, v }).commit());
  ws.commit();
  await wb.commit();
}));

// ---------- user management (Admin) ----------
const USERNAME_RE = /^[A-Za-z0-9._-]{2,50}$/;
const isAdmin = [requireLogin(), requireRole(auth.can.manageUsers, 'admins')];

app.get('/api/users', ...isAdmin, route(async (req, res) => {
  res.json({ ok: true, users: await db.listUsers(), me: req.user.UserId });
}));

app.post('/api/users', ...isAdmin, route(async (req, res) => {
  const userName = clean(req.body.userName);
  const fullName = clean(req.body.fullName).slice(0, 100);
  const role = clean(req.body.role);
  let password = String(req.body.password || '');
  if (!USERNAME_RE.test(userName)) return bad(res, 'User name: 2-50 letters, numbers, dot, dash or underscore');
  if (!auth.ROLES.includes(role)) return bad(res, 'Choose a role');
  if (await db.getUserByName(userName)) return bad(res, 'That user name is already taken');
  const generated = !password;
  if (generated) password = auth.randomPassword();
  const problem = auth.passwordProblem(password);
  if (problem) return bad(res, problem);
  await db.createUser({ userName, fullName, role, passwordHash: auth.hashPassword(password), mustChange: true });
  console.log(`  ${req.user.UserName} created user ${userName} (${role})`);
  res.status(201).json({ ok: true, tempPassword: generated ? password : undefined });
}));

app.patch('/api/users/:id', ...isAdmin, route(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const target = id && await db.getUserById(id);
  if (!target) return bad(res, 'User not found', 404);
  const fields = {};
  const self = target.UserId === req.user.UserId;

  if (req.body.fullName !== undefined) fields.fullName = clean(req.body.fullName).slice(0, 100);
  if (req.body.role !== undefined) {
    const role = clean(req.body.role);
    if (!auth.ROLES.includes(role)) return bad(res, 'Choose a role');
    if (self && role !== target.Role) return bad(res, 'You cannot change your own role');
    if (role !== target.Role) fields.role = role;
  }
  if (req.body.isActive !== undefined) {
    const active = !!req.body.isActive;
    if (self && !active) return bad(res, 'You cannot deactivate your own account');
    if (active !== !!target.IsActive) fields.isActive = active;
  }
  const losingAdmin = target.Role === 'Admin' && target.IsActive &&
    ((fields.role && fields.role !== 'Admin') || fields.isActive === false);
  if (losingAdmin && (await db.activeAdminCount()) <= 1) return bad(res, 'There must be at least one active admin');

  let tempPassword;
  if (req.body.resetPassword) {
    let pw = typeof req.body.resetPassword === 'string' ? req.body.resetPassword : '';
    if (!pw) { pw = auth.randomPassword(); tempPassword = pw; }
    const problem = auth.passwordProblem(pw);
    if (problem) return bad(res, problem);
    fields.passwordHash = auth.hashPassword(pw);
    fields.mustChange = true;
  }
  await db.updateUser(id, fields);
  console.log(`  ${req.user.UserName} updated user ${target.UserName}: ${Object.keys(fields).filter(k => k !== 'passwordHash').join(', ') || 'no changes'}`);
  res.json({ ok: true, tempPassword });
}));

app.use('/api', (req, res) => bad(res, 'Not found', 404));

// ---------- start ----------
app.listen(PORT, '0.0.0.0', async () => {
  console.log('');
  console.log('Carton Scanner server is running');
  console.log(`  On this PC:              http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  On the scanner / phone:  http://${a.address}:${PORT}`);
    }
  }
  console.log(`  Dashboard:               http://localhost:${PORT}/dashboard`);
  console.log('  Keep this window open. Close it to stop.');
  console.log('');
  try { await ensureReady(); }
  catch (e) {
    console.error('Could not connect to SQL Server yet:', e.message);
    console.error('The server keeps running and will retry on the next request.');
  }
});
