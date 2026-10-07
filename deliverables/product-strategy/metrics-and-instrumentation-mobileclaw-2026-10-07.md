# MobileClaw 成功指标体系与埋点方案

> 作者：数析（数据分析师）｜日期：2026-10-07｜对齐 roadmap 阶段门禁 S0–S3
> 数字来源：`[gate]`=路线图门禁阈值（对齐，非新造）｜`[估]`=估算+假设｜`[市]`=market-data-brief

## 一、北极星指标（候选 → 推荐）

| 候选 | 衡量什么 | 为何可能误导 |
|---|---|---|
| 周动作执行会话数 | 总量活跃 | 被少数重度/批量用户刷高，不问来源 |
| 周动作活跃用户 (WAU-act) | 广度 | 被引导/onboarding 拉来的一次性用户也计入 |
| **自发复用率** = 7日内**无提示主动**发起≥2次动作的用户 / 周活用户 | **真会用** vs 被引导 | 需防诱导，靠 initiation_mode 判定 |

**推荐：自发复用率。** 直接对齐 S0 最硬门禁（≥3人 7日内自发复用≥2次）`[gate]`，是 PRD 的 PMF 前瞻信号。搭档深度指标：自发起用户的**周动作次数中位数**（防"广而浅"）。

## 二、一级指标体系（五组）

| 组 | 指标 | 目标门槛 | 依据 | 测量方式 |
|---|---|---|---|---|
| 激活 | 首次价值达成率（Share→1次成功动作） | ≥50% | S1门禁`[gate]` | 漏斗 share_in→exec_result(success) |
| 激活 | 解析成功率 | ≥90% | 假设主流意图可解析`[估]` | intent_parse.parse_ok |
| 激活 | 首次价值时延 | <90s | 零设置定位`[估]` | t(exec_success)−t(share_in) |
| 留存 | D7 | ≥25% | S1门禁`[gate]` | cohort 回访 |
| 留存 | D30 | ≥15% | D7按行业衰减曲线`[估]` | cohort 回访 |
| 留存 | 自发复用率（7日） | S0≥3/5–8人`[gate]`；S1≥20%`[估]` | S0门禁 | action_session(initiation_mode=self) |
| 留存 | 周活动作次数（自发起用户中位） | ≥3 | `[估]` | 会话计数 |
| 入口进阶 | tier1→tier2（SAF授权）转化 | ≥15% | S1门禁`[gate]`，No-Go<5% | tier2_prompt→tier2_result(accept) |
| 入口进阶 | 授权后频次变化 | 授权后7日人均动作/授权前 ≥1.5× | `[估]` | 同用户前后对比 |
| 护城河 | 模型可换使用率 | ≥10% | 极客核心占比`[估]` | provider_change 去重用户/WAU |
| 护城河 | 端侧模型启用率 | ≥5% | `[估]` | ondevice_enable 去重/WAU |
| 护城河 | shell/python 工具调用率 | ≥20% | S2门禁`[gate]` | exec_result.tool 族 |
| 质量信任 | 任务成功率 | ≥85% | `[估]` | exec_result.status≠fail |
| 质量信任 | 审批拒绝/撤销率 | 观测（高=解析/预览差），无硬目标 | 防"审批疲劳" | approval_result.decision |
| 质量信任 | 审批超时率 | <5% | `[估]` | decision=timeout |
| 质量信任 | **数据损失事件数** | **=0（硬约束）** | 信任底线 | 本地计数+异常上报 |

## 三、埋点事件表（12 事件，覆盖全部必测项）

| 事件名 | 触发时机 | 关键属性 |
|---|---|---|
| `share_in` | 系统分享面板切入 | source_app_cat, mime_cat, files_count, tier |
| `session_start` | 动作会话发起 | **initiation_mode**(self/prompted), tier, entry |
| `intent_parse` | 意图→工具计划解析 | action_type, parse_ok, provider_cls, latency_ms |
| `preview_shown` | 变更预览展示 | files_count, ops_count, action_type |
| `approval_result` | 审批通过/拒绝/超时 | decision, risk_class, op_count, duration_ms |
| `exec_result` | 执行完成/部分失败 | status, ops_ok, ops_failed, tool, error_code, duration_ms |
| `share_out` | 结果回分享 | target_app_cat, files_count |
| `tier2_prompt` | SAF 授权引导展示 | after_tier1_n, context |
| `tier2_result` | 授权接受/拒绝 | decision |
| `provider_change` | 更换 provider | from_cls, to_cls(local/remote/compat), ok |
| `ondevice_enable` | 端侧模型启用 | model_family, size_tier |
| `error` | 错误分类 | error_code, stage(parse/approve/exec), tool, retriable |

## 四、必须规避的虚荣指标

| 虚荣指标 | 规避理由 |
|---|---|
| 总对话数 / 总 token 数 | 与"真执行"无关；高 token 常意味着啰嗦或失败重试 |
| 累计安装量 / 下载量 | 分发≠激活；侧载样本偏极客，不代表大盘 |
| 总文件处理数 | 一次批量即可刷高，不反映复用 |
| DAU 绝对值（未拆分来源） | 引导拉动的 DAU 会掩盖无 PMF 的事实 |
| "审批通过率 100%" | 若当目标会诱导只做低风险动作；拒绝率低≠好 |

## 五、合规与隐私约束（硬约束：数据不出机 / 本地优先）

1. **默认本地聚合**：埋点先落设备内 SQLite 计数/直方图，原始事件**不出机**；上报仅限自愿的聚合计数。
2. **显式 opt-in**：遥测**默认关闭**（首次启动明确选择）；侧载/极客版默认全关，端侧模型用户可强制全本地。
3. **禁止上传**：文件内容、文件名、路径、tree URI、剪贴板、对话文本、prompt、API key / endpoint。
4. **最小化字段**：文件仅上报 `mime_cat` 与 `files_count` 分桶；provider 仅上报**类别**与是否变更，绝不上报 URL/key。
5. **标识与追踪**：仅随机安装级 UUID（可重置），不做跨 App 追踪，不含账号 PII；分组哈希用**设备本地加盐**，盐不出机。
6. **保留与删除**：本地 90 天滚动删除；提供"导出/删除我的数据"；已上报聚合数据 TTL 90 天。

> 与定位一致性：以上规则使埋点在"数据不出机"前提下仍可衡量北极星（自发复用）与质量底线（数据损失=0）。
