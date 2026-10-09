# 开发环境与 Android 工具链

> **这份文档名义上跨项目共用，但工具链部分已经改了性质。** 它现在描述的是**本仓库如何解析工具链**
> （`eng/toolchain.cjs` / `eng/setup-toolchain.ps1`），而不是某一台机器的固定布局。所以：平台相关的
> 坑（ninja 长路径、260 字符、PowerShell 的怪癖、`nodeLinker: hoisted`）对任何项目仍然有用，
> 路径则不必再逐字对应。接手前先读这一份，能省掉踩过的十几个坑。

## 一、项目位置与工具链位置

**仓库放在哪都行。** 构建不再引用任何写死的绝对路径（`eng/build-local.ps1` 里那三行已经删掉了）。
要构建时，脚本先解析工具链：

```
eng/toolchain.cjs        ← 按固定顺序解析 JDK / Android SDK / Gradle home
eng/setup-toolchain.ps1  ← 新机器跑一次，把缺的组件装进 <仓库>/.toolchain/
```

解析顺序（最具体优先）：显式参数（`-Jdk` / `-Sdk` / `-GradleHome`）→ 环境变量
（`MOBILECLAW_JDK` / `JAVA_HOME`；`MOBILECLAW_ANDROID_SDK` / `ANDROID_HOME` / `ANDROID_SDK_ROOT`；
`MOBILECLAW_GRADLE_HOME` / `GRADLE_USER_HOME`）→ **仓库旁 git 忽略的 `<仓库>/.toolchain/`** →
各平台常见位置。全都没找到时会列出**每一个试过的路径**和三种修法。看当前解析结果：
`node eng/toolchain.cjs print`。

工具链**故意不提交进仓库**：SDK 好几 GB、JDK 约 200MB、Google 许可不允许再分发、二进制还分平台
（Windows 的到 Linux 没用）。要用就装到 `<仓库>/.toolchain/`（已在 `.gitignore` 里），或把它整份
拷到另一台机器 —— 那是换机最省事的办法。

> **位置变更历史（重要，教训仍在）**：2026-10-07 曾把仓库临时挪到 E 盘下的一个短路径
> （`E:\mc\...` 那一套），赌的是"路径超 260 字符、放哪都没救"。**那个结论是误诊**：260 是 SDK 自带
> ninja 的版本问题，和仓库位置基本无关（见第三节）。**挪源码治不了根因，还平添迁移风险**，所以那次
> 搬迁已回退；旧笔记里看到 `E:\mc` / `E:\m\mc` 一类的路径即为过期信息。
>
> 顺带提醒：**如果将来真要移动仓库目录，注意两点** ——
> (1) 移动前先停掉 Gradle daemon，否则 `node_modules` 会被占用导致复制不完整；
> (2) `Move-Item` 在目标目录已存在时会把源目录**嵌套进去**（曾造出过 `mobileclaw\mobileclaw\`），
> 因此移动前要确保目标不存在或用 `robocopy /E`。
> 现在没有理由再移了 —— 只要让 `eng/toolchain.cjs` 重新解析到工具链即可。

## 二、Android 构建工具链

版本只有一处出处：`eng/toolchain-versions.cjs`（以前这些版本**只写在 `build-local.ps1` 的注释里**，
运行时根本不校验）。`eng/toolchain.cjs` 按它校验、`eng/setup-toolchain.ps1` 按它安装，所以两者不会
各说各话。当前值：

| 组件 | `.toolchain/` 里的相对落点（解析结果见下） | 版本 |
| --- | --- | --- |
| JDK | `jdk/`（`bin/java` 必须在） | Temurin 21（≥ 21 即可；只用 `bin/java` 与 `bin/keytool`）|
| Android SDK | `android-sdk/`（`platform-tools/adb` 必须在） | build-tools 36.0.0 / platforms/android-36 / NDK 27.1.12297006 |
| CMake | `android-sdk/cmake/3.30.5` | **必须 3.30.5，不要用 SDK 默认的 3.22.1** |
| Gradle | `gradle-home/`（可以不存在，Gradle 首次运行会自建） | 9.3.1，缓存已预热 |
| adb | `android-sdk/platform-tools/adb.exe` | 1.0.41 |
| ninja | `android-sdk/cmake/{3.30.5,3.22.1}/bin/ninja.exe` | **1.12.1**（2026-10-07 手工换入；两份的原 1.10.2 各备份为同目录 `ninja-1.10.2.exe.bak`）|

⚠️ "`.toolchain/` 里的相对落点"只是**解析器最后才试的兜底位置**。`eng/toolchain.cjs` 先看显式参数、
再看环境变量、然后才是仓库旁的 `.toolchain/`、最后才到各平台常见位置。跑
`node eng/toolchain.cjs print` 看本站的真实结果，别照抄这张表。

⚠️ **ninja 必须 ≥ 1.11**：SDK 的 CMake 自带的 1.10.2 会在 260 字符处直接失败，与仓库放哪无关。
原因、实测和还原方法都在第三节。

⚠️ **PATH 里的 `java` 可能是 Java 8**，构建 Android 不够。解析器会读 JDK 自带的 `release` 文件校验
主版本（`JAVA_VERSION="1.8.0_x"` 要解析成 8 而不是 1），太低的候选直接跳过，所以最终选中的一定是
≥ 21 的那个；必要时设 `JAVA_HOME` / `MOBILECLAW_JDK` 指过去。

## 三、路径长度：真正的限制来自 ninja 的版本，不是 Windows

Android 原生编译（prefab + CMake）会生成极深的路径。实测本项目里最长的一条：

```
<仓库根>/node_modules/.pnpm/expo-modules-core@57.0.21_r_1e6aeb6e95e4a16e1ae348a1b4629ea0/node_modules/
  expo-modules-core/android/.cxx/Debug/6g1yt324/prefab/arm64-v8a/prefab/lib/
  aarch64-linux-android/cmake/react-native-worklets/react-native-workletsConfigVersion.cmake
