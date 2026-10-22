/* =====================================================================
   Carton Scanner - local server
   Saves every scan into SQL Server:  ContainerTracking.dbo.ContainerCartonScan
   Also serves the scanner page at  http://<this PC>:3000

   Start:  npm start      (inside this "server" folder)
   ===================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

// ---------- config ----------
const CONFIG_FILE = path.join(__dirname, 'config.json');
const defaults = {
  port: 3000,
  server: 'localhost\\SQLEXPRESS',
  database: 'ContainerTracking',
  auth: 'windows',          // "windows" = same login you use in SSMS, "sql" = SQL login below
  sqlUser: '',
  sqlPassword: '',
  odbcDriver: ''            // leave empty to auto-detect (Windows login only)
};
let cfg = { ...defaults };
if (fs.existsSync(CONFIG_FILE)) {
  try { cfg = { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch (e) { console.error('config.json is not valid JSON:', e.message); process.exit(1); }
}
const PORT = Number(process.env.PORT || cfg.port || 3000);

// ---------- database ----------
let sql;            // the mssql module in use
let poolPromise;    // cached connection

function splitServer(s) {
  const [host, instance] = String(s).split('\\');
  return { host: host || 'localhost', instance };
}

async function connectWindows() {
  try { sql = require('mssql/msnodesqlv8'); }
  catch (e) {
    throw new Error('Windows login needs the "msnodesqlv8" package. Run "npm install" again, ' +
      'or set "auth": "sql" in config.json and use a SQL login.');
  }
  const drivers = cfg.odbcDriver
    ? [cfg.odbcDriver]
    : ['ODBC Driver 18 for SQL Server', 'ODBC Driver 17 for SQL Server', 'SQL Server'];
  let lastErr;
  for (const d of drivers) {
    const extra = d.includes('18') ? 'Encrypt=no;TrustServerCertificate=yes;' : '';
    const connectionString =
      `Driver={${d}};Server=${cfg.server};Database=${cfg.database};Trusted_Connection=Yes;${extra}`;
    try {
      const pool = new sql.ConnectionPool({ connectionString });
      await pool.connect();
      console.log(`Connected to ${cfg.server} / ${cfg.database} (Windows login, ${d})`);
      return pool;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function connectSql() {
  sql = require('mssql');
  const { host, instance } = splitServer(cfg.server);
  const pool = new sql.ConnectionPool({
    server: host,
    database: cfg.database,
    user: cfg.sqlUser,
    password: cfg.sqlPassword,
    options: { instanceName: instance, encrypt: false, trustServerCertificate: true }
  });
  await pool.connect();
  console.log(`Connected to ${cfg.server} / ${cfg.database} (SQL login ${cfg.sqlUser})`);
  return pool;
}

function getPool() {
  if (!poolPromise) {
    poolPromise = (cfg.auth === 'sql' ? connectSql() : connectWindows())
      .then(pool => {
        pool.on('error', () => { poolPromise = null; });
        return pool;
      })
      .catch(err => { poolPromise = null; throw err; });
  }
  return poolPromise;
}

async function query(text, params = {}) {
  const pool = await getPool();
  const req = pool.request();
  for (const [name, value] of Object.entries(params)) req.input(name, sql.NVarChar(100), value);
  return req.query(text);
}

// ---------- helpers ----------
const clean = v => (v == null ? '' : String(v)).trim();
const cleanContainer = v => clean(v).toUpperCase();

function bad(res, msg) { return res.status(400).json({ ok: false, error: msg }); }
function fail(res, err) {
  console.error(err && err.message ? err.message : err);
  return res.status(503).json({ ok: false, error: 'Database error: ' + (err && err.message ? err.message : err) });
}
function validate(c, k, u) {
  if (!c) return 'Container number is required';
  if (!k) return 'Carton ID is required';
  if (c.length > 20) return 'Container number is longer than 20 characters';
  if (k.length > 50) return 'Carton ID is longer than 50 characters';
  if (u && u.length > 50) return 'User name is longer than 50 characters';
  return null;
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '100kb' }));

// allow the page to call this server even when it is opened from GitHub Pages
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.headers['access-control-request-private-network']) {
    res.set('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// the scanner page itself
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

// is the database reachable?
app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1 AS ok');
    res.json({ ok: true, database: cfg.database });
  } catch (e) { fail(res, e); }
});

// cartons already saved for a container (used to resume a container)
app.get('/api/containers/:containerNumber/cartons', async (req, res) => {
  const c = cleanContainer(req.params.containerNumber);
  if (!c) return bad(res, 'Container number is required');
  try {
    const r = await query(
      `SELECT CartonId,
              CONVERT(varchar(19), ScanDateTime, 126) AS ScanDateTime,
              UserName
       FROM dbo.ContainerCartonScan
       WHERE ContainerNumber = @c
       ORDER BY ScanDateTime, Id;`, { c });
    res.json({ ok: true, containerNumber: c, count: r.recordset.length, cartons: r.recordset });
  } catch (e) { fail(res, e); }
});

// save one scan
app.post('/api/scans', async (req, res) => {
  const c = cleanContainer(req.body.containerNumber);
  const k = clean(req.body.cartonId);
  const u = clean(req.body.userName);
  const t = clean(req.body.scannedAt);   // device local time, e.g. 2026-10-22T13:08:05
  const err = validate(c, k, u);
  if (err) return bad(res, err);
  try {
    const r = await query(
      `INSERT INTO dbo.ContainerCartonScan (ContainerNumber, CartonId, ScanDateTime, UserName)
       SELECT @c, @k, ISNULL(TRY_CONVERT(datetime2(0), NULLIF(@t, ''), 126), SYSDATETIME()), NULLIF(@u, '')
       WHERE NOT EXISTS (SELECT 1 FROM dbo.ContainerCartonScan WITH (UPDLOCK, HOLDLOCK)
                         WHERE ContainerNumber = @c AND CartonId = @k);`, { c, k, u, t });
    const saved = r.rowsAffected && r.rowsAffected[0] > 0;
    res.status(saved ? 201 : 200).json({ ok: true, saved, duplicate: !saved });
  } catch (e) {
    if (/duplicate key|UNIQUE KEY|2627|2601/i.test(String(e && e.message))) {
      return res.json({ ok: true, saved: false, duplicate: true });
    }
    fail(res, e);
  }
});

// remove one scan (Undo)
app.delete('/api/scans', async (req, res) => {
  const c = cleanContainer(req.body.containerNumber);
  const k = clean(req.body.cartonId);
  const err = validate(c, k);
  if (err) return bad(res, err);
  try {
    const r = await query(
      'DELETE FROM dbo.ContainerCartonScan WHERE ContainerNumber = @c AND CartonId = @k;', { c, k });
    res.json({ ok: true, deleted: (r.rowsAffected && r.rowsAffected[0]) || 0 });
  } catch (e) { fail(res, e); }
});

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.listen(PORT, '0.0.0.0', async () => {
  console.log('');
  console.log('Carton Scanner server is running');
  console.log(`  On this PC:        http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  On other devices:  http://${a.address}:${PORT}`);
    }
  }
  console.log('');
  try { await getPool(); }
  catch (e) {
    console.error('Could not connect to SQL Server yet:', e.message);
    console.error('The server will keep running and retry on the next scan.');
  }
});
