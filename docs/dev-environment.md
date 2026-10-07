# 开发环境与项目位置约定

> **这份文档跨项目共用。** `E:\code\Eng` 里的工具链不专属于 mobileclaw，任何需要构建 Android
> 或跑 Node 的会话都可以用。接手前先读这一份，能省掉我踩过的十几个坑。

## 一、当前项目位置

```
E:\code\mobileclaw\       ← 本项目
E:\code\Eng\              ← Android 构建工具链，多项目共用，不要移动或改名
```

> **位置变更历史（重要）**：2026-10-07 曾把仓库临时迁到 `E:\mc\mobileclaw`、`E:\m\mc`，
> 目的是绕过第三节的 260 字符路径限制。**结论证明那没用**（即使放在盘符根目录也超限），
> 所以**已迁回 `E:\code\mobileclaw`**。如果你在别处看到 `E:\mc` 或 `E:\m` 的路径，那是过期信息。
>
> 顺带提醒：**如果将来又移动这个目录，务必注意两点** ——
> (1) 移动前先停掉 Gradle daemon，否则 `node_modules` 会被占用导致复制不完整；
> (2) `Move-Item` 在目标目录已存在时会把源目录**嵌套进去**（我就这样造出过
> `E:\code\mobileclaw\mobileclaw\`），因此移动前要确保目标不存在或用 `robocopy /E`。

## 二、Android 构建工具链

`E:\code\Eng` 下的版本（均已验证可用）：

| 组件 | 路径 | 版本 |
| --- | --- | --- |
| JDK | `E:\code\Eng\.jdk21` | Temurin 21.0.12 |
| Android SDK | `E:\code\Eng\.android-sdk` | build-tools 36.0.0 / platforms/android-36 / NDK 27.1.12297006 |
| CMake | `.android-sdk\cmake\3.30.5` | **必须 3.30.5，不要用 SDK 默认的 3.22.1** |
| Gradle | `E:\code\Eng\.gradle-home` | 9.3.1，缓存已预热 |
| adb | `.android-sdk\platform-tools\adb.exe` | 1.0.41 |

⚠️ **PATH 里的 `java` 是 Java 8**（Zulu 8），构建 Android 不够，必须显式
`JAVA_HOME=E:\code\Eng\.jdk21`。

## 三、路径长度：这是硬约束，不是洁癖

Windows 上 **`ninja.exe` 没有长路径支持清单**，路径超过 **260 字符**直接失败：

```
ninja: error: rebuilding 'build.ninja':
  Stat(.../react-native-workletsConfigVersion.cmake): Filename longer than 260 characters
```

而 Android 原生编译（prefab + CMake）会生成极深的路径。实测本项目里最长的一条：

```
<仓库根>/node_modules/.pnpm/expo-modules-core@57.0.21_r_1e6aeb6e95e4a16e1ae348a1b4629ea0/node_modules/
  expo-modules-core/android/.cxx/Debug/6g1yt324/prefab/arm64-v8a/prefab/lib/
  aarch64-linux-android/cmake/react-native-worklets/react-native-workletsConfigVersion.cmake
