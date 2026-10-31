Add-Type -AssemblyName System.Drawing
function Make-Icon($size, $path, $pad) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255,255,90,31)), ([System.Drawing.Color]::FromArgb(255,180,30,20)), 45
  $g.FillRectangle($bg, $rect)
  $c = $size / 2
  $inner = $size * (1 - 2 * $pad)
  $white = [System.Drawing.Color]::White
  foreach ($k in 0.46, 0.32, 0.18) {
    $r = $inner * $k
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(230,255,255,255)), ($size * 0.035)
    $g.DrawEllipse($pen, [float]($c - $r), [float]($c - $r), [float](2 * $r), [float](2 * $r))
  }
  $pen2 = New-Object System.Drawing.Pen $white, ($size * 0.03)
  $g.DrawLine($pen2, [float]$c, [float]($c - $inner * 0.5), [float]$c, [float]($c - $inner * 0.08))
  $g.DrawLine($pen2, [float]$c, [float]($c + $inner * 0.08), [float]$c, [float]($c + $inner * 0.5))
  $g.DrawLine($pen2, [float]($c - $inner * 0.5), [float]$c, [float]($c - $inner * 0.08), [float]$c)
  $g.DrawLine($pen2, [float]($c + $inner * 0.08), [float]$c, [float]($c + $inner * 0.5), [float]$c)
  $dr = $inner * 0.06
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $white), [float]($c - $dr), [float]($c - $dr), [float](2 * $dr), [float](2 * $dr))
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
$dir = Join-Path $PSScriptRoot "..\public\icons"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
foreach ($s in 72, 96, 128, 144, 152, 192, 384, 512) {
  Make-Icon $s (Join-Path $dir "icon-${s}x${s}.png") 0.08
}
Make-Icon 512 (Join-Path $dir "icon-maskable-512x512.png") 0.2
