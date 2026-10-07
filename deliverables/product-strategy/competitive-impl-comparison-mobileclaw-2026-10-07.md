# 同领域实现对比（PRD 第 4 章输入）

> 作者：竞析（competitive-analyst）｜日期：2026-10-07
> 用途：钻到"这个功能别人怎么做"的实现层，给出可借鉴 / 需规避设计。

## 一、实现对比矩阵

| 产品 | ①入口 | ②本地文件动作 | ③审批/可审计 UX | ④模型可换·端侧 | ⑤离线 | ⑥上架 |
|---|---|---|---|---|---|---|
| **Operit AI**（开源 local-first 代表） | ⚠️ 对话/工作区为主，亦可"分享文件给 AI" | ✅ 40+工具，fs 读写/搜索/解压/转换 + Ubuntu24 PRoot | ⚠️ 权限分级(全局ASK/白名单ALLOW)，非逐步 diff | ✅ MNN/llama.cpp GGUF 本地 + 任意云 API | ✅ 可（本地模型） | ❌ 侧载（声明全盘+Shizuku+无障碍） |
| **PokeClaw** | ⚠️ 对话/悬浮/任务卡，无障碍驱动 | ⚠️ 以屏幕操作为主，文件动作弱 | ⚠️ playbook/guard、敏感先确认，无统一审计面板[推断] | ✅ Gemma4 端侧 + 云(OpenAI/Anthropic/Google)会话内切 | ✅ Local 完全离线 | ❌ GitHub 侧载（需无障碍） |
| **Google AI Edge Gallery** | ❌ 应用内作品集(Mobile Actions)，非分享面板 | ❌ 仅设备控制类函数(手电/日历)，无文件批处理 | ⚠️ Thinking Mode 可见推理，无审批/回看 | ✅ Gemma/.litertlm 可导入，端侧 100% | ✅ 完全离线 | ✅ Google Play |
| **OpenClaw 移动端** | ✅ 聊天/语音/相机 + iOS 分享扩展 / Android App Actions | ⚠️ 手机是节点，动作由 Gateway 编排 | ✅ 敏感命令默认关 + 逐项 allowlist + 手机批准/拒绝 | ⚠️ 模型路由在 Gateway，手机不自跑 | ❌ 必须连 Gateway | ✅ App Store + Play |
| **iOS 快捷指令(+Use Model)** | ✅ Show in Share Sheet + 主屏/Siri | ⚠️ 单/文本为主，可循环批量、Quick Look 预览 | ⚠️ 运行时权限提示，无统一审计（用户即作者） | ⚠️ 仅 On-device/Private Cloud/ChatGPT 三选，非任意 BYOK | ✅ 端侧可离线；ChatGPT 需网 | ✅ 系统内置 |
| **Tasker / MacroDroid** | ✅ 分享目标(File/Text Shared、AutoShare) | ✅ 强：SAF 或全盘、重命名/保存/批量（需自建宏） | ⚠️ 无逐步审批，靠预建流程+导入警告；非 AI | ❌ 无 LLM | ✅ 本地规则 | ✅ Play（全盘需声明审核） |
| **厂商内置（超级小爱2.0/蓝心小V Pro）** | ⚠️ 系统助手/语音/圈搜/灵感球，非分享面板 | ✅ 系统级：文件自动归类/命名/摘要、跨端搜文件、生成文档 | ✅ 敏感操作"先确认后执行"+记忆管理页+授权范围可控 | ⚠️ 仅自家模型(MiMo/蓝心)，旗舰端侧 | ⚠️ 部分端侧；专家/办公走云、积分计费 | ✅ 系统预装 |
| **ChatGPT / Claude 移动端** | ❌ 应用内上传/相机 | ❌ 只读上传，不落地改名/归档 | ❌ 无审批/审计 | ❌ 固定云模型 | ❌ 需网 | ✅ 商店 |

## 二、可借鉴的设计（抄哪一点）

