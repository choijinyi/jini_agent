<#
.SYNOPSIS
  PNG → ICO 변환 (외부 도구 없이 System.Drawing 만 사용)

.DESCRIPTION
  Windows 바로가기(.lnk)의 아이콘은 .ico 만 받는다. PNG 를 지정 크기로 리샘플한 뒤
  ICO 컨테이너에 PNG 압축 엔트리로 담는다(Vista 이상 지원 형식).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/make-icon.ps1 -Png ~/Desktop/jini.png -Ico assets/jini.ico
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Png,
  [Parameter(Mandatory)][string]$Ico,
  [int]$Size = 256
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$srcPath = (Resolve-Path $Png).Path
$outDir = Split-Path -Parent $Ico
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$src = [System.Drawing.Image]::FromFile($srcPath)
try {
  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 0, 0, $Size, $Size)
  $g.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  $bmp.Dispose()
} finally {
  $src.Dispose()
}

# ICO 헤더(6) + 디렉터리 엔트리(16) + PNG 본문. 256px 는 폭·높이 바이트를 0 으로 적는다.
$dim = if ($Size -ge 256) { 0 } else { $Size }
$fs = [System.IO.File]::Create((Join-Path (Get-Location) $Ico))
try {
  $w = New-Object System.IO.BinaryWriter($fs)
  $w.Write([uint16]0)              # reserved
  $w.Write([uint16]1)              # type = icon
  $w.Write([uint16]1)              # image count
  $w.Write([byte]$dim)             # width
  $w.Write([byte]$dim)             # height
  $w.Write([byte]0)                # palette
  $w.Write([byte]0)                # reserved
  $w.Write([uint16]1)              # color planes
  $w.Write([uint16]32)             # bits per pixel
  $w.Write([uint32]$bytes.Length)  # image size
  $w.Write([uint32]22)             # offset (6 + 16)
  $w.Write($bytes)
  $w.Flush()
} finally {
  $fs.Close()
}

Write-Host "[icon] $Png -> $Ico ($Size x $Size, $($bytes.Length) bytes)"
