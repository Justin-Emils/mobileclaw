# 构建 APK

> **环境事实、工具链版本以及 Windows 路径分析现在都放在
> [`docs/dev-environment.md`](../docs/dev-environment.md) 里** —— 该文档跨项目共享，
> 因此它是首要参考。本文件保留构建命令以及与构建相关的历史记录。

无需设备、也无需 Expo 账号即可运行的验证（全部在本地）：

```bash
pnpm check      # typecheck + 370 tests (core 102 / capabilities 74 / mobile 194) + a real Metro bundle
pnpm doctor     # expo-doctor, expect 21/21
```

> **构建不再假定仓库所在的位置。** 工具链在构建时由 `eng/toolchain.cjs` 解析（显式的
> `-Jdk`/`-Sdk`/`-GradleHome` → 环境变量 → 仓库旁被 git 忽略的 `.toolchain/` → 平台的常规位置）。
> 在新机器上，`eng/setup-toolchain.ps1` 会把 JDK 和 Android SDK 安装到 `.toolchain/` 中。
> 2026-10-07 的那次迁移是在追查一个路径长度问题，结果发现真正的原因是 Android SDK
> 自带的 ninja 太旧 —— 见阻碍项 2。

## 本地 Android 构建（`eng/build-local.ps1`）

本地构建不需要 EAS 配额。工具链由 `eng/toolchain.cjs` 解析，各组件版本集中放在一处：
`eng/toolchain-versions.cjs`。`node eng/toolchain.cjs print` 会显示构建将使用什么。

| 组件 | 位置（相对于 `.toolchain/`，即解析器的回退位置） | 版本 |
| --- | --- | --- |
| JDK | `jdk\`（`bin\java` 必须存在） | Temurin **21**。见下方警告：并非所有更新的 JDK 都能用。 |
| Android SDK | `android-sdk\`（`platform-tools\adb` 必须存在） | build-tools 36.0.0, platforms/android-36, ndk 27.1.12297006 |

### 不要用 JDK 24 构建

`:react-native-worklets:configureCMakeRelWithDebInfo[<abi>]` 在 JDK 24 下会中止，并报

```
> WARNING: A restricted method in java.lang.System has been called
```

这是 JDK 24 针对 CMake 集成所做的更严格校验，并非 Gradle 或 CMake 的故障，但它会让整个
构建失败。JDK 21 构建同一棵代码树只需不到一分钟。解析器只检查 JDK *至少* 是 21，因此
更新的版本会被接受，然后在很晚的阶段才失败，而错误信息既没提 Java 也没提版本号。

### 按机器固定工具链：`.toolchain/.config`

解析器在查阅任何环境变量之前会先读这个文件，所以写在这里的设置优先于通用的 `JAVA_HOME`
—— 这一点很重要，因为一台机器的 `JAVA_HOME` 里很容易装着一个本项目无法用来构建的 JDK。

该文件位于 `.toolchain/` 内，而该目录被 git 忽略，因此它只留在本地。每行一个
`KEY=VALUE`，`#` 开始一行注释：

```
MOBILECLAW_JDK=E:\code\Eng\.jdk21
MOBILECLAW_ANDROID_SDK=E:\code\Eng\.android-sdk
MOBILECLAW_GRADLE_HOME=E:\code\Eng\.gradle-home
MOBILECLAW_ENG_ROOT=E:\code\Eng
```

这四项都是可选的。如果一个都没设置，解析器会回退到环境变量，然后是 `.toolchain/`，
再然后是常规安装位置；失败时 `node eng/toolchain.cjs print` 会列出它查找过的每一个位置。

| CMake | `android-sdk\cmake\3.30.5` | 3.30.5，由 `eng/pin-cmake-version.init.gradle` 固定（3.22.1 会死循环 —— 阻碍项 1） |
| ninja | `android-sdk\cmake\{3.30.5,3.22.1}\bin\ninja.exe` | 两处都已手动换成 1.12.1；原文件各自以 `ninja-1.10.2.exe.bak` 留在旁边（阻碍项 2） |
| adb | `android-sdk\platform-tools\adb.exe` | 1.0.41 |
| Gradle | `gradle-home\`（无需存在 —— Gradle 会自己创建） | 9.3.1，已预先解压并带有热缓存 |

在新机器上，请先安装工具链（或者把 `JAVA_HOME` / `ANDROID_HOME` 指向你已有的 —— 解析器
会先检查环境，再看 `.toolchain/`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File eng\setup-toolchain.ps1 -DryRun    # plan only
powershell -NoProfile -ExecutionPolicy Bypass -File eng\setup-toolchain.ps1 -FixNinja  # install + replace ninja
node eng\toolchain.cjs print                                                           # confirm resolution
```

