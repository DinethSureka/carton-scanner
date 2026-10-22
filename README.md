# Trilogi Carton Scanner

Scan cartons into a container. Every scan is saved to SQL Server with the
**container number, carton ID, date & time and user**.

```
Phone / PC browser  ──►  server (this PC, port 3000)  ──►  SQL Server: ContainerTracking.dbo.ContainerCartonScan
```

## Quick start – nothing to install (PowerShell)

1. **Database** – in SSMS run `server/sql/setup.sql` (skip if `ContainerTracking` already exists).
2. Double-click **`server/start-server-powershell.bat`** and keep the window open.
3. Open **http://localhost:3000** in Chrome and scan.

This version uses PowerShell, which is built into Windows. It works on the PC that runs it
(`localhost`). To let phones on the network use it, use the Node.js version below.
Server name and database are at the top of `server/server.ps1`.

## Node.js version (also lets phones on the network connect)

1. **Database** – in SSMS run `server/sql/setup.sql` (skip if `ContainerTracking` already exists).
2. **Node.js** – install the LTS version from <https://nodejs.org>.
3. **Start the server** – double-click `server/start-server.bat`.
   The first run installs packages and creates `server/config.json`.
   The window shows the address to open, for example:
   ```
   On this PC:        http://localhost:3000
   On other devices:  http://192.168.1.25:3000
   ```
   Keep this window open while scanning.

The server logs in to SQL Server with your Windows account (the same as SSMS).
To use a SQL login instead, edit `server/config.json`:
`"auth": "sql", "sqlUser": "...", "sqlPassword": "..."`.

## Using it

1. Open the address shown by the server.
2. Enter **your name** (remembered next time) and the **container number**, then scan.
3. The badge under the counter shows the database status:
   * **All scans saved to database** – everything is stored.
   * **Saving… / Database offline · N waiting** – scans are kept on the device and saved automatically when the server is back. Don't clear the browser data while scans are waiting.
4. **Undo last** also removes the carton from the database.
5. Re-opening a container loads the cartons already saved, so the count continues and duplicates are still blocked.

The GitHub Pages version also works on the PC that runs the server (it saves to `http://localhost:3000`).
To point it at another address, tap **Server** at the bottom of the page.

### Camera scanning on phones
Browsers only allow the camera on `https` or `localhost`. When phones open the
server over `http://192.168.x.x:3000`, use a Bluetooth/USB barcode scanner, or in
Chrome on the phone open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
add the server address, and restart Chrome.

## Reports (SSMS)

```sql
USE ContainerTracking;

SELECT * FROM dbo.ContainerCartonScan ORDER BY ScanDateTime DESC;

SELECT ContainerNumber, COUNT(*) AS Cartons, MIN(ScanDateTime) AS FirstScan, MAX(ScanDateTime) AS LastScan
FROM dbo.ContainerCartonScan GROUP BY ContainerNumber ORDER BY LastScan DESC;
```

## API (used by the page)

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` when the database is reachable |
| GET | `/api/containers/{no}/cartons` | cartons already saved for a container |
| POST | `/api/scans` | `{ containerNumber, cartonId, userName, scannedAt }` |
| DELETE | `/api/scans` | `{ containerNumber, cartonId }` |
