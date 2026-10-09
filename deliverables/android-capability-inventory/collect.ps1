# collect.ps1 — 采集安卓设备上"每个 App 对外暴露了什么能力"
#
# 用法（需先连好 adb 设备）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File collect.ps1
#
# 产出（同目录）：
#   app-capabilities.csv        宽表：一行一个 App，一列一个能力
#   app-capabilities.md         同样的表，Markdown 版
#
# 原理：
#   1) cmd package query-activities / query-services —— 问系统"谁能处理这个请求"。
#      只返回导出的、真正可被调用的组件，所以这是"能不能用"的准确来源。
#   2) dumpsys package 的 * Resolver Table -> Schemes: —— 每个 App 注册了哪些 URL 协议。
#   3) pm list packages -s/-3 —— 区分系统应用和第三方应用。

param(
    # Empty means "resolve it" - see Resolve-adb.ps1. There is no machine-specific default:
  # this used to hardcode one developer's SDK path, which made the script unusable elsewhere.
  [string]$Adb = "",
  [string]$OutDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'Resolve-adb.ps1')
$Adb = Resolve-Adb -Explicit $Adb

# ---------------------------------------------------------------- 能力清单
# 名称 -> adb shell 里执行的完整命令
# 注意：这些值必须用「PowerShell 双引号字符串 + 内层单引号」。
# 内层用双引号时，参数会以不带引号的形式落到设备 shell 上，`*/*` 会被当成通配符展开，
# 于是查询静默返回 0 个结果（踩过一次）。
$capabilities = [ordered]@{
  "接收分享·文字"    = "cmd package query-activities --brief -a android.intent.action.SEND -t 'text/plain'"
  "接收分享·图片"    = "cmd package query-activities --brief -a android.intent.action.SEND -t 'image/*'"
  "接收分享·视频"    = "cmd package query-activities --brief -a android.intent.action.SEND -t 'video/*'"
  "接收分享·任意文件" = "cmd package query-activities --brief -a android.intent.action.SEND -t '*/*'"
  "接收分享·多个文件" = "cmd package query-activities --brief -a android.intent.action.SEND_MULTIPLE -t '*/*'"
  "处理选中文字"     = "cmd package query-activities --brief -a android.intent.action.PROCESS_TEXT -t 'text/plain'"
  "编辑图片"         = "cmd package query-activities --brief -a android.intent.action.EDIT -t 'image/*'"
  "打开网页链接"     = "cmd package query-activities --brief -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d 'https://example.com'"
  "打开PDF"          = "cmd package query-activities --brief -a android.intent.action.VIEW -t 'application/pdf'"
  "打开视频文件"     = "cmd package query-activities --brief -a android.intent.action.VIEW -t 'video/*'"
  "打开音频文件"     = "cmd package query-activities --brief -a android.intent.action.VIEW -t 'audio/*'"
  "当文件选择器"     = "cmd package query-activities --brief -a android.intent.action.GET_CONTENT -c android.intent.category.OPENABLE -t '*/*'"
  "拨号"             = "cmd package query-activities --brief -a android.intent.action.DIAL"
  "发短信"           = "cmd package query-activities --brief -a android.intent.action.SENDTO -d 'smsto:10086'"
  "发邮件"           = "cmd package query-activities --brief -a android.intent.action.SENDTO -d 'mailto:a@b.com'"
  "地图导航"         = "cmd package query-activities --brief -a android.intent.action.VIEW -d 'geo:0,0?q=test'"
  "建日程"           = "cmd package query-activities --brief -a android.intent.action.INSERT -t 'vnd.android.cursor.item/event'"
  "设闹钟"           = "cmd package query-activities --brief -a android.intent.action.SET_ALARM"
  "设计时器"         = "cmd package query-activities --brief -a android.intent.action.SET_TIMER"
  "建联系人"         = "cmd package query-activities --brief -a android.intent.action.INSERT -t 'vnd.android.cursor.dir/person' -d 'content://com.android.contacts/contacts'"
  "拍照"             = "cmd package query-activities --brief -a android.media.action.IMAGE_CAPTURE"
  "录音"             = "cmd package query-activities --brief -a android.provider.MediaStore.RECORD_SOUND"
  "语音识别"         = "cmd package query-activities --brief -a android.speech.action.RECOGNIZE_SPEECH"
  "建备忘"           = "cmd package query-activities --brief -a android.intent.action.CREATE_NOTE"
  "网页搜索"         = "cmd package query-activities --brief -a android.intent.action.WEB_SEARCH"
  "扫码"             = "cmd package query-activities --brief -a com.google.zxing.client.android.SCAN"
  "设壁纸"           = "cmd package query-activities --brief -a android.intent.action.SET_WALLPAPER"
  "文字朗读(TTS)"    = "cmd package query-services --brief -a android.intent.action.TTS_SERVICE"
}

