"""把三份采集脚本的产出合成一个完整工作簿。"""
import collections
import csv
import os
import re

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "安卓应用能力清单.xlsx")

CAPABILITIES = [
    "接收分享·文字", "接收分享·图片", "接收分享·视频", "接收分享·任意文件", "接收分享·多个文件",
    "处理选中文字", "编辑图片", "打开网页链接", "打开PDF", "打开视频文件", "打开音频文件",
    "当文件选择器", "拨号", "发短信", "发邮件", "地图导航", "建日程", "设闹钟", "设计时器",
    "建联系人", "拍照", "录音", "语音识别", "建备忘", "网页搜索", "扫码", "设壁纸", "文字朗读(TTS)",
]

HEAD_FILL = PatternFill("solid", fgColor="2E6BE6")
HEAD_FONT = Font(bold=True, color="FFFFFF", size=10)
BODY_FONT = Font(size=10)
THIN = Side(style="thin", color="D9D9D9")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
OK_FONT = Font(size=10, color="1B7F3B", bold=True)
OK_FILL = PatternFill("solid", fgColor="E8F6EC")
WARN_FILL = PatternFill("solid", fgColor="FFF6E5")
BAD_FILL = PatternFill("solid", fgColor="FDEDED")
MONO = Font(size=9, name="Consolas")

# 深链字典里要滤掉的 SDK 内部协议
JUNK_SCHEME_PREFIX = ("agoo", "active-dl", "umeng", "ut.")
JUNK_HOST_HINT = ("push", "thirdpush", "sdk", "oauth.callback", "callback")


def read(name):
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def style_header(ws, row=1):
    for c in range(1, ws.max_column + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = HEAD_FILL
        cell.font = HEAD_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = BORDER
    ws.row_dimensions[row].height = 28


def widths(ws, spec):
    for col, w in spec.items():
        ws.column_dimensions[col].width = w


def paint(ws, mono_cols=(), wrap_cols=(), center_cols=()):
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, max_col=ws.max_column):
        for cell in row:
            cell.border = BORDER
            cell.font = BODY_FONT
            if cell.column in mono_cols:
                cell.font = MONO
            if cell.column in wrap_cols:
                cell.alignment = Alignment(wrap_text=True, vertical="top")
            if cell.column in center_cols:
                cell.alignment = Alignment(horizontal="center")


# ------------------------------------------------------------------ 1 能力矩阵
def sheet_matrix(wb, rows):
    ws = wb.active
    ws.title = "能力矩阵"
    ws.append(["名称", "包名", "类型", "系统角色", "能力数", "公开URL协议"] + CAPABILITIES)
    for r in sorted(rows, key=lambda x: (-int(x["能力数"] or 0), x["名称"] or x["包名"])):
        caps = set((r["能力"] or "").split())
        ws.append([r["名称"] or "", r["包名"], r["类型"], r["系统角色"] or "",
                   int(r["能力数"] or 0), r["公开协议"] or ""]
                  + ["✅" if c in caps else "" for c in CAPABILITIES])
    style_header(ws)
    widths(ws, {"A": 20, "B": 42, "C": 8, "D": 16, "E": 7, "F": 40})
    for i in range(len(CAPABILITIES)):
        ws.column_dimensions[get_column_letter(7 + i)].width = 11
    paint(ws, mono_cols=(2,), center_cols=(3, 5))
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, min_col=7, max_col=ws.max_column):
        for cell in row:
            cell.alignment = Alignment(horizontal="center")
            if cell.value == "✅":
                cell.font = OK_FONT
                cell.fill = OK_FILL
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = f"A1:{get_column_letter(ws.max_column)}{ws.max_row}"


# ------------------------------------------------------------------ 2 能力反向索引
def sheet_index(wb, rows):
    ws = wb.create_sheet("能力反向索引")
    ws.append(["能力", "能做到的 App 数", "都有谁"])
    for cap in CAPABILITIES:
        who = [r["名称"] or r["包名"] for r in rows if cap in set((r["能力"] or "").split())]
        ws.append([cap, len(who), "、".join(who) if who else "（无）"])
    style_header(ws)
    widths(ws, {"A": 20, "B": 14, "C": 110})
    paint(ws, wrap_cols=(3,), center_cols=(2,))
    ws.freeze_panes = "A2"


# ------------------------------------------------------------------ 3 深链·常用（按协议聚合）
SKIP_SCHEME = {"http", "https", "file", "content", "market", "ftp", "javascript", "about", "tel", "geo",
               "mailto", "sms", "smsto", "mms", "mmsto", "ed2k", "magnet", "thunder", "flashget"}
BLACKLIST_SCHEME = {"android_secret_code", "chimera-action", "version", "wear", "app", "theme", "newhome",
                    "mifg", "bluelite", "voice_agent", "baidu_lauch", "flyme_3dtouch", "ucweb", "uclink",
                    "content", "file", "browser", "widget", "widgetid"}
