/* =====================================================================
   Database layer for PostgreSQL (pgAdmin) - same functions as db.js.
   Used when config.json has  "dbType": "postgres"
   ===================================================================== */
'use strict';

const { Pool, Client, types } = require('pg');

types.setTypeParser(20, v => parseInt(v, 10));      // COUNT(*) etc. come back as numbers
types.setTypeParser(1700, v => parseFloat(v));

let cfg, pool, dbChecked = false;

function conn(database) {
  return {
    host: cfg.pgHost || 'localhost',
    port: Number(cfg.pgPort || 5432),
    user: cfg.pgUser || 'postgres',
    password: cfg.pgPassword || '',
    database,
    connectionTimeoutMillis: 5000
  };
}
const dbName = () => cfg.pgDatabase || 'container_tracking';

// creates the database the first time (needs a login allowed to create databases)
async function ensureDatabase() {
  if (dbChecked) return;
  const c = new Client(conn('postgres'));
  try {
    await c.connect();
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName()]);
    if (!r.rowCount) {
      if (!/^[a-z_][a-z0-9_]*$/.test(dbName())) throw new Error('pgDatabase may only use lower-case letters, numbers and _');
      await c.query(`CREATE DATABASE ${dbName()} ENCODING 'UTF8'`);
      console.log(`Created PostgreSQL database ${dbName()}`);
    }
  } catch (e) {
    // no rights to look/create: fine if the database already exists, the next connect tells us
    if (!/permission denied/i.test(e.message) && !/does not exist/i.test(e.message)) throw e;
  } finally { await c.end().catch(() => {}); }
  dbChecked = true;
}

async function getPool() {
  if (!pool) {
    await ensureDatabase();
    const p = new Pool({ ...conn(dbName()), max: 10 });
    p.on('error', () => { pool = null; });
    await p.query('SELECT 1');
    console.log(`Connected to PostgreSQL ${cfg.pgHost || 'localhost'}:${cfg.pgPort || 5432} / ${dbName()} (user ${cfg.pgUser || 'postgres'})`);
    pool = p;
  }
  return pool;
}

async function q(text, params = []) {
  const p = await getPool();
  try { return await p.query(text, params); }
  catch (e) {
    if (/terminat|ECONNRESET|ECONNREFUSED/i.test(e.message)) pool = null;
    throw e;
  }
}
const rows = async (t, p) => (await q(t, p)).rows;
const one = async (t, p) => (await rows(t, p))[0] || null;

// ---------- schema ----------
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS container_carton_scan (
  id               BIGSERIAL PRIMARY KEY,
  container_number VARCHAR(20) NOT NULL,
  carton_id        VARCHAR(50) NOT NULL,
  scan_date_time   TIMESTAMP(0) NOT NULL DEFAULT LOCALTIMESTAMP(0),
  user_name        VARCHAR(50),
  CONSTRAINT uq_container_carton_scan UNIQUE (container_number, carton_id)
);
CREATE INDEX IF NOT EXISTS ix_container_carton_scan_time ON container_carton_scan (scan_date_time);
CREATE INDEX IF NOT EXISTS ix_container_carton_scan_user ON container_carton_scan (lower(user_name));

