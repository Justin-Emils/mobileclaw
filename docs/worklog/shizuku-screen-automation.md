# Work log / handover — Shizuku 屏幕自动化

> **这是一份交接文档。** 刻意写成自包含的：换一个对话、换一台机器，读完这一份就能接着干。
> 会话上下文会丢；实施计划在 `~/.claude/plans/` 下、**不随仓库走**，所以关键结论全部抄在这里。
>
> 👉 **想先看项目整体在哪、接下来先做什么，读 [`project-status.md`](./project-status.md)。**
> 那份里有一条要紧的：这条线做的是 PRD 里排 **M2** 的东西，而 **M1 的分享面板入口和 SAF 都还没写**。
>
> 最后更新：2026-10-09

---

## 一、目标与不可协商的约束

给 MobileClaw 加"输入一条命令，去 A 软件取信息、处理后写进 B 软件"的能力（目标场景：微信 → QQ）。
走 **Shizuku（shell / uid 2000）**，不走无障碍服务——本项目有意排除了 AccessibilityService
（`README.md`、`docs/android-capabilities.md` 都记了：Play 政策不接受自动化用途，Android 17 的 AAPM
会封掉非无障碍用途的 Accessibility API）。

用户在过程中定下的硬约束，**任何后续改动都不能违反**：

1. **每一次涉及更改的操作都要用户亲自确认**，不允许"本次会话内总是允许"。
2. **必须明确提出"我做了什么"**，且这句陈述由代码从实际执行的事实生成，不能由模型自由发挥。
3. **必须附截图存证。**
4. **范围只到日常功能**：银行、支付、政务这类不做自动化，遇到就如实说"这一步你自己来"。
5. **严禁硬编码**，遵守仓库既有开发规范；魔数提常量、只在一处定义。
6. **改 bug 前先确定成因再针对性修**：不要顺手大改，也不要"给某个报错单独套个 catch"消掉症状。
7. **测试交给另一个 agent 产出并运行**（可异步），拿到结果后**自己复核**。
8. **每完成一个事件就更新日志**（开发完一个阶段 / 测试生成完 / 测试跑完）。
9. 过程叙述、进度、结论**用中文**。

---

## 二、现在的状态

**能装到手机上用的东西：没有。** 没有任何 APK 产出过，Kotlin 从未编译，真机一行都没跑过。
所有已完成的产出都在 JS/TS 层，加上一份**未编译**的 Kotlin。

原计划 8 步，做完 6 步：

| 步骤 | 状态 |
|---|---|
| 1. core `neverRemember` | ✅ 完成，有测试 |
| 2. `AutomationService` 端口 + `cap-automation` 工具束 | ✅ 完成，有测试 |
| 3. 审批通道携带数据 | ✅ 完成，有测试 |
| 4. 存证截图进入会话记录 | ✅ 完成，有测试 |
| 5. JS 原生桥 + `bootstrap.ts` 接线 | ✅ 完成 |
| 6. Kotlin + AIDL + 三个 config plugin | ⚠️ **代码写完、config plugin 已验证、Kotlin 从未编译** |
| 7. UI（取点器 / 审批弹窗 / 引导弹窗） | ⚠️ **取点器与审批弹窗完成；Shizuku 未安装引导弹窗没做** |
| 8. 真机端到端验证 | ❌ 未开始 |

**测试现状（自己跑过的真实数字）**：core 102、capabilities 74、mobile 194、`node --test eng/toolchain.test.cjs` 17。
typecheck 三个包全过，Metro 打包通过。

### 仓库状态（写这份时）

- 分支是 **`myqiV1`**。用户自己做过一次提交 `c0b721b 修改硬编码`（37 个文件，+3358/−178），
  **本工作的大部分文件都在那一次里**（`automation.ts`、`native-shizuku.ts`、`eng/toolchain*.cjs`、
  `setup-toolchain.ps1`、本日志……）。
- **还没提交的**是它之后的一层：坐标归一化（`types.ts` / `automation.ts` / `native-shizuku.ts`）、
  取点器与审批弹窗（`point-picker.tsx` / `point-mapping.ts` / `approval-sheet.tsx`）、
  Kotlin 与 AIDL（`apps/mobile/android-native/`）、以及 README / `dev-environment.md` / `BUILD.md` /
  `android-capabilities.md` 的文档更新。
- **提交前先跑第七节那三条验证命令**，别只看这份文档说的数字。

---

## 三、文件地图

