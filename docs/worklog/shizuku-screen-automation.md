# Work log — Shizuku 屏幕自动化

> 这是工作的连续记录，刻意写成**自包含**的 markdown，换一个对话也能直接接上。
> 实施计划另在 `C:\Users\簪子\.claude\plans\eager-roaming-ocean.md`——那**不在仓库里**，会随环境丢失，
> 所以凡是关键结论都抄在这份日志里，不要只依赖它。
>
> 最后更新：2026-10-09

## 目标

给 MobileClaw 加"输入一条命令，去 A 软件取信息、处理后写进 B 软件"的能力（目标场景：微信 → QQ）。
走 **Shizuku（shell / uid 2000）**，不走无障碍服务——本项目有意排除了 AccessibilityService
（`README.md:128-136`、`docs/android-capabilities.md:128-131`：Play 政策不接受自动化用途，
Android 17 的 AAPM 会封非无障碍用途的 Accessibility API）。

## 用户定的硬约束（不可协商）

1. **每一次涉及更改的操作都要用户亲自确认**，不能有"本次会话内总是允许"这种一次性豁免。
2. **必须明确提出"我做了什么"**——这句陈述由代码从实际执行的事实生成，不能由模型自由发挥。
3. **必须附截图存证。**
4. **范围只到日常功能**：银行、支付这类用户绝不会放心交给 agent 的场景**不做自动化**，
   遇到就如实说"这一步你自己来"。这条把 `FLAG_SECURE` 从缺陷变成了可接受的边界——
   见下面「已决定但不做」。

## 已确认的技术事实（不用再查一遍）

- **Shizuku 依赖**：`dev.rikka.shizuku:api` 与 `dev.rikka.shizuku:provider`，最新稳定版 **13.1.5**
  （已从 Maven Central 核实）。仅支持 Shizuku 时 `:provider` 也要加。
- **manifest 的 provider 必须这么写**（已从官方 README 核实）：

  ```xml
  <provider
      android:name="rikka.shizuku.ShizukuProvider"
      android:authorities="${applicationId}.shizuku"
      android:multiprocess="false"
      android:enabled="true"
      android:exported="true"
      android:permission="android.permission.INTERACT_ACROSS_USERS_FULL" />
  ```

  **不要**加网上流传的 `moe.shizuku.manager.permission.API_V23`——官方 README 里没有这条。
- **权限 API**：`Shizuku.isPreV11()` / `checkSelfPermission()` / `shouldShowRequestPermissionRationale()`
  / `requestPermission(code)` / `addRequestPermissionResultListener` / `removeRequestPermissionResultListener`。
  监听器必须在回调里和被销毁时都移除（漏掉是这类代码的经典 bug）。
- **`Shizuku.getUid()`**：root 返回 0，ADB 返回 2000。
- **UserService**：类继承 `IYouAidlInterface.Stub`；`UserServiceArgs` **必须设 `tag`**
  （类名在 R8 后不稳定）；`version` 不匹配会重启服务。
- **unbind 后进程不会自动退出**——必须在 AIDL 里实现 transaction code `16777115`（aidl 写 `16777114`）
  的 destroy 方法并 `System.exit()`，否则每次重连漏一个进程。
- **UserService 进程不是合法的 Android 应用进程**，`registerReceiver` / `getContentResolver` 不能用。
- **uid 2000 写不进应用私有目录**（`/data/user/0/dev.mobileclaw.app/…` 属 app uid），
  而 app 读不到 `/data/local/tmp`。所以**截图必须经 binder 回传字节**，不能靠共享文件路径。
- 非 root 模式重启后 Shizuku 会停止，需要重新配对；Android 11+ 可以完全在设备上完成，不需要电脑。

## 进度

### 已完成

