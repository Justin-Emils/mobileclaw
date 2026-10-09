# 环境搭建：从零到能构建（给队友）

这份文档写给**第一次在这台机器上构建**、或者**换了一台电脑**的人。照着做，不要跳步。

如果做完仍然构建失败，跳到最后的「出问题时」一节，把指定命令的输出发出来即可定位。

---

## 开始之前：确认你的机器状态

```powershell
node --version      # 需要 22 或更高（本地开发用 22.18）
git --version
```

**先看一眼你的默认 JDK，这决定后面要不要额外配置：**

```powershell
java -version
```

> ⚠️ **如果你的 Java 版本是 24 或更高，请务必读完本文档再构建。**
> 这个项目**不能用 JDK 24 构建**——它会以一个完全看不出和 Java 有关的错误失败。原因见文末。

---

## 第一步：拉取代码

```powershell
git clone https://github.com/Justin-Emils/mobileclaw.git
cd mobileclaw
```

已有仓库就：

```powershell
git pull origin main
```

## 第二步：装依赖

```powershell
corepack enable
pnpm install
```

> 若 `pnpm` 不在 PATH，用 `corepack pnpm install`。

## 第三步：装 Android 工具链

```powershell
pwsh -NoProfile -File eng/setup-toolchain.ps1
```

这一步会下载并安装到仓库旁的 `.toolchain/`（该目录已被 git 忽略，不会污染仓库）：

| 组件 | 说明 |
| --- | --- |
| JDK | Temurin **21**（固定版本，别换成 24） |
| Android SDK | build-tools 36.0.0、platforms/android-36、ndk 27.1.12297006 |
| ninja | 1.12.1（替换 SDK 自带的 1.10.2，后者有 260 字符路径限制，会让本项目构建失败） |
| **Gradle** | 解压好、可以直接用（**这一步以前缺失**，导致第一次构建卡在下载，看着像卡死） |

**先干跑一遍确认它要做什么**（不下载任何东西）：

```powershell
pwsh -NoProfile -File eng/setup-toolchain.ps1 -DryRun
```

### 如果你已经有可用的 Gradle

复用比重新下载快得多（几百 MB）：

```powershell
pwsh -NoProfile -File eng/setup-toolchain.ps1 -GradleHome "你已有的 Gradle home 路径"
```

所谓「可用的 Gradle home」= 里面有 `wrapper\dists\` 目录，并且能搜到 `gradle.bat`。
一般是你之前成功构建过这个项目后留下的那个目录。

### 网络说明（很重要，方向是反的）

| 目标 | 走法 |
| --- | --- |
| **GitHub** | **必须走代理**（如 `127.0.0.1:7897`） |
| Google / Maven / Gradle 分发 | **直连即可，很快** |

构建脚本会自动设置 `NO_PROXY=*`（避免代理破坏 Maven/TLS）。
但 **`git push` 必须走代理**——如果你在 shell 里设了 `NO_PROXY=*`，推送会连不上，报 `Failed to connect to github.com port 443`。

## 第四步：写本机配置文件（**最容易漏，也最关键**）

```powershell
New-Item -ItemType Directory -Force -Path .toolchain | Out-Null
@"
MOBILECLAW_JDK=<你的 JDK 21 路径>
MOBILECLAW_ANDROID_SDK=<你的 Android SDK 路径>
MOBILECLAW_GRADLE_HOME=<你的 Gradle home 路径>
MOBILECLAW_ENG_ROOT=<放上面这些的父目录>
"@ | Set-Content .toolchain/.config -Encoding UTF8
```

**为什么必须做这一步**

`eng/toolchain.cjs` 解析工具链时会优先看 `JAVA_HOME`，而你机器上的 `JAVA_HOME` 很可能是**别的工具装的任意版本**（我这边就是 jdk-24，直接导致构建失败）。

这个文件**优先级高于所有环境变量**，能把构建用的 JDK 钉死在 21。

- 四个变量**都可选**，只写你需要的
- 文件在 `.toolchain/` 里，**已被 git 忽略，不会提交**
- 格式就是每行 `KEY=VALUE`，`#` 开头是注释

**示例（我的机器）**：

```
MOBILECLAW_JDK=E:\code\Eng\.jdk21
MOBILECLAW_ANDROID_SDK=E:\code\Eng\.android-sdk
MOBILECLAW_GRADLE_HOME=E:\code\Eng\.gradle-home
MOBILECLAW_ENG_ROOT=E:\code\Eng
```

> **Windows 提示**：用 `Set-Content -Encoding UTF8` 会在文件开头写入 BOM，导致第一行的键名多出一个不可见字符。用 `New-Item` + 上面那种 here-string 写法通常没事；若第一行不生效，把第一行改成注释再加一遍。

## 第五步：验证（**不要跳过**）

```powershell
# 1) 确认解析到的 JDK 是 21，不是 24
node eng/toolchain.cjs print
```

期望看到 `"jdk"` 指向 21。**如果指向 24 或更高，回到第四步。**

```powershell
# 2) 跑测试和类型检查（约 10 秒）
pnpm run check
```

期望 **576 个测试全过**（core 149 + capabilities 233 + mobile 194）。

```powershell
# 3) 构建 APK
pwsh -NoProfile -File eng/build-local.ps1 -Variant release
```

期望以 `=== build ok ===` 结束，产物在 `artifacts/`。
缓存热的情况下**约 13 秒**；第一次（要编译所有原生模块）**几分钟**。