`eng/build-local.ps1` 是**受支持的入口**：直接调用 `gradle` 会绕过它施加的陈旧性防护
（见下文“一次‘成功’的构建却打进了陈旧的 JS bundle”）。

本机的执行策略会拒绝未签名的脚本，而该错误不会落到重定向的日志里 —— 它会静默退出。
请通过一个 Bypass 主机来启动它：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File eng\build-local.ps1 -Variant debug
powershell -NoProfile -ExecutionPolicy Bypass -File eng\build-local.ps1 -Variant release -GenerateKeystore
powershell -NoProfile -ExecutionPolicy Bypass -File eng\build-local.ps1 -Install   # adb install

Unblock-File eng\build-local.ps1     # after that, plain .\eng\build-local.ps1 works too
```

### 进展：所有阻碍项均已解决（2026-10-07）

1. **Gradle wrapper 试图下载 9.3.1 并超时了。** 一份完整的发行版其实已经解压在
   `.gradle-home\wrapper\dists\...\<hash>\gradle-9.3.1` 下，但 wrapper 是根据
   `gradle-wrapper.properties` 对自己的目录做哈希的，结果去另一个（只下载了一半的）
   目录里找。脚本现在直接调用解压出来的 `bin\gradle.bat`。
2. **`NODE_ENV` 未设置**，而 Expo Gradle 插件在没有它的情况下拒绝构建。
   脚本会按变体设置它。
3. **CMake 的 250 字符对象路径消息是警告，不是失败**（实测 252 个字符；
   日志里写的是 `The build may not work correctly`）。即便在包名还没开始之前，隔离存储
   就已经占掉约 93 个字符，所以值得认真修掉：
   `...\.pnpm\react-native-worklets@0.13._82ad66a5…\node_modules\react-native-worklets\…`
   再加上 CMake 自身的目录就溢出了。把仓库映射到一个短盘符会有帮助：
   ```powershell
   subst S: <path to the repository>   # 252 -> 229 characters
   ```
   注意，扁平布局是由 `pnpm-workspace.yaml` 中的 `nodeLinker: hoisted` 配置的，
   **而不是**由 `.npmrc` 中的 `node-linker=hoisted` —— pnpm 11 只从 workspace 文件读取
   布局设置，所以那条旧的 `.npmrc` 条目是无效的，还被误认为是 pnpm 丢掉了该设置。
   `virtualStoreDir` 也存在，但它不会移动 `.cxx`。
4. **`expo prebuild` 必须经由一个 `.cmd` 垫片（shim）执行，绝不能用 `npx --no-install expo`**
   （在当前 workspace 布局下，它无法解析出该二进制文件）。布局变扁平之后垫片的位置也变了：
   使用 `nodeLinker: hoisted` 时，它是仓库根目录下的 `node_modules\.bin\expo.cmd`，
   而不是在 `apps\mobile` 下。脚本两处都会检查。

### 阻碍项 1：CMake 3.22 的自我重生成死循环 —— 已解决

`react-native-screens` / `react-native-worklets` 失败并报：

```
C/C++: ninja: error: manifest 'build.ninja' still dirty after 100 tries
```

根本原因，从生成出来的文件里读出来的：

```ninja
build CMakeFiles/rebuild_cache.util: CUSTOM_COMMAND
  COMMAND = cmd.exe /C "cd /D <build dir> && cmake.exe --regenerate-during-build -S<src> -B<build>"
  restat = 1
```

该规则声明了**没有任何输入**，所以 ninja 认为 `build.ninja` 永远陈旧：它重新运行 CMake，
CMake 重写该文件（已验证 —— 时间戳确实会前进），ninja 重新开始，然后在 100 次尝试后
放弃。这不是文件陈旧，不是时钟偏移，也不是源文件日期在未来：这条规则永远无法收敛。

`CMAKE_SUPPRESS_REGENERATION=ON` 无法注入 —— AGP 9 从 `CmakeOptions` 中移除了
`arguments`（通过 dump 该对象验证过：只剩下 `path`、`version`、
`buildStagingDirectory`）。**`version` 是唯一可用的属性**，所以修复办法是改用不会生成
那条规则的 CMake：

```powershell
<android-sdk>\cmdline-tools\latest\bin\sdkmanager.bat "cmake;3.30.5"
```

由 `eng/pin-cmake-version.init.gradle` 固定（向 Gradle 传 `-I`）。有了它之后，
`react-native-screens` 和 `expo-modules-core` 的大部分都能成功编译。

### 阻碍项 2：ninja 的 260 字符防护 —— 已解决（两个独立的修复）

CMake 的修复到位后，失败转移到了：

```
ninja: error: rebuilding 'build.ninja':
  Stat(.../react-native-workletsConfigVersion.cmake): Filename longer than 260 characters
