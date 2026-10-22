<#  =====================================================================
    Carton Scanner - local server (PowerShell version, nothing to install)
    Saves every scan into SQL Server: ContainerTracking.dbo.ContainerCartonScan
    and serves the scanner page at http://localhost:3000

    Start: double-click start-server-powershell.bat
    Stop : close the window
    ===================================================================== #>

$Port     = 3000
$Server   = 'localhost\SQLEXPRESS'
$Database = 'ContainerTracking'

# Same Windows login you use in SSMS. For a SQL login use instead:
#   "Server=$Server;Database=$Database;User ID=myuser;Password=mypassword;"
$ConnStr  = "Server=$Server;Database=$Database;Integrated Security=True;Connect Timeout=5;"

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web -ErrorAction SilentlyContinue
$PagePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'index.html'
$Utf8     = New-Object System.Text.UTF8Encoding($false)

# ---------- database ----------
function Invoke-Sql([string]$Sql, [hashtable]$Params, [switch]$Rows) {
    $conn = New-Object System.Data.SqlClient.SqlConnection $ConnStr
    try {
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $Sql
        if ($Params) {
            foreach ($k in $Params.Keys) {
                $p = $cmd.Parameters.Add("@$k", [System.Data.SqlDbType]::NVarChar, 100)
                $p.Value = [string]$Params[$k]
            }
        }
        if ($Rows) {
            $list = New-Object System.Collections.ArrayList
            $r = $cmd.ExecuteReader()
            while ($r.Read()) {
                $o = [ordered]@{}
                for ($i = 0; $i -lt $r.FieldCount; $i++) {
                    $v = $r.GetValue($i)
                    if ($v -is [System.DBNull]) { $v = $null }
                    $o[$r.GetName($i)] = $v
                }
                [void]$list.Add($o)
            }
            $r.Close()
            return ,$list
        }
        return $cmd.ExecuteNonQuery()
    } finally { $conn.Dispose() }
}

