# MobileClaw 项目状态

> **这份文档回答四个问题**：这个项目要做什么？现在做到哪了？什么还没写？接下来先写哪一块？
> 每个结论后面都跟证据（文件、行号、命令），**没有"应该差不多"这种话**。
>
> 最后更新：2026-10-09 · 分支 `myqiV1`

---

## 一、这个项目是什么

**一个手机本地的 AI agent。** 不是聊天应用——模型在这个产品里拿到的是**真实的手**：
能读写文件、跑脚本、跨应用操作，而每一次动手都被一个权限系统拦住并要求你确认。

### 产品目标（引自 `deliverables/product-strategy/prd-mobileclaw-2026-10-07.md` §1）

三个目标**正交**，任一不成立产品就不成立：

| # | 目标 | 含义 | 衡量 |
|---|---|---|---|
| **G1** | 零门槛 | 不会写脚本的人，**不进入任何系统设置**，用一句话完成一次真实的文件批处理 | 首次价值达成率 ≥50%，首值时延 <90s |
| **G2** | 可信可控 | Agent 的每一次动作都是**可见、可拒绝、可回看**的授权事件 | 任务成功率 ≥85%，**数据损失事件 = 0（硬约束）** |
| **G3** | 可移植 | 同一套内核与用户的技能/记忆**跨设备携带**，反厂商锁定 | 换机迁移成功率 ≥90%，模型可换使用率 ≥10% |

**北极星**＝7 日内**无提示主动发起 ≥2 次动作**的用户占周活的比例（自发复用率）。

### 两个阶段（同一个产品）

- **阶段 1（M0–M1）**：从系统**分享面板**切入，"一句话批量文件动作 → 结果再分享/保存"。
  零设置、Play-safe 可上架。**获客用。**
- **阶段 2（M2–M4）**：同一套内核做成**可移植的 Agent Harness**（模型可换、端侧可选、审批可审计、
  技能与记忆可携带）。**护城河是这四件套，不是"能整理文件"。**

### 架构

```
apps/mobile  ──▶  packages/capabilities  ──▶  packages/core
  (Expo/RN)          (工具、guard)               (纯内核)
```

**唯一那条规矩**：`packages/core` 永不 import 平台模块（不许 `node:fs`、不许 `react-native`、不许 `expo-*`）。
Agent 能做的一切都是**接口背后的服务**，在构造时注入。这是内核能在笔记本上跑测试、
而手机的脏活被关在 `apps/mobile` 里的原因。详见 `docs/architecture.md`。

---

## 二、现在做到哪了

### 能用、且**真机验证过**的

来源是 `docs/device-verification.md`（那份是"看到它工作"的记录，不是"测试通过"）：

| 能力 | 状态 |
|---|---|
| **文件这条主线** | ✅ 端到端通了。应用私有目录随便读写；共享存储（Download/Documents/DCIM/Pictures）在上「所有文件访问」后也能读写 |
| 会话历史 | ✅ 列表 / 打开还原 / 重启后还在 |
| Markdown 渲染 | ✅ 表格、代码块按真结构渲染，不是原样文本 |
| 权限闸门 | ✅ 弹窗真的会拦，拒绝后模型收到 `[E_PERMISSION_DENIED]` |
| 每会话独立工作区 | ✅ 四个会话四个目录，按会话 id 命名 |
| 完全离线自检 | ✅ 设置 → 自检，用脚本化 provider 走**真实**流水线，不需要 key |

底层是 22 个文件/系统/网络类工具（`fs_*` 7 个、`shell_*` 2 个、`web_fetch`、
`system_*` 6 个、`python_*` 3 个、`shizuku_*` 3 个）。

### 是桩、会自我解释的

`shell_run` / `python_run` / `shizuku_*` 在缺后端时**不假装成功**，而是报出缺什么、怎么开。
这是设计（架构不变量第 8 条：能力缺失要能解释），不是缺陷。

### 测试

| 套件 | 数量 |
|---|---|
| `packages/core` | 102 |
| `packages/capabilities` | 74 |
| `apps/mobile` | 194 |
| `eng/`（工具链解析器） | 17 |

typecheck 三个包全过，Metro 打包通过。**命令和坑见 `docs/dev-environment.md` 与下面的第七节。**

---

## 三、计划 vs 实际：**工作方向偏了**

这是最需要知道的一件事，写在最前面。

