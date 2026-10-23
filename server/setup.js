/* =====================================================================
   Carton Scanner - first-time setup (run by SETUP.bat)
   - PostgreSQL: creates login "carton_app" + database "container_tracking"
     using the PostgreSQL admin password typed here (never saved)
   - SQL Server: just records the server name (Windows login is used)
   Writes server/config.json. Safe to run again.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const CONFIG_FILE = process.env.CS_CONFIG || path.join(__dirname, 'config.json');
const APP_ROLE = 'carton_app';
const APP_DB = 'container_tracking';

// answers can be given as environment variables for unattended runs
const preset = {
  db: process.env.CS_SETUP_DB, host: process.env.CS_SETUP_HOST, port: process.env.CS_SETUP_PORT,
  adminUser: process.env.CS_SETUP_ADMIN_USER, adminPassword: process.env.CS_SETUP_ADMIN_PASSWORD,
  sqlServer: process.env.CS_SETUP_SQLSERVER, appPort: process.env.CS_SETUP_APP_PORT
};

let rl, closed = false, muted = false;
const queue = [], waiters = [];
function startInput() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const orig = rl._writeToOutput.bind(rl);
  rl._writeToOutput = s => { if (!muted) orig(s); };          // hide what is typed for passwords
  rl.on('line', l => (waiters.length ? waiters.shift()(l) : queue.push(l)));
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(''); });
}
function nextLine() {
  if (queue.length) return Promise.resolve(queue.shift());
  if (closed) return Promise.resolve('');
  return new Promise(r => waiters.push(r));
}
async function ask(question, def = '') {
  process.stdout.write(def ? `${question} [${def}]: ` : `${question}: `);
  const a = (await nextLine()).trim();
  if (!process.stdin.isTTY) process.stdout.write('\n');
  return a || def;
}
async function askHidden(question) {
  process.stdout.write(`${question}: `);
  muted = true;
  const a = await nextLine();
  muted = false;
  process.stdout.write('\n');
  return a;
}
const line = () => console.log('-'.repeat(62));
const randomPassword = () => crypto.randomBytes(18).toString('base64url');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

async function setupPostgres(cfg) {
  const { Client } = require('pg');
  console.log('\nPostgreSQL details (press Enter to accept the value in [brackets])');
  const host = preset.host || await ask('  Server', cfg.pgHost || 'localhost');
  const port = Number(preset.port || await ask('  Port', String(cfg.pgPort || 5432)));
  const adminUser = preset.adminUser || await ask('  Admin user (the one used in pgAdmin)', 'postgres');

  for (let attempt = 1; attempt <= 3; attempt++) {
    const adminPassword = preset.adminPassword !== undefined ? preset.adminPassword
      : await askHidden(`  Password for ${adminUser} (not saved)`);
    const admin = new Client({ host, port, user: adminUser, password: adminPassword, database: 'postgres', connectionTimeoutMillis: 8000 });
    try {
      await admin.connect();
    } catch (e) {
      console.log(`\n  Could not sign in: ${e.message}`);
      if (preset.adminPassword !== undefined || attempt === 3) throw new Error('PostgreSQL sign-in failed');
      console.log('  Please try again.\n');
      continue;
    }
    try {
      const appPassword = randomPassword();
      const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
      if (role.rowCount) {
        await admin.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${admin.escapeLiteral(appPassword)}`);
        console.log(`  Login "${APP_ROLE}" already existed - gave it a new password.`);
      } else {
        await admin.query(`CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${admin.escapeLiteral(appPassword)}`);
        console.log(`  Created login "${APP_ROLE}".`);
      }
      const db = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [APP_DB]);
      if (db.rowCount) {
        await admin.query(`ALTER DATABASE ${APP_DB} OWNER TO ${APP_ROLE}`);
        console.log(`  Database "${APP_DB}" already existed - kept its data.`);
      } else {
        await admin.query(`CREATE DATABASE ${APP_DB} OWNER ${APP_ROLE} ENCODING 'UTF8'`);
        console.log(`  Created database "${APP_DB}".`);
      }
      Object.assign(cfg, { dbType: 'postgres', pgHost: host, pgPort: port, pgUser: APP_ROLE, pgPassword: appPassword, pgDatabase: APP_DB });
    } finally { await admin.end().catch(() => {}); }

    // check the app login works and hand existing tables to it
    const app = new Client({ host, port, user: APP_ROLE, password: cfg.pgPassword, database: APP_DB, connectionTimeoutMillis: 8000 });
    await app.connect();
    await app.end();
    console.log(`  Checked: the app can sign in to "${APP_DB}".`);
    return;
  }
}

async function setupSqlServer(cfg) {
  console.log('\nSQL Server details (press Enter to accept the value in [brackets])');
  const server = preset.sqlServer || await ask('  Server name, as shown in SSMS', cfg.server || 'localhost\\SQLEXPRESS');
  Object.assign(cfg, { dbType: 'sqlserver', server, database: cfg.database || 'ContainerTracking', auth: cfg.auth || 'windows' });
  console.log('  The app will sign in with this Windows account, the same way SSMS does.');
}

(async () => {
  startInput();
  console.log('');
  line();
  console.log('  Carton Scanner - setup');
  line();
  const cfg = { port: 3000, ...readConfig() };

  let choice = (preset.db || '').toLowerCase();
  if (!choice) {
    console.log('\nWhich database should the scans be saved in?');
    console.log('  1  PostgreSQL  (pgAdmin)');
    console.log('  2  SQL Server  (SSMS)');
    choice = await ask('Choose 1 or 2', cfg.dbType === 'sqlserver' ? '2' : '1');
  }
  if (choice === '2' || choice.startsWith('sql')) await setupSqlServer(cfg);
  else await setupPostgres(cfg);

  cfg.port = Number(preset.appPort || cfg.port || 3000);
  writeConfig(cfg);
  console.log('');
  line();
  console.log('  Setup finished. Settings saved in server\\config.json');
  console.log('  From now on just double-click START.bat');
  line();
  rl.close();
})().catch(err => {
  console.log('');
  console.log('  Setup could not finish: ' + (err && err.message ? err.message : err));
  console.log('  Settings were not saved. Fix the problem and run SETUP.bat again.');
  if (rl) rl.close();
  process.exitCode = 1;
});