### 屏幕自动化（本次新增）

| 文件 | 是什么 |
|---|---|
| `packages/core/src/tool.ts` | `ToolDefinition` 上的 `neverRemember` 与 `pickPoint` 两个新字段 |
| `packages/core/src/permission.ts` | 权限闸门；`neverRemember` 的强制执行在这里 |
| `packages/core/src/agent.ts` | `mergeApprovedInput` / `evidenceOf` |
| `packages/core/src/automation.ts` | `SCREEN_DEFAULTS`（截图默认参数的唯一出处） |
| `packages/core/src/types.ts` | `AutomationService` / `ScreenCapture` / `AutomationStatus` / `ForegroundWindow` |
| `packages/capabilities/src/tools/automation.ts` | 六个 `screen_*` 工具 |
| `packages/capabilities/src/plugins.ts` | 第七个工具束 `cap-automation` |
| `apps/mobile/src/runtime/services/native-shizuku.ts` | **JS 桥 + 所有命令拼装**（几何、解析、转义都在这里，有测试） |
| `apps/mobile/android-native/shizuku/*` | 4 个真实文件（3 个 `.kt` + 1 个 `.aidl`），prebuild 时被拷进生成的项目 |
| `apps/mobile/src/ui/point-picker.tsx` | 全屏取点器 |
| `apps/mobile/src/ui/point-mapping.ts` | letterbox 与归一化的纯函数（有测试） |
| `apps/mobile/src/ui/approval-sheet.tsx` | 审批弹窗（缩略图 / 取点按钮 / 隐藏"总是允许"） |
| `apps/mobile/src/ui/tool-card.tsx` | 会话记录里的存证截图（本项目第一个 `<Image>`） |
| `apps/mobile/app.config.ts` | 三个 config plugin：`withMobileClawShizuku` / `withShizukuManifest` / `withShizukuGradle` |

### 工具链可移植化（本次新增）

| 文件 | 是什么 |
|---|---|
| `eng/toolchain.cjs` | 解析工具链位置（参数 → 环境变量 → 仓库旁 `.toolchain/` → 平台常见位置） |
| `eng/toolchain-versions.cjs` | 版本唯一出处（JDK 21 / SDK 包 / CMake / ninja / Gradle / 下载端点） |
| `eng/toolchain.test.cjs` | 17 个用例，用 Node 内置的 `node --test` |
| `eng/setup-toolchain.ps1` | 新机器跑一次装好；`-DryRun` 可先看计划，`-FixNinja` 换 ninja |

---

## 四、已确认的技术事实（不用再查一遍）

- **Shizuku API**：`dev.rikka.shizuku:api` 与 `:provider`，最新稳定版 **13.1.5**（从 Maven Central 读的，不是猜的）。
- **provider 必须这么写**（官方 README）：

  ```xml
  <provider
      android:name="rikka.shizuku.ShizukuProvider"
      android:authorities="${applicationId}.shizuku"
      android:multiprocess="false" android:enabled="true" android:exported="true"
      android:permission="android.permission.INTERACT_ACROSS_USERS_FULL" />
  ```

  **不要**加网上流传的 `moe.shizuku.manager.permission.API_V23`——官方 README 里没有这条。
- **`Shizuku.getUid()`**：root 返回 0，ADB 返回 2000。
- **`UserServiceArgs` 必须设 `tag`**（类名在 R8 后不稳定）；`version` 不匹配会重启服务。
- **unbind 后进程不会自己退出**，要处理 destroy（transaction code `16777115` / aidl 写 `16777114`）并 `System.exit()`。
- **UserService 进程不是合法的 Android 应用进程**，`registerReceiver` / `getContentResolver` 不能用。
- **uid 2000 写不进应用私有目录**，app 也读不到 `/data/local/tmp` → 截图必须经 binder 回传字节。
- **生成的 `app/build.gradle`**：有 `dependencies {`（顶级，第 165 行附近）；**没有** `buildFeatures {`，
  必须自己插一块，否则 AIDL 被静默忽略。
- **`MainApplication.kt` 里模板注释 `// add(MyReactNativePackage())` 一直在**，`withMobileClawFiles`
  是把新行插在它**后面**，并没有消费掉它。
- **Expo 的 mod 编译器按 mod 类型分组**，两个插件的 `withMainApplication` **不保证按数组顺序执行**。
  不要依赖另一个插件的产物当锚点。