```

这段路径在隔离布局下确实会爆掉，报错长这样：

```
ninja: error: rebuilding 'build.ninja':
  Stat(.../react-native-workletsConfigVersion.cmake): Filename longer than 260 characters
```

**但 260 不是 Windows 的限制，是 ninja 自己写死的守卫**，而且只存在于旧版本。上游
`src/disk_interface.cc` 里这个判断是（[ninja master](https://github.com/ninja-build/ninja/blob/master/src/disk_interface.cc)）：

```cpp
if (!path.empty() && !AreLongPathsEnabled() && path[0] != '\\' && path.size() > MAX_PATH)
```

`AreLongPathsEnabled()` 探测 ntdll 的 `RtlAreLongPathsEnabled` —— 也就是"本机有没有开长路径"。
本机实测：

```
LongPathsEnabled (HKLM\SYSTEM\CurrentControlSet\Control\FileSystem) = 1
RtlAreLongPathsEnabled()                                            = 1
```

系统这侧本来就是好的。问题在 SDK 的 CMake 3.30.5 自带的 `ninja.exe` 是 **1.10.2**，这一版
**还没有**上面那个探测：我在它的二进制里找不到 `RtlAreLongPathsEnabled`，却能找到写死的
报错串（`"): Filename longer than "` + `" characters"`）。**换成 1.12.1 后守卫直接消失**。
同一个 `build.ninja`、输入路径 340 字符的实测：

| ninja | 结果 |
| --- | --- |
| 1.10.2（SDK 原带） | `Stat(...): Filename longer than 260 characters`，exit 1 |
| 1.12.1（现在装的；取自 CLion 2025.1.3 的 `bin\ninja\win\x64\ninja.exe`，含 `longPathAware` 清单） | exit 0，正常规划并执行命令 |

AGP 调用的就是这个路径（`gradle-cmake30.txt:641` 里能看到工具链里的
`cmake\3.30.5\bin\ninja.exe`），所以替换一个文件即可。
**3.22.1 那份也必须一起换**：`eng/pin-cmake-version.init.gradle` 只覆盖
`com.android.library`，`:app` 模块的原生构建仍然走默认的 CMake 3.22.1，于是又用回旧 ninja
（`build-local-debug.txt:1524` 就抓到了这一点）。现在两份都换了：

| 文件 | 说明 |
| --- | --- |
| `cmake\3.30.5\bin\ninja.exe` | 1.12.1，sha256 `D66FB0BB742CD99DA6C3B9A3F870FE44E4EF610EDA2FB92EACB6BF52DA4AB0F9` |
| `cmake\3.22.1\bin\ninja.exe` | 1.12.1，同一个文件 |
| 同目录 `ninja-1.10.2.exe.bak` | 各自的原文件备份，sha256 `3ED5DDA7CB9E5DFA242AF02E34E777C1C4D202DDEA00415F944DB587F1B626A0`；还原就是把名字改回去 |

### 第二道保险：平面 node_modules（`nodeLinker: hoisted`）

就算 ninja 修好了，路径短一点也更稳：CMake 自己还有一条 250 字符的**警告**线，而 NDK 的
`clang.exe` 和 CMake 本身都**没有**长路径清单，超过 260 的真实文件操作仍可能出问题。

pnpm 11 **支持** `nodeLinker`，只是要写在 `pnpm-workspace.yaml`，不能写在 `.npmrc`
（`.npmrc` 现在只读 auth / registry）。已经加上：

```yaml
nodeLinker: hoisted
```

实测效果（取 prefab 那条最坏路径）：

| 包 | 隔离布局 | 平面布局 |
| --- | --- | --- |
| `expo-modules-core` | 265 | **178** |
| `react-native-worklets` | 262 | **182** |
| `react-native-screens` | 261 | **181** |

平面布局下包直接落在 `node_modules\<包名>`，`node_modules\.pnpm` 不再参与；
`apps/mobile/node_modules/.bin/expo.cmd` 在平面布局下**不存在**了（shim 装在仓库根的
`node_modules\.bin\expo.cmd`），`eng/build-local.ps1` 已改成两处都找。

⚠️ **切换布局必须彻底重装。** 光跑一次 `pnpm install` 不会清掉 `node_modules\.pnpm` 的旧目录，
也不会清掉 `apps/mobile/node_modules\<包>` 那些**指回 `.pnpm` 的 junction**；Node 解析走 realpath，
会顺着 junction 回到长路径 —— 第一轮换完布局后构建仍然报 260，就是这个原因。清空时注意：

1. **先删 junction，再删目录**（`Remove-Item` 即可）；`robocopy` / `xcopy` 这类工具要加 `/XJ`
   才能不跟随重解析点；
2. **绝对不要用 `robocopy /MIR 空目录 node_modules`**。workspace 包在 node_modules 里是指向
   `packages\*`、`apps\mobile` 的 junction，robocopy 会穿透它**删掉源文件**——2026-10-07 就这么
   毁过一次 `apps/mobile/**` 与 `packages/*/**`，靠 `git checkout -- apps packages` 恢复的。

### 确实试过、确实没用（别再花时间）

| 办法 | 为什么无效 |
| --- | --- |
| `subst S: <仓库>` / 目录 junction | CMake 把**真实绝对路径**写进 `build.ninja`，短盘符骗不过 |
| 注册表 `LongPathsEnabled=1` | 早就开了，但旧 ninja 不读它；换成 1.11+ 之后它才开始起作用 |
| 手工改写 `build.ninja` 去掉重生成命令 | 还有其他重生成钩子，且下次 Gradle 会重写 |
| 把仓库挪到 `E:\mc`、`E:\m\mc` 这类短路径 | 治不了根因，还平添迁移风险（见第一节） |

### 曾被误判为"无效"、其实是放错了位置

| 办法 | 真相 |
| --- | --- |
| `.npmrc` 里的 `node-linker=hoisted` | 键名有效，但 pnpm 11 不从 `.npmrc` 读它 → 写进 `pnpm-workspace.yaml` 就行（上一节）|
| `.npmrc` 里的 `shamefully-hoist=true` | 同上，camelCase 写作 `shamefullyHoist` |
| `.npmrc` 里的 `virtual-store-dir=E:\.pnp` | 同上，camelCase 写作 `virtualStoreDir`；但它改不动 `.cxx` 的位置，别指望它 |

### 其他项目怎么用这套工具链

本项目是"原生依赖多 + CMake prefab 深"的最坏情况。**纯 Java/Kotlin 的 Android 项目完全不受
影响**，仓库放哪都行。判断方法：项目里如果有 `.cxx/`、`CMakeLists.txt` 或 `externalNativeBuild`，
就按本节检查两件事：

1. **SDK 里那份 ninja 已经全局换成 1.12.1**（第二节），所有项目共享，不必各自处理；
2. **pnpm 项目加 `nodeLinker: hoisted`**（写进 `pnpm-workspace.yaml`）。npm / yarn 本来就是
   平面布局，没有这个问题。

## 四、环境特有的坑（每个都踩过）

| # | 症状 | 原因 | 修法 |
| --- | --- | --- | --- |
| 1 | 脚本在 `java -version`、`git push` 后直接中止，报 `NativeCommandError` | `$ErrorActionPreference='Stop'` 把**任何 stderr 输出**当终止性异常，而这些命令正常就写 stderr | 别用 `& cmd 2>&1`；用 .NET `ProcessStartInfo` 取输出与退出码，或临时切 `'Continue'` |
| 2 | git / npm / Expo CLI 报 TLS 握手失败或 21 秒超时 | 全局代理（`http.proxy`，本机是 `127.0.0.1:7897`，**端口换过**——旧记录里的 7892 已失效）访问 GitHub 会失败 | 子进程设 `NO_PROXY=*`。**git 配置里写空值无效**（空值被当作未设置，仍回退全局代理）。另：`dl.google.com`、`services.gradle.org`、`repo1.maven.org` **直连可达且快**，只有 GitHub 被墙 |
| 3 | `gradlew` 卡在下载 gradle-9.3.1-bin.zip 然后超时 | wrapper 按 `gradle-wrapper.properties` 的哈希找目录，找到的是没下完的那份 | 直接用工具链目录里已解压的 `gradle-home\wrapper\dists\...\gradle-9.3.1\bin\gradle.bat` |
| 4 | `npx --no-install expo ...` 报 `could not determine executable to run` | pnpm workspace 布局下 npx 解析不到 | 用 `node_modules\.bin\expo.cmd` |
| 5 | `The NODE_ENV environment variable is required but was not specified` | Expo 的 Gradle 插件要求 | 设 `NODE_ENV=development`（debug）/ `production`（release） |
| 6 | `ninja: error: manifest 'build.ninja' still dirty after 100 tries` | CMake 3.22 生成的 `build.ninja` 里重生成规则**不声明任何输入**且 `restat=1`，ninja 永远认为清单过期 → 重跑 CMake → 再重来，100 次后放弃 | **装并用 CMake 3.30.5**（`sdkmanager "cmake;3.30.5"`），用 `eng/pin-cmake-version.init.gradle` 钉住 |
| 7 | 文件被写成 `鈫?`、`鈥?` 乱码 | PowerShell 的 `Get-Content -Raw` + `Set-Content -Encoding UTF8` 把 UTF-8 当 GBK 解码 | 用编辑工具；或 .NET `[System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)` 配 `UTF8Encoding($false)` |
| 8 | 构建停在 `Filename longer than 260 characters` | SDK 自带的 ninja 1.10.2 把 260 写死在代码里，且不认识系统的长路径开关 | 换 ninja ≥ 1.11（第三节，已经换好）|
| 9 | `& .\eng\build-local.ps1` 立刻返回，重定向的日志里一行都没有 | 执行策略禁止运行未签名脚本，抛 `PSSecurityException`，而且这条错误**不进**被重定向的文件 | 用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File eng\build-local.ps1 ...`（`eng\schedule.ps1` 注册任务时同理）|
| 10 | 受限会话里写**工具链目录的子目录**全被拒（`UnauthorizedAccessException`），只有根目录可写 | 这些目录是更早的会话在非受限进程里创建的，完整性级别高于受限会话；修 DACL 治不了 | 切「完全权限」会话，或对那一条写入用一次性提权 |
| 11 | 用 `\| Out-String` 捕获会派生子进程的原生工具（ninja、gradle）时，命令**永不返回** | 子进程继承了管道句柄，外层要等句柄全部关闭 | 别捕获：重定向到文件再读；或只跑 dry-run（`ninja -n`）|
| 12 | 清空 node_modules 后，`apps/mobile/**`、`packages/*/**` 的源文件整片消失 | 用了跟随重解析点的方式清 node_modules，而 workspace 包在里面是指向源码目录的 junction | 先删 junction 再用 `Remove-Item`；已经删了就 `git checkout -- apps packages`（文件都在 HEAD 里）|
| 13 | `eng/build-local.ps1` 报 `expo CLI not found at ...apps\mobile\node_modules\.bin\expo.cmd` | 平面布局下 shim 只装在仓库根 `node_modules\.bin` | 脚本已改成两处都找（2026-10-07）|
| 14 | `:app` 模块的原生构建报 `Filename longer than 260 characters`，但库模块都正常 | `pin-cmake-version.init.gradle` 只覆盖 `com.android.library`，`:app` 仍用默认 CMake 3.22.1，于是用了 3.22.1 那份旧 ninja | 两份 ninja 都要换（第三节已换）|

