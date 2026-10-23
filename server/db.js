/* =====================================================================
   Database layer - every SQL statement the app runs lives in this file.
   SQL Server: <cfg.server> / <cfg.database>
   ===================================================================== */
'use strict';

let sql;           // mssql module in use
let poolPromise;   // cached connection pool
let cfg;

// ---------- connection ----------
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
      .then(pool => { pool.on('error', () => { poolPromise = null; }); return pool; })
      .catch(err => { poolPromise = null; throw err; });
  }
  return poolPromise;
}

/* params: { name: value } or { name: [type, value] } where type is 'int' | 'date' | 'text' | 'bit' */
async function q(text, params = {}) {
  const pool = await getPool();
  const req = pool.request();
  for (const [name, raw] of Object.entries(params)) {
    const [type, value] = Array.isArray(raw) ? raw : ['text', raw];
    const t = type === 'int' ? sql.Int
      : type === 'bigint' ? sql.BigInt
      : type === 'date' ? sql.Date
      : type === 'bit' ? sql.Bit
      : type === 'longtext' ? sql.NVarChar(sql.MAX)
      : sql.NVarChar(200);
    req.input(name, t, value);
  }
  return req.query(text);
}
const rows = async (text, params) => (await q(text, params)).recordset || [];
const one = async (text, params) => (await rows(text, params))[0] || null;
const affected = r => (r.rowsAffected && r.rowsAffected.reduce((a, b) => a + b, 0)) || 0;

// ---------- schema (created automatically if missing) ----------
const SCHEMA_SQL = `
IF OBJECT_ID(N'dbo.ContainerCartonScan', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.ContainerCartonScan
    (
        Id              BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ContainerNumber NVARCHAR(20)  NOT NULL,
        CartonId        NVARCHAR(50)  NOT NULL,
        ScanDateTime    DATETIME2(0)  NOT NULL CONSTRAINT DF_ContainerCartonScan_ScanDateTime DEFAULT (SYSDATETIME()),
        UserName        NVARCHAR(50)  NULL,
        CONSTRAINT UQ_ContainerCartonScan UNIQUE (ContainerNumber, CartonId)
    );
    CREATE INDEX IX_ContainerCartonScan_Container ON dbo.ContainerCartonScan (ContainerNumber);
    CREATE INDEX IX_ContainerCartonScan_DateTime  ON dbo.ContainerCartonScan (ScanDateTime);
END;

IF OBJECT_ID(N'dbo.AppUsers', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AppUsers
    (
        UserId             INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AppUsers PRIMARY KEY,
        UserName           NVARCHAR(50)  NOT NULL CONSTRAINT UQ_AppUsers_UserName UNIQUE,
        FullName           NVARCHAR(100) NULL,
        Role               NVARCHAR(20)  NOT NULL CONSTRAINT CK_AppUsers_Role CHECK (Role IN (N'Admin', N'Supervisor', N'User')),
        PasswordHash       NVARCHAR(200) NOT NULL,
        MustChangePassword BIT           NOT NULL CONSTRAINT DF_AppUsers_MustChange DEFAULT (1),
        IsActive           BIT           NOT NULL CONSTRAINT DF_AppUsers_IsActive DEFAULT (1),
        TokenVersion       INT           NOT NULL CONSTRAINT DF_AppUsers_TokenVersion DEFAULT (1),
        CreatedAt          DATETIME2(0)  NOT NULL CONSTRAINT DF_AppUsers_CreatedAt DEFAULT (SYSDATETIME()),
        LastLoginAt        DATETIME2(0)  NULL
    );
END;
`;

async function ensureSchema() { await q(SCHEMA_SQL); }

// ---------- users ----------
const USER_COLS = `UserId, UserName, FullName, Role, PasswordHash, MustChangePassword, IsActive, TokenVersion,
                   CONVERT(varchar(19), CreatedAt, 120) AS CreatedAt,
                   CONVERT(varchar(19), LastLoginAt, 120) AS LastLoginAt`;

const userCount = async () => (await one('SELECT COUNT(*) AS n FROM dbo.AppUsers;')).n;
const getUserById = id => one(`SELECT ${USER_COLS} FROM dbo.AppUsers WHERE UserId = @id;`, { id: ['int', id] });
const getUserByName = name => one(`SELECT ${USER_COLS} FROM dbo.AppUsers WHERE UserName = @n;`, { n: name });

function listUsers() {
  return rows(`
    SELECT u.UserId, u.UserName, u.FullName, u.Role, u.MustChangePassword, u.IsActive,
           CONVERT(varchar(19), u.CreatedAt, 120)   AS CreatedAt,
           CONVERT(varchar(19), u.LastLoginAt, 120) AS LastLoginAt,
           (SELECT COUNT(*) FROM dbo.ContainerCartonScan s WHERE s.UserName = u.UserName) AS Scans
    FROM dbo.AppUsers u
    ORDER BY u.IsActive DESC, u.UserName;`);
}