---

## 出问题时

### 第一步永远是这条

```powershell
node eng/toolchain.cjs print
```

它会打印**解析到的路径**，以及**找过但没找到的所有位置**。多数问题一眼可辨。

### 常见症状对照

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `no usable Android SDK found` + 一列路径 | SDK 没装，或没写进 `.toolchain/.config` | 跑 `setup-toolchain.ps1`，或在配置里写 `MOBILECLAW_ANDROID_SDK` |
| `WARNING: A restricted method in java.lang.System has been called` | **用了 JDK 24** | 在 `.toolchain/.config` 里把 `MOBILECLAW_JDK` 指向 21 |
| 第一次构建长时间无输出、看着像卡死 | Gradle 在下载（几百 MB） | 等，或用 `-GradleHome` 复用已有的；`setup-toolchain.ps1` 现在会预先装好 |
| `Filename longer than 260 characters` | ninja 被 `sdkmanager` 重装、退回了 1.10.2 | 重跑 `setup-toolchain.ps1 -FixNinja` |
| `git push` 报 `Failed to connect to github.com port 443` | shell 里设了 `NO_PROXY=*`，绕开了代理 | 推送时清掉：`Remove-Item Env:NO_PROXY` |
| `You must either assign id's to all methods or to none of them` | AIDL 混用了带 id / 不带 id 的方法 | 已知问题，已修复（见下方「已修掉的坑」） |
| 构建脚本跑很久后静默无输出 | 曾因 PowerShell 的 `&` 调用 Gradle 而挂起 | 已修复（改成 `cmd /c`） |

### 仍然不行时，把这些发出来

```powershell
node eng/toolchain.cjs print
java -version
node --version
git log --oneline -1
```

---

## 已修掉的坑（别重复踩）

这些都是这段时间实际发生、并且**已经修好**的。列出来是为了让你遇到类似现象时能认出来。

### 1. 构建用了 JDK 24 → 失败

`react-native-worklets` 的 CMake 配置在 JDK 24 下会中止，报 `A restricted method in java.lang.System has been called`——**报错里完全不提 Java**。

解析器的版本检查只保证「≥ 21」，所以 24 会被接受，然后在很久之后才失败。
**现在**：`.toolchain/.config` 优先于 `JAVA_HOME`，可以钉死 21。

### 2. `setup-toolchain.ps1` 不装 Gradle

于是第一次构建会退到 `gradlew.bat` 去下载 Gradle 和全部依赖——**看起来就是卡死**。
**现在**：脚本会按 Gradle 期望的布局解压好，并支持 `-GradleHome` 复用。

### 3. 构建脚本会挂起

用 PowerShell 的 `&` 调用 Gradle 时，Gradle 跑到约 23 秒后**静止 20+ 分钟**（守护进程空闲、无输出），连续三次；同样的命令行用 `cmd /c` 每次 30 秒内完成。
**现在**：脚本用 `cmd /c` 调用。

### 4. AIDL 编译不过

```aidl
String exec(String command, int timeoutMs);
String screenshot(int maxWidth, int quality);
void destroy() = 16777114;      // ← AIDL 不允许混用带 id / 不带 id
```

**注意**：这个文件是在**没有安卓工具链的机器上写的，从未经过编译器**——所以直到第一次真正构建才暴露。

修法是**从 AIDL 里删掉 `destroy`**：Shizuku 的销毁回调在 Kotlin 的 `onTransact` 里处理（同时接受 `16777114` 和 `16777115`，因为 Shizuku 文档和它自己的常量不一致），AIDL 里的声明**根本到不了那段代码**。

### 5. 采集脚本写死了 adb 路径

`deliverables/android-capability-inventory/` 下三个脚本曾写死 `E:\code\Eng\...\adb.exe`，在别的机器上第一行就失败。
**现在**：共用 `Resolve-adb.ps1`，复用 `eng/toolchain.cjs`，全仓只有一处定义 adb 位置。

### 6. 陈旧 JS bundle 会被打进 APK

Gradle 不把 `packages/*` 当作 JS 打包任务的输入，所以改了 core/capabilities 后，任务会显示 UP-TO-DATE，**APK 里装的是上一版 JS**——构建「成功」但代码是旧的。

**现在**：`build-local.ps1` 会在 Gradle 前后各查一次，包内 bundle 比源码旧就报错。

> **因此：请通过 `eng/build-local.ps1` 构建，不要直接跑 `gradle assembleRelease`。** 两者不等价。

---

## 常用命令速查

```powershell
# 工具链解析情况（排错第一条）
node eng/toolchain.cjs print

# 全部校验：类型检查 + 测试 + expo 导出
pnpm run check

# 只跑测试
pnpm test

# 构建 release APK（产物在 artifacts/）
pwsh -NoProfile -File eng/build-local.ps1 -Variant release

# 干跑工具链安装
pwsh -NoProfile -File eng/setup-toolchain.ps1 -DryRun

# 修复 ninja
pwsh -NoProfile -File eng/setup-toolchain.ps1 -FixNinja

# 装到已连接的设备
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r artifacts/mobileclaw-local-release.apk
```

---

## 参考

- `eng/BUILD.md` — 构建细节、已解决的阻塞问题、陈旧 bundle 陷阱
- `docs/dev-environment.md` — 工具链版本与本机环境
- `docs/device-verification.md` — 真机上验证过什么、以及**没验证**什么
