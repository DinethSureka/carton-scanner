<#  =====================================================================
    Carton Scanner - local server (PowerShell version, nothing to install)
    Saves every scan into SQL Server: ContainerTracking.dbo.ContainerCartonScan
    and serves the scanner page on port 3000, to this PC and to handheld
    scanners / phones on the same network.

    Start: double-click start-server-powershell.bat
    (that .bat contains a copy of this script - run build-bat.py after editing)
    Stop : close the window
    ===================================================================== #>

$Port     = 3000
$Server   = 'localhost\SQLEXPRESS'
$Database = 'ContainerTracking'

# Same Windows login you use in SSMS. For a SQL login use instead:
#   "Server=$Server;Database=$Database;User ID=myuser;Password=mypassword;"
$ConnStr  = "Server=$Server;Database=$Database;Integrated Security=True;Connect Timeout=5;"

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
if ($env:CS_HERE) { $Here = $env:CS_HERE }      # set when started from the .bat file
$PagePath = Join-Path (Split-Path $Here -Parent) 'index.html'
$Utf8     = New-Object System.Text.UTF8Encoding($false)
$Ascii    = [System.Text.Encoding]::ASCII

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

# ---------- minimal HTTP over TCP (no admin rights needed) ----------
$StatusText = @{ 200 = 'OK'; 201 = 'Created'; 204 = 'No Content'; 400 = 'Bad Request';
                 404 = 'Not Found'; 500 = 'Internal Server Error'; 503 = 'Service Unavailable' }

function Read-Request($client) {
    $client.ReceiveTimeout = 10000
    $stream = $client.GetStream()
    $buf = New-Object byte[] 16384
    $ms  = New-Object System.IO.MemoryStream
    $headerEnd = -1
    while ($headerEnd -lt 0) {
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { return $null }
        $ms.Write($buf, 0, $n)
        if ($ms.Length -gt 1MB) { return $null }
        $headerEnd = $Ascii.GetString($ms.ToArray()).IndexOf("`r`n`r`n")
    }
    $all   = $ms.ToArray()
    $lines = $Ascii.GetString($all, 0, $headerEnd) -split "`r`n"
    $first = $lines[0] -split ' '
    if ($first.Count -lt 2) { return $null }
    $headers = @{}
    foreach ($l in $lines[1..($lines.Count - 1)]) {
        $i = $l.IndexOf(':')
        if ($i -gt 0) { $headers[$l.Substring(0, $i).Trim().ToLower()] = $l.Substring($i + 1).Trim() }
    }
    $len = 0
    if ($headers['content-length']) { $len = [int]$headers['content-length'] }
    if ($len -gt 1MB) { return $null }
    $bodyStart = $headerEnd + 4
    while (($all.Length - $bodyStart) -lt $len) {
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $ms.Write($buf, 0, $n)
        $all = $ms.ToArray()
    }
    $body = ''
    if ($len -gt 0) { $body = $Utf8.GetString($all, $bodyStart, [Math]::Min($len, $all.Length - $bodyStart)) }
    $target = $first[1]
    $q = $target.IndexOf('?')
    if ($q -ge 0) { $target = $target.Substring(0, $q) }
    return [pscustomobject]@{
        Method  = $first[0].ToUpper()
        Path    = [System.Uri]::UnescapeDataString($target)
        Headers = $headers
        Body    = $body
        Stream  = $stream
    }
}

function Send($ctx, [int]$Status, $Body, [string]$Type = 'application/json; charset=utf-8') {
    $bytes = New-Object byte[] 0
    if ($null -ne $Body) {
        if ($Body -is [byte[]]) { $bytes = $Body }
        elseif ($Body -is [string]) { $bytes = $Utf8.GetBytes($Body) }
        else { $bytes = $Utf8.GetBytes((ConvertTo-Json -InputObject $Body -Depth 5 -Compress)) }
    }
    $h = "HTTP/1.1 $Status $($StatusText[$Status])`r`n" +
         "Access-Control-Allow-Origin: *`r`n" +
         "Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS`r`n" +
         "Access-Control-Allow-Headers: Content-Type`r`n" +
         "Cache-Control: no-store`r`n" +
         "Connection: close`r`n" +
         "Content-Length: $($bytes.Length)`r`n"
    if ($ctx.Headers['access-control-request-private-network']) { $h += "Access-Control-Allow-Private-Network: true`r`n" }
    if ($bytes.Length -gt 0) { $h += "Content-Type: $Type`r`n" }
    $h += "`r`n"
    $hb = $Ascii.GetBytes($h)
    $ctx.Stream.Write($hb, 0, $hb.Length)
    if ($bytes.Length -gt 0) { $ctx.Stream.Write($bytes, 0, $bytes.Length) }
    $ctx.Stream.Flush()
}

function Read-Json($ctx) {
    if ([string]::IsNullOrWhiteSpace($ctx.Body)) { return New-Object PSObject }
    return ConvertFrom-Json $ctx.Body
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
    $method = $ctx.Method
    $path   = $ctx.Path

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
$listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Any), $Port
try { $listener.Start() }
catch {
    Write-Host "Could not start on port $Port. Is the server already open in another window?" -ForegroundColor Red
    Write-Host $_.Exception.Message
    return
}

$ips = @()
try {
    $ips = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
        Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not [System.Net.IPAddress]::IsLoopback($_) } |
        ForEach-Object { $_.ToString() }
} catch {}

Write-Host ''
Write-Host 'Carton Scanner server is running' -ForegroundColor Green
Write-Host "  On this PC:              http://localhost:$Port"
foreach ($ip in $ips) { Write-Host "  On the scanner / phone:  http://${ip}:$Port" -ForegroundColor Cyan }
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

# Browsers open spare connections they may never use, so only serve a
# connection once its request has arrived, and drop idle ones after 15s.
$waiting = New-Object System.Collections.ArrayList
while ($true) {
    while ($listener.Pending()) {
        [void]$waiting.Add(@{ client = $listener.AcceptTcpClient(); since = [DateTime]::UtcNow })
    }
    $busy = $false
    foreach ($w in @($waiting)) {
        $client = $w.client
        $ready = $false
        try { $ready = $client.Available -gt 0 } catch {}
        if ($ready) {
            $waiting.Remove($w)
            $busy = $true
            try {
                $ctx = Read-Request $client
                if ($ctx) {
                    try { Handle $ctx }
                    catch {
                        Write-Host ("  Error: " + $_.Exception.Message) -ForegroundColor Red
                        try { Send $ctx 500 @{ ok = $false; error = $_.Exception.Message } } catch {}
                    }
                }
            } catch {
                # client disconnected or timed out - ignore
            } finally { $client.Close() }
        } elseif (([DateTime]::UtcNow - $w.since).TotalSeconds -gt 15) {
            $waiting.Remove($w)
            $client.Close()
        }
    }
    if (-not $busy) { Start-Sleep -Milliseconds 15 }
}