- [x] **core：`neverRemember` 标志**（安全属性，全离线可测）
  - `packages/core/src/tool.ts`：`ToolDefinition` 加 `neverRemember?: boolean`。
  - `packages/core/src/permission.ts`：① `evaluate()` 的白名单短路加 `!request.definition?.neverRemember`
    条件；② deny 规则之后、allow 规则之前插提前返回，一律返回需确认；③ `authorize()` 里
    `const rememberable = remember === true && !request.definition?.neverRemember`，只在
    `rememberable` 时调 `allowForSession` 并回传 `remember`。
  - 为什么这样就够：`agent.ts` 只在 `decision.remember` 为真时才写 `conversation.allowlist`，
    所以在 `authorize` 里剥掉足够；`seedConversation` 仍会把旧数据放进集合，但 `evaluate`
    对这类工具根本不查集合，**历史白名单自动失效，不需要数据迁移**。
  - `packages/core/test/permission.test.ts`：新增 7 个测试锁死这条属性（每次调用都问、
    `remember` 被丢弃、旧版本存下的白名单无效、全局白名单无效、allow 规则无效、
    deny 规则仍然赢、`alwaysAsk` 语义未被改动）。
  - **验证：`corepack pnpm --filter @mobileclaw/core run test` → 7 文件 90 测试全过。**

- [x] **`AutomationService` 端口 + `cap-automation` 工具束**（对假实现，全离线可测）
  - `packages/core/src/types.ts`：新增 `AutomationService` / `AutomationStatus` / `ScreenCapture` /
    `ForegroundWindow`，挂在 `SystemService.automation?` 上（跟随 `privileged` 那种"可选能力"模式）。
  - `packages/capabilities/src/tools/automation.ts`：6 个工具——`screen_current`（read，不弹窗）、
    `screen_capture` / `screen_tap` / `screen_scroll` / `screen_type`（四者 `system` + `alwaysAsk` +
    **`neverRemember`**）、`screen_wait`（read）。
  - **两处对原计划的改动，都是为了不让模型被迫编坐标**：
    1. `screen_swipe` 改成 **`screen_scroll`**：只要 `direction` + `amount`，几何由后端按真实分辨率算。
       模型看不见屏幕，让它给滑动两个端点的坐标是不现实的。
    2. `screen_tap` 缺坐标时**直接报错**（`hint` 指向"先 `screen_capture`，再在弹窗里点选位置"），绝不猜。
  - **动作后的存证截图是 best-effort**：截图失败不会把已经成功的点击变成工具错误，而是回一个
    `evidenceNote`。反过来会报告一个"失败"但实际发生过的动作，比证据薄弱更糟。
  - 测试（`capabilities.test.ts` 新增 14 个 → 包内 58 全过）锁住：每个 `system` 风险的工具都必须带
    `neverRemember`（**结构性断言，将来新增工具忘加也会失败**）、没坐标拒绝点击、截图失败不影响动作、
    全黑帧的 note 透传而不伪装成空屏、滚动不需要坐标、走粘贴时如实报告用了剪贴板、
    **summary 不回显输入的文本**（避免密码进 UI）。

- [x] **审批通道携带数据，不只是布尔**
  - `packages/core/src/permission.ts`：`PermissionDecision` 加 `input?: unknown`；`ApprovalHandler`
    返回值加 `input?`；`authorize()` 在有 `input` 时透传。
  - `apps/mobile/src/runtime/approval.ts`：抽出 `ApprovalAnswer` 类型（`{approved, remember?, input?}`），
    `PendingApproval.resolve` / `handle` / `answer` / `flush` / `autoAnswer` 统一用它。
  - `packages/core/src/agent.ts`：`executeCall` 里 `mergeApprovedInput(call.input, decision.input)`
    合并后再交给 `registry.execute`。**关键顺序**：合并发生在 registry 的 `safeParse` **之前**
    （`tools-registry.ts:89`），所以模型可以只给 `target`、由用户补 `x/y`，而供应进去的垃圾值
    仍然会被 schema 拒绝。transcript entry 记的是**合并后**的输入和重算的 summary，
    也就是"实际发生了什么"，不是"模型想干什么"。
  - 测试：`agent.test.ts` 新增 2 个——用户给的坐标真的到达 `execute`；审批塞进来的非法值
    到达的是 parser 而不是工具（`E_TOOL_INPUT`，工具没被调用）。