**PRD 的 `9.1 Out of scope（首发不做）` 里明确列着「跨应用 UI 自动化」，并把 `shizuku_*` 归到阶段 2（M2）。**
而目前投入最多的工作恰恰是**跨应用 UI 自动化（Shizuku）**——也就是排 M2 的东西。

同时，阶段 1（M0/M1）的两个硬前置**还没写**：

| 阶段 1 必备 | 状态 | 证据 |
|---|---|---|
| **分享面板接收入口** | ❌ **不存在** | `apps/mobile/android/app/src/main/AndroidManifest.xml:46-55` 只有 MAIN/LAUNCHER 和一个 `mobileclaw://` VIEW scheme，**没有任何 `ACTION_SEND` 的 intent-filter**。app 收不到分享进来的文件 |
| **SAF 目录授权**（PRD 称"M1 关键路径与阻塞项"） | ❌ **不存在** | 全仓库搜不到 `ACTION_OPEN_DOCUMENT_TREE` / `DocumentPicker` / `takePersistableUriPermission`；`grantedTrees` 只是 `expo-system.ts:129` 接口里的一个字段，**声明了从没被填过** |

**含义**：阶段 1 的入口（分享进来）和关键路径（SAF）都空着，而阶段 2 的管道已经铺了一部分。
按 PRD 的前置链 `M0 → M1 → M2`，**M2 的东西不该早于 M1 的入口**——至少要看清楚这个顺序是有意为之还是不小心。

（这不是说已做的工作没用：Shizuku 那套是 M2 的硬前置，早晚要做，而且契约、安全机制、测试都已经就位。
问题是**它现在不能给任何用户带来价值**，因为用户连分享都进不来。）

---

## 四、什么还没写

### A. 阶段 1（PRD 说是首发必需）

1. **分享面板接收**：`ACTION_SEND` / `ACTION_SEND_MULTIPLE` 的 intent-filter + 处理 `content://` URI
   + 处理完回传 `system_share`。**入口没了，整个阶段 1 的 loop 不成立。**
2. **SAF onboarding**：目录授权引导、持久化 URI 权限、授权失效时的重授权深链。
3. **前台服务 / 完成通知**的收尾（`system_notify` 有，长任务没有——PRD 也只是取完成通知）。
4. **Play-safe 构建的实测**：开关存在（`MOBILECLAW_PLAY_SAFE=1`），但没验证过开之后的产物。

### B. 阶段 2（做了前置，没做完）

5. **Shizuku 原生模块**：Kotlin 与 AIDL **已写，但从未编译过**（本机没有 Android 工具链）。
6. **Shizuku 未安装的引导弹窗**：文案已写好（`strings.ts` 的 `automation` 段），**只差渲染**。
7. **真机端到端验证**：一次都没跑过。
8. **端侧模型**（G3 的一部分）：没有任何代码。
9. **Skill 插件包 / 换机迁移**（M2/M3）：没有任何代码。
10. **可审计审批链的持久化**：审批现在是**每会话**的（`conversation.allowlist`），
    但 PRD 要的是"可回看"的审计链——目前只有会话内的 transcript，没有独立的审计视图。

### C. 明确**不做**的（有意为之，不是遗漏）

- 无障碍服务 UI 自动化（Play 政策 + Android 17 AAPM；`README.md` 与 `docs/android-capabilities.md` 都记了理由）。
- `/Android/data`、`/Android/obb`（SAF 也拿不到）。
- 设备内任意脚本。
- iOS 一等支持（只保证降级不崩）。
- 银行/支付类场景的自动化（产品范围决定，见工作日志第一节第 4 条）。

---

## 五、马上要写的代码块

按**建议优先级**（依据是"解除阻塞的先后"，不是"我更喜欢哪个"）：

### 1️⃣ 先解除编译阻塞 —— 拿工具链做一次编译验证

