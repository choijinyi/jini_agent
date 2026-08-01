<#
.SYNOPSIS
  PNG 원본에서 PWA 아이콘(192·512)과 애플 터치 아이콘(180)을 만든다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1 -Png ~/Desktop/jini.png -OutDir assets
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Png,
  [string]$OutDir = 'assets'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Png).Path)

try {
  foreach ($size in 192, 512, 180) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()
    $name = if ($size -eq 180) { 'apple-touch-icon.png' } else { "icon-$size.png" }
    $path = Join-Path $OutDir $name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "[icons] $name ($size x $size)"
  }
} finally {
  $src.Dispose()
}