- **网络（这台机器实测）**：`dl.google.com` / `services.gradle.org` / `repo1.maven.org` **直连都很快**
  （0.24–0.76s），只有 **GitHub 需要走 `http://127.0.0.1:7897` 代理**。
- **本机工具链现状**：**没有 Android SDK、没有 JDK 21、没有 Gradle 缓存**（`~/.jdks` 里只有
  corretto-1.8 / ms-17 / loom-ea-25）。`E:\code\Eng` 那套路径**已经不存在**。

---

## 五、关键设计决定（含中途改过的，以及为什么）

### 1. `neverRemember` 而不是 `alwaysAsk`

`alwaysAsk` 仍然会让步于"本次会话内总是允许"——那是那个按钮的定义。而**原来的 `evaluate()` 把白名单判定
排在 `alwaysAsk` 之前**，所以那条"必须每次确认"的硬要求在代码层面根本做不到，UI 上怎么写都没用。
`neverRemember` 是更严的承诺：它的检查放在 deny 规则之后（硬拒绝仍然赢）、allow 规则之前，
并让 `authorize()` 把审批返回的 `remember` 丢掉。历史遗留的白名单条目因此**自动失效，不需要数据迁移**。

### 2. 审批通道要能传数据，而且**只补不覆盖**

没有 OCR 的版本里模型看不见屏幕、产生不了坐标，所以"用户在截图上点位置"**就是**坐标的来源，
不是锦上添花。

**中途修掉的一个真漏洞**：审批返回的 `input` 原本是 `{ ...base, ...approved }` **覆盖**合并，
而 `paths` 和规则判定都在 `authorize` **之前**、基于合并前的 `call.input` 算好；`registry` 之后只按
schema 重校验类型，**不重跑权限规则**。于是可以先用一个合法路径满足 `pathPattern` deny 规则的检查，
再由审批值把落点换成被禁路径。**已复现**（`written = ['/root/secret/leak.txt']`）。
修法是改成**只补模型没给的键**——这条通道的本来目的就是补模型不可能知道的东西，覆盖从来不是需求。

**已知残留**（今天不可达）：若将来有工具的路径字段是**可选**的且模型省略了它，审批仍能补进一个被 deny 的
路径。彻底堵上需要对合并后的输入重跑一次 gate。当前所有 `fs_*` 的 `path` 都是必填，够不着。

### 3. 坐标**归一化**（0~1），不是设备像素

**这是中途改的，原因值得记**：取点器需要把图上的点换算成设备像素，但**它拿不到设备尺寸**——
工具入参里没有，让模型再转发一遍是脆的。而截图是**降采样**的（720 宽的图拍的是 1080 宽的屏），
所以图的像素根本不是设备像素。

改成上报**比例**：取点器只报 0~1，换算发生在 `createAutomationService.tap` 里、用 `wm size` 当场解析。
好处是几何只有一处说了算（和 `scroll` 一致）、取点器不需要知道设备尺寸、
**而且能撤掉一段加进 Kotlin 的代码**（不可编译的代码越少越好）。
`tap` 的注释里写明了这一点，别改回去。

### 4. AIDL 压到最小，命令在 JS 里拼

AIDL 只有 `exec` / `screenshot` / `destroy`。点击、滑动、`dumpsys` 解析、文本转义**全部在 JS 里拼**
（`native-shizuku.ts`）。理由：**这台机器编译不了 Kotlin**，Kotlin 的每一行都是盲区，而 JS 有测试。
`screenshot` 留成原生方法是因为降采样必须发生在 uid 2000 那一侧（字节只能走 binder）。

### 5. Kotlin 用**真实文件**，不用模板字符串

放在 `apps/mobile/android-native/shizuku/`，插件用 `fs.copyFileSync` 拷进去。
理由：Kotlin 的 `${...}` 是字符串模板，塞进 TS 模板字符串会被 TS 当插值处理掉；
而且五百行转义字符串没人能读、没有语法检查。
（`withMobileClawFiles` 仍是内联写法，应该也搬过来，但那是另一件事。）

### 6. `pickPoint` 声明式，不嗅探

审批弹窗怎么知道该显示取点器？没有去嗅探"有没有 `x`/`y` 字段"（那是隐式的硬编码），
而是在 `ToolDefinition` 上加 `pickPoint: { x, y, image }`，和 `paths` / `alwaysAsk` / `summarize`
一个风格。`screen_tap` 声明它，UI 读它。

