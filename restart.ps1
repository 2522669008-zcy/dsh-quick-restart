# restart.ps1 - close every process of the DSH desktop app, wait until they are gone,
# then start the app again. Created OUTSIDE the app's Windows job object by launch.ps1, so
# killing the app cannot take this script down with it.
#
# Budget (measured): ~1s standby + <=1.5s polite close + ~1.5s force + relaunch. The app
# itself then takes however long its own boot takes; nothing here waits on that.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, and a
# non-ASCII string literal would be mangled. Every message here is English for that
# reason; the log path is shared with index.js.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [int]$DelaySeconds = 1,
    # How long a polite close is given before forcing. Kept short on purpose: the measured
    # desktop app ignores WM_CLOSE entirely (20s of waiting, then it had to be killed
    # anyway), so every second here is pure latency. A process that does exit is noticed
    # by the poll loop, which leaves as soon as the count drops.
    [int]$GraceSeconds = 3,
    [int]$ForceSeconds = 15,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$logPath = Join-Path $env:TEMP 'dsh-desktop-restart.log'
$scriptStart = Get-Date

function Write-Log {
    param([string]$Message)
    $stamp = (Get-Date).ToString('HH:mm:ss.fff')
    $line = '{0} [ps1:{1}] {2}' -f $stamp, $PID, $Message
    try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch { }
}

function Get-TargetProcesses {
    param([string]$FullPath)
    $found = @()
    foreach ($candidate in @(Get-Process -ErrorAction SilentlyContinue)) {
        try {
            if ($candidate.Id -eq $PID) { continue }
            $candidatePath = $candidate.Path
            if ([string]::IsNullOrEmpty($candidatePath)) { continue }
            $resolved = [IO.Path]::GetFullPath($candidatePath)
            if ([string]::Equals($resolved, $FullPath, [StringComparison]::OrdinalIgnoreCase)) {
                $found += $candidate
            }
        } catch {
            # Protected or exiting processes throw on .Path; they are not our targets.
        }
    }
    return @($found)
}

function Format-Ids {
    param($Processes)
    if (@($Processes).Count -eq 0) { return '-' }
    return (@($Processes) | ForEach-Object { $_.Id }) -join ','
}

Write-Log "start exe='$ExePath' delay=$DelaySeconds grace=$GraceSeconds force=$ForceSeconds dry=$DryRun"

if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    Write-Log 'ERROR executable not found; aborting without killing anything'
    exit 2
}

$fullPath = [IO.Path]::GetFullPath($ExePath)
Write-Log "standby ${DelaySeconds}s so the caller can answer the HTTP request"
Start-Sleep -Seconds $DelaySeconds

$targets = Get-TargetProcesses -FullPath $fullPath
Write-Log ("found {0} matching process(es): {1}" -f @($targets).Count, (Format-Ids $targets))

if ($DryRun) {
    Write-Log 'dry run: would close them and relaunch; nothing killed'
    exit 0
}

# 1) Ask their windows to close first: a graceful quit lets Electron flush state.
$pollStarted = Get-Date
$requested = $false
foreach ($process in $targets) {
    try {
        if ($process.MainWindowHandle -ne 0) {
            $null = $process.CloseMainWindow()
            $requested = $true
            Write-Log "requested graceful close of pid $($process.Id)"
        }
    } catch {
        Write-Log "graceful close failed for pid $($process.Id): $($_.Exception.Message)"
    }
}

if ($requested) {
    $baseline = @($targets).Count
    $deadline = (Get-Date).AddSeconds($GraceSeconds)
    while ((Get-Date) -lt $deadline) {
        $left = Get-TargetProcesses -FullPath $fullPath
        if (@($left).Count -eq 0) { break }
        # The app ignored the close request: it is not going to quit on its own, so stop
        # paying for the grace window (1.5s is enough to see whether anything moved).
        if ((@($left).Count -eq $baseline) -and (((Get-Date) - $pollStarted).TotalMilliseconds -ge 1500)) {
            Write-Log 'the app ignored the close request; going straight to the force step'
            break
        }
        Start-Sleep -Milliseconds 250
    }
} else {
    # Nothing to ask politely (tray-only or console-only processes): do not burn the
    # whole grace window before forcing.
    Write-Log 'no window to close gracefully; going straight to the force step'
}

# 2) Whatever is still alive gets killed; a hung renderer must not block the restart.
$left = Get-TargetProcesses -FullPath $fullPath
if (@($left).Count -gt 0) {
    Write-Log ("forcing {0} process(es): {1}" -f @($left).Count, (Format-Ids $left))
    # One call for all ids: seven separate Stop-Process round trips cost more than the
    # whole rest of the sequence put together.
    $ids = @($left | ForEach-Object { $_.Id })
    try {
        Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Log "force kill reported: $($_.Exception.Message)"
    }
    $deadline = (Get-Date).AddSeconds($ForceSeconds)
    while ((Get-Date) -lt $deadline) {
        $left = Get-TargetProcesses -FullPath $fullPath
        if (@($left).Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    }
}

$left = Get-TargetProcesses -FullPath $fullPath
if (@($left).Count -gt 0) {
    # Launching now would leave two instances fighting over the profile; stop instead.
    Write-Log ("ERROR {0} process(es) survived: {1}; not launching a second copy" -f @($left).Count, (Format-Ids $left))
    exit 3
}

Write-Log ("all matching processes are gone after {0:N1}s; relaunching" -f ((Get-Date) - $scriptStart).TotalSeconds)

# 3) Relaunch through the WMI provider, NOT Start-Process.
#
# Start-Process made the new app a child of this script, which owns a (hidden) console.
# Electron then attached to that console and piped the host's stdout into it, so a Windows
# Terminal window appeared with "dsh web: http://..." on every restart. A WMI-created
# process has no console to inherit - the same starting condition as a Start Menu launch.
$workingDirectory = Split-Path -Parent $fullPath
$launched = $false
try {
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine      = ('"' + $fullPath + '"')
        CurrentDirectory = $workingDirectory
    }
    if ($created.ReturnValue -eq 0) {
        $launched = $true
        Write-Log ("relaunch requested via WMI at +{0:N1}s (pid {1})" -f ((Get-Date) - $scriptStart).TotalSeconds, $created.ProcessId)
    } else {
        Write-Log "WMI relaunch returned $($created.ReturnValue); falling back to Start-Process"
    }
} catch {
    Write-Log "WMI relaunch failed: $($_.Exception.Message); falling back to Start-Process"
}

if (-not $launched) {
    try {
        Start-Process -FilePath $fullPath -WorkingDirectory $workingDirectory -ErrorAction Stop
        Write-Log ("relaunch requested via Start-Process at +{0:N1}s" -f ((Get-Date) - $scriptStart).TotalSeconds)
    } catch {
        Write-Log "ERROR relaunch failed: $($_.Exception.Message)"
        exit 4
    }
}

Start-Sleep -Seconds 3
$after = Get-TargetProcesses -FullPath $fullPath
Write-Log ("after relaunch: {0} process(es) alive ({1})" -f @($after).Count, (Format-Ids $after))
Write-Log 'done'
exit 0
