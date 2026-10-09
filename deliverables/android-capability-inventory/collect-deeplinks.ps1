# collect-deeplinks.ps1 — 解析每个 App 声明的深链（协议 + host + 路径）
#
# 上一次用"猜协议名"的办法测深链，14 条没命中；原因是很多 App 只注册带 host 的过滤器：
# 裸协议 `bilibili://` 不匹配，`bilibili://video/1` 才匹配。
# `dumpsys package <包名>` 的 Activity Resolver Table 里其实写着完整的 Scheme / Authority / Path，
# 所以这份字典是解析出来的，不是猜的。
#
# 产出：deep-link-dictionary.csv

param(
  [string]$Adb = "E:\code\Eng\.android-sdk\platform-tools\adb.exe",
  [string]$OutDir = $PSScriptRoot,
  [string]$CapCsv = "app-capabilities.csv"
)

$ErrorActionPreference = "Stop"

$names = @{}
Import-Csv (Join-Path $OutDir $CapCsv) | ForEach-Object { if ($_.名称) { $names[$_.包名] = $_.名称 } }

# 与 collect.ps1 同一套垃圾协议过滤
$junkScheme = '^(ut\.|tencent\d|pp[a-z0-9]{4,}|com[._]|cn[._]|[0-9a-f]{7,}$|h[0-9a-f]{6,}$|default_value$|data_assistant$|widgetid$|scenetype$|qts$|players?$|about$|package$|openapp$|gsdk|sejsbhycol)'
$junkContains = 'alipay_|_alipay|cashier|walletbox|_push|push_|^push|_sdk$|_sdk_|sdkback|sslocal|saitama|wtlogin|txdt'
$standard = @('http', 'https', 'tel', 'geo', 'mailto', 'smsto', 'mms', 'mmsto', 'sms', 'market', 'content', 'file', 'ftp', 'magnet', 'ed2k', 'thunder', 'javascript')

function ConvertTo-Row($cur, [string]$appName) {
  if (-not $cur -or -not $cur.scheme -or -not $cur.comp) { return $null }
  if ($cur.scheme -match $junkScheme) { return $null }
  if ($cur.scheme -match $junkContains) { return $null }
  $a = (@($cur.auth) | Sort-Object -Unique) -join ", "
  $p = (@($cur.paths) | Sort-Object -Unique) -join ", "
  $host1 = if ($a) { ($a -split ',')[0].Trim() } else { "" }
  $path1 = if ($p) { ($p -split ',')[0].Trim() } else { "" }
  $example = if ($host1) { "$($cur.scheme)://$host1$path1" } elseif ($path1) { "$($cur.scheme)://$path1" } else { "$($cur.scheme)://" }
  $kind = if ($standard -contains $cur.scheme) { "标准/网页" } else { "自定义协议" }
  return [pscustomobject]@{
    "协议"     = $cur.scheme
    "深链示例" = ($example -replace '\*', '')
    "host"     = $a
    "路径"     = $p
    "类型"     = $kind
    "App"      = $appName
    "包名"     = $cur.pkg
    "组件"     = $cur.comp
  }
}

$targets = @(Import-Csv (Join-Path $OutDir $CapCsv) |
  Where-Object { $_.公开协议 -and $_.公开协议.Trim() -ne "" } |
  Select-Object -ExpandProperty 包名)
Write-Host "待解析 App 数: $($targets.Count)"

$rows = New-Object System.Collections.ArrayList
$n = 0
foreach ($pkg in $targets) {
  $n++
  if ($n % 40 -eq 0) { Write-Host "  ...$n/$($targets.Count)" }
  $appName = if ($names.ContainsKey($pkg)) { $names[$pkg] } else { "" }
  $dump = & $Adb shell dumpsys package $pkg 2>&1

  $inTable = $false
  $inSchemes = $false
  $cur = $null
  $schemeName = $null

  foreach ($line in $dump) {
    if ($line -match '^Activity Resolver Table:') { $inTable = $true; $inSchemes = $false; continue }
    if ($inTable -and $line -match '^  (\S.*):\s*$') {
      $inSchemes = ($matches[1] -eq 'Schemes')
      if (-not $inSchemes -and $cur) {
        $r = ConvertTo-Row $cur $appName
        if ($r) { [void]$rows.Add($r) }
        $cur = $null
      }
      continue
    }
    if (-not $inSchemes) { continue }

    if ($line -match '^      (\S+):\s*$') {
      if ($cur) { $r = ConvertTo-Row $cur $appName; if ($r) { [void]$rows.Add($r) } }
      $schemeName = $matches[1]
      $cur = [pscustomobject]@{ scheme = $schemeName; comp = $null; auth = @(); paths = @(); pkg = $pkg }
      continue
    }
    if ($line -match '^\s+[0-9a-f]+\s+(\S+/\S+)\s+filter\s') {
      if ($cur -and $cur.comp) { $r = ConvertTo-Row $cur $appName; if ($r) { [void]$rows.Add($r) } }
      if ($cur) { $cur.comp = $matches[1]; $cur.auth = @(); $cur.paths = @() }
      continue
    }
    if (-not $cur) { continue }
    if ($line -match '^\s+Authority:\s*"([^"]+)"') { $cur.auth += $matches[1]; continue }
    if ($line -match '^\s+Path(?:Prefix|Pattern)?:\s*"PatternMatcher\{[A-Z]+:\s*([^}]*)\}"') { $cur.paths += $matches[1].Trim(); continue }
  }
  if ($cur) { $r = ConvertTo-Row $cur $appName; if ($r) { [void]$rows.Add($r) } }
}

$out = Join-Path $OutDir "deep-link-dictionary.csv"
$rows | Sort-Object 类型, 协议, 包名 | Export-Csv -Path $out -NoTypeInformation -Encoding UTF8
Write-Host "深链条目: $($rows.Count)  -> $out"