function Get-PackagesFor([string]$shellCommand) {
  $raw = & $Adb shell $shellCommand 2>&1
  $set = @{}
  foreach ($line in $raw) {
    if ($line -match '^\s+([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/') { $set[$matches[1]] = $true }
  }
  return $set.Keys
}

Write-Host "=== 1/4 查询能力（$($capabilities.Count) 项）==="
$capMap = @{}   # 包名 -> HashSet(能力名)
foreach ($cap in $capabilities.Keys) {
  $pkgs = Get-PackagesFor $capabilities[$cap]
  foreach ($p in $pkgs) {
    if (-not $capMap.ContainsKey($p)) { $capMap[$p] = New-Object System.Collections.Generic.HashSet[string] }
    [void]$capMap[$p].Add($cap)
  }
  "{0,-18} {1,4} 个" -f $cap, ($pkgs | Measure-Object).Count
}

Write-Host "`n=== 2/4 抓 dumpsys package（约 12MB，几秒）==="
$dump = Join-Path $env:TEMP "mc-pkgs-dump.txt"
& $Adb shell dumpsys package 2>&1 | Out-File -FilePath $dump -Encoding utf8
$lines = Get-Content $dump
Write-Host "  $($lines.Count) 行"

Write-Host "=== 3/4 解析每个 App 注册的 URL 协议 ==="
$schemeMap = @{}   # 包名 -> HashSet(协议)
$inSchemes = $false
foreach ($line in $lines) {
  if ($line -match '^  (\S.*):\s*$') {
    $inSchemes = ($matches[1] -eq 'Schemes')
    continue
  }
  if ($line -match '^\S') { $inSchemes = $false; continue }   # 换到另一个表
  if (-not $inSchemes) { continue }
  if ($line -match '^\s{6}(\S+):\s*$') { $curScheme = $matches[1]; continue }
  if ($line -match '^\s{8}\S+\s+([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/') {
    $p = $matches[1]
    if (-not $schemeMap.ContainsKey($p)) { $schemeMap[$p] = New-Object System.Collections.Generic.HashSet[string] }
    [void]$schemeMap[$p].Add($curScheme)
  }
}
Write-Host "  $(($schemeMap.Keys | Measure-Object).Count) 个 App 注册了 URL 协议"

Write-Host "=== 4/4 应用清单与系统角色 ==="
$systemPkgs = @{}
(& $Adb shell pm list packages -s 2>&1) | ForEach-Object { if ($_ -match '^package:(.+)$') { $systemPkgs[$matches[1].Trim()] = $true } }
$thirdPkgs = @{}
(& $Adb shell pm list packages -3 2>&1) | ForEach-Object { if ($_ -match '^package:(.+)$') { $thirdPkgs[$matches[1].Trim()] = $true } }
$allPkgs = @{}
$systemPkgs.Keys | ForEach-Object { $allPkgs[$_] = $true }
$thirdPkgs.Keys | ForEach-Object { $allPkgs[$_] = $true }
Write-Host "  系统 $($systemPkgs.Count) 个 / 第三方 $($thirdPkgs.Count) 个"

# Known Packages 角色（浏览器 / 安装器 / 助手 …）
$roles = @{}
$inKnown = $false
foreach ($line in $lines) {
  if ($line -match '^Known Packages:\s*$') { $inKnown = $true; continue }
  if ($inKnown) {
    if ($line -match '^\S') { break }
    if ($line -match '^  ([^:]+):\s*(.*)$') { $roleName = $matches[1].Trim(); $roleVal = $matches[2].Trim() }
    elseif ($line -match '^\s+(\S+)\s*$' -and $roleName -and $roleVal -eq '') {
      $roles[$matches[1]] = $roleName
    }
  }
}