```

那个 260 是 **ninja 自己硬编码的防护，并不是 Windows 的限制**，而且它只存在于旧版的
ninja 构建里。上游的 `src/disk_interface.cc` 现在把它写成
`if (!path.empty() && !AreLongPathsEnabled() && path[0] != '\\' && path.size() > MAX_PATH)`，
其中 `AreLongPathsEnabled()` 会探测 ntdll 的 `RtlAreLongPathsEnabled`。本机已经开启了
长路径（注册表 `LongPathsEnabled=1`，`RtlAreLongPathsEnabled()==1`）—— 但 SDK 的
CMake 3.30.5 捆绑的是 **ninja 1.10.2**，它早于那次探测：其二进制里带着这段字面的错误
文本，而且完全没有 `RtlAreLongPathsEnabled`。两个修复，都已应用：

1. **ninja 1.10.2 -> 1.12.1**，位于 `<toolchain>\android-sdk\cmake\3.30.5\bin\ninja.exe`
   （这正是 AGP 调用的路径；原文件以 `ninja-1.10.2.exe.bak` 留在旁边）。
   在同一个 `build.ninja` 上用 340 字符的输入路径做 A/B 对比：1.10.2 以退出码 1 失败
   并给出上面的错误，1.12.1 以 0 退出并执行了该命令。
2. **`pnpm-workspace.yaml` 中的 `nodeLinker: hoisted`**，它去掉了
   `node_modules/.pnpm/<name>@<version>_<hash>/node_modules/` 这段前缀。实测最长的 prefab
   路径：**265 -> 181 字符**，低于 ninja 旧的 260 和 CMake 的 250 警告线。
   这也缩短了 NDK `clang.exe` 和 CMake 自身必须打开的路径，而这两者都不带长路径清单。

早先那条“即使放在盘符根目录也还剩 262 个字符，所以这事不可能”的结论，是基于隔离布局
加上旧版 ninja 得出的；它是错的。细节、实测数据和回退命令见
[`docs/dev-environment.md`](../docs/dev-environment.md)。

## 陷阱：一次“成功”的构建却打进了陈旧的 JS bundle

**在信任任何 release APK 之前，请先读这一节。**

`createBundleReleaseJsAndAssets` 不把 workspace 包（`packages/core`、`packages/capabilities`）
当作自己的输入 —— 它们是通过 tsconfig paths 和 pnpm 链接进来的，而 Gradle 不会跟踪这些。
因此修改核心代码会让该任务保持 `UP-TO-DATE`：

```
> Task :app:createBundleReleaseJsAndAssets UP-TO-DATE
```

于是 Gradle 会重新打包一个包含*上一份* bundle 的 APK，并以 0 退出。产物能安装、能运行，
却悄悄地表现得像更早某次提交的代码。这确实真的发生过：交付出去的 release APK 缺少了
几分钟前刚提交的改动，最后只能靠在打包好的 bundle 里搜索新字符串才发现。

`eng/build-local.ps1` 里现在有两道防护，所以直接运行是安全的：

1. 在 Gradle 运行之前，会把 `apps/mobile/app`、`apps/mobile/src`、`packages/core/src`
   和 `packages/capabilities/src` 下最新的 `*.ts`/`*.tsx` mtime 与现有的 bundle 做比较。
   如果源码更新，就删除该 bundle 及其合并副本，迫使 Gradle 重新运行该任务。
   （`--rerun-tasks` 也可以，但它会连带重建每一个原生模块。）
2. Gradle 结束后，APK 必须比脚本启动的那一刻更新，否则脚本会抛错，而不是复制一个陈旧的
   产物。脚本会打印 `apk built = …`，这样不深挖也能看到时间戳。

如果你是直接调用 Gradle 构建的，这两道防护都不生效 —— 请加上 `-Clean`，或者先删除
`apps/mobile/android/app/build/generated/assets/react/<variant>/index.android.bundle`。
要确认某个包确实包含你的改动：

```powershell
node eng\axml-manifest.cjs <apk>            # permissions/queries
# and for JS: search the packaged bundle for a string you just added.
```

云端构建依然可用，也仍然是一个有用的后备方案 —— 见下文。

## 云端构建（无需 Android SDK）

```bash
cd apps/mobile
npx eas-cli login          # interactive, browser-based; cannot be scripted
npx eas-cli init           # created project 2f118dc0-… ; writes extra.eas.projectId
pnpm --filter @mobileclaw/mobile run build:apk      # preview profile -> .apk
```

`preview` 和 `development` 会设置 `android.buildType: "apk"`；`production` 则为应用商店
构建 `.aab`。免费额度：15 次 Android 构建，低优先级队列，45 分钟上限。

`eas.json` 为每个 profile 固定了 `pnpm: "11.22.0"` 和 `node: "22.23.1"`，这样构建器使用的
就是写出该锁文件的同一个包管理器。这些都是真实的 schema 字段（`pnpm`/`node`/`yarn`/`bun`）；
`buildProfile` **并不存在**，它会让 `eas.json` 失效。

### 一次成功的构建

| | |
| --- | --- |
| 构建 | `9299de3c-845b-4892-b79f-3e6882bb7088`（FINISHED，约 19 分钟） |
| 产物 | https://expo.dev/artifacts/eas/hEg3VK0hEFmGIhk9ygCxE08I1U1qZAdGh97Ux1Lhpv0.apk |
| 大小 | 102.97 MB（4 个 ABI，未剥离的调试符号 —— 对 `preview` 而言是预期情况） |
| 包 | `dev.mobileclaw.app`, versionCode 1, minSdk 24, targetSdk 36 |

安装：复制到手机上并打开它（侧载），或者执行 `adb install -r <file>.apk`。

### 代价是四次构建的那次失败

`Install dependencies` 添加完 619 个包，*然后*才以 1 退出：

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.21.5
pnpm install --frozen-lockfile exited with non-zero code: 1
```