- [x] **存证截图进入会话记录**
  - `packages/core/src/types.ts`：`TranscriptEntry` 的 tool 变体加 `evidence?: ScreenCapture` 与
    `evidenceNote?: string`。
  - `packages/core/src/agent.ts`：新增 `evidenceOf(value)`，只认工具输出里**约定的 `evidence` 键**，
    然后 spread 进成功分支的 entry。为什么必须显式做这一步：`renderToolOutput` 会把输出压平成
    给模型看的文本，顺手把图片丢掉。
  - `apps/mobile/src/ui/tool-card.tsx`：**本项目第一个 `<Image>`**。折叠行在有存证时显示「截图存证」小标，
    展开后按 `width/height` 的宽高比渲染；`evidenceNote`（取不到）和 `evidence.note`（全黑帧）
    都显示在图片位置下方。
  - 测试：`agent.test.ts` 新增 2 个——存证能穿过 `renderToolOutput` 到达 entry；
    工具输出里**顺口提到的** `file://` 路径不算存证（避免把散文当成已验证的证据）。

- [x] **JS 原生桥 + `bootstrap.ts` 接线**
  - 新增 `apps/mobile/src/runtime/services/native-shizuku.ts`：`loadNativeShizuku()`（照 `native-files.ts` 的
    惰性容错加载——`require("react-native").NativeModules["MobileClawShizuku"]`，缺失就返回 undefined 并打日志，
    不抛）、`createAutomationService(native)`、`createPrivilegedService(native)`。
  - `ExpoSystemPorts.privileged` 从内联结构体改为引用 core 的 `PrivilegedService`，新增
    `automation?: AutomationService`；`ExpoSystemService` 加对应 getter。
  - `bootstrap.ts`：`loadNativeShizuku()` 只调一次，派生出 `privileged` / `automation`，分别传给
    `pickShellBackend(privileged)` 与 `createSystemPorts({...})`。
    **顺带修掉一个老 bug：`SystemService.privileged` 此前恒为 `undefined`**——`createSystemPorts()`
    从来不设这个端口，所以 `shizuku_status/request/run` 三个工具永远报 "not integrated on this platform"。
  - 删掉死代码：`MobileClawNativeModule` 接口与 `importOptionalNativeModule()`（它动态 import 的包
    `"mobileclaw-native"` 根本不存在，恒返回 undefined）。`NativeBridgeShell` 改成包一层 `PrivilegedService`。
  - 三个包 typecheck 全过。

- [x] **按新要求回退中文与硬编码**（用户中途加的要求：严禁硬编码、必须遵守代码规范）
  - `packages/capabilities/src` 原本**一个中文字都没有**（22 个工具全英文），我在 `automation.ts`
    里塞的中文全部撤回：描述、hint、summarize 一律英文。`NativeBridgeShell.reason()` 也从中文改回英文。
  - 截图默认参数原本在**工具 schema 和原生桥两处各写一遍**，提成
    `packages/core/src/automation.ts` 的 `SCREEN_DEFAULTS`（`maxWidth 720 / quality 70 /
    evidenceQuality 60 / scrollFraction 0.6`）。工具**不再自带 `default()`**，由实现里的 `??` 兜底，
    保证这些数只有一处说了算。
  - `screen_wait` 的轮询间隔和默认超时提成具名常量 `WAIT_POLL_MS` / `WAIT_DEFAULT_MS`。

### 阻塞点：这台机器没有 Android 工具链（环境问题，不是代码问题）

要出一个能装到手机上的 APK，卡在环境：

- **没有 Android SDK**（找不到 `sdkmanager.bat`，`ANDROID_HOME` / `ANDROID_SDK_ROOT` 都未设）
- **没有 JDK 21**（`~/.jdks` 里只有 corretto-1.8、ms-17.0.20、loom-ea-25）
- **没有 Gradle 缓存**（`~/.gradle` 不存在）
- `eng/build-local.ps1` 把工具链写死成 `E:\code\Eng\*`，而那个目录**在这台机器上不存在**

**好消息：网络不是问题。** 实测直连 `dl.google.com` 200/0.35s、`services.gradle.org` 200/0.76s、
`repo1.maven.org` 200/0.24s。只有 GitHub 需要走 7897 代理。所以装 SDK 这条路是通的，
Shizuku 的 Maven 依赖也拉得下来。

### 进行中：工具链可移植化

用户要求"换电脑也能继续编程"。**决定不把工具链提交进仓库**（SDK 3-5GB、JDK 约 200MB、
Google 许可不允许再分发、Windows 二进制到别的系统没用），改成让脚本**解析**工具链位置。

- [x] `eng/toolchain-versions.cjs`：版本唯一出处（JDK 21、SDK 包列表、CMake 3.30.5 与模板默认的 3.22.1、
  ninja 最低 1.12.1、Gradle 9.3.1、`.toolchain` 目录名）。这些版本原本**只写在 `build-local.ps1`
  的注释里**，脚本运行时不校验。