### 7. `FLAG_SECURE` → **决定不降级到无障碍**

`FLAG_SECURE` 挡的是像素、挡不住 `AccessibilityNodeInfo`，所以技术上可以降级。**不做的理由**：
设了它的银行类 app 恰恰也是最爱检测无障碍的那一批（两个防御相关，最需要时最可能不可用）；
它是第二个独立权限；而且按"只做日常功能"的范围根本不需要碰银行。
`ScreenCapture.note` 会把"看起来是纯色画面"如实报出来，而不是假装截到了空屏。

---

## 六、还没做的（按建议顺序）

1. **Shizuku 未安装的引导弹窗**（第 7 步的剩余部分）。文案已经写好在 `strings.ts` 的 `automation` 段
   （`shizukuTitle` / `shizukuSteps` / `shizukuRisks` / `shizukuOpen` / `shizukuLater`），
   只差把它渲染出来并接到 `shizuku_status` / `shizuku_request` 上。**用户机器上还没装 Shizuku，所以这个是必须的。**
2. **拿工具链做一次编译验证**。跑 `eng/setup-toolchain.ps1`（下几个 GB），然后
   `eng/build-local.ps1 -Variant debug`。**Kotlin 从未编译过，第一次大概率报错**——这是最优先的未知数。
   顺带能验证 `${applicationId}` 是否被 Gradle 正确代换进 provider 的 authorities。
3. **真机端到端**：`screen_capture` → 用户在截图上点位置 → `screen_tap` 执行 → 确认弹窗没有"总是允许" →
   会话记录里能看到存证截图。需要手机上装好 Shizuku 并配对（**这一步只能用户操作**）。
4. **OCR（下一版）**：设备端 ML Kit 中文识别为默认离线路径，配置了支持视觉的 provider 时改走模型。
   **硬要求**：一旦屏幕内容/文字发给模型，内容就出本机了——必须做一次明确的用户告知与同意。
   本版不会把屏幕内容发给模型服务商，这一点写在风险文案里。
5. 无障碍作为第三个读取通道：不做，理由见下。

### ⚠️ 后续更新：读取通道已接入，而且**不需要无障碍**

第 4、5 条当时的前提是"读取只能靠 OCR / 无障碍"。这个前提是错的：**shell 身份本来就能读任意应用的
无障碍树**，所以读取既不需要第二个权限，也不需要多一次系统设置。

- **已实现**：`uiautomator dump` 走 Shizuku 读取 → 解析 → 投影成带坐标的紧凑文本。
  新增端口 `AutomationService.readScreen`、工具 `screen_read` / `screen_tap_element`、
  模块 `packages/capabilities/src/ui-dump.ts` 与 `android-ui-dump.ts`。
- **`screen_tap` 由此不再必然要人**：读取会给出每个可点元素的真实像素坐标，"按编号点击"成为可能；
  用户手点坐标退化成"没有可读元素时"的兜底，而不是唯一来源。
- **OCR 的定位改为降级通道**，不再是默认路径：只有自绘 UI（游戏、部分 Flutter/Unity、视频）才需要它。
- **无障碍服务仍然不做，但理由要换掉**：原文用"Play 政策 + Android 17 AAPM"两条排除它，这两条都站不住——
  本产品因为 `MANAGE_EXTERNAL_STORAGE` 本来就不上 Play；而 AAPM 封的是"非无障碍工具调用无障碍 API"，
  它对 Shizuku 路线是**同一堵墙**，因此证明不了该选哪条。**真正的理由**：shell 能拿到的树，
  没有理由再声明一个 `AccessibilityService` 去拿第二遍——那是多一个权限、多一次设置。
- **原文第 5 条说"`ScreenReader` 这个 seam 预留着"是不准确的**：当时 `AutomationService` 上并没有这个
  seam（全仓库搜不到 `ScreenReader`）。现在它有了，名字是 `readScreen`。

---

## 七、怎么验证 / 怎么跑命令

**这台机器的坑**（每条都踩过）：

- bash 里**没有 `pnpm`**，要用 **`corepack pnpm ...`**（node 在 `D:\noedJS`）。
- **根 `package.json` 的脚本跑不了**：它们内部又调 `pnpm`，子 shell 的 PATH 上没有，会以
  `'pnpm' 不是内部或外部命令` 失败。`pnpm run check` 因此**从来没有通过过**。分三条跑：

  ```bash
  corepack pnpm -r --filter "./packages/**" --filter "./apps/**" run typecheck
  corepack pnpm -r --filter "./packages/**" --filter "./apps/**" run test
  corepack pnpm --filter @mobileclaw/mobile run bundle
  ```