CREATE TABLE IF NOT EXISTS app_users (
  user_id              SERIAL PRIMARY KEY,
  user_name            VARCHAR(50)  NOT NULL,
  full_name            VARCHAR(100),
  role                 VARCHAR(20)  NOT NULL CHECK (role IN ('Admin', 'Supervisor', 'User')),
  password_hash        VARCHAR(200) NOT NULL,
  must_change_password BOOLEAN      NOT NULL DEFAULT TRUE,
  is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
  token_version        INT          NOT NULL DEFAULT 1,
  created_at           TIMESTAMP(0) NOT NULL DEFAULT LOCALTIMESTAMP(0),
  last_login_at        TIMESTAMP(0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_users_name ON app_users (lower(user_name));
`;
async function ensureSchema() { await q(SCHEMA_SQL); }

const TS = col => `to_char(${col}, 'YYYY-MM-DD HH24:MI:SS')`;

// ---------- users ----------
const USER_COLS = `user_id AS "UserId", user_name AS "UserName", full_name AS "FullName", role AS "Role",
  password_hash AS "PasswordHash", must_change_password AS "MustChangePassword", is_active AS "IsActive",
  token_version AS "TokenVersion", ${TS('created_at')} AS "CreatedAt", ${TS('last_login_at')} AS "LastLoginAt"`;

const userCount = async () => (await one('SELECT COUNT(*) AS n FROM app_users')).n;
const getUserById = id => one(`SELECT ${USER_COLS} FROM app_users WHERE user_id = $1`, [id]);
const getUserByName = n => one(`SELECT ${USER_COLS} FROM app_users WHERE lower(user_name) = lower($1)`, [n]);

const listUsers = () => rows(`
  SELECT u.user_id AS "UserId", u.user_name AS "UserName", u.full_name AS "FullName", u.role AS "Role",
         u.must_change_password AS "MustChangePassword", u.is_active AS "IsActive",
         ${TS('u.created_at')} AS "CreatedAt", ${TS('u.last_login_at')} AS "LastLoginAt",
         (SELECT COUNT(*) FROM container_carton_scan s WHERE lower(s.user_name) = lower(u.user_name)) AS "Scans"
  FROM app_users u
  ORDER BY u.is_active DESC, lower(u.user_name)`);

async function createUser({ userName, fullName, role, passwordHash, mustChange }) {
  const r = await one(`INSERT INTO app_users (user_name, full_name, role, password_hash, must_change_password)
                       VALUES ($1, NULLIF($2, ''), $3, $4, $5) RETURNING user_id AS "UserId"`,
    [userName, fullName || '', role, passwordHash, !!mustChange]);
  return r.UserId;
}

async function updateUser(id, f) {
  const sets = [], p = [];
  const add = (sqlText, v) => { p.push(v); sets.push(sqlText.replace('?', `$${p.length}`)); };
  if (f.fullName !== undefined) add(`full_name = NULLIF(?, '')`, f.fullName);
  if (f.role !== undefined) add('role = ?', f.role);
  if (f.isActive !== undefined) {
    add('is_active = ?', !!f.isActive);
    if (!f.isActive) sets.push('token_version = token_version + 1');
  }
  if (f.passwordHash !== undefined) {
    add('password_hash = ?', f.passwordHash);
    add('must_change_password = ?', !!f.mustChange);
    sets.push('token_version = token_version + 1');
  }
  if (!sets.length) return 0;
  p.push(id);
  return (await q(`UPDATE app_users SET ${sets.join(', ')} WHERE user_id = $${p.length}`, p)).rowCount;
}

const touchLogin = id => q('UPDATE app_users SET last_login_at = LOCALTIMESTAMP(0) WHERE user_id = $1', [id]);
const activeAdminCount = async () =>
  (await one(`SELECT COUNT(*) AS n FROM app_users WHERE role = 'Admin' AND is_active`)).n;

// ---------- scans ----------
const validStamp = t => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t || '') && !isNaN(Date.parse(t)) ? t : null);

async function insertScan({ containerNumber, cartonId, userName, scannedAt }) {
  const r = await q(`
    INSERT INTO container_carton_scan (container_number, carton_id, scan_date_time, user_name)
    VALUES ($1, $2, COALESCE($3::timestamp(0), LOCALTIMESTAMP(0)), NULLIF($4, ''))
    ON CONFLICT (container_number, carton_id) DO NOTHING`,
    [containerNumber, cartonId, validStamp(scannedAt), userName || '']);
  return r.rowCount > 0;
}

const SCAN_ROW = `id AS "Id", container_number AS "ContainerNumber", carton_id AS "CartonId", user_name AS "UserName"`;
const getScan = (c, k) => one(`SELECT ${SCAN_ROW} FROM container_carton_scan WHERE container_number = $1 AND carton_id = $2`, [c, k]);
const getScanById = id => one(`SELECT ${SCAN_ROW} FROM container_carton_scan WHERE id = $1`, [id]);
const deleteScanById = async id => (await q('DELETE FROM container_carton_scan WHERE id = $1', [id])).rowCount;

const containerCartons = c => rows(`
  SELECT carton_id AS "CartonId", to_char(scan_date_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS "ScanDateTime", user_name AS "UserName"
  FROM container_carton_scan WHERE container_number = $1 ORDER BY scan_date_time, id`, [c]);

// ---------- reports ----------
const escapeLike = s => s.replace(/[\\%_]/g, ch => '\\' + ch);

function buildFilter(f = {}) {
  const where = [], p = [];
  const add = (sqlText, v) => { p.push(v); where.push(sqlText.replace('?', `$${p.length}`)); };
  if (f.from) add('scan_date_time >= ?::date', f.from);
  if (f.to) add(`scan_date_time < (?::date + 1)`, f.to);
  if (f.container) add('container_number ILIKE ?', `%${escapeLike(f.container)}%`);
  if (f.carton) add('carton_id ILIKE ?', `%${escapeLike(f.carton)}%`);
  if (f.user) add('lower(user_name) = lower(?)', f.user);
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', p };
}

async function summary(f) {
  const { where, p } = buildFilter(f);
  const s = `WITH s AS (SELECT * FROM container_carton_scan ${where})`;
  const [totals, byDay, byUser, byContainer] = await Promise.all([
    one(`${s} SELECT COUNT(*) AS "Cartons", COUNT(DISTINCT container_number) AS "Containers",
                     COUNT(DISTINCT lower(user_name)) AS "Users",
                     ${TS('MIN(scan_date_time)')} AS "FirstScan", ${TS('MAX(scan_date_time)')} AS "LastScan" FROM s`, p),
    rows(`${s} SELECT to_char(d, 'YYYY-MM-DD') AS "Day", n AS "Cartons" FROM (
            SELECT scan_date_time::date AS d, COUNT(*) AS n FROM s GROUP BY 1 ORDER BY 1 DESC LIMIT 62) x ORDER BY d`, p),
    rows(`${s} SELECT COALESCE(user_name, '(none)') AS "Name", COUNT(*) AS "Cartons"
               FROM s GROUP BY user_name ORDER BY COUNT(*) DESC, user_name LIMIT 10`, p),
    rows(`${s} SELECT container_number AS "Name", COUNT(*) AS "Cartons"
               FROM s GROUP BY container_number ORDER BY COUNT(*) DESC, container_number LIMIT 10`, p)
  ]);
  return { totals, byDay, byUser, byContainer };
}

const SCAN_SORT = { time: 'scan_date_time', container: 'container_number', carton: 'carton_id', user: 'user_name' };
const CONTAINER_SORT = { last: '"LastScanTs"', first: '"FirstScanTs"', container: 'g.container_number', cartons: '"Cartons"' };
const orderBy = (map, sort, dir, fallback, tie) =>
  `ORDER BY ${map[sort] || map[fallback]} ${dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, ${tie}`;

async function scans(f, { page = 1, pageSize = 50, sort = 'time', dir = 'desc', limit } = {}) {
  const { where, p } = buildFilter(f);
  const lp = [...p, limit || pageSize, (page - 1) * pageSize];
  const [list, total] = await Promise.all([
    rows(`SELECT ${SCAN_ROW}, ${TS('scan_date_time')} AS "ScanDateTime"
          FROM container_carton_scan ${where}
          ${orderBy(SCAN_SORT, sort, dir, 'time', 'id DESC')}
          LIMIT $${lp.length - 1} OFFSET $${lp.length}`, lp),
    limit ? null : one(`SELECT COUNT(*) AS n FROM container_carton_scan ${where}`, p)
  ]);
  return { rows: list, total: total ? total.n : list.length };
}

async function containers(f, { page = 1, pageSize = 50, sort = 'last', dir = 'desc', limit } = {}) {
  const { where, p } = buildFilter(f);
  const lp = [...p, limit || pageSize, (page - 1) * pageSize];
  const list = await rows(`
    SELECT g.container_number AS "ContainerNumber", g."Cartons",
           ${TS('g."FirstScanTs"')} AS "FirstScan", ${TS('g."LastScanTs"')} AS "LastScan", g."Users"
    FROM (
      SELECT container_number, COUNT(*) AS "Cartons",
             MIN(scan_date_time) AS "FirstScanTs", MAX(scan_date_time) AS "LastScanTs",
             STRING_AGG(DISTINCT user_name, ', ' ORDER BY user_name) AS "Users"
      FROM container_carton_scan ${where}
      GROUP BY container_number
    ) g
    ${orderBy(CONTAINER_SORT, sort, dir, 'last', 'g.container_number')}
    LIMIT $${lp.length - 1} OFFSET $${lp.length}`, lp);
  const total = limit ? null : await one(`SELECT COUNT(DISTINCT container_number) AS n FROM container_carton_scan ${where}`, p);
  return { rows: list, total: total ? total.n : list.length };
}

const scanUserNames = () => rows(`
  SELECT DISTINCT user_name AS "UserName" FROM (
    SELECT user_name FROM container_carton_scan WHERE user_name IS NOT NULL
    UNION SELECT user_name FROM app_users) x
  ORDER BY 1`);

module.exports = {
  init(config) { cfg = config; },
  getPool, ensureSchema, ping: () => q('SELECT 1'),
  userCount, getUserById, getUserByName, listUsers, createUser, updateUser, touchLogin, activeAdminCount,
  insertScan, getScan, getScanById, deleteScanById, containerCartons,
  summary, scans, containers, scanUserNames
};