- [x] `eng/toolchain.cjs`：`candidatesFor(kind, ctx)` 是**纯函数**（测试直接断言它，不需要磁盘），
  `resolveToolchain(ctx)` 再加文件系统检查。顺序是：显式参数 → 环境变量 →
  **仓库旁 gitignore 掉的 `.toolchain/`** → 各平台常见位置。校验**子路径**（`bin/java`、
  `platform-tools/adb`）而不是只看根目录存在，否则半装的 SDK 会被当成装好了。失败时列出
  **所有试过的位置**加三种修法。
- [x] `eng/toolchain.test.cjs`：**17 个用例**，用 **Node 内置的 `node --test`**（不加依赖、不动 vitest 配置）。
  跑法 `node --test eng/toolchain.test.cjs`——注意 `node --test eng/` 这种目录形式在这个 Node 上不行，
  它会把目录当模块加载。
- [x] `eng/setup-toolchain.ps1`：新机器跑一次，把 JDK 和 cmdline-tools 下到 `.toolchain/`，再用
  `sdkmanager` 装那五个包。带 `-DryRun`（已实测通过）和 `-FixNinja`。
  cmdline-tools 的构建号**故意不写死**——Google 每隔几周换一次文件名，写死的那个迟早 404，
  所以脚本去读 `repository2-3.xml` 挑最新的。`-FixNinja` 从 GitHub 下载 ninja 1.12.1
  并替换 SDK 里**两份**（`:app` 仍走模板默认的 CMake，只换一份不够）。
- [x] 改掉 5 处真硬编码：`eng/build-local.ps1` 的三行工具链常量，
  `eng/drive-emulator-settings.cjs` 与 `eng/emulator-send-message.cjs` 的 `ADB` 常量
  （其余盘符全在注释和文档里，不在逻辑里）。`build-local.ps1` 顺带加了
  `-Jdk`/`-Sdk`/`-GradleHome` 三个覆盖参数。
- [x] `.gitignore` 加 `/.toolchain/`。
- [x] 文档（派给另一个 agent 做的，**我自己复核过**）：`README.md`、`docs/dev-environment.md`、
  `eng/BUILD.md`、`eng/README.md`，外加两份 `deliverables/` 里的历史研究文档（各加一行
  "此处路径为历史信息"，未改正文）。
  **复核结果**：机器无关的硬知识**一条没丢**——`RtlAreLongPathsEnabled`、两个 sha256
  （`D66FB0BB…` 与 `3ED5DDA7…`）、`robocopy /MIR` 的警告、`nodeLinker: hoisted` 的四节内容、
  上游 `disk_interface.cc` 片段、AGP 9 的 `CmakeOptions` 那条，全部在；第四节**十四条陷阱表完整**
  （`^\| [0-9]+ \|` 数出来正好 14 行）。
  代理端口也从过时的 7892 改成 7897，并补了"GitHub 被墙、Google/Maven 直连很快"这个反过来的事实。
- [x] 收尾：`eng/build-local.ps1` 的头部注释（第 4/11-14 行）也还写着 `E:\code\Eng`——文档 agent
  受"不许改 `eng/*.ps1`"约束没动，我自己改了。

### 红队审查（第二次测试派发，比第一次严格）

第一次派发只要求"写测试"；第二次明确要求**红队**，且**必须拿出一个在当前代码下失败的测试作为证据**，
拿不出的一律归为"未证实的观点"。它报了 4 条，我逐条复核。

**Bug 1（中，安全属性）——我自己独立复现了。**
审批回传的 `input` 走 `{ ...base, ...approved }` 浅合并，**覆盖**模型入参；而 `paths` 和规则判定
都在 `authorize` **之前**、基于**合并前**的 `call.input` 算好；`registry` 之后只按 schema 重校验类型，
**不重跑权限规则**。于是可以先用一个合法路径满足 `pathPattern` deny 规则的检查，
再由审批值把落点换成被禁路径。我的复现输出：`PROBE written = [ '/root/secret/leak.txt' ]`——
**被 deny 的路径真的写进去了。**
可达性：**今天不可达**（真实 UI 的 `answer()` 从不带 `input`），但 `ApprovalHandler` 契约、
`ApprovalBroker.autoAnswer`、以及计划中的取点 UI 都走这条通道，属于"已实现但还没接线"的真缺陷。

