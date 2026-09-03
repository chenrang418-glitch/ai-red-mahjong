[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDirectory,

  [string[]]$CharacterId
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$smallRoot = Join-Path $repoRoot 'src\sanguosha\assets\characters\portraits'
$fullRoot = Join-Path $repoRoot 'src\sanguosha\assets\characters\portraits-full'
$sourceRoot = (Resolve-Path -LiteralPath $SourceDirectory).Path
$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
$ffprobe = (Get-Command ffprobe -ErrorAction Stop).Source

$sourceAliases = @{
  pingtoufangkuai = '平头方块.png'
}

if (-not $CharacterId -or $CharacterId.Count -eq 0) {
  $CharacterId = Get-ChildItem -LiteralPath $smallRoot -Filter '*.webp' |
    ForEach-Object { $_.BaseName } |
    Sort-Object -Unique
}

function Get-ImageSize([string]$Path) {
  $size = & $ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 $Path
  if ($LASTEXITCODE -ne 0 -or $size -notmatch '^(\d+)x(\d+)$') {
    throw "无法读取图片尺寸：$Path"
  }
  return @{ Width = [int]$Matches[1]; Height = [int]$Matches[2] }
}

foreach ($id in ($CharacterId | Sort-Object -Unique)) {
  if ($id -notmatch '^[a-z0-9]+$') { throw "characterId 非法：$id" }
  $sourceName = if ($sourceAliases.ContainsKey($id)) { $sourceAliases[$id] } else { "$id.png" }
  $input = Join-Path $sourceRoot $sourceName
  if (-not (Test-Path -LiteralPath $input -PathType Leaf)) { throw "缺少源图：$input" }

  $sourceSize = Get-ImageSize $input
  $ratio = $sourceSize.Width / $sourceSize.Height
  if ([Math]::Abs($ratio - 0.75) -gt 0.005) {
    throw "源图不是 3:4 竖图：$input ($($sourceSize.Width)x$($sourceSize.Height))"
  }

  $small = Join-Path $smallRoot "$id.webp"
  $full = Join-Path $fullRoot "$id.webp"
  & $ffmpeg -hide_banner -loglevel error -y -i $input -vf 'scale=480:640:flags=lanczos' -c:v libwebp -quality 84 -compression_level 6 -preset picture -an $small
  if ($LASTEXITCODE -ne 0) { throw "座位图转换失败：$id" }
  & $ffmpeg -hide_banner -loglevel error -y -i $input -c:v libwebp -quality 84 -compression_level 6 -preset picture -an $full
  if ($LASTEXITCODE -ne 0) { throw "艺术集高清图转换失败：$id" }

  $smallSize = Get-ImageSize $small
  $fullSize = Get-ImageSize $full
  if ($smallSize.Width -ne 480 -or $smallSize.Height -ne 640) { throw "座位图尺寸不合规：$id" }
  if ($fullSize.Width -lt 1000 -or $fullSize.Height -lt 1300) { throw "艺术集高清图尺寸不足：$id" }
  Write-Host "完成 $id：座位图 480x640，高清图 $($fullSize.Width)x$($fullSize.Height)"
}
