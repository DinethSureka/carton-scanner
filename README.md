# Trilogi Carton Scanner

Scan cartons into containers from handheld scanners. Every scan is saved to SQL Server with the
**container number, carton ID, date & time and the signed-in user**. Supervisors and admins get a
dashboard with filters, charts and Excel/CSV downloads.

```
Handheld scanner / PC browser  ──►  server (Node.js, port 3000)  ──►  SQL Server: ContainerTracking
```

## Roles

| | User | Supervisor | Admin |
|---|:-:|:-:|:-:|
| Scan cartons | ✓ | ✓ | ✓ |
| Undo own last scan | ✓ | ✓ | ✓ |
| Dashboard, filters, downloads | own scans only | all data | all data |
| Delete any scan | | ✓ | ✓ |
| Add users, change roles, reset passwords | | | ✓ |

## Setup (on the PC/desktop that runs the server)

Needs: **SQL Server Express** (with SSMS) and **Node.js LTS** – installed by IT.

1. **Database** – in SSMS run `server/sql/setup.sql` (creates `ContainerTracking`, the scan table and the users table).
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

## Reports in SSMS

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
| `server/db.js` | All SQL queries |
| `server/auth.js` | Passwords, sessions, roles |
| `server/sql/setup.sql` | Database setup |