**窄修**（按"先定成因再针对性改"）：成因是"执行的输入不是被检查的那个输入"，所以把
`mergeApprovedInput` 改成**只补、不覆盖**——审批只能填模型**没给**的键。
这不是权宜，而是这条通道的本来目的：补模型**不可能知道**的东西（它看不见屏幕，给不了坐标）；
"覆盖模型已经给出的值"从来不是需求，而且正是它破坏了不变量。非对象输入也不再整体替换，
否则等于执行一个完全没被评估过的东西。回归测试在 `packages/core/test/approval-input.test.ts`（4 个用例）。

**残留（已知、今天同样不可达）**：若将来有工具的路径字段是**可选**的、且模型省略了它，
审批仍能补进一个被 deny 的路径。当前所有 `fs_*` 工具的 `path` 都是必填，够不着；
彻底堵上需要对合并后的输入**重跑一遍 gate**。我没有一起做——那是第二处改动且现在没有收益。
这条我明确告诉用户，而不是悄悄留着。

**Bug 2（低，防御性，已修）**：`evidenceOf` 只查 `typeof === "number"`，`NaN` / 0 / 负数都能过，
而 `NaN` 经 JSON 落盘会变成 `null`——一张坏图会被当成"已验证的存证"渲染出来。
改成要求有限、为正的像素数，且路径非空。回归测试 4 个。

**Bug 3（中，文档事实错误，已修）**：README 的能力清单**整条漏了 `cap-automation`**，
6 个 `screen_*` 工具一个没提，读者会以为屏幕自动化不存在。

**Bug 4（中，源码里的假事实，已修）**：`native-shizuku.ts` 的注释声称 Kotlin 由
`withMobileClawShizuku` 插件在 prebuild 生成——**那个插件不存在，仓库里没有任何 `.kt` 文件**。
这是我写的注释，而且它和 README 里"特权原生模块还没写"那句**互相矛盾**。已改成如实说明。
同类还有 `app.config.ts:525`（声称 Shizuku provider 是条件声明的，实际 manifest 里没这段），一并修了。

**它报的"攻过但没问题的地方"同样有价值**（让我知道覆盖了什么，而不是只知道命中了什么）：
`neverRemember` 的每一处逃生口（白名单、`seedConversation`、`update()`、allow 规则、`remember:true`、
审批器缺失、deny 仍然赢）逐条对照后**全部成立**；
**路径包含性没有被绕过**——`GuardedFileSystem` 在执行时对真实路径做包围盒检查，
Bug 1 绕过的只是"按 `pathPattern` 的权限规则"；存证只存 `path/width/height/note` 不含图片字节，
无体积问题；降级矩阵六种情形与描述一致；常量确实只有 `SCREEN_DEFAULTS` 一处；
解析器边界（候选是**文件**而非目录、`release` 畸形、空白环境变量、重复 flag）都正确。
它还诚实标注"构造出 `definition` 为 undefined 但工具仍可执行"的分歧**不是可达缺陷**因而未上报——
这个克制是对的。

顺手修的两处口径不一致：ninja 版本措辞（文档写"≥1.11"、我的注释写"1.12.1 才是第一版"；
真相是上游修复在 1.11 落地、1.12.1 是本项目验证过的版本），以及 `-FixNinja` 的备份文件名
（现在统一成 `ninja-1.10.2.exe.bak`，名字描述备份**里面**是什么，与文档的手工程序一致）。

### 一个反复出问题的模式（值得单独记）

**测试数量写在三个文件里，一小时内已经过时三次。** 原文档写"130 个单测"（当时实际 94+65+167）；
文档 agent 改成 330——它开始跑之后我又加了 5 个用例，立刻又错，我改成 335；
修完红队报的 bug 又变成 **343**（core 102 / capabilities 74 / mobile 167），第三次。
根子是**同一个会变的数字被复制到 README、`docs/dev-environment.md`、`eng/BUILD.md` 三处**，
外加 `node --test eng/` 的 17 个（不在 `pnpm check` 里，所以没算进 343）。
这正好是用户"严禁硬编码"那条规矩的文档版。**建议**：要么只留一处、其余引用它，
要么干脆不写数字（跑一次就有）。这三次我都只把数字对齐，没擅自重构文档结构——等用户定。