JUNK_BLOB = re.compile(
    r"pay|auth|login|oauth|callback|sign|bind|wallet|verifycode|token|push|track|stat|umeng|agoo|report"
    r"|analytics|bugreport|crash|miniapp|smallapp|plugin|webapp|sdk|test|debug|/log|logcheck|monitor"
    r"|sample|feedback|assistant|privacy|internal",
    re.I,
)
GOOD_HINT = re.compile(
    r"video|bangumi|movie|live|song|music|play|playlist|album|artist|item|goods|product|detail|shop|mall"
    r"|store|order|cart|coupon|search|user|space|profile|author|uper|note|feed|topic|article|read|book"
    r"|comic|chat|message|scan|qr|home|main|map|navi|route|ticket|history|favorite|collect|follow",
    re.I,
)
PURPOSE = [
    (r"video|bangumi|movie|episode|season", "视频/番剧"),
    (r"/mv|live", "直播/视频"),
    (r"song|/music|/play|audio|/dj", "音乐播放"),
    (r"playlist|album|artist", "歌单/专辑/歌手"),
    (r"item|goods|product|/detail", "商品/详情页"),
    (r"shop|mall|store", "店铺/商城"),
    (r"order|cart|coupon|bill", "交易/订单"),
    (r"search|query", "搜索"),
    (r"user|space|profile|author|uper", "用户主页"),
    (r"note|feed|topic|article|read|book|comic|opus|post", "内容/阅读"),
    (r"chat|message|/im|conversation", "聊天/消息"),
    (r"scan|qr", "扫码"),
    (r"home|main|root|index|splash", "首页"),
    (r"map|navi|route|geo", "地图/导航"),
    (r"ticket|train|flight", "票务"),
    (r"history|favorite|collect|follow", "个人列表"),
    (r"camera|capture|photo", "拍照"),
]


def guess_purpose(blob):
    for pat, name in PURPOSE:
        if re.search(pat, blob, re.I):
            return name
    return "打开指定页面"


def sheet_common(wb, rows):
    ws = wb.create_sheet("深链·常用")
    ws.append(["协议", "主要App", "这个App的条目", "推测用途（按路径关键词猜的，仅供参考）", "典型深链（挑过的）", "全部条目", "典型 host", "典型 路径"])
    groups = {}
    for r in rows:
        s = r["协议"]
        if s.lower() in SKIP_SCHEME or s in BLACKLIST_SCHEME:
            continue
        if len(s) >= 9 and s.islower() and s.isalnum():
            continue
        if JUNK_BLOB.search(s):
            continue
        blob = " ".join([r["深链示例"], r["host"] or "", r["路径"] or ""])
        if JUNK_BLOB.search(blob):
            continue
        groups.setdefault(s, []).append(r)

    out = []
    for s, items in groups.items():
        apps = collections.Counter(x["App"] or x["包名"] for x in items)
        main_app, main_n = apps.most_common(1)[0]
        scored = sorted(items, key=lambda x: (0 if GOOD_HINT.search(" ".join([x["深链示例"], x["host"] or "", x["路径"] or ""])) else 1,
                                              0 if x["路径"] else 1))
        ex, hosts, paths = [], [], []
        for x in scored:
            u = x["深链示例"]
            if u not in ex:
                ex.append(u)
            if x["host"] and x["host"] not in hosts:
                hosts.append(x["host"])
            if x["路径"] and x["路径"] not in paths:
                paths.append(x["路径"])
            if len(ex) >= 4:
                break
        out.append([
            s, main_app, main_n, guess_purpose(ex[0] + " " + s),
            "  |  ".join(ex), len(items),
            ", ".join(hosts[:4]), ", ".join(paths[:4]),
        ])
    out.sort(key=lambda x: (-x[5], x[0]))
    for row in out:
        ws.append(row)
    style_header(ws)
    widths(ws, {"A": 18, "B": 18, "C": 13, "D": 16, "E": 74, "F": 9, "G": 34, "H": 30})
    paint(ws, mono_cols=(1,), wrap_cols=(5, 7, 8), center_cols=(3, 6))
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = f"A1:H{ws.max_row}"
    return len(out)