# ---------------------------------------------------------------- 中文名
$names = @{
  'ai.x.grok'='Grok'; 'air.tv.douyu.android'='斗鱼'; 'bin.mt.plus'='MT管理器'
  'cn.com.chsi.chsiapp'='学信网'; 'cn.cyberIdentity.certification'='网络身份认证'
  'cn.nokia.speedtest5g'='网速测试'; 'cn.wps.moffice_eng'='WPS Office'
  'cn.wps.moffice_eng.xiaomi.lite'='WPS Office 小米版'; 'com.able.wisdomtree'='智慧树'
  'com.agentsanywhere.app'='Agents Anywhere（DSH 手机端）'
  'com.android.browser'='小米浏览器'; 'com.android.calendar'='日历'; 'com.android.camera'='相机'
  'com.android.contacts'='联系人'; 'com.android.deskclock'='时钟'; 'com.android.documentsui'='文件'
  'com.android.email'='邮件'; 'com.android.mms'='短信'; 'com.android.providers.downloads.ui'='下载管理'
  'com.android.soundrecorder'='录音机'; 'com.android.vending'='Google Play'
  'com.articlereading.selfstudy'='自学阅读'; 'com.autonavi.minimap'='高德地图'
  'com.azure.authenticator'='Microsoft Authenticator'; 'com.baidu.BaiduMap'='百度地图'
  'com.baidu.input_mi'='百度输入法'; 'com.baidu.netdisk'='百度网盘'; 'com.baidu.searchbox'='百度'
  'com.bankcomm.Bankcomm'='交通银行'; 'com.bilibili.comic'='哔哩哔哩漫画'; 'com.bxkj.student'='学生端App'
  'com.cctv.yangshipin.app.androidp'='央视频'; 'com.chaoxing.mobile'='学习通'
  'com.chinalife.ebz'='中国人寿'; 'com.dangdang.buy2'='当当'; 'com.danlan.xiaolan'='小蓝'
  'com.deepseek.chat'='DeepSeek'; 'com.dianping.v1'='大众点评'; 'com.dragon.read'='番茄免费小说'
  'com.duokan.phone.remotecontroller'='万能遥控'; 'com.duokan.reader'='多看阅读'
  'com.eg.android.AlipayGphone'='支付宝'; 'com.fiveplay'='边锋游戏'; 'com.github.android'='GitHub'
  'com.google.android.apps.bard'='Gemini'; 'com.google.android.gm'='Gmail'
  'com.google.android.googlequicksearchbox'='Google'; 'com.google.android.youtube'='YouTube'
  'com.greenpoint.android.mc10086.activity'='中国移动'; 'com.hexin.plat.android'='同花顺'
  'com.hiby.music'='海贝音乐'; 'com.hpbr.bosszhipin'='BOSS直聘'; 'com.htinns'='华住会'
  'com.huachenjie.shandong_school'='山东校园'; 'com.hypergryph.arknights.bilibili'='明日方舟(B服)'
  'com.hypergryph.skland'='森空岛'; 'com.iflytek.inputmethod.miui'='讯飞输入法'
  'com.instagram.android'='Instagram'; 'com.jingdong.app.mall'='京东'; 'com.jiongji.andriod.card'='囧记单词'
  'com.jxedt'='驾校一点通'; 'com.larus.nova'='豆包'; 'com.max.xiaoheihe'='小黑盒'
  'com.mfashiongallery.emag'='小米画报'; 'com.mi.health'='小米运动健康'; 'com.midea.ai.appliances'='美的'
  'com.mipay.wallet'='小米钱包'; 'com.miui.calculator'='计算器'; 'com.miui.cleanmaster'='垃圾清理'
  'com.miui.compass'='指南针'; 'com.miui.findmy'='查找设备'; 'com.miui.gallery'='相册'
  'com.miui.huanji'='小米换机'; 'com.miui.mediaeditor'='相册编辑'; 'com.miui.miservice'='服务与反馈'
  'com.miui.newhome'='内容中心'; 'com.miui.newmidrive'='小米云盘'; 'com.miui.notes'='小米笔记'
  'com.miui.password'='密码管理'; 'com.miui.player'='音乐'; 'com.miui.screenrecorder'='屏幕录制'
  'com.miui.securitymanager'='安全中心'; 'com.miui.themestore'='主题商店'; 'com.miui.video'='小米视频'
  'com.miui.virtualsim'='虚拟SIM'; 'com.miui.voiceassistProxy'='小爱同学(代理)'
  'com.miui.weather2'='天气'; 'com.MobileTicket'='铁路12306'; 'com.netease.android.cloudgame'='网易云游戏'
  'com.netease.buff'='网易BUFF'; 'com.netease.cloudmusic'='网易云音乐'; 'com.openai.chatgpt'='ChatGPT'
  'com.phoenix.read'='小说阅读'; 'com.picacomic.fregata'='哔咔漫画'; 'com.plan.kot32.tomatotime'='番茄钟'
  'com.ProjectMoon.LimbusCompany'='边狱公司'; 'com.pwrd.steam.esports'='完美世界电竞'
  'com.qiekj.user'='企客'; 'com.qiyi.video'='爱奇艺'; 'com.quark.browser'='夸克浏览器'
  'com.sankuai.meituan'='美团'; 'com.shanbay.sentence'='扇贝'; 'com.sina.weibo'='微博'
  'com.sinovatech.unicom.ui'='中国联通'; 'com.smile.gifmaker'='快手'
  'com.ss.android.article.news'='今日头条'; 'com.ss.android.lark'='飞书'
  'com.ss.android.ugc.aweme'='抖音'; 'com.taobao.idlefish'='闲鱼'; 'com.taobao.taobao'='淘宝'
  'com.taoguba.app'='淘股吧'; 'com.taptap'='TapTap'; 'com.tencent.apps.valorant'='无畏契约'
  'com.tencent.mm'='微信'; 'com.tencent.mobileqq'='QQ'; 'com.tencent.rmcn'='腾讯会议'
  'com.tencent.tmgp.sgame'='王者荣耀'; 'com.tencent.tmgp.supercell.clashofclans'='部落冲突'
  'com.tencent.wemeet.app'='腾讯会议'; 'com.tencent.wework'='企业微信'
  'com.tgwgroup.MiRearScreenSwitcher'='小米背屏切换'; 'com.tmri.app.main'='交管12123'
  'com.tongcheng.android'='同程旅行'; 'com.twitter.android'='X (Twitter)'; 'com.UCMobile'='UC浏览器'
  'com.umetrip.android.msky.app'='航旅纵横'; 'com.valvesoftware.android.steam.community'='Steam'
  'com.xiangtian.pixcake'='像素蛋糕'; 'com.xiaomi.gamecenter'='游戏中心'
  'com.xiaomi.mibrain.speech'='小爱语音'; 'com.xiaomi.scanner'='扫一扫'; 'com.xiaomi.shop'='小米商城'
  'com.xiaomi.smarthome'='米家'; 'com.xiaomi.tinygame'='小游戏'; 'com.xiaomi.vipaccount'='小米社区'
  'com.xiaomi.youpin'='小米有品'; 'com.xingin.xhs'='小红书'; 'com.xs.fm'='喜马拉雅'
  'com.xunlei.downloadprovider'='迅雷'; 'com.xunmeng.pinduoduo'='拼多多'
  'com.yitong.mbank.psbc'='邮储银行'; 'com.youdao.dict'='有道词典'; 'com.zhihu.android'='知乎'
  'ctrip.android.view'='携程'; 'dev.mobileclaw.app'='MobileClaw（你开发的）'
  'host.exp.exponent'='Expo Go'; 'io.wallpaperengine.weclient'='Wallpaper Engine'
  'mark.via'='Via浏览器'; 'mega.privacy.android.app'='MEGA'; 'moe.shizuku.privileged.api'='Shizuku'
  'net.csdn.csdnplus'='CSDN'; 'notion.id'='Notion'; 'org.mewx.wenku8'='轻小说文库'
  'org.telegram.messenger'='Telegram'; 'org.thunderdog.challegram'='Telegram X'
  'tv.danmaku.bili'='哔哩哔哩'; 'tv.twitch.android.app'='Twitch'
  'com.miui.home'='桌面'; 'com.android.systemui'='系统界面'; 'com.android.settings'='设置'
  'com.miui.securitycenter'='安全中心'; 'com.lbe.security.miui'='权限管理'
  'com.android.providers.media.module'='媒体存储'; 'com.android.providers.contacts'='联系人存储'
  'com.android.providers.calendar'='日历存储'; 'com.android.providers.telephony'='电话存储'
  'com.miui.notes.fallback'='小米笔记'; 'com.android.printspooler'='打印服务'
  'com.google.android.tts'='Google 语音合成'
  'com.android.wallpaper'='壁纸'; 'com.miui.wallpaper'='壁纸'
}

