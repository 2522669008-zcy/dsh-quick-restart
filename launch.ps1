# launch.ps1 - put restart.ps1 OUTSIDE the desktop app's job object.
#
# Why this file exists: every "DeepSeek Harness.exe" process on this host lives inside a
# Windows job object (measured: IsProcessInJob = true for all of them). A job is inherited
# by children, and a kill-on-close job kills them the moment the browser process exits -
# so a plain child would die together with the app it is supposed to restart.
#
# Win32_Process.Create runs the new process as a child of WmiPrvSE.exe, which is not in
# that job (measured: inJob = false, session = 1, console created hidden). The created
# process therefore survives the app's death, and it can start the GUI app in the user's
# interactive session.
#
# Output: one line of JSON on stdout, so the host can answer the browser truthfully.
#   {"ok":true,"pid":1234}
#   {"ok":false,"error":"..."}
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [int]$DelaySeconds = 2,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Result {
    param([hashtable]$Payload)
    Write-Output ($Payload | ConvertTo-Json -Compress)
}

$restart = Join-Path $PSScriptRoot 'restart.ps1'
if (-not (Test-Path -LiteralPath $restart -PathType Leaf)) {
    Write-Result @{ ok = $false; error = "restart.ps1 is missing next to launch.ps1: $restart" }
    exit 2
}
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    Write-Result @{ ok = $false; error = "executable not found: $ExePath" }
    exit 2
}

# Quoted, absolute paths: the created process starts in System32, not in this directory.
$inner = @(
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File', ('"' + $restart + '"'),
    '-ExePath', ('"' + $ExePath + '"'),
    '-DelaySeconds', "$DelaySeconds"
)
if ($DryRun) { $inner += '-DryRun' }
$commandLine = $inner -join ' '

try {
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
} catch {
    Write-Result @{ ok = $false; error = ("WMI is unavailable: " + $_.Exception.Message) }
    exit 3
}

if ($created.ReturnValue -ne 0) {
    Write-Result @{ ok = $false; error = ("Win32_Process.Create returned " + $created.ReturnValue) }
    exit 4
}

Write-Result @{ ok = $true; pid = [int]$created.ProcessId }
exit 0
