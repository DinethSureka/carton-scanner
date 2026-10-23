# Trilogi Carton Scanner

Scan cartons into containers from handheld scanners. Every scan is saved to SQL Server with the
**container number, carton ID, date & time and the signed-in user**. Supervisors and admins get a
dashboard with filters, charts and Excel/CSV downloads.

```
Handheld scanner / PC browser  ──►  server (Node.js, port 3000)  ──►  SQL Server (SSMS)  or  PostgreSQL (pgAdmin)
```

## Roles

| | User | Supervisor | Admin |
|---|:-:|:-:|:-:|
| Scan cartons | ✓ | ✓ | ✓ |
| Dashboard, filters, downloads | own scans only | all data | all data |
| Delete a wrong scan (dashboard) | | ✓ | ✓ |
| Add users, change roles, reset passwords | | | ✓ |

## Setup (on the PC/desktop that runs the server)

Needs: **Node.js LTS**, plus **one** database: **SQL Server Express** (SSMS) *or* **PostgreSQL** (pgAdmin).

### Choosing the database
After the first start, `server/config.json` exists. Set `dbType`:

* **SQL Server** (default) – `"dbType": "sqlserver"`. Signs in with Windows (same as SSMS).
  Run `server/sql/setup.sql` in SSMS once (or let the server create the tables).
* **PostgreSQL** – `"dbType": "postgres"` and fill in the PostgreSQL login:
  ```json
  "dbType": "postgres",
  "pgHost": "localhost", "pgPort": 5432,
  "pgUser": "postgres", "pgPassword": "your password",
  "pgDatabase": "container_tracking"
  ```
  The server creates the `container_tracking` database and its tables automatically
  (tables `container_carton_scan` and `app_users`). Close and restart the server after editing.
  On a shared PostgreSQL, ask its owner for a separate login rather than using theirs.


1. **Database** – SQL Server: run `server/sql/setup.sql` in SSMS. PostgreSQL: nothing to do (see above).
2. **Start the server** – double-click `server/start-server.bat` (first run installs packages).
   The window shows the addresses:
   ```
   On this PC:              http://localhost:3000
   On the scanner / phone:  http://192.168.1.25:3000
   Dashboard:               http://localhost:3000/dashboard
   ```
3. **First admin** – on the very first start the window shows a one-time password for user **admin**
   (also saved in `server/FIRST-ADMIN-PASSWORD.txt`). Sign in, choose your own password
   (the file is then deleted), and add your team on the **Users** page.
4. **Firewall** – allow inbound **TCP 3000** on this PC so scanners on the Wi-Fi can connect.

The server signs in to SQL Server with the Windows account it runs under (same as SSMS).
For a SQL login instead, edit `server/config.json`: `"auth": "sql", "sqlUser": "...", "sqlPassword": "..."`.
`config.json` also holds `sessionSecret` – keep it private; changing it signs everyone out.

> If SQL Server was just started (e.g. after a reboot), wait 1–2 minutes before scanning.

## Using it

* **Scanner** – open the scanner address on the handheld, sign in, enter the container number, scan.
  The badge shows *All scans saved to database*; if the connection drops, scans wait on the device and
  are saved automatically. Re-opening a container continues its count and still blocks duplicates.
* **Dashboard** – `/dashboard`. Pick a period or dates, filter by container, carton ID or user.
  Click a bar, container or user to drill in. **Excel** downloads scans + container summary + the filters used;
  **CSV** downloads the table you are looking at.
* **Users** (admins) – `/users`. New users and password resets get a temporary password; the person
  chooses their own at first sign-in. Deactivating a user or resetting a password signs them out at once.

Security: passwords are stored hashed (scrypt); 5 wrong passwords lock the account for 5 minutes;
sessions last 12 hours.

### Camera scanning on phones
Browsers only allow the camera on `https` or `localhost`. Over `http://192.168.x.x:3000` use the
scanner's trigger, or in Chrome on the phone enable
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` for the server address.

## Reports in pgAdmin (PostgreSQL)

```sql
SELECT * FROM container_carton_scan ORDER BY scan_date_time DESC;

SELECT container_number, COUNT(*) AS cartons, MIN(scan_date_time) AS first_scan, MAX(scan_date_time) AS last_scan
FROM container_carton_scan GROUP BY container_number ORDER BY last_scan DESC;
```

## Reports in SSMS (SQL Server)

```sql
USE ContainerTracking;

SELECT * FROM dbo.ContainerCartonScan ORDER BY ScanDateTime DESC;

SELECT ContainerNumber, COUNT(*) AS Cartons, MIN(ScanDateTime) AS FirstScan, MAX(ScanDateTime) AS LastScan
FROM dbo.ContainerCartonScan GROUP BY ContainerNumber ORDER BY LastScan DESC;

SELECT UserName, FullName, Role, IsActive, LastLoginAt FROM dbo.AppUsers;
```

## Files

| Path | What |
|---|---|
| `index.html` | Scanner page |
| `login.html`, `dashboard.html`, `users.html` | Sign-in, dashboard, user admin |
| `assets/` | Shared styles, scripts, logo |
| `server/server.js` | Web server and API |
| `server/db.js` | All SQL Server queries |
| `server/db-pg.js` | All PostgreSQL queries |
| `server/auth.js` | Passwords, sessions, roles |
| `server/sql/setup.sql` | Database setup |
