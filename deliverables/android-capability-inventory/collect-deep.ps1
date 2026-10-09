# collect-deep.ps1 — 补齐另外两层：数据接口(ContentProvider) 与 深链实测
#
# 用法（需先连好 adb 设备，并已跑过 collect.ps1）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File collect-deep.ps1
#
# 产出（同目录）：
#   data-interfaces.csv   数据接口：authority / 归属App / 实测能不能读 / 需要什么权限
#   deep-links.csv        深链字典：协议 + 实测哪些 App 响应
#   media-services.csv    可被浏览的媒体库服务(MediaBrowserService)

param(
    # Empty means "resolve it" - see Resolve-adb.ps1. There is no machine-specific default:
  # this used to hardcode one developer's SDK path, which made the script unusable elsewhere.
  [string]$Adb = "",
  [string]$OutDir = $PSScriptRoot,
  [int]$ChunkSize = 40,
  [int]$MaxSystemProbes = 40
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'Resolve-adb.ps1')
$Adb = Resolve-Adb -Explicit $Adb

# 名称映射复用 collect.ps1 的产出，避免重复维护
$names = @{}
$capCsv = Join-Path $OutDir "app-capabilities.csv"
if (Test-Path $capCsv) {
  Import-Csv $capCsv | ForEach-Object { if ($_.名称) { $names[$_.包名] = $_.名称 } }
}
function NameOf([string]$pkg) { if ($names.ContainsKey($pkg)) { return $names[$pkg] } return "" }

# ---------------------------------------------------------------- 1. 数据接口清单
Write-Host "=== 1/4 解析数据接口(ContentProvider) ==="
$raw = & $Adb shell dumpsys activity providers 2>&1
$cur = $null
$authPkg = [ordered]@{}
foreach ($l in $raw) {
  if ($l -match '^\s+package=(\S+)') { $cur = $matches[1] }
  elseif ($l -match '^\s+authority=(\S+)' -and $cur) {
    if (-not $authPkg.Contains($matches[1])) { $authPkg[$matches[1]] = $cur }
  }
}
$third = @{}
(& $Adb shell pm list packages -3 2>&1) | ForEach-Object { if ($_ -match '^package:(.+)$') { $third[$matches[1].Trim()] = $true } }
Write-Host "  数据接口总数 $($authPkg.Count)"

# 探测范围：全部第三方 App 的接口 + 系统里名字"像公共接口"的若干个
$sysPattern = 'contacts|calendar|media|download|call_log|^sms$|mms|browser|deskclock|notes|gallery|weather|telephony|settings'
$targets = New-Object System.Collections.ArrayList
foreach ($auth in $authPkg.Keys) {
  $pkg = $authPkg[$auth]
  $isThird = $third.ContainsKey($pkg)
  if ($isThird) { [void]$targets.Add([pscustomobject]@{ auth = $auth; pkg = $pkg; kind = "第三方" }) }
}
$sysPick = @()
foreach ($auth in $authPkg.Keys) {
  if ($third.ContainsKey($authPkg[$auth])) { continue }
  if ($auth -match $sysPattern) { $sysPick += [pscustomobject]@{ auth = $auth; pkg = $authPkg[$auth]; kind = "系统" } }
}
$sysPick = $sysPick | Select-Object -First $MaxSystemProbes
foreach ($s in $sysPick) { [void]$targets.Add($s) }
Write-Host "  将实测 $($targets.Count) 个（第三方 $($targets.Count - $sysPick.Count) + 系统 $($sysPick.Count)）"

# 逐个探测：读得到就记数据，读不到就记"要什么权限"
Write-Host "=== 2/4 实测每个数据接口 ==="
$probe = @{}
$valid = $targets | Where-Object { $_.auth -match '^[A-Za-z0-9._-]+$' }
$total = $valid.Count
$done = 0
for ($i = 0; $i -lt $total; $i += $ChunkSize) {
  $end = [Math]::Min($i + $ChunkSize - 1, $total - 1)
  $chunk = @($valid)[$i..$end]
  $parts = foreach ($t in $chunk) {
    "echo '@@$($t.auth)'"
    "timeout 3 content query --uri content://$($t.auth)/ 2>&1 | head -2"
  }
  $out = & $Adb shell ($parts -join '; ') 2>&1
  $curAuth = $null
  foreach ($line in $out) {
    if ($line -match '^@@(.+)$') { $curAuth = $matches[1].Trim(); $probe[$curAuth] = New-Object System.Collections.ArrayList; continue }
    if ($curAuth) { [void]$probe[$curAuth].Add($line) }
  }
  $done = $end + 1
  Write-Host "  ...$done/$total"
}