**第 6 条的注入方式值得单独记**：AGP 9 **移除了** `CmakeOptions.arguments`（可用 init 脚本
dump 出该对象只有 `path` / `version` / `buildStagingDirectory` 三个成员），所以
`-DCMAKE_SUPPRESS_REGENERATION=ON` 的三条注入路径全部走不通。**`version` 是唯一还能用的属性**：

```groovy
// eng/pin-cmake-version.init.gradle
allprojects { project ->
    project.plugins.withId("com.android.library") {
        project.android.externalNativeBuild.cmake.version = "3.30.5"
    }
}
```

## 五、日常命令

**首次（新机器只跑一次）** —— 把工具链装进 `<仓库>/.toolchain/`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File eng\setup-toolchain.ps1 -DryRun    # 先看计划
powershell -NoProfile -ExecutionPolicy Bypass -File eng\setup-toolchain.ps1 -FixNinja  # 装 + 换 ninja
node eng\toolchain.cjs print        # 确认解析到哪
# 已经有现成 JDK/SDK 的话不用装：设 JAVA_HOME / ANDROID_HOME，解析器会自动找到
```

**验收（无需设备，秒级，改代码后必跑）** —— 在仓库根执行：

```powershell
pnpm check        # 类型检查 + 370 个单测（core 102 / capabilities 74 / mobile 194）+ 真实 Metro 打包
```

**出 APK（本地，首选）：**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File eng\build-local.ps1 -Variant debug
powershell -NoProfile -ExecutionPolicy Bypass -File eng\build-local.ps1 -Variant release -GenerateKeystore
```