# ------------------------------------------------------------------ 4 深链字典（全量）
def sheet_dict(wb, rows):
    ws = wb.create_sheet("深链字典(全量)")
    ws.append(["协议", "深链示例", "App", "host", "路径", "类型", "包名", "组件"])
    kept = []
    for r in rows:
        scheme = r["协议"]
        host = r.get("host", "") or ""
        path = r.get("路径", "") or ""
        if scheme.startswith(JUNK_SCHEME_PREFIX):
            continue
        if any(h in host for h in JUNK_HOST_HINT) or any(h in path for h in JUNK_HOST_HINT):
            continue
        if len(scheme) >= 9 and scheme.islower() and scheme.isalnum() and not host and not path:
            continue
        kept.append(r)
    kept.sort(key=lambda r: (r["协议"], r["App"] or r["包名"]))
    for r in kept:
        ws.append([r["协议"], r["深链示例"], r["App"] or "", r.get("host", ""),
                   r.get("路径", ""), r["类型"], r["包名"], r["组件"]])
    style_header(ws)
    widths(ws, {"A": 18, "B": 46, "C": 18, "D": 26, "E": 30, "F": 11, "G": 40, "H": 52})
    paint(ws, mono_cols=(1, 7, 8), wrap_cols=(2, 4, 5), center_cols=(6,))
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = f"A1:H{ws.max_row}"
    return len(kept)


# ------------------------------------------------------------------ 4 深链实测
def sheet_tested(wb, rows):
    ws = wb.create_sheet("深链实测")
    ws.append(["深链", "说明", "响应数", "谁响应"])
    for r in rows:
        ws.append([r["深链"], r["说明"], int(r["响应数"] or 0), r["谁响应"]])
    style_header(ws)
    widths(ws, {"A": 34, "B": 26, "C": 8, "D": 60})
    paint(ws, mono_cols=(1,), wrap_cols=(4,), center_cols=(3,))
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, min_col=3, max_col=3):
        for cell in row:
            if cell.value == 0:
                cell.fill = BAD_FILL
                cell.font = Font(size=10, color="B4232A", bold=True)
            else:
                cell.fill = OK_FILL
                cell.font = OK_FONT
    ws.freeze_panes = "A2"


# ------------------------------------------------------------------ 5 数据接口
def sheet_iface(wb, rows):
    ws = wb.create_sheet("数据接口")
    ws.append(["数据接口 (authority)", "归属App", "包名", "类型", "实测结果", "需要什么权限", "样例数据"])
    order = {"可读": 0, "可读·无数据": 1, "需要权限": 2, "未导出（第三方读不到）": 3, "URI 不存在": 4, "其它": 5, "无响应": 6}
    for r in sorted(rows, key=lambda x: (order.get(x["实测结果"], 9), x["类型"], x["归属App"] or x["包名"])):
        ws.append([r["数据接口(authority)"], r["归属App"], r["包名"], r["类型"],
                   r["实测结果"], r["需要权限"], r["样例数据"]])
    style_header(ws)
    widths(ws, {"A": 58, "B": 16, "C": 36, "D": 8, "E": 20, "F": 46, "G": 60})
    paint(ws, mono_cols=(1, 3, 6), wrap_cols=(7,), center_cols=(4,))
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, min_col=5, max_col=5):
        for cell in row:
            if cell.value == "可读":
                cell.fill = OK_FILL
                cell.font = OK_FONT
            elif cell.value and cell.value.startswith("未导出"):
                cell.fill = BAD_FILL
            elif cell.value == "需要权限":
                cell.fill = WARN_FILL
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = f"A1:G{ws.max_row}"


# ------------------------------------------------------------------ 6 媒体库服务
def sheet_media(wb, rows):
    ws = wb.create_sheet("媒体库服务")
    ws.append(["App", "包名", "实现的服务"])
    for r in rows:
        ws.append([r["App"] or "", r["包名"], r["实现的服务"]])
    style_header(ws)
    widths(ws, {"A": 22, "B": 38, "C": 70})
    paint(ws, mono_cols=(2, 3))
    ws.freeze_panes = "A2"