function ClassifyProbe($lines) {
  $txt = ($lines -join "`n")
  if (-not $txt) { return @{ status = "无响应"; perm = ""; sample = "" } }
  if ($txt -match 'not exported') { return @{ status = "未导出（第三方读不到）"; perm = "—"; sample = "" } }
  if ($txt -match 'SecurityException') {
    $perm = "（未识别）"
    if ($txt -match 'requires ([\w.]+)') { $perm = $matches[1] }
    return @{ status = "需要权限"; perm = $perm; sample = "" }
  }
  if ($txt -match 'No result found') { return @{ status = "可读·无数据"; perm = ""; sample = "" } }
  if ($txt -match 'Row:') {
    $row = ($lines | Where-Object { $_ -match 'Row:' } | Select-Object -First 1)
    if ($row.Length -gt 240) { $row = $row.Substring(0, 240) + "…" }
    return @{ status = "可读"; perm = ""; sample = $row }
  }
  if ($txt -match 'Unknown URI|IllegalArgument|FileNotFound|no such|inaccessible') {
    return @{ status = "URI 不存在"; perm = ""; sample = "" }
  }
  $first = ($lines | Select-Object -First 1)
  if ($first.Length -gt 120) { $first = $first.Substring(0, 120) + "…" }
  return @{ status = "其它"; perm = ""; sample = $first }
}

$rowsIf = @()
foreach ($t in $targets) {
  $lines = if ($probe.ContainsKey($t.auth)) { $probe[$t.auth] } else { @() }
  $c = ClassifyProbe $lines
  $rowsIf += [pscustomobject]@{
    "数据接口(authority)" = $t.auth
    "归属App"             = NameOf $t.pkg
    "包名"                = $t.pkg
    "类型"                = $t.kind
    "实测结果"            = $c.status
    "需要权限"            = $c.perm
    "样例数据"            = $c.sample
  }
}
$ifCsv = Join-Path $OutDir "data-interfaces.csv"
$rowsIf | Export-Csv -Path $ifCsv -NoTypeInformation -Encoding UTF8
$readable = ($rowsIf | Where-Object { $_.实测结果 -eq "可读" }).Count
Write-Host "  可读 $readable / 需要权限 $(($rowsIf | Where-Object { $_.实测结果 -eq '需要权限' }).Count) / 未导出 $(($rowsIf | Where-Object { $_.实测结果 -like '未导出*' }).Count)"
Write-Host "  CSV -> $ifCsv"

# ---------------------------------------------------------------- 3. 媒体库服务
Write-Host "=== 3/4 可被浏览的媒体库服务 ==="
$rawM = & $Adb shell "cmd package query-services --brief -a android.media.browse.MediaBrowserService" 2>&1
$mediaPkgs = @{}
$rowsMedia = @()
foreach ($line in $rawM) {
  if ($line -match '^\s+([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/(\S+)\s*$') {
    $pkg = $matches[1]
    if (-not $mediaPkgs.ContainsKey($pkg)) {
      $mediaPkgs[$pkg] = $true
      $rowsMedia += [pscustomobject]@{
        "App"       = NameOf $pkg
        "包名"      = $pkg
        "实现的服务" = "$pkg/$($matches[2])"
      }
    }
  }
}
$mediaCsv = Join-Path $OutDir "media-services.csv"
$rowsMedia | Export-Csv -Path $mediaCsv -NoTypeInformation -Encoding UTF8
Write-Host "  $($rowsMedia.Count) 个 -> $mediaCsv"

