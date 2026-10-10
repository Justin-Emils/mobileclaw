# MobileClaw

一个**手机原生的本地 AI 智能体** —— DeepSeek Harness / OpenClaw 的手机版思路。模型不是一个聊天
气泡：它长着手脚（文件、shell、脚本、跨应用操作），而它的每一个动作都要经过一道你自己控制的权限门。

目标平台：**Android 优先**，iOS 以「优雅降级」保持可用（同一段代码会如实报告沙箱禁止了什么，而不是
假装成功）。大脑：任何**兼容 OpenAI 协议**的端点（DeepSeek、OpenAI、OpenRouter、局域网里的 Ollama、
vLLM……）。

```
┌────────────────────────── Expo 应用 (apps/mobile) ──────────────────────────┐
│  聊天界面 · 授权面板 · 工具卡片 · 设置 · 权限矩阵                            │
│                                                                             │
│  MobileClawRuntime  ── 插件宿主 ── 能力插件 (fs/shell/web/…)                │
│         │                    │                                              │
│         │              PermissionGate ── PathGuard                          │
│         ▼                                                                   │
│  智能体循环 ── 流式模型接口 (SSE) ── 会话存储                                │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │  平台服务（注入式）
      ┌────────────────────────┼────────────────────────┬─────────────────┐
      ▼                        ▼                        ▼                 ▼
 expo-file-system         shell 后端               expo intents       SecureStore
 (+ guard, SAF/所有文件)  (Termux/Shizuku)        剪贴板/分享        SQLite（历史）
```

## 为什么这样设计

内核（`packages/core`）是**纯 TypeScript，不导入任何平台模块**。智能体能做的一切都以「注入的服务 +
接口」的形式抵达，因此：

- 整个智能体循环可以在 Node 上做单元测试（不需要模拟器、不需要真机）；
- 手机侧换成 Expo/原生实现时，不必改动智能体行为；
- 将来的 CLI 或桌面宿主可以原样复用同一个内核。

插件风格沿用 Cordis：插件 = 一个函数 + 元数据；它接收一个 context，在上面注册服务/工具/监听器，
并通过 `inject` 声明依赖 —— 这样缺了某个能力会被精确报出来，而不是在对话中途神秘失败。

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `packages/core` | 内核：context、事件总线、插件宿主、工具注册表、权限门、路径守卫、智能体循环、模型接口、会话存储。**不含 `node:*`，不含 RN。** |
| `packages/capabilities` | 受守卫的文件系统 + 全部工具：`fs_*`、`shell_*`、`web_fetch`、`system_*`、`python_*`、`shizuku_*`、`screen_*`。`./node` 子路径放仅限 Node 的后端实现。 |
| `apps/mobile` | Expo 应用（SDK 57）：运行时装配、聊天界面、授权面板、设置、权限矩阵、EAS 配置。 |
| `docs/setup-for-teammates.md` | **换一台机器或第一次构建，先看这份。** 从零到能构建的完整步骤，以及六个已修掉的坑各自的症状。 |
| `docs/android-capabilities.md` | Android 实际允许什么的踩坑记录，以及原生模块的规划。 |
| `docs/architecture.md` | 各模块如何拼合、一次请求的生命周期、以及不变式。 |
| `docs/dev-environment.md` | **动手构建之前先读这份。** Android 工具链如何解析（`eng/toolchain.cjs` / `eng/setup-toolchain.ps1`）、SDK 自带的旧版 ninja 为何曾挡住本地原生构建（以及两种修法），外加十四个环境相关的坑及其症状与修法。 |
| `docs/device-verification.md` | 真机上**实际验证过**什么，以及**没验证**什么。 |
| `docs/worklog/project-status.md` | **项目当前状态**：产品目标、哪些能用哪些不能、计划与代码之间的差距、接下来写什么。 |
| `docs/worklog/shizuku-screen-automation.md` | 屏幕自动化这条线的完整记录 —— 决策、证据、以及耗费了时间的那些坑。 |

> **仓库位置**：放哪都行。构建在运行时会解析工具链，而不是写死路径（`eng/toolchain.cjs`）；
> 在新机器上，`eng/setup-toolchain.ps1` 会把 JDK 和 Android SDK 装到仓库旁、已被 git 忽略的
> `.toolchain/` 里。详见 `docs/setup-for-teammates.md`。