async function createUser({ userName, fullName, role, passwordHash, mustChange }) {
  const r = await one(`
    INSERT INTO dbo.AppUsers (UserName, FullName, Role, PasswordHash, MustChangePassword)
    OUTPUT INSERTED.UserId
    VALUES (@u, NULLIF(@f, ''), @r, @p, @m);`,
    { u: userName, f: fullName || '', r: role, p: passwordHash, m: ['bit', mustChange ? 1 : 0] });
  return r.UserId;
}

/* fields: fullName, role, isActive (bool), passwordHash + mustChange */
async function updateUser(id, fields) {
  const sets = [];
  const p = { id: ['int', id] };
  if (fields.fullName !== undefined) { sets.push(`FullName = NULLIF(@f, '')`); p.f = fields.fullName; }
  if (fields.role !== undefined) { sets.push('Role = @r'); p.r = fields.role; }
  if (fields.isActive !== undefined) {
    sets.push('IsActive = @a');
    p.a = ['bit', fields.isActive ? 1 : 0];
    if (!fields.isActive) sets.push('TokenVersion = TokenVersion + 1');   // signs the user out
  }
  if (fields.passwordHash !== undefined) {
    sets.push('PasswordHash = @p', 'MustChangePassword = @m', 'TokenVersion = TokenVersion + 1');
    p.p = fields.passwordHash;
    p.m = ['bit', fields.mustChange ? 1 : 0];
  }
  if (!sets.length) return 0;
  return affected(await q(`UPDATE dbo.AppUsers SET ${sets.join(', ')} WHERE UserId = @id;`, p));
}

const touchLogin = id => q('UPDATE dbo.AppUsers SET LastLoginAt = SYSDATETIME() WHERE UserId = @id;', { id: ['int', id] });
const activeAdminCount = async () =>
  (await one(`SELECT COUNT(*) AS n FROM dbo.AppUsers WHERE Role = N'Admin' AND IsActive = 1;`)).n;

// ---------- scans ----------
async function insertScan({ containerNumber, cartonId, userName, scannedAt }) {
  const r = await q(`
    INSERT INTO dbo.ContainerCartonScan (ContainerNumber, CartonId, ScanDateTime, UserName)
    SELECT @c, @k, ISNULL(TRY_CONVERT(datetime2(0), NULLIF(@t, ''), 126), SYSDATETIME()), NULLIF(@u, '')
    WHERE NOT EXISTS (SELECT 1 FROM dbo.ContainerCartonScan WITH (UPDLOCK, HOLDLOCK)
                      WHERE ContainerNumber = @c AND CartonId = @k);`,
    { c: containerNumber, k: cartonId, u: userName || '', t: scannedAt || '' });
  return affected(r) > 0;
}

const getScan = (containerNumber, cartonId) => one(`
    SELECT Id, ContainerNumber, CartonId, UserName FROM dbo.ContainerCartonScan
    WHERE ContainerNumber = @c AND CartonId = @k;`, { c: containerNumber, k: cartonId });

const getScanById = id => one(`
    SELECT Id, ContainerNumber, CartonId, UserName FROM dbo.ContainerCartonScan WHERE Id = @id;`,
  { id: ['bigint', id] });

async function deleteScanById(id) {
  return affected(await q('DELETE FROM dbo.ContainerCartonScan WHERE Id = @id;', { id: ['bigint', id] }));
}

const containerCartons = c => rows(`
    SELECT CartonId, CONVERT(varchar(19), ScanDateTime, 126) AS ScanDateTime, UserName
    FROM dbo.ContainerCartonScan
    WHERE ContainerNumber = @c
    ORDER BY ScanDateTime, Id;`, { c });

// ---------- reports ----------
const escapeLike = s => s.replace(/[[\]%_]/g, ch => `[${ch}]`);

/* f: { from, to (yyyy-mm-dd), container, carton, user } -> WHERE clause + params */
function buildFilter(f = {}) {
  const where = [];
  const p = {};
  if (f.from) { where.push('ScanDateTime >= @from'); p.from = ['date', f.from]; }
  if (f.to) { where.push('ScanDateTime < DATEADD(day, 1, CAST(@to AS datetime2(0)))'); p.to = ['date', f.to]; }
  if (f.container) { where.push('ContainerNumber LIKE @container'); p.container = `%${escapeLike(f.container)}%`; }
  if (f.carton) { where.push('CartonId LIKE @carton'); p.carton = `%${escapeLike(f.carton)}%`; }
  if (f.user) { where.push('UserName = @user'); p.user = f.user; }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', p };
}