**为什么排第一**：Kotlin/AIDL 从未编译过，**这是当前最大的未知数**。一次编译能同时验证
`${applicationId}` 的代换、AIDL 生成、以及 Shizuku 依赖能否解析。所有其它工作都建立在它之上。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File eng\setup-toolchain.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File eng\build-local.ps1 -Variant debug
```

预计第一次会报错（导入名、API 名）。网络已验通：`dl.google.com` / `services.gradle.org` /
`repo1.maven.org` **直连都很快**，只有 GitHub 要 `127.0.0.1:7897` 代理。

### 2️⃣ 阶段 1 的入口：分享面板接收

**为什么排第二**：这是 PRD 里 M1 的头号交付物，也是**唯一能让普通用户看到价值**的东西。

要动的文件：
- `apps/mobile/app.config.ts` —— 加一个 `withShareTarget` config plugin，往 `MainActivity` 挂
  `ACTION_SEND` / `ACTION_SEND_MULTIPLE` 的 intent-filter（`text/plain` + `*/*`），
  并处理 `content://` 的读取权限
- 新增 `apps/mobile/app/share.tsx` —— 接收路由：解析进来的 URI，分流（文本 → 建备忘/日程；
  文件 → 批量动作），把结果交给 agent
- `packages/capabilities/src/tools/system.ts` —— 回传用现成的 `system_share`

**这条现在是 0**，manifest 里一行都没有。

### 3️⃣ 阶段 2 收尾：Shizuku 未安装引导弹窗

**为什么排第三**：文案已写好，是最小的一块；而且**没有它，即使编译通过，用户也不知道去哪装 Shizuku**。

要做的：新增一个组件（`apps/mobile/src/ui/shizuku-setup.tsx`），把 `strings.ts` 的 `automation` 段
渲染出来，并接到 `shizuku_status` / `shizuku_request` 上（`shizukuOpen` → `shizuku_request`）。

### 4️⃣ SAF onboarding（阶段 1 的关键路径）

### 5️⃣ 真机端到端（需要用户在手机上装 Shizuku 并配对——**这一步只能用户操作**）

---

## 六、现状速查

| 项 | 值 |
|---|---|
| 分支 | `myqiV1` |
| 工具总数 | **28 个，7 个束**（`cap-files` / `cap-shell` / `cap-web` / `cap-system` / `cap-python` / `cap-shizuku` / `cap-automation`） |
| 测试 | core 102 · capabilities 74 · mobile 194 · eng 17 |
| typecheck | 三个包全过 |
| 出过 APK 吗 | **没有**（本机从未装过 Android 工具链） |
| 真机跑过吗 | 文件主线跑过（见 `docs/device-verification.md`）；屏幕自动化**一行没跑过** |
| Kotlin 编译过吗 | **从未** |

---

## 七、怎么验证 / 怎么跑命令（本机的坑）

- bash 里**没有 `pnpm`**，要用 **`corepack pnpm ...`**（node 在 `D:\noedJS`）。
- **根 `package.json` 的脚本跑不了**：内部又调 `pnpm`，子 shell 的 PATH 上没有。

  ```bash
  corepack pnpm -r --filter "./packages/**" --filter "./apps/**" run typecheck
  corepack pnpm -r --filter "./packages/**" --filter "./apps/**" run test
  corepack pnpm --filter @mobileclaw/mobile run bundle
  ```

- **不要用 `... | tail` 判断退出码**——管道退出码是 `tail` 的，恒为 0。这个坑害我误报过一次"检查通过"。
- 工具链解析器：`node --test eng/toolchain.test.cjs`（`node --test eng/` 这种目录形式**不行**）。
- **改内联 Kotlin 或 `android-native/` 之后必须删 `android/` 重新 prebuild**，
  `build-local.ps1` 的 staleness guard 只重打 JS bundle。
- 详细的环境陷阱（十四条，每条都踩过）：`docs/dev-environment.md`。

---

## 八、文档索引

| 文档 | 什么时候看 |
|---|---|
| **本文件** | 想知道项目整体在哪、接下来做什么 |
| `docs/worklog/shizuku-screen-automation.md` | 要接手**屏幕自动化**那条线（最详细的一份，含关键词表） |
| `docs/architecture.md` | 动手改代码前。那 8 条不变量是硬约束 |
| `docs/dev-environment.md` | 构建出问题前。ninja 长路径、pnpm 布局、十四条陷阱 |
| `docs/device-verification.md` | 想知道"什么被真正看到工作过"（区别于"测试通过"） |
| `docs/android-capabilities.md` | 写原生代码前。Android 到底允许什么、两个 `ReactPackage` 的结构 |
| `deliverables/product-strategy/*` | 产品决策的依据（PRD / 里程碑 / 用户故事 / 竞品 / 指标） |
| `eng/BUILD.md` | 出 APK |