> **⚠️ 不要用 JDK 24 构建。** 它会让 `react-native-worklets` 的 CMake 配置中止，而报错完全
> 不提 Java。用 `.toolchain/.config` 把 JDK 钉在 21 —— 见 `eng/BUILD.md`。

## 快速开始

```bash
pnpm install
pnpm check            # 类型检查 + 576 个测试（core 149 / capabilities 233 / mobile 194）+ 一次真实的 Metro 打包
pnpm doctor           # expo-doctor：依赖/SDK 一致性检查
pnpm mobile           # 起 Metro（需要先装 dev client）
```

`pnpm check` 里刻意包含 **`pnpm bundle`**（`expo export --platform android`）。类型检查和单元测试
各自都能解析 `@/*` 别名和 `.ts` 源码，因此它们**抓不到**真正会挡住设备构建的两类失败：Metro 不读
tsconfig 的 `paths`，以及无扩展名的 TS 导入后面被加上 `.js`。只有真正打一次包才能发现。

构建可安装的 APK。

**本地构建**（通过 `eng/toolchain.cjs` 解析 JDK + Android SDK + Gradle；新机器上先跑一次
`eng/setup-toolchain.ps1` —— 见 `docs/setup-for-teammates.md`）。这台机器的执行策略会拒绝未签名
脚本，所以需要显式指定宿主：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File eng\build-local.ps1 -Variant debug
# -> artifacts\mobileclaw-local-debug.apk
```

> **必须用这个脚本构建。** 直接跑 `gradle assembleRelease` 不等价：Gradle 不把 `packages/*` 当作
> JS 打包任务的输入，所以改了 core/capabilities 之后它会显示 UP-TO-DATE，**APK 里装的是上一版
> JS** —— 构建「成功」，代码是旧的。脚本会在打包前后各校验一次。

**云端构建**，本机无需 Android SDK：

```bash
npx eas-cli login
cd apps/mobile && npx eas-cli init          # 写入 projectId
pnpm apk                                    # preview 配置 → 可安装的 .apk
pnpm apk:dev                                # 供 Metro 使用的 development client
```

默认的 `production` 配置产出用于应用商店的 `.aab`；`preview` 和 `development` 在
`apps/mobile/eas.json` 里被设为 `buildType: "apk"`，正是这一点让产物可以直接安装。

装好之后，在应用里：**设置 → 选择服务商预设 → 粘贴 API 密钥 → 测试连接**。密钥写入
`expo-secure-store`；若该设备的加密存储不可用，会降级到应用私有存储并**明确告知你未加密**。

### 两条保持打包正常的铁律

1. **绝不要手写 Expo 包的版本号。** SDK 57 统一把它们定为 `~57.x`；按旧版 SDK 的习惯猜一个版本，
> 打出来的包能装但会崩。用 `npx expo install <包名>` 加依赖，再用 `pnpm doctor` 复查。
2. **相对导入或别名导入不要带扩展名。** 写 `from "./foo"`，不要写 `from "./foo.js"` —— Metro
> 无法把 `./foo.js` 映射到 `foo.ts`，而 `tsc` 和 vitest 却完全接受，所以这个错误直到打包才暴露。

## 智能体现在能做什么

| 能力包 | 工具 | 说明 |
| --- | --- | --- |
| `cap-files` | `fs_list` `fs_read` `fs_write` `fs_edit` `fs_search` `fs_info` `fs_organize` | `fs_search` 同时支持 glob **和** 正则内容搜索——「整理我的下载目录」的主力。`fs_organize` 永远会征求确认。 |
| `cap-shell` | `shell_run` `shell_which` | 需要 Termux 或 Shizuku；两者都没配好时会明说。 |
| `cap-web` | `web_fetch` | 返回净化后的文本，并把结果标记为不可信数据。 |
| `cap-system` | `system_open` `system_apps` `system_clipboard` `system_share` `system_notify` `system_calendar` | Intent / 剪贴板 / 分享面板 / 日历写入。 |
| `cap-python` | `python_run` `python_script` `python_status` | 经由 shell 后端触达解释器（Termux，将来是 Chaquopy）。代码通过 **stdin** 传入，所以引号永远不会破坏它。 |
| `cap-shizuku` | `shizuku_status` `shizuku_request` `shizuku_run` | 以 shell 身份（uid 2000）执行特权命令，不是 root。 |
| `cap-automation` | `screen_current` `screen_capture` `screen_tap` `screen_scroll` `screen_type` `screen_wait` | 通过 Shizuku **看**屏幕并操作它。坐标由**人**在截图上点选（授权面板里出图，用户落点），而不是让模型自己编一个——因为一个编出来的坐标会点到你没打算点的地方。每个会改变屏幕状态的工具都声明了 `neverRemember`，所以「总是允许」永远不能覆盖下一次点击，并且每次都会返回截图作为存证。 |

安全模型一句话：**边界是词法的、绝对的**（模型给的每一个路径都要过 `PathGuard`，配置的根目录之外
一律拒绝）；**能力按风险等级授予**（`read`/`network` 自动放行；`write`/`execute`/`system` 会弹确认，
可「本次会话内总是允许」，且会过期）。

## 有意为之的限制（提 issue 前请先读）

- **Google Play 不会接受带「所有文件访问」的这个应用。** `MANAGE_EXTERNAL_STORAGE` 不属于 AI 智能体
  可用的许可类别，所以预期的分发渠道是侧载、F-Droid 和 GitHub Release。
  `MOBILECLAW_PLAY_SAFE=1 pnpm prebuild` 可以在不带该权限的情况下构建（智能体只能看到应用私有存储
  和经 SAF 授权的目录树）。
- **Android 10+ 禁止执行应用存储里的文件。** 任何随包工具都必须作为 `jniLibs/<abi>/lib*.so` 打进
  APK；你无法下载一个二进制再运行它。
- **存储用的原生模块已在真机上验证**：`MobileClawFilesModule` 是内联在
  `apps/mobile/app.config.ts` 里的 Kotlin，由 `withMobileClawFiles` 配置插件在 prebuild 时写出
  （磁盘上刻意没有 `.kt` 文件）。**Shizuku 那个是真实存在的 Kotlin 与 AIDL**，位于
  `apps/mobile/android-native/shizuku/`，由三个配置插件复制进生成的原生工程。
  **注意**：AIDL 与 Kotlin 能编译通过（已在 `compileReleaseAidl` 与 Kotlin 编译中验证），但
  **运行时行为尚未在真机上验证过** —— 装了 Shizuku 的设备上的实际表现是个未知数。
  没有配对 Shizuku 时，`screen_*` 和 `shizuku_*` 会如实报告缺了什么。Termux 与存储权限提示仍是
  已规划、待实现的状态（`apps/mobile/src/runtime/bootstrap.ts`）。细节见
  `docs/android-capabilities.md`。
- **`expo-file-system` 的适配层是唯一未经验证的接缝。** 它是照着 SDK 57 的
  `File`/`Directory`/`Paths` API 写的，如果 Expo 改了成员名，这里是唯一需要改的地方
  （`apps/mobile/src/runtime/services/expo-file-system.ts`）。另外，该模块的权限预检用
  `File.canRead()`/`canWrite()` 判断，对共享存储里属于其他 uid 的文件永远返回假 —— 这正是
  `fs_write` 必须绕开它、走自建原生模块的原因。
- **基于 AccessibilityService 的技能式自动化不在范围内** —— 但理由和常见的说法不同。这个应用本来就
  不通过 Play 分发（`MANAGE_EXTERNAL_STORAGE` 不在许可类别内），所以「Play 拒绝自动化工具」在这里
  排除不了任何东西；而 Android 17 的 Advanced Protection Mode 会禁止非无障碍类应用使用无障碍 API，
  与是否使用 Shizuku 无关。真正的理由更窄也更强：**shell 身份本来就能读到别的应用的无障碍树**，
  所以再声明一个 `AccessibilityService` 只会为「已经拿到的视图」多要一个权限、多跑一次系统设置。

## 路线图

1. **补完原生模块**：Termux 的 `RUN_COMMAND`、所有文件访问的引导、已安装应用列表（已实现部分见
   `system_apps`）。解锁 `shell_run`、`python_*`、`shizuku_*` 的完整能力。
2. **后台运行**：带声明类型的前台服务，让长任务在应用切到后台后仍能继续（`dataSync` /
   `specialUse`），并在任务完成时发一条通知。
3. **SAF 引导**：一个文件夹选择器，持久化目录树 URI，这样不用「所有文件访问」也能工作。
4. **Chaquopy Python**：真正的应用内解释器，藏在同一套 `python_*` 工具后面。
5. **技能包**：可安装的插件包（插件宿主已支持运行时加载/卸载，并能按插件报告失败）。