async function summary(f) {
  const { where, p } = buildFilter(f);
  const base = `SELECT * FROM dbo.ContainerCartonScan ${where}`;
  const [totals, byDay, byUser, byContainer] = await Promise.all([
    one(`WITH s AS (${base})
         SELECT COUNT(*) AS Cartons,
                COUNT(DISTINCT ContainerNumber) AS Containers,
                COUNT(DISTINCT UserName) AS Users,
                CONVERT(varchar(19), MIN(ScanDateTime), 120) AS FirstScan,
                CONVERT(varchar(19), MAX(ScanDateTime), 120) AS LastScan
         FROM s;`, p),
    rows(`WITH s AS (${base})
          SELECT TOP (62) CONVERT(varchar(10), CAST(ScanDateTime AS date), 23) AS Day, COUNT(*) AS Cartons
          FROM s GROUP BY CAST(ScanDateTime AS date)
          ORDER BY CAST(ScanDateTime AS date) DESC;`, p),
    rows(`WITH s AS (${base})
          SELECT TOP (10) ISNULL(UserName, N'(none)') AS Name, COUNT(*) AS Cartons
          FROM s GROUP BY UserName ORDER BY COUNT(*) DESC, UserName;`, p),
    rows(`WITH s AS (${base})
          SELECT TOP (10) ContainerNumber AS Name, COUNT(*) AS Cartons
          FROM s GROUP BY ContainerNumber ORDER BY COUNT(*) DESC, ContainerNumber;`, p)
  ]);
  return { totals, byDay: byDay.reverse(), byUser, byContainer };
}

const SCAN_SORT = { time: 'ScanDateTime', container: 'ContainerNumber', carton: 'CartonId', user: 'UserName' };
const CONTAINER_SORT = { last: 'LastScan', first: 'FirstScan', container: 'ContainerNumber', cartons: 'Cartons' };

function orderBy(map, sort, dir, fallback, tie) {
  const col = map[sort] || map[fallback];
  return `ORDER BY ${col} ${dir === 'asc' ? 'ASC' : 'DESC'}, ${tie}`;
}

async function scans(f, { page = 1, pageSize = 50, sort = 'time', dir = 'desc', limit } = {}) {
  const { where, p } = buildFilter(f);
  p.off = ['int', (page - 1) * pageSize];
  p.ps = ['int', limit || pageSize];
  const order = orderBy(SCAN_SORT, sort, dir, 'time', 'Id DESC');
  const [list, total] = await Promise.all([
    rows(`SELECT Id, ContainerNumber, CartonId,
                 CONVERT(varchar(19), ScanDateTime, 120) AS ScanDateTime, UserName
          FROM dbo.ContainerCartonScan ${where}
          ${order}
          OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY;`, p),
    limit ? Promise.resolve(null) : one(`SELECT COUNT(*) AS n FROM dbo.ContainerCartonScan ${where};`, p)
  ]);
  return { rows: list, total: total ? total.n : list.length };
}

async function containers(f, { page = 1, pageSize = 50, sort = 'last', dir = 'desc', limit } = {}) {
  const { where, p } = buildFilter(f);
  p.off = ['int', (page - 1) * pageSize];
  p.ps = ['int', limit || pageSize];
  const order = orderBy(CONTAINER_SORT, sort, dir, 'last', 'ContainerNumber');
  const list = await rows(`
    WITH s AS (SELECT * FROM dbo.ContainerCartonScan ${where}),
    g AS (
      SELECT ContainerNumber, COUNT(*) AS Cartons, MIN(ScanDateTime) AS FirstScan, MAX(ScanDateTime) AS LastScan
      FROM s GROUP BY ContainerNumber
    ),
    u AS (SELECT DISTINCT ContainerNumber, UserName FROM s WHERE UserName IS NOT NULL),
    ul AS (
      SELECT ContainerNumber, STRING_AGG(UserName, N', ') WITHIN GROUP (ORDER BY UserName) AS Users
      FROM u GROUP BY ContainerNumber
    )
    SELECT g.ContainerNumber, g.Cartons,
           CONVERT(varchar(19), g.FirstScan, 120) AS FirstScan,
           CONVERT(varchar(19), g.LastScan, 120)  AS LastScan,
           ul.Users
    FROM g LEFT JOIN ul ON ul.ContainerNumber = g.ContainerNumber
    ${order}
    OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY;`, p);
  const total = limit ? null : await one(`SELECT COUNT(DISTINCT ContainerNumber) AS n FROM dbo.ContainerCartonScan ${where};`, p);
  return { rows: list, total: total ? total.n : list.length };
}

const scanUserNames = () => rows(`
    SELECT DISTINCT UserName FROM dbo.ContainerCartonScan WHERE UserName IS NOT NULL
    UNION
    SELECT UserName FROM dbo.AppUsers
    ORDER BY UserName;`);

module.exports = {
  init(config) { cfg = config; },
  getPool, ensureSchema, ping: () => q('SELECT 1 AS ok;'),
  userCount, getUserById, getUserByName, listUsers, createUser, updateUser, touchLogin, activeAdminCount,
  insertScan, getScan, getScanById, deleteScanById, containerCartons,
  summary, scans, containers, scanUserNames,
  _sql: { SCHEMA_SQL, buildFilter }
};