**中途自己发现并修掉的一个漏洞**：CLI 第一次跑起来时，它**把 JDK 解析成功了**——这台机器上
唯一过检的是 `~/.jdks/corretto-1.8.0_504`，因为当时只检查 `bin/java` 是否存在。
也就是说 `toolchain-versions.cjs` 里的 `JDK_MAJOR = 21` 是个摆设，正是我声称要修掉的
"版本只写在注释里"那个毛病。补法：读 JDK 自带的 `release` 文件校验主版本
（`JAVA_VERSION="1.8.0_x"` 要解析成 8 而不是 1），太低就跳过该候选；全都太低时在错误里
说明要求。现在这台机器上它正确跳过了 corretto 8 和 ms-17，选中 `loom-ea-25`
（一个 EA 版 JDK 25，是这里唯一 ≥21 的），然后卡在缺 SDK 上。
装了 `.toolchain/jdk` 之后本地那份优先，不会用这个 EA 版。


### 已完成：测试（按用户要求派给独立 agent）

- [x] 新增 `apps/mobile/test/native-shizuku.test.ts`（12 个）与 `packages/core/test/automation.test.ts`（4 个），
  重写 `packages/capabilities/test/capabilities.test.ts` 的 `Automation tools` 块。
- 覆盖：`SCREEN_DEFAULTS` 不变量；六个工具的契约与降级矩阵；**"工具不发明默认值"**（只查传给 service 的参数）；
  tap 无坐标抛错；存证 best-effort（失败 → `evidenceNote`，成功 → `evidence.note` 透传）；
  `screen_wait` 的匹配/超时/取消；以及各工具的 `summarize`。
- **agent 抓到一个我写的真 bug（已修）**：`screen_capture` 原先直接返回裸 `ScreenCapture`，而
  `evidenceOf` 只认显式的 `evidence` 键——于是**截图工具自己那张图永远进不了卡片**，
  而那正是拍它的全部目的。修法是 `automation.ts` 改成 `return { ...shot, evidence: shot }`。
  这是"**先定成因再针对性修**"的典型：成因在**返回值形状**，不在 `evidenceOf`，所以没有去动判定逻辑
  （放宽它会让任何顺口返回 `{path,width,height}` 的工具都被当成存证）。
- [x] **独立复验那个存证 bug**（新增 `packages/capabilities/test/automation-evidence.test.ts`，5 个用例）。
  旧的覆盖是分开的两半——core 测"工具返回 `{evidence}` 能进记录"，capabilities 测
  "`screen_capture` 的返回值形状"——**而 bug 恰好住在这两半之间**：工具返回裸截图，
  `evidenceOf` 只认显式的 `evidence` 键，没有任何测试把两者连起来跑。
  新文件用**真实的工具定义走真实的 agent loop**，再读**持久化之后**的会话记录
  （也就是用户真正看到的东西），覆盖 `screen_capture` 与 `screen_tap` 两条路径，
  外加"全黑帧的 note 要传到记录里"和"取不到截图时要说明原因、而不是只报一个成功"。
- [x] **变异检查（这一步才是关键）**：把 `automation.ts` 临时改回修复前的 `return shot;` 再跑——
  **恰好那两个 `screen_capture` 用例变红**，两个 `screen_tap` 用例仍然绿
  （它走的是另一条本来就带 `evidence` 的路径）。这证明新测试确实能抓到这个 bug，
  而不是事后"碰巧通过"。随后已还原，并确认没有残留的临时注释。
- **复核结果**（自己重跑，不看 agent 的转述）：eng 17/17、core 98、capabilities 70、mobile 167，
  全部 `EXIT_CODE=0`，与 agent 报的数字一致（capabilities 从 65 涨到 70 是这次新增的 5 个）。

### 未开始（全部需要真机）

- [ ] **⛔ 第一个需要真机 + Shizuku 的节点**：`app.config.ts` 三个 config plugin + Kotlin + AIDL，
      然后 `eng/build-local.ps1 -Variant release -Clean`（改了内联 Kotlin 必须 `-Clean`，
      staleness guard 只重打 JS bundle，不重跑 prebuild）。
- [ ] `PointPicker`（本项目第一个取点 UI）+ 审批弹窗改造 + Shizuku 未安装引导弹窗。
- [ ] 端到端验证。