# ------------------------------------------------------------------ 7 说明
NOTES = [
    ("这是一份什么表", ""),
    ("", "小米 2509FPN0BC（Android 16 / SDK 36）上，每个 App 对外暴露的能力，全部由 adb 实测得出。"),
    ("", ""),
    ("安卓的「能力」分三层", ""),
    ("", "第一层 · 门（Intent/Activity/Service）：能让别的 App「跳进来」。例如接收分享、打开链接、拨号。"),
    ("", "第二层 · 数据（ContentProvider）：能让别的 App「把数据取出来」。"),
    ("", "第三层 · 参数（深链的 host 和路径）：跳进去之后带什么参数。"),
    ("", ""),
    ("这七张表各对应什么", ""),
    ("能力矩阵 / 能力反向索引", "第一层。234 个 App × 28 项能力。"),
    ("数据接口", "第二层。713 个数据接口，实测了 183 个。"),
    ("深链·常用", "第三层的干净视图：按协议聚合，381 个协议，一条一行，带典型深链和推测用途。"),
    ("深链字典(全量)", "第三层的原始转储，6639 条。里面大部分不是给人看的，见下。"),
    ("深链实测", "实测 58 条深链，看谁真的响应。"),
    ("媒体库服务", "18 个 App 开放了可被浏览的媒体库（MediaBrowserService）。"),
    ("", ""),
    ("深链字典里为什么有一大堆看不懂的", ""),
    ("", "每个 App 的安装包里都塞了一堆第三方 SDK（推送、支付、统计、分享、广告）。"),
    ("", "每个 SDK 都注册自己的协议名用来互相通信，所以条目数会爆炸。构成大致是："),
    ("", "  · 约 55% 是 SDK 内部管道 / 文件类型过滤器（content:// 、随机串协议）—— 不是给用户用的"),
    ("", "  · 约 27% 是 App 的真实功能页路由（video / item / search / user / live …）—— 这部分有用"),
    ("", "  · 其余是支付回调、登录授权、小程序容器。"),
    ("", "「深链·常用」已经把管道滤掉了；要查某个 App，在「深链字典(全量)」里按 App 列筛选。"),
    ("", "注意：一个 App 注册几百条路由是正常的，就像网站的 URL 路由表。"),
    ("", ""),
    ("必须知道的边界", ""),
    ("", "· 枚举只能发现「已经开好的门」。App 没声明的接口，永远枚举不出来。"),
    ("", "· 数据接口实测结果：可读 12 个、需要权限 47 个、未导出 88 个。"),
    ("", "  连 adb 的系统身份都被拒，普通 App 更不可能读。例：微信有 ShareableChatRecords（可分享聊天记录），"),
    ("", "  但要 com.tencent.mm.app.provider.ShareableChatRecords.READ_BY_CONSENT；QQ 的 qq.friendlist 直接「未导出」。"),
    ("", "· 裸协议常常不匹配：bilibili:// 无人响应，bilibili://video/1 才命中 —— 因为过滤器带 host。"),
    ("", "  这就是「深链字典」比「协议列表」值钱的地方。"),
    ("", "· 深链字典里 host 和路径都为空的，表示 App 没声明结构、由它自己内部解析（例如 orpheus://）。"),
    ("", "· 数据接口清单来自 dumpsys activity providers，只含系统已注册的 provider。"),
    ("", ""),
    ("怎么重跑", ""),
    ("", "pwsh -NoProfile -ExecutionPolicy Bypass -File collect.ps1           # 能力矩阵"),
    ("", "pwsh -NoProfile -ExecutionPolicy Bypass -File collect-deep.ps1      # 数据接口 / 媒体库 / 深链实测"),
    ("", "pwsh -NoProfile -ExecutionPolicy Bypass -File collect-deeplinks.ps1 # 深链字典"),
    ("", "python build_xlsx.py                                              # 重新生成本工作簿"),
]


def sheet_notes(wb, stats):
    ws = wb.create_sheet("说明与方法")
    ws.append(["项目", "内容"])
    for a, b in NOTES:
        ws.append([a, b])
    for k, v in stats:
        ws.append([k, v])
    style_header(ws)
    widths(ws, {"A": 26, "B": 108})
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, max_col=2):
        for cell in row:
            cell.border = BORDER
            cell.font = BODY_FONT
            cell.alignment = Alignment(wrap_text=True, vertical="top")
        if row[0].value:
            row[0].font = Font(size=10, bold=True)


def main():
    caps = read("app-capabilities.csv")
    iface = read("data-interfaces.csv")
    dl = read("deep-links.csv")
    ddict = read("deep-link-dictionary.csv")
    media = read("media-services.csv")

    wb = Workbook()
    sheet_matrix(wb, caps)
    sheet_index(wb, caps)
    common = sheet_common(wb, ddict)
    kept = sheet_dict(wb, ddict)
    sheet_tested(wb, dl)
    sheet_iface(wb, iface)
    sheet_media(wb, media)

    readable = sum(1 for r in iface if r["实测结果"] == "可读")
    needperm = sum(1 for r in iface if r["实测结果"] == "需要权限")
    notexp = sum(1 for r in iface if r["实测结果"].startswith("未导出"))
    hit = sum(1 for r in dl if int(r["响应数"] or 0) > 0)
    stats = [
        ("本次统计", ""),
        ("", f"App 数 {len(caps)}；数据接口 {len(iface)} 个（可读 {readable} / 需要权限 {needperm} / 未导出 {notexp}）"),
        ("", f"深链声明 {len(ddict)} 条（去重后 {kept} 条入全量表，聚合出 {common} 个协议入「深链·常用」）"),
        ("", f"深链实测 {len(dl)} 条，命中 {hit} 条；媒体库服务 {len(media)} 个"),
    ]
    sheet_notes(wb, stats)
    wb.save(OUT)
    print(f"caps={len(caps)} iface={len(iface)} dict={len(ddict)}->{kept} tested={len(dl)} media={len(media)}")
    print(OUT)


if __name__ == "__main__":
    main()
