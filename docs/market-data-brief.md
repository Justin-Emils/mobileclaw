# 市场数据与采纳趋势 · MobileClaw 方向数据依据

> 检索日：2026-10-07。所有数字附来源与年份；无可靠公开数据处标注 [估算] + 假设。置信度标 H/M/L。

## 1. Android 版本分布 — 决定 minSdk 与存储模型

| 版本(API) | Google官方全球份额(2025-12-01) | 官方累计可覆盖 | StatCounter全球(2025-11) | StatCounter中国(2025-11) |
|---|---|---|---|---|
| Android 16 (36) | 7.5% | 7.5% | — | — |
| Android 15 (35) | 19.3% | 26.8% | 30.6% | 24.4% |
| Android 14 (34) | 17.2% | 44.0% | 15.6% | 11.2% |
| Android 13 (33) | 13.9% | 57.9% | 15.2% | 8.7% |
| Android 12 (31) | 11.4% | 69.3% | 11.1% | 19.6% |
| Android 11 (30) | 13.7% | **82.9%** | 9.4% | 4.1% |
| Android 10 (29) | 7.8% | 90.8% | 4.8% | ~3.2% |

**洞察/建议**：分区存储自 Android 11(API30) 生效 → **minSdk 30 的累计覆盖 ~83%**，中国因 Android 12/15 占比极高、12 以下长尾仍在（Android 5.0 中国约 13%），minSdk 30 是中国市场合理下限（H）。全文件访问(MANAGE_EXTERNAL_STORAGE)与 W^X 限制在 API29+ 全量适用（H）。中国厂商 ROM 适配慢，实际 15 占比会滞后于 StatCounter 值（M）。

## 2. 侧载 / 替代分发渠道规模

| 渠道 | 规模 | 来源(年份) |
|---|---|---|
| F-Droid 应用数 | 4,061 款（+547 YoY），仅 ~21% 可复现构建 | F-Droid 年报(2025) |
| F-Droid 下载量 | 2024 全年 5,716 万次应用下载；2025 1–8 月 4,075 万次 | F-Droid 指标(2025) |
| APK 镜像站 | 7 站共 3,400 万版本/2,700 万包；APKCombo 1,200 万包 | ACM IMC'25(2025) |
| APKMirror | 月访问 ~8,000 万（自报）；Similarweb Q4'25 3 月 1,830 万 | Similarweb(2025) |
| 中国商店份额 | 华为 27.6%/3.39亿MAU、腾讯 14.1%、vivo~12%、小米~10%、OPPO~8%；厂商店合计 ~60% | Mighil/AppInChina(2025) |

**关键风险**：Google 开发者注册新规 **2026-09 起强制实名+上报签名密钥**，F-Droid 称其为"灭绝事件"——侧载/F-Droid/GitHub Releases 这条分发路径本身在 2026H2 面临结构性威胁（H）。**结论：不能把 F-Droid/侧载当作稳定长期渠道**。

## 3. 极客运行时天花板（"依赖用户自建环境"模式）

| 运行时 | 规模 | 来源(年份) |
|---|---|---|
| Termux（Google Play） | 1,000万+ 安装档位；估算 3,342 万 | androidrank(2026-09) |
| Termux（F-Droid） | 累计 50.6 万下载 | F-Droid metrics(2025) |
| Shizuku | GitHub 3.09万 star / 3,239 fork；最新 v13.6.0(2025-05) | RepositoryStats(2026) |

**洞察**：极客自建环境是**量级 1,000万–3,000万**的小众池，且 Shizuku 需"每次重启后重新授权"、Termux 需改配置文件——**操作门槛把可达用户砍到极客圈**（H）。这是该模式的**明确天花板**。

## 4. 手机端 AI 使用习惯与端侧模型现状