pnpm 11 把 `onlyBuiltDependencies` 改名为一个名为 `allowBuilds` 的**映射（map）**，
而旧键会被静默忽略。修复写在 `pnpm-workspace.yaml` 中：

```yaml
allowBuilds:
  esbuild: true
```

要在本地复现（热的 `node_modules` 会把这个问题完全掩盖掉，因为当没有任何东西需要构建时，
pnpm 会跳过审批检查）：

```powershell
Remove-Item node_modules,apps/mobile/node_modules,packages/*/node_modules -Recurse -Force
pnpm install --frozen-lockfile --store-dir .logs/probe-store   # exit 1 before the fix, 0 after
```

## 在没有 Android SDK 的情况下验证已构建的 APK

`eng/axml-manifest.cjs` 可以解码 APK 内编译后的 `AndroidManifest.xml`（无依赖，
不需要 `aapt2`）：

```bash
node eng/axml-manifest.cjs artifacts/mobileclaw-preview.apk MANAGE_EXTERNAL_STORAGE
```

在已交付的 preview APK 中确认存在：37 项权限，其中包括
`MANAGE_EXTERNAL_STORAGE` 和 `com.termux.permission.RUN_COMMAND`，另有一个 `<queries>`
块，包含 `com.termux`、`com.android.calendar`、`com.android.documentsui` 以及
SEND/VIEW intent。

## 本地原生工程（用于检查生成的配置）

```bash
cd apps/mobile
npx expo prebuild --platform android --no-install
```

在没有 SDK 的情况下生成 `android/`（已被 git 忽略）。检查
`android/app/src/main/AndroidManifest.xml`，确认权限和 queries 是同一组内容。
Play 安全变体就是这样验证的：在 `MOBILECLAW_PLAY_SAFE=1` 时，
`MANAGE_EXTERNAL_STORAGE` 的数量为 0（光靠 `android.blockedPermissions` 列表**并不能**
移除 `android.permissions` 中声明的权限 —— 它只过滤库带来的贡献 —— 所以要用一个
manifest 修改器来实现）。

## 本机的网络坑

git 和 Expo CLI 会走一个本地代理（本机上是 `http.proxy`、`127.0.0.1:7897` ——
**这个端口以前变过**），该代理到 GitHub 的 TLS 握手会失败。`eng/commit.ps1` 会为它的
子进程设置 `NO_PROXY=*`。手动执行命令时也照做：

```powershell
$env:NO_PROXY='*'; $env:no_proxy='*'
```

注意这里只有 GitHub 被挡住：`dl.google.com`、`services.gradle.org` 和 `repo1.maven.org`
都能直连而且很快，所以下载 SDK、Gradle 和 Maven 都不需要代理。

GitHub 推送也会间歇性失败，报 `Connection was reset` 或 21 秒连接超时；多试几次就好了。