# ---------------------------------------------------------------- 出表
# URL 协议里绝大多数是推送/支付/统计 SDK 的内部管道，不是给人用的接口。
# 这里按"垃圾特征"过滤，只留看起来是公开入口的协议；原始全量仍保留在 CSV 的 URL协议 列。
$junkScheme = '^(ut\.|tencent\d|pp[a-z0-9]{4,}|com[._]|cn[._]|[0-9a-f]{7,}$|h[0-9a-f]{6,}$|default_value$|data_assistant$|widgetid$|scenetype$|qts$|players?$|about$|package$|openapp$|gsdk|sejsbhycol)' 
$junkContains = 'alipay_|_alipay|cashier|walletbox|_push|push_|^push|_sdk$|_sdk_|sdkback|sslocal|saitama|wtlogin|txdt'
function Get-PublicSchemes($schemes) {
  $schemes | Where-Object { $_ -notmatch $junkScheme -and $_ -notmatch $junkContains } | Sort-Object
}

$rows = @()
foreach ($pkg in ($allPkgs.Keys | Sort-Object)) {
  $caps = if ($capMap.ContainsKey($pkg)) { $capMap[$pkg] } else { @() }
  $sch  = if ($schemeMap.ContainsKey($pkg)) { $schemeMap[$pkg] } else { @() }
  $pub  = Get-PublicSchemes $sch
  $isSystem = $systemPkgs.ContainsKey($pkg)
  # 只保留"至少能干一件事"的 App，滤掉纯后台零件
  if (($caps | Measure-Object).Count -eq 0 -and ($sch | Measure-Object).Count -eq 0 -and -not $roles.ContainsKey($pkg)) { continue }
  $rows += [pscustomobject]@{
    "包名"       = $pkg
    "名称"       = if ($names.ContainsKey($pkg)) { $names[$pkg] } else { "" }
    "类型"       = if ($isSystem) { "系统" } else { "第三方" }
    "系统角色"   = if ($roles.ContainsKey($pkg)) { $roles[$pkg] } else { "" }
    "公开协议"   = ($pub -join " ")
    "内部协议数" = (($sch | Measure-Object).Count) - (($pub | Measure-Object).Count)
    "URL协议全量" = (($sch | Sort-Object) -join " ")
    "能力数"     = ($caps | Measure-Object).Count
    "能力"       = (($capabilities.Keys | Where-Object { $caps -contains $_ }) -join " ")
  }
}