| 指标 | 数值 | 来源(年份) |
|---|---|---|
| 中国用户用过手机 GenAI | 95.3%；通用大模型 63.7% | 京东/中国电子报(2025) |
| 全球使用 GenAI 应用 | ~75%，38% 付费 | Omdia(2025) |
| 与手机 AI Agent 对话 | 仅 14% | Omdia(2025) |
| 期望"跨 App 一句话执行任务" | 67.8%（中国） | 京东(2025) |
| 移动端 AI 助手渗透 | 桌面 36% / 移动 24% | Comscore(2025) |
| 端侧可跑模型 | Qwen3-4B（GGUF-Q4<4GB，INT8~2GB，iPhone15Pro 可跑）；Apple FM ~3B；Gemini Nano | 阿里(2025-08) |

**洞察**：**"问答/搜索"已是刚需，"真正执行任务"仍是少数（14%）**——需求与实现有 67.8% vs 14% 的巨大缺口，这正是 MobileClaw 的机会（M）。

## 5. LLM API 成本门槛

| 模型 | 输入 $/1M | 输出 $/1M | 来源(年份) |
|---|---|---|---|
| Gemini 2.0 Flash | $0.075 | $0.30 | tokenpapa(2025) |
| GPT-4o mini | $0.15 | $0.60 | OpenAI(2024) |
| DeepSeek V3 | $0.27 | $1.10 | DeepSeek(2025) |
| DeepSeek-V4-Flash | $0.14 | $0.28 | llmapiprices(2025) |

**洞察**：3 年降幅 **95–99%**（GPT-4 从 $30 → 现 $0.10–2.5/M）；预算模型折合 **≈¥1–2/百万输入 token**。**"自填 API key"门槛已极低**（重度个人用户月成本约 ¥5–30）[估算，假设日 1M token]（H）。**结论：成本不是障碍，分发与合规才是。**

## 6. 合规/生态风险与可触达用户估算 [估算]

- **Android 17（API37，2026-06-16 稳定）AAPM**：开启后**仅 isAccessibilityTool="true" 可用无障碍 API**，自动撤销自动化/助手类应用权限（Android Authority/heise 2026-03，H）；AAPM 同时**封禁侧载**。但 AAPM 为**用户主动开启**的少数高风险场景，对大盘影响有限 [假设开启率 <5%]。
- **Play 政策**：MANAGE_EXTERNAL_STORAGE 不在 AI Agent 允许类别 → Play 渠道直接封死（项目已确认，H）。
- 可触达规模估算：TAM = 全球 Android 12+ 设备 ≈ **24 亿**[基于 StatCounter 全球约 35 亿 Android × 69%]；SAM（愿侧载的极客）≈ **2,000万–5,000万**（以 Termux 10M+ 安装为基座上浮）；SOM（2026–27 现实可得）≈ **10万–100万**。**中国**：Android 12+ 约 60–70% 的约 10 亿国产安卓设备，但分发受厂商商店管控，侧载更受限。

## 数据来源清单

1. Google 官方分布 distributions.json（2025-12-01）— heise / composables.com/android-distribution-chart
2. StatCounter Global Stats 全球/中国 Android 版本份额（2025-11）
3. F-Droid 年报 "F-Droid in 2025"（2026-01）；F-Droid 指标 MR（2025-08）
4. androidrank.org Termux（2026-09）；apkmirror Termux F-Droid（2025）
5. RepositoryStats RikkaApps/Shizuku（2026）
6. Mighil "Google Play in China"（2025）；Business of Apps App Stores List（2025）
7. ACM IMC'25 "Mirror Mirror"（2025-11）；Similarweb via apkprompt（2025）
8. 京东消费研究院 / 中国电子报（2025-08）；Omdia via GSMA Mobile AI（2025）；Comscore AI Intelligence Report（2025-12）
9. 阿里 Qwen3-4B 发布（2025-08）；llmapiprices.xyz & tokenpapa & tokencost.app（2025–26）
10. Android Authority / heise / ThaiCERT — Android 17 AAPM（2026-03）；Android Developers Blog（2026-06）
11. F-Droid / App Fair 关于 Google 开发者注册新规（2025-2026）