## 关键设计决定

### 用户"在截图上点位置"是必需的，不是锦上添花

没有 OCR 的版本里**模型看不见屏幕、产生不了坐标**。所以点击坐标只能由用户指出来——
这反而让"亲自确认"变得有意义，否则你只是在批准一个你并不知道是什么的坐标 `(540, 1860)`。
因此审批通道必须能**传数据**（回传用户点的坐标），而 agent loop 现在是停在 `authorize()` 上等一个布尔值。

### 待办清单里的坐标合并

`screen_tap` 的入参设计成 `{ target: string, x?: number, y?: number, screenshotPath?: string }`：
模型给 `target`（它的意图），用户在 picker 里给 `x/y`，审批时合并，registry 重跑 `safeParse` 保证注入不进去。

### 已决定但不做：`FLAG_SECURE` → 降级无障碍

讨论过的方案：截图全黑时（银行/支付/密码框）改用无障碍读视图树，因为 `FLAG_SECURE` 挡的是**像素**、
挡不住 `AccessibilityNodeInfo`。技术上成立，但**决定不在本阶段做**，理由：

- **两个防御是相关的**：设 `FLAG_SECURE` 的银行类 app 恰恰也是最爱检测无障碍的那批，
  最需要降级的地方降级最可能不可用。
- 它是**第二个独立权限**，用户得另外开，所以不是保底。
- 更重要的：按用户定的范围（只做日常功能），**根本不需要去碰银行**。

正确形状（记下来供未来参考）：无障碍不该只是备胎，它在**读取**上本来就比截图强（结构化文本、
无 OCR 错字、离线、不把屏幕内容发给模型服务商），而且两个通道的失败集合几乎不相交——
无障碍读不到游戏/SurfaceView/自绘和"开着无障碍就拒绝运行"的 app，截图读不到 `FLAG_SECURE`。
所以应当是"**哪个能读就用哪个**"，两边都读不到就如实说看不到。

为此本阶段的工具**一律通过一个 `ScreenReader` 接口问"屏幕上有什么"，不直接调截图**，
这样以后加无障碍是纯新增，不用回头改工具。

## 下一步

1. 做完工具链可移植化：`setup-toolchain.ps1` → 改那 5 处硬编码 → `.gitignore` → 文档。
2. 装工具链，然后跑一次 `expo prebuild` 确认两个还没验证的锚点（生成的 `app/build.gradle` 里有没有
   `dependencies {` 和 `buildFeatures {`，AIDL 该往哪开）。**这一步不需要真机，也不需要装 Shizuku。**
3. 第 6 步：Kotlin + AIDL + 三个 config plugin。
4. 第 7 步：取点 UI + 未安装引导弹窗。
5. 真机验证（需要手机上装好 Shizuku 并配对）。

## 待用户决定

- **工具的 `summarize` 该用中文还是英文？** 它显示在中文界面的工具卡片上，但现有 22 个工具的
  summary 都是英文（如 `read /sdcard/...`）。我按"对齐现有 22 个"选了英文，没擅自埋一个中文特例进去。
  要统一改成中文的话那是仓库级决定，得连 22 个一起动。

## 跑命令的注意

- 这台机器 bash 里没有 `pnpm`，要用 **`corepack pnpm ...`**（node 在 `D:\noedJS`）。
- **`corepack pnpm run check` 是跑不通的**：根 `package.json` 的脚本内部又调 `pnpm`
  （`"check": "pnpm run typecheck && pnpm run test && pnpm run bundle"`），而子 shell 的 PATH 上没有
  `pnpm`，会以 `'pnpm' 不是内部或外部命令` 失败。要分三条跑：

  ```bash
  corepack pnpm -r --filter "./packages/**" --filter "./apps/**" run typecheck
  corepack pnpm -r --filter "./packages/**" --filter "./apps/**" run test
  corepack pnpm --filter @mobileclaw/mobile run bundle
  ```

- **别用 `... | tail` 去看退出码**：管道的退出码是 `tail` 的，恒为 0。加 `set -o pipefail`
  或者干脆不接管道。这一点害我误报过一次"检查通过"。
- 直连 GitHub 被墙，走本地代理 `http://127.0.0.1:7897`（`eng/commit.ps1` 里记的 7892 是过时的）。