产物在 `artifacts\mobileclaw-local-<variant>.apk`。脚本先调 `eng\toolchain.cjs` 解析工具链，再自己
设好 `JAVA_HOME` / `ANDROID_HOME` / `GRADLE_USER_HOME` / `NODE_ENV`，并加载
`eng\pin-cmake-version.init.gradle` 钉住 CMake 3.30.5；`-Clean` 会先删掉 `android\` 再跑一次
`expo prebuild`。要覆盖自动解析的结果，就加 `-Jdk` / `-Sdk` / `-GradleHome`。

**云端 EAS（备选，消耗额度）：**

```powershell
cd apps\mobile
npx eas-cli@latest build -p android --profile preview --non-interactive
```

免费额度 15 次，已用 11 次。`preview` / `development` 为 `buildType: "apk"`（可直接安装），
`production` 出 `.aab`。

## 六、其他会话必读的三条

1. **仓库放哪都行**，构建路径由 `eng/toolchain.cjs` 解析（见第一节），代码里不再有写死的绝对路径。
   想要一个可携带的工具链，就把它装进 `<仓库>/.toolchain/` 再整份拷到别的机器。
2. **工具链不提交进仓库**：`<仓库>/.toolchain/` 已被 `.gitignore` 忽略 —— 它有好几 GB、Google 许可
   不允许再分发、二进制还分平台。新机器跑一次 `eng\setup-toolchain.ps1` 装上即可。
3. **写含中文的文件务必用 UTF-8 无 BOM**，见上表第 7 条——本项目因此损坏过两次文件、被迫两次
   `git checkout` 恢复，其中一次还把已改好的界面文案一起回滚了（提交前务必 `git diff` 核对）。