# ---------- http helpers ----------
function Send($ctx, [int]$Status, $Body, [string]$Type = 'application/json; charset=utf-8') {
    $res = $ctx.Response
    $res.StatusCode = $Status
    $res.Headers['Access-Control-Allow-Origin']  = '*'
    $res.Headers['Access-Control-Allow-Methods'] = 'GET,POST,DELETE,OPTIONS'
    $res.Headers['Access-Control-Allow-Headers'] = 'Content-Type'
    if ($ctx.Request.Headers['Access-Control-Request-Private-Network']) {
        $res.Headers['Access-Control-Allow-Private-Network'] = 'true'
    }
    if ($null -ne $Body) {
        if ($Body -is [byte[]]) { $bytes = $Body }
        elseif ($Body -is [string]) { $bytes = $Utf8.GetBytes($Body) }
        else { $bytes = $Utf8.GetBytes((ConvertTo-Json -InputObject $Body -Depth 5 -Compress)) }
        $res.ContentType = $Type
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    $res.Close()
}

function Read-Json($ctx) {
    $sr = New-Object System.IO.StreamReader($ctx.Request.InputStream, $Utf8)
    $text = $sr.ReadToEnd()
    $sr.Close()
    if ([string]::IsNullOrWhiteSpace($text)) { return New-Object PSObject }
    return ConvertFrom-Json $text
}

function Clean($v) { if ($null -eq $v) { return '' } return ([string]$v).Trim() }

function Test-Input([string]$c, [string]$k, [string]$u) {
    if (-not $c) { return 'Container number is required' }
    if (-not $k) { return 'Carton ID is required' }
    if ($c.Length -gt 20) { return 'Container number is longer than 20 characters' }
    if ($k.Length -gt 50) { return 'Carton ID is longer than 50 characters' }
    if ($u -and $u.Length -gt 50) { return 'User name is longer than 50 characters' }
    return $null
}

function Db-Error($ctx, $err) {
    $msg = $err.Exception.Message
    Write-Host ("  DB error: " + $msg) -ForegroundColor Red
    Send $ctx 503 @{ ok = $false; error = "Database error: $msg" }
}

# ---------- request handler ----------
function Handle($ctx) {
    $req    = $ctx.Request
    $method = $req.HttpMethod
    $path   = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)

    if ($method -eq 'OPTIONS') { Send $ctx 204 $null; return }

    if ($method -eq 'GET' -and ($path -eq '/' -or $path -eq '/index.html')) {
        if (-not (Test-Path $PagePath)) { Send $ctx 404 'index.html not found next to the server folder' 'text/plain'; return }
        Send $ctx 200 ([System.IO.File]::ReadAllBytes($PagePath)) 'text/html; charset=utf-8'
        return
    }

    if ($method -eq 'GET' -and $path -eq '/api/health') {
        try { [void](Invoke-Sql 'SELECT 1' @{}); Send $ctx 200 @{ ok = $true; database = $Database } }
        catch { Db-Error $ctx $_ }
        return
    }

    if ($method -eq 'GET' -and $path -match '^/api/containers/(.+)/cartons$') {
        $c = (Clean $Matches[1]).ToUpper()
        try {
            $rows = Invoke-Sql @"
SELECT CartonId, CONVERT(varchar(19), ScanDateTime, 126) AS ScanDateTime, UserName
FROM dbo.ContainerCartonScan
WHERE ContainerNumber = @c
ORDER BY ScanDateTime, Id;
"@ @{ c = $c } -Rows
            Send $ctx 200 @{ ok = $true; containerNumber = $c; count = $rows.Count; cartons = @($rows) }
        } catch { Db-Error $ctx $_ }
        return
    }

    if ($path -eq '/api/scans' -and ($method -eq 'POST' -or $method -eq 'DELETE')) {
        try { $b = Read-Json $ctx } catch { Send $ctx 400 @{ ok = $false; error = 'Invalid JSON' }; return }
        $c = (Clean $b.containerNumber).ToUpper()
        $k = Clean $b.cartonId
        $u = Clean $b.userName
        $t = Clean $b.scannedAt
        $bad = Test-Input $c $k $u
        if ($bad) { Send $ctx 400 @{ ok = $false; error = $bad }; return }

        if ($method -eq 'POST') {
            try {
                $n = Invoke-Sql @"
INSERT INTO dbo.ContainerCartonScan (ContainerNumber, CartonId, ScanDateTime, UserName)
SELECT @c, @k, ISNULL(TRY_CONVERT(datetime2(0), NULLIF(@t, ''), 126), SYSDATETIME()), NULLIF(@u, '')
WHERE NOT EXISTS (SELECT 1 FROM dbo.ContainerCartonScan WITH (UPDLOCK, HOLDLOCK)
                  WHERE ContainerNumber = @c AND CartonId = @k);
"@ @{ c = $c; k = $k; u = $u; t = $t }
                $saved = ($n -gt 0)
                if ($saved) { Write-Host ("  saved   {0}  {1}  {2}" -f $c, $k, $u) }
                $status = 200; if ($saved) { $status = 201 }
                Send $ctx $status @{ ok = $true; saved = $saved; duplicate = (-not $saved) }
            } catch {
                if ($_.Exception.Message -match 'duplicate key|UNIQUE KEY') {
                    Send $ctx 200 @{ ok = $true; saved = $false; duplicate = $true }
                } else { Db-Error $ctx $_ }
            }
        } else {
            try {
                $n = Invoke-Sql 'DELETE FROM dbo.ContainerCartonScan WHERE ContainerNumber = @c AND CartonId = @k;' @{ c = $c; k = $k }
                Write-Host ("  removed {0}  {1}" -f $c, $k) -ForegroundColor Yellow
                Send $ctx 200 @{ ok = $true; deleted = $n }
            } catch { Db-Error $ctx $_ }
        }
        return
    }

    Send $ctx 404 @{ ok = $false; error = 'Not found' }
}

# ---------- start ----------
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() }
catch {
    Write-Host "Could not start on port $Port. Is the server already open in another window?" -ForegroundColor Red
    Write-Host $_.Exception.Message
    return
}

Write-Host ''
Write-Host 'Carton Scanner server is running' -ForegroundColor Green
Write-Host "  Open in Chrome:  http://localhost:$Port"
Write-Host '  Keep this window open while scanning. Close it to stop.'
Write-Host ''
try {
    [void](Invoke-Sql 'SELECT 1' @{})
    Write-Host "Connected to $Server / $Database" -ForegroundColor Green
} catch {
    Write-Host "Could not connect to SQL Server yet: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'The server keeps running and will try again on the next scan.'
}
Write-Host ''

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try { Handle $ctx }
    catch {
        Write-Host ("  Error: " + $_.Exception.Message) -ForegroundColor Red
        try { Send $ctx 500 @{ ok = $false; error = $_.Exception.Message } } catch {}
    }
}
