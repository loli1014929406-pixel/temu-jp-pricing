$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://127.0.0.1:5173/"
$port = 5173

function Test-PortOpen {
  param([int]$Port)

  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return $null -ne $connection
}

Set-Location $projectDir

if (-not (Test-PortOpen -Port $port)) {
  $stdout = Join-Path $projectDir "vite.log"
  $stderr = Join-Path $projectDir "vite.err.log"

  Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList @("run", "dev", "--", "--host", "127.0.0.1", "--port", "$port") `
    -WorkingDirectory $projectDir `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden

  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortOpen -Port $port) {
      break
    }
    Start-Sleep -Milliseconds 500
  }
}

Start-Process $url