```

**去掉仓库根之后，这段固定路径本身就有 258 字符。** 实测不同仓库位置下的总长：

| 仓库根 | 该路径总长 | 结果 |
| --- | --- | --- |
| `E:\code\mobileclaw` | 275 | ✗ 超 15 |
| `E:\mc\mobileclaw` | 265 | ✗ 超 5 |
| `E:\m\mc` | 265 | ✗ 超 5 |
| `E:\x`（盘符根下 1 字符） | 262 | ✗ 超 2 |
| `E:\`（盘符根，仓库根长度为 0） | 262 | ✗ 超 2 |

**即使把仓库直接放在盘符根目录也超过 260。** 也就是说：在保留 pnpm 隔离目录结构
（`.pnpm/<包名>@<版本>_<哈希>/node_modules/<包名>`，固定开销约 120 字符）的前提下，
本机**不可能**完成这个项目的本地 Android 原生构建。

### 试过且无效的办法（别再花时间）

| 办法 | 为什么无效 |
| --- | --- |
| `subst S: <仓库>` | CMake 把**真实绝对路径**写进 `build.ninja`，短盘符骗不过 |
| 目录 junction | 同上 |
| 注册表 `LongPathsEnabled=1` | 已开启，但 ninja 二进制自身没有长路径清单 |
| `node-linker=hoisted` | pnpm 11 已忽略该配置 |
| `shamefully-hoist=true` | 同上 |
| `virtual-store-dir=E:\.pnp` | pnpm 11 已忽略 |
| 手工改写 `build.ninja` 去掉重生成命令 | 还有其他重生成钩子，且下次 Gradle 会重写 |

### 其他项目怎么用这套工具链

本项目是"原生依赖多 + CMake prefab 深"的最坏情况。**纯 Java/Kotlin 的 Android 项目不受
此限制**，仓库放哪都行——路径问题只出现在带 C++/CMake 原生编译的项目上。判断方法：项目里
如果有 `.cxx/`、`CMakeLists.txt` 或 `externalNativeBuild`，就要按本节把路径压到最短。

## 四、环境特有的坑（每个都踩过）

| # | 症状 | 原因 | 修法 |
| --- | --- | --- | --- |
| 1 | 脚本在 `java -version`、`git push` 后直接中止，报 `NativeCommandError` | `$ErrorActionPreference='Stop'` 把**任何 stderr 输出**当终止性异常，而这些命令正常就写 stderr | 别用 `& cmd 2>&1`；用 .NET `ProcessStartInfo` 取输出与退出码，或临时切 `'Continue'` |
| 2 | git / npm / Expo CLI 报 TLS 握手失败或 21 秒超时 | 全局代理 `http.proxy=127.0.0.1:7892`（yeshayunCore）访问 GitHub 会失败 | 子进程设 `NO_PROXY=*`。**git 配置里写空值无效**（空值被当作未设置，仍回退全局代理） |
| 3 | `gradlew` 卡在下载 gradle-9.3.1-bin.zip 然后超时 | wrapper 按 `gradle-wrapper.properties` 的哈希找目录，找到的是没下完的那份 | 直接用已解压的 `E:\code\Eng\.gradle-home\wrapper\dists\...\gradle-9.3.1\bin\gradle.bat` |
| 4 | `npx --no-install expo ...` 报 `could not determine executable to run` | pnpm workspace 布局下 npx 解析不到 | 用 `node_modules\.bin\expo.cmd` |
| 5 | `The NODE_ENV environment variable is required but was not specified` | Expo 的 Gradle 插件要求 | 设 `NODE_ENV=development`（debug）/ `production`（release） |
| 6 | `ninja: error: manifest 'build.ninja' still dirty after 100 tries` | CMake 3.22 生成的 `build.ninja` 里重生成规则**不声明任何输入**且 `restat=1`，ninja 永远认为清单过期 → 重跑 CMake → 再重来，100 次后放弃 | **装并用 CMake 3.30.5**（`sdkmanager "cmake;3.30.5"`），用 `eng/pin-cmake-version.init.gradle` 钉住 |
| 7 | 文件被写成 `鈫?`、`鈥?` 乱码 | PowerShell 的 `Get-Content -Raw` + `Set-Content -Encoding UTF8` 把 UTF-8 当 GBK 解码 | 用编辑工具；或 .NET `[System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)` 配 `UTF8Encoding($false)` |

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

**验收（无需设备，秒级，改代码后必跑）：**

```powershell
cd E:\code\mobileclaw
pnpm check        # 类型检查 + 130 个单测 + 真实 Metro 打包
```

**出 APK（当前唯一可靠路径 —— 云端）：**

```powershell
cd apps\mobile
npx eas-cli@latest build -p android --profile preview --non-interactive
```

免费额度 15 次，已用 11 次。`preview` / `development` 为 `buildType: "apk"`（可直接安装），
`production` 出 `.aab`。

**本地构建脚本** `eng/build-local.ps1` 已写好，能顺利跑到原生编译之前；在路径限制解决前
无法产出 APK。保留它是为了将来 pnpm 布局或 ninja 版本变化时可直接复用。

## 六、其他会话必读的三条

1. **仓库位置已变更为 `E:\code\mobileclaw`**。看到旧路径 `E:\code\mobileclaw` 即为过期信息
   （现在只剩空目录残留）。
2. **`E:\code\Eng` 不要移动或改名**，工具链路径是绝对引用。
3. **写含中文的文件务必用 UTF-8 无 BOM**，见上表第 7 条——本项目因此损坏过两次文件、被迫两次
   `git checkout` 恢复，其中一次还把已改好的界面文案一起回滚了（提交前务必 `git diff` 核对）。