1. **MacroDroid「File Shared to MacroDroid」触发器**：分享目标直接收文件 + magic text（`{file_shared_name/uri/app_pkg}`）+ SAF/全盘双模式 + 可选改名保存。→ 我们 Share 入口抄"接收→可改名保存"，并保留来源包名做上下文。*(来源1)*
2. **AI Edge Gallery · Mobile Actions**：单任务=单函数调用，270M FunctionGemma 微调后准确率 58%→85%。→ 用窄域小模型做**端侧意图→动作路由**，省 token、离线、快。*(来源3)*
3. **OpenClaw 移动端**：敏感命令默认关闭 + 逐项 allowlist + 手机端批准/拒绝。→ 落我们 PermissionGate 的"默认拒绝 + 显式白名单 + 手机作审批面"。*(来源5)*
4. **iOS 快捷指令**：Quick Look 预览后才落地 + 短流程固化为可复用动作。→ 对应我们"预览后执行"与 Skill 包。*(来源见②)*
5. **Operit 权限分级**：基础/无障碍/调试/管理员/root 五级自选上限 + 全局 ASK/白名单 ALLOW。→ 用"能力分级 + 白名单"替代单开关。*(来源7)*

## 三、必须规避的设计（别重复的坑）

1. **把无障碍当主路径**：PokeClaw/Operit/肉包都靠无障碍读 UI 树；Operit 明示"微信会扫描、严重封号"。Play 2026 政策禁自主 Agent → 绝不做主路径。
2. **全盘/root/Shizuku 当默认**：Operit 声明全盘+Shizuku+root 才完整 → 只能侧载。我们 Play-safe 默认，全盘仅侧载甜点。
3. **逐条确认造成确认疲劳**：HITL 共识——对每个文件都弹窗会训练用户盲点"同意"。只在**不可逆/越权**时弹，**批量=一次逻辑确认（看 diff/预览）**而非 N 次。*(来源8)*
4. **高估分享面板能力边界**：`ACTION_SEND` 目标只拿 URI + 临时读权，**无法把结果回传来源 App**（只能再发一次 chooser / 写回剪贴板）；Android 14 才有自定义 ChooserAction，且 AEP 强制走系统 chooser、禁自建分享菜单。→ 别承诺"原地改好回原 App"，收口设计为"改完→再次分享/保存"。
5. **幻觉直接落地文件操作**：高权即执行是 Operit/PokeClaw 的隐忧。→ 必须 PathGuard 词法 containment + 高危动作预览（匹配可逆性分级、fail-safe）。

## 四、差异化启示（影响功能取舍）

1. **没有一款同时做到"Play 可上架 + 模型可换 + 可审计审批"**：厂商内置（超级小爱/小V）有系统权限能平替文件动作，但锁死自家模型、无 BYOK/审计回看；开源 local-first（Operit/PokeClaw）模型可换/端侧强，却靠无障碍/Shizuku 只能侧载。这正是我们的空位。
2. **别打"文件动作覆盖面"军备竞赛**：厂商系统权限碾压，我们打不过。资源投到「模型可换 + 端侧意图路由 + 审批可见/可回看 + 可移植运行时」四件套；Share loop 是获取中间层的入口，不是护城河。
3. **审批 UX 要作为一等特性**（非对话框）：融合 OpenClaw allowlist + 快捷指令预览 + HITL"按可逆性分级/批量逻辑确认/记录审计"，做出**可回看的审批面板**——这是厂商 Agent 也没有的差异点。

## 来源清单

1. Android Developers — Send data to other apps / Sharesheet & custom actions：https://developer.android.com/training/sharing/send
2. MacroDroid Wiki — Trigger: File Shared to MacroDroid：https://wiki.macrodroid.com/wiki/index.php?title=Trigger:_File_Shared_to_MacroDroid
3. Google Developers Blog — On-Device Function Calling in Google AI Edge Gallery：https://developers.googleblog.com/on-device-function-calling-in-google-ai-edge-gallery/
4. Google Play — AI Edge Gallery（上架状态）：https://play.google.com/store/apps/details?id=com.google.ai.edge.gallery
5. OpenClaw Launch — OpenClaw Mobile App（节点/审批/分享扩展）：https://openclawlaunch.com/guides/openclaw-mobile-app
6. 百度百科 — PokeClaw：https://baike.baidu.com/item/PokeClaw/67731183
7. 掘金 — Operit AI 教程：权限分级（无障碍/调试/root）：https://juejin.cn/post/7621038426792247311
8. dev.to — Human in the loop: designing approvals people do not skip：https://dev.to/adityagoyal009/human-in-the-loop-designing-approvals-people-do-not-skip-1a7k
9. 腾讯新闻 — 超级小爱 2.0 专家模式 / 隐私守护：https://news.qq.com/rain/a/20260813A0995600
10. 凤凰科技 — vivo 蓝心小V Pro / 蓝心 Harness：https://tech.ifeng.com/c/8wTLq9JbtDa

> 说明：✅/⚠️/❌ 为竞析基于上述来源的实现层判断；标注 [推断] 处为缺乏直接证据的合理推测。
