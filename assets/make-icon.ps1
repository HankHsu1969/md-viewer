# 產生 app.ico（多尺寸）與 icon.png：陶土橘圓角方塊 + 白色「MD」字樣
# 用法：powershell -ExecutionPolicy Bypass -File make-icon.ps1
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-IconFont {
    foreach ($name in 'Segoe UI', 'Arial') {
        try { return New-Object System.Drawing.FontFamily($name) } catch { }
    }
    return [System.Drawing.FontFamily]::GenericSansSerif
}
$fontFamily = Get-IconFont

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 48.0

    # 圓角方塊（陶土橘漸層）
    $r = 10 * $s; $x = 2 * $s; $y = 4 * $s; $w = 44 * $s; $h = 40 * $s
    $small = $size -le 24
    if ($small) { $r = 8 * $s; $x = 0; $y = 3 * $s; $w = 48 * $s; $h = 42 * $s }  # 小尺寸：方塊放大、字也放大
    $box = New-Object System.Drawing.Drawing2D.GraphicsPath
    $box.AddArc($x, $y, 2*$r, 2*$r, 180, 90)
    $box.AddArc($x + $w - 2*$r, $y, 2*$r, 2*$r, 270, 90)
    $box.AddArc($x + $w - 2*$r, $y + $h - 2*$r, 2*$r, 2*$r, 0, 90)
    $box.AddArc($x, $y + $h - 2*$r, 2*$r, 2*$r, 90, 90)
    $box.CloseFigure()
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, $y)), (New-Object System.Drawing.PointF(0, ($y + $h))),
        [System.Drawing.Color]::FromArgb(255, 220, 124, 92), [System.Drawing.Color]::FromArgb(255, 188, 88, 56))
    $g.FillPath($brush, $box)

    # 白色粗體「MD」：先做成路徑，再縮放置中
    $txt = New-Object System.Drawing.Drawing2D.GraphicsPath
    $fmt = [System.Drawing.StringFormat]::GenericTypographic
    $txt.AddString('MD', $fontFamily, [int][System.Drawing.FontStyle]::Bold, 100, (New-Object System.Drawing.PointF(0, 0)), $fmt)
    $b = $txt.GetBounds()
    $maxW = if ($small) { $w * 0.90 } else { $w * 0.74 }
    $maxH = if ($small) { $h * 0.64 } else { $h * 0.50 }
    $k = [Math]::Min($maxW / $b.Width, $maxH / $b.Height)
    $cx = $x + $w / 2
    $cy = $y + $h / 2
    $m = New-Object System.Drawing.Drawing2D.Matrix
    $m.Translate($cx, $cy)
    $m.Scale($k, $k)
    $m.Translate(-($b.X + $b.Width / 2), -($b.Y + $b.Height / 2))
    $txt.Transform($m)
    $g.FillPath([System.Drawing.Brushes]::White, $txt)

    $g.Dispose()
    return $bmp
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = @()
foreach ($sz in $sizes) {
    $bmp = New-IconBitmap $sz
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($sz -eq 256) { $bmp.Save((Join-Path $here 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
    $bmp.Dispose()
    $pngs += , @($sz, $ms.ToArray())
}

# 寫出 ICO（每個尺寸存成 PNG 區塊）
$fs = [System.IO.File]::Create((Join-Path $here 'app.ico'))
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($p in $pngs) {
    $sz = $p[0]; $data = $p[1]
    $bs = if ($sz -ge 256) { 0 } else { $sz }
    $bw.Write([byte]$bs); $bw.Write([byte]$bs); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
    $offset += $data.Length
}
foreach ($p in $pngs) { $bw.Write([byte[]]$p[1]) }
$bw.Close()
Write-Host "已產生 app.ico 與 icon.png"
