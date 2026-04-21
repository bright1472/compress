# Titan Native Host Installation Script
# Run as: powershell -ExecutionPolicy Bypass -File install-titan-host.ps1

$ErrorActionPreference = "Stop"

$INSTALL_DIR = "$env:LOCALAPPDATA\TitanHost"
$HOST_MANIFEST = "$INSTALL_DIR\titan-host.json"
$BINARY = "$INSTALL_DIR\titan-host.exe"
$REG_KEY = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.titan.video.host"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host "=== Titan Native Host Installer ===" -ForegroundColor Cyan

# 1. Check FFmpeg
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    Write-Host "[ERROR] ffmpeg not found in PATH. Please install FFmpeg first." -ForegroundColor Red
    Write-Host "  Download: https://www.gyan.dev/ffmpeg/builds/" -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] FFmpeg found: $($ffmpeg.Source)" -ForegroundColor Green

# 2. Create install directory
if (-not (Test-Path $INSTALL_DIR)) {
    New-Item -ItemType Directory -Path $INSTALL_DIR | Out-Null
    Write-Host "[OK] Created $INSTALL_DIR" -ForegroundColor Green
}

# 3. Copy binary
$srcBinary = Join-Path $SCRIPT_DIR "target\release\titan-host.exe"
if (-not (Test-Path $srcBinary)) {
    Write-Host "[ERROR] Binary not found at: $srcBinary" -ForegroundColor Red
    Write-Host "  Run 'cargo build --release' first." -ForegroundColor Yellow
    exit 1
}
Copy-Item -Force $srcBinary $BINARY
Write-Host "[OK] Binary copied to $BINARY" -ForegroundColor Green

# 4. Get binary size
$size = (Get-Item $BINARY).Length
Write-Host "    Size: $([math]::Round($size / 1MB, 1)) MB" -ForegroundColor Gray

# 5. Generate host manifest
$manifest = @{
    name = "com.titan.video.host"
    description = "Titan GPU-accelerated video compression native host"
    path = $BINARY
    type = "stdio"
    allowed_origins = @("chrome-extension://PLACEHOLDER_EXTENSION_ID/")
} | ConvertTo-Json -Depth 3

Set-Content -Path $HOST_MANIFEST -Value $manifest -Encoding UTF8
Write-Host "[OK] Host manifest created at $HOST_MANIFEST" -ForegroundColor Green

# 6. Register in Windows Registry
if (Test-Path $REG_KEY) {
    Write-Host "[WARN] Registry key already exists, updating..." -ForegroundColor Yellow
}
New-Item -Path $REG_KEY -Force | Out-Null
Set-ItemProperty -Path $REG_KEY -Name "(default)" -Value $HOST_MANIFEST -Type String
Write-Host "[OK] Registry entry created at $REG_KEY" -ForegroundColor Green

# 7. Verify
try {
    $regValue = Get-ItemProperty -Path $REG_KEY -Name "(default)"
    Write-Host "[OK] Registry value: $($regValue.'(default)')" -ForegroundColor Gray
} catch {
    Write-Host "[ERROR] Registry verification failed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Installation Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Load the Chrome Extension (chrome://extensions -> Developer mode -> Load unpacked)"
Write-Host "   Extension path: $SCRIPT_DIR\..\native-bridge"
Write-Host ""
Write-Host "2. After loading, copy the Extension ID and update the manifest:"
Write-Host "   - Edit: $HOST_MANIFEST"
Write-Host "   - Replace 'PLACEHOLDER_EXTENSION_ID' with your actual Extension ID"
Write-Host "   - Then reload the extension in chrome://extensions"
Write-Host ""
Write-Host "3. Verify: click the Titan extension icon — encoder badge should show GPU engine" -ForegroundColor Yellow