- **不要用 `... | tail` 判断退出码**：管道退出码是 `tail` 的，恒为 0。这个坑害我误报过一次"检查通过"。
  要加 `set -o pipefail` 或不接管道。
- 工具链解析器：`node --test eng/toolchain.test.cjs`（**`node --test eng/` 这种目录形式不行**）。
- 重新生成原生工程：`cd apps/mobile && corepack pnpm exec expo prebuild --platform android --no-install`。
  **改内联 Kotlin 或 `android-native/` 下的文件后必须删掉 `android/` 重新 prebuild**，
  `eng/build-local.ps1` 的 staleness guard 只重打 JS bundle，不重跑 prebuild。
- 直连 GitHub 被墙，走代理 `http://127.0.0.1:7897`（`eng/commit.ps1` 注释里写的 7892 是**过时的**）。

**验证 config plugin 是否真的生效**（不需要 SDK）：

```bash
grep -n 'ShizukuProvider' apps/mobile/android/app/src/main/AndroidManifest.xml
grep -n -A3 'MOBILECLAW_SHIZUKU' apps/mobile/android/app/build.gradle
grep -n -B1 -A2 'buildFeatures' apps/mobile/android/app/build.gradle
```

---

## 八、关键词（给新会话 / 新人导航用）

**领域词**：Shizuku、UserService、uid 2000、shell identity、No root、ADB、binder、AIDL、
`FLAG_SECURE`、`screencap`、`input tap` / `input swipe` / `input keyevent`、`dumpsys window`、
`wm size`、AccessibilityService、ML Kit、`neverRemember`、`pickPoint`、`alwaysAsk`、`pathPattern` deny rule。

**本仓库的标识符**：`MobileClawShizuku`、`MobileClawFiles`、`MobileClawShizukuUserService`、
`IMobileClawShizukuUserService`、`AutomationService`、`ScreenCapture`、`ScreenEvidence`（**已删除，别找**）、
`SCREEN_DEFAULTS`、`mergeApprovedInput`、`evidenceOf`、`pickPoint`、`PointPicker`、`containRect`、
`toFraction`、`clampFraction`、`scrollPath`、`parseScreenSize`、`parseForeground`、`isAsciiOnly`、
`encodeInputText`、`withMobileClawShizuku`、`withShizukuManifest`、`withShizukuGradle`、
`resolveToolchain`、`candidatesFor`、`setup-toolchain.ps1`。

**工具名**：`screen_current`、`screen_capture`、`screen_tap`、`screen_scroll`、`screen_type`、`screen_wait`、
`shizuku_status`、`shizuku_request`、`shizuku_run`。

**架构不变量**（在 `docs/architecture.md` 里，动手前读它）：
`packages/core` 不许 import 任何平台模块；每个模型给的路径都过 guard；
**工具失败是数据不是异常**（`[E_*]` 字符串）；一次工具调用对应一个结果；非零退出码从不抛。

---

## 九、过程中的失误记录（避免重复踩）

- **误报过一次"检查通过"**：用了 `| tail`，管道退出码恒为 0。根脚本当时其实直接失败了。
- **`SystemService.privileged` 此前恒为 `undefined`**：`createSystemPorts()` 从来没设这个端口，
  所以 `shizuku_*` 三个工具一直报 "not integrated on this platform"。已修。
- **`JDK_MAJOR = 21` 一度是摆设**：解析器只检查 `bin/java` 存在，会把 Java 8 当合格——
  正是我要修掉的"版本只写在注释里"那毛病，自己又犯了一遍。现在读 JDK 自带的 `release` 文件校验主版本
  （`JAVA_VERSION="1.8.0_x"` 要解析成 8 而不是 1）。
- **用另一个插件的产物当锚点是竞态**：Expo 的 mod 按类型分组，不保证数组顺序。
- **测试数量写在三个文件里，一小时内过时三次。** 根子是一个会变的值写在多处，
  和代码里的硬编码是同一个病。**建议**：只留一处，或干脆不写数字。
- **`screen_capture` 存证 bug**：工具返回裸截图、没有 `evidence` 键，而记录只认这个键 →
  截图工具自己那张图永远进不了卡片。用**变异检查**证明测试能抓到它（撤掉修复后恰好那两条用例变红）。