$csv = Join-Path $OutDir "app-capabilities.csv"
$rows | Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8
Write-Host "`nCSV -> $csv  （$($rows.Count) 行）"

# Markdown：宽表（✅/空）
$capNames = $capabilities.Keys
$md = Join-Path $OutDir "app-capabilities.md"
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("# 安卓设备能力清单")
[void]$sb.AppendLine()
[void]$sb.AppendLine("> 由 collect.ps1 自动生成。一行一个 App，一列一个它能对外提供的能力（✅ = 可被调用）。")
[void]$sb.AppendLine("> 只列出至少能干一件事的 App；纯后台零件已过滤。")
[void]$sb.AppendLine()
[void]$sb.AppendLine("| 包名 | 名称 | 类型 | URL协议 | " + ($capNames -join " | ") + " |")
[void]$sb.AppendLine("|---|---|---|" + ("---|" * ($capNames.Count + 1)))
foreach ($r in ($rows | Sort-Object -Property @{Expression="能力数";Descending=$true}, 包名)) {
  $has = if ($capMap.ContainsKey($r.包名)) { $capMap[$r.包名] } else { New-Object System.Collections.Generic.HashSet[string] }
  $cells = foreach ($c in $capNames) { if ($has.Contains($c)) { "✅" } else { "" } }
  [void]$sb.AppendLine("| ``$($r.包名)`` | $($r.名称) | $($r.类型) | $($r.公开协议) | " + ($cells -join " | ") + " |")
}
[void]$sb.AppendLine()
[void]$sb.AppendLine("## 能力 -> App 反向索引")
[void]$sb.AppendLine()
foreach ($c in $capNames) {
  $who = $rows | Where-Object { $capMap.ContainsKey($_.包名) -and $capMap[$_.包名].Contains($c) } |
         ForEach-Object { if ($_.名称) { $_.名称 } else { $_.包名 } }
  [void]$sb.AppendLine("### $c  （$(($who|Measure-Object).Count) 个）")
  [void]$sb.AppendLine()
  [void]$sb.AppendLine(($who -join "、"))
  [void]$sb.AppendLine()
}
$sb.ToString() | Out-File -FilePath $md -Encoding utf8
Write-Host "MD  -> $md"