# ---------------------------------------------------------------- 4. 深链实测
Write-Host "=== 4/4 深链实测 ==="
$deepLinks = @(
  # 格式：深链, 备注
  @("weixin://", "微信"),
  @("weixin://scanqrcode", "微信·扫一扫"),
  @("weixin://dl/scan", "微信·扫一扫（旧格式）"),
  @("mqq://", "QQ"),
  @("mqqwpa://", "QQ·语音通话"),
  @("mqqapi://", "QQ·开放接口"),
  @("wxwork://", "企业微信"),
  @("lark://", "飞书"),
  @("feishu://", "飞书（旧格式）"),
  @("taobao://", "淘宝"),
  @("taobao://item.taobao.com/item.htm", "淘宝·商品页"),
  @("tmall://", "天猫"),
  @("alipays://", "支付宝"),
  @("alipayqr://", "支付宝·扫码"),
  @("fleamarket://", "闲鱼"),
  @("pinduoduo://", "拼多多"),
  @("openapp.jdmobile://", "京东"),
  @("imeituan://", "美团"),
  @("dianping://", "大众点评"),
  @("ctrip://", "携程"),
  @("cn.12306://", "铁路12306"),
  @("amapuri://", "高德地图"),
  @("androidamap://", "高德地图（旧格式）"),
  @("baidumap://", "百度地图"),
  @("zhihu://", "知乎"),
  @("zhihu://questions/1", "知乎·问题页"),
  @("bilibili://", "哔哩哔哩"),
  @("bilibili://video/1", "哔哩哔哩·视频页"),
  @("xhsdiscover://", "小红书"),
  @("xhsdiscover://item/1", "小红书·笔记页"),
  @("sinaweibo://", "微博"),
  @("orpheus://song/1", "网易云·播放歌曲"),
  @("orpheus://playlist/1", "网易云·打开歌单"),
  @("orpheus://album/1", "网易云·打开专辑"),
  @("orpheus://artist/1", "网易云·打开歌手"),
  @("orpheus://dj/1", "网易云·电台"),
  @("snssdk1128://", "抖音"),
  @("aweme://", "抖音（旧格式）"),
  @("kwai://", "快手"),
  @("vnd.youtube://", "YouTube"),
  @("googlegmail://", "Gmail"),
  @("instagram://", "Instagram"),
  @("twitter://", "X (Twitter)"),
  @("tg://", "Telegram"),
  @("notion://", "Notion"),
  @("steam://", "Steam"),
  @("mega://", "MEGA"),
  @("github://", "GitHub"),
  @("wpsoffice://", "WPS Office"),
  @("mishop://", "小米商城"),
  @("mihome://", "米家"),
  @("mobileclaw://", "MobileClaw（你自己的 App）"),
  @("https://github.com/a/b", "网页链接·GitHub（对照）"),
  @("https://www.example.com", "网页链接·通用（对照）"),
  @("geo:0,0?q=test", "标准·地图坐标"),
  @("tel:10086", "标准·拨号"),
  @("smsto:10086", "标准·短信"),
  @("mailto:a@b.com", "标准·邮件")
)
$rowsDl = @()
foreach ($item in $deepLinks) {
  $uri = $item[0]
  $note = $item[1]
  $o = & $Adb shell "cmd package query-activities --brief -a android.intent.action.VIEW -d '$uri'" 2>&1
  $hits = @()
  foreach ($line in $o) {
    if ($line -match '^\s+([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/(\S+)\s*$') { $hits += $matches[1] }
  }
  $hits = $hits | Sort-Object -Unique
  $who = ($hits | ForEach-Object { $n = NameOf $_; if ($n) { "$n($_)" } else { $_ } }) -join "、"
  $rowsDl += [pscustomobject]@{
    "深链"     = $uri
    "说明"     = $note
    "响应数"   = ($hits | Measure-Object).Count
    "谁响应"   = if ($who) { $who } else { "（无人响应）" }
  }
}
$dlCsv = Join-Path $OutDir "deep-links.csv"
$rowsDl | Export-Csv -Path $dlCsv -NoTypeInformation -Encoding UTF8
$hit = ($rowsDl | Where-Object { $_.响应数 -gt 0 }).Count
Write-Host "  $hit / $($rowsDl.Count) 条命中 -> $dlCsv"
