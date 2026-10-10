# Android 能力：实际上能做什么

本文档是诚实的版本。它记录了 Android 允许什么、禁止什么，以及应用因此怎么做。这里的每一条都对照
当前的平台行为与依赖包版本核对过；凡是属于政策风险而非技术限制的地方，都已明确说明。

## 1. 文件：路径与权限

Android 11+（API 30）的分区存储意味着普通应用只能得到：

- 它**自己**的目录（`Paths.document`、`Paths.cache`、应用私有的外部目录）——始终可用；
- 它自己拥有的 **MediaStore** 条目，需要 `READ_MEDIA_IMAGES/VIDEO/AUDIO`（13+）；
- 用户通过 `ACTION_OPEN_DOCUMENT_TREE` + `takePersistableUriPermission` 显式授予的 **SAF 树
  URI**，这些是基于 URI 而非基于路径的，并且不会延伸到同级目录；
- **全文件路径**，仅在拥有 `MANAGE_EXTERNAL_STORAGE` 时可用。

`MANAGE_EXTERNAL_STORAGE` **没有运行时权限对话框**。用户必须在系统设置中开启它；应用只能把他们
深链到那里：

```kotlin
if (!Environment.isExternalStorageManager()) {
  startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
    Uri.parse("package:$packageName")))
}
```

它还需要在 manifest 中声明，并加上 `tools:ignore="ScopedStorage"`。

**Play 政策：** 全文件访问被限制在少数几个类别（文件管理器、备份/恢复、杀毒、文档管理、设备内文件
搜索、磁盘加密、设备间迁移），且需要填写声明表。AI agent 不属于其中任何一类。因此分发方式是侧载 /
F-Droid / GitHub Release。`MOBILECLAW_PLAY_SAFE=1` 可以在不带该权限的情况下构建，供想尝试
Play 风格构建的人使用。

因为 agent 在**真实路径**中工作，让它保持规矩的是 `PathGuard` 的边界约束：配置的根目录就是契约，
根目录之外的一切都会被拒绝并给出说明。

### 两个存储权限，不是一个

这两者很容易混为一谈，而混淆它们的结果，就是一个塞满的文件夹显示为“文件夹是空的”：

| 权限 | Android | 授予方式 | 没有它时 |
| --- | --- | --- | --- |
| `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE`（manifest 中为 `maxSdkVersion=32`） | ≤ 12（API 32） | **运行时对话框**（`PermissionsAndroid.requestMultiple`） | 共享存储被直接拒绝：名字可能仍能列出，内容永远读不到 |
| `MANAGE_EXTERNAL_STORAGE` | 11+（API 30） | **没有对话框**——只能在设置中通过 `ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` 开启 | 名字能列出，但每个文件都报告为不存在 |

在 manifest 中声明其中任何一个都不会授予任何东西。应用两个都声明了，却一个都没有请求，这最可能是
共享存储读起来为空的原因。代码位置：

- `apps/mobile/src/runtime/services/permissions.ts`——纯逻辑：探测访问是否已生效，并判断给定 API
  级别需要哪些旧版权限。有单元测试。
- `apps/mobile/src/runtime/services/storage-permissions.ts`——仅设备端：运行时请求与跳转设置。
  `runtime.ts` 会导入它，因此 vitest 把 `react-native` 别名到一个 stub（见
  `apps/mobile/vitest.config.ts`）。
- 聊天界面在首次启动时请求一次，由持久化标志守护；设置界面同时提供“申请读写权限”按钮和全文件访问的
  设置跳转。

在 Android 13+ 上，旧版权限对被细粒度的 `READ_MEDIA_*` 取代，因此 `legacyStoragePermissionsFor`
在那里返回空——若还去请求，不会显示任何对话框，看起来就像静默失败。

**两种失败模式看起来一模一样，但并不是一回事。**“不允许看”和“允许看，而且里面确实是空的”都表现
为空列表。`probeAllFilesAccess` 通过探测真实手机上从不为空的目录来区分二者，而 `fs_list` 和
`fs_search` 会报告它们读不到的条目，而不是直接丢弃——正是这种静默丢弃让 agent 得出了塞满的文件夹
是空的这个结论。

## 2. 执行命令与二进制文件

两条硬性约束：

1. **W^X。** 自 Android 10 起，targetSdk 为 API 29+ 的应用无法 `execve()` 自身可写数据目录中的
   文件（SELinux 不允许 `untrusted_app` 对 `app_data_file` 执行）。对 `files/` 中的东西调用
   `Runtime.exec()` 会失败。你无法下载一个二进制文件然后运行它。
2. **因此：随包工具以 `jniLibs/<abi>/lib*.so` 的形式打进 APK。** 它们会被解包到
   `applicationInfo.nativeLibraryDir`，而那个目录*是*可执行的。要求：真正的 PIE ELF、`lib*.so`
   命名、正确的 ABI，以及面向 Android 15+ 目标时的 16 KB 页对齐。

应用目前没有打包 busybox/python；它转而采用委托的方式。

### Shell 后端，按优先级顺序

| 后端 | 工作方式 | 用户必须做的设置 | 限制 |
| --- | --- | --- | --- |
| **Shizuku** | 一个 Shizuku **UserService**（我们自己的 AIDL `Stub`）以 uid 2000/0 运行我们的代码。 | 安装 Shizuku、启用无线调试、授予应用权限——**每次重启后都要重做**。 | Shell 身份，**不是 root**：无法读取其他应用的 `/data/data`，无法使用仅 root 可用的 API。Binder 会随 Shizuku 服务一起消亡。 |
| **Termux** | 用 `Intent(com.termux.RUN_COMMAND)` 调用 `com.termux/com.termux.app.RunCommandService`，结果通过 `PendingIntent` 返回。 | 安装 Termux；授予 `com.termux.permission.RUN_COMMAND`；在 `~/.termux/termux.properties` 中设置 `allow-external-apps=true`；声明 `<queries><package android:name="com.termux"/></queries>`。 | 结果 bundle 在约 100 KB 处被截断（否则会 `TransactionTooLargeException`）；没有交互式 tty；前台会话需要悬浮窗权限，才能在不点击的情况下启动。 |
| **None** | `MemoryShellService` | — | `shell_run` 返回被阻止的结果，并准确说明需要开启什么。 |

**`Shizuku.newProcess` 自 13.1.1 起已废弃，并计划移除**——替代方案是 UserService。依赖
（Maven Central）：`dev.rikka.shizuku:api:13.1.5` 和 `:provider:13.1.5`；provider authority 为
`${applicationId}.shizuku`；当 `minSdk < 24` 时，13.1.0+ 需要 core library desugaring。

Shizuku **没有 React Native 封装**（npm 上不存在 `react-native-shizuku`），因此桥接层是一个带 AIDL
接口的本地 Expo module。

## 3. 设备上的 Python 与 Node

- **Chaquopy 17** 是唯一可信的应用内 Python 方案。它是一个 Gradle 插件，`minSdk ≥ 24`，必须指定
  `abiFilters`，且只允许在一个 module 中使用。没有 `curses`/`tkinter`/`readline`；`multiprocessing`
  不可用。两个真实的 EAS 风险：构建机上的 `buildPython` 必须是*完全*匹配的次要版本，才能用于
  pip/static proxy；而 Expo SDK 57 的构建镜像文档中列出了 Node/JDK/NDK，却**没有** Python。提交前
  需要核查许可证条款。
- **没有仍在维护的应用内 Node。** `nodejs-mobile-react-native` 最后一次发布是 2024 年 10 月，针对
  的是 Node 18（已 EOL），且 New Architecture 支持未经证实。把它当作死路。
- **Hermes 不是脚本引擎。** 它随 RN 一起发布，但不会在生产环境中求值任意运行时字符串，所以“运行
  模型写出的这段 JS”不是你能免费得到的功能。如果你愿意自己维护 JSI 桥接和沙箱，QuickJS/JSC 嵌入
  是可行的。

结论：`python_*` 工具**通过 shell 后端**访问解释器（目前是 Termux，将来可能是 Chaquopy），并通过
**stdin** 发送代码片段，因此任何引号问题都无法破坏它。当什么都不具备时，它们会准确报告如何启用。

## 4. 跨应用自动化

| 能力 | 机制 | 要求 |
| --- | --- | --- |
| 打开 URL / 应用 | `Intent`（`expo-intent-launcher`） | Android 11+ 需要 `<queries>` 才能解析第三方包；`QUERY_ALL_PACKAGES` 受 Play 限制。 |
| 分享文本 | `Share` 面板 | 无——最安全的交接方式。 |
| 剪贴板 | `expo-clipboard` | 无；最可靠的跨应用文本通道。 |
| 日历事件 | `expo-calendar`、`CalendarContract` | `READ_CALENDAR`/`WRITE_CALENDAR` 运行时弹窗。 |
| 通知 | `POST_NOTIFICATIONS`（13+） | 运行时弹窗。 |
| 后台启动 Activity | — | Android 10+ 上除非应用处于前台，否则会被阻止。 |

有意排除在范围之外：

- **AccessibilityService UI 自动化。** Play 的政策要求核心用途是无障碍，并明确排除“自动化工具”；
  Android 17 的可选 Advanced Protection Mode 会阻止非无障碍工具类应用使用 Accessibility API。侧载
  能避开审核，但避不开 AAPM。
- **读取通知**（`NotificationListenerService`，由用户通过 Settings 授予并提供 Play 理由说明）、
  **精确闹钟**（`USE_EXACT_ALARM` 在 Play 上仅限闹钟/日历应用），以及**短信/通话记录**（仅限默认
  处理应用）。

## 5. 后台工作

持续运行的 agent 循环需要**带声明类型的前台服务加上常驻通知**（在 Android 14+ 上是
`FOREGROUND_SERVICE_DATA_SYNC`，或带 Play 理由说明的 `..._SPECIAL_USE`；`dataSync` 在 15+ 上有
时间上限）。`expo-background-task` 只能做粗粒度的周期性任务——最短 15 分钟，需要网络和电量，而且
用户杀掉应用后它就停止。

当前设计：任务在应用位于前台时运行，并由**通知报告完成**。前台服务是路线图上的第 2 项，不是今天已有
的承诺。

## 6. 密钥

`expo-secure-store` 是经 Keystore 加密的 SharedPreferences：存放一个简短的 API key 够用，但算不上
保险库。只支持字符串；较大的负载可能被拒绝；**Android 上的值会在卸载时丢失**；`getItem`/`setItem`
是同步的，会阻塞 JS；Auto Backup 必须排除 SecureStore 的 sharedpref（配置插件默认会这样做），否则
恢复出来的密文无法解密。在已 root 或可使用 Shizuku 的设备上，请假定任何静态存储的密钥都能被提取。

因此 API key 从不写入会被持久化的 config 对象——它只存在于 SecureStore 和内存中。

## 7. 原生模块：构建了什么

两个 `ReactPackage`，都由 `apps/mobile/app.config.ts` 中的配置插件生成，因为 `android/` 被 git
忽略，并由 `expo prebuild` 重新生成。

**不是 Expo module。** 一开始试过一个：它的 Kotlin 编译进了 APK，Gradle 也包含了该工程，但
`requireNativeModule` 始终解析不到它（`expo-modules-autolinking search` 能找到该 module，而
`resolve` 不能），于是应用静默回退到 expo-file-system，看起来就像修复根本没有生效。`ReactPackage`
没有发现步骤——要么类能编译并被注册，要么构建大声失败。在经历过一个藏在静默回退背后的缺陷之后，
这一点比整洁更重要。见 `docs/device-verification.md`。

### `MobileClawFiles`——存储（可用，已在设备上验证）

由 `withMobileClawFiles` 生成，在 `app.config.ts` 中**以内联 Kotlin 模板字符串**的形式存在。它
存在的意义是绕过 expo-file-system 的 `File.canRead()`/`canWrite()` 预检查：对于应用不拥有的任何
文件，该检查都返回 false——因此即使已授予全文件访问权限，共享存储写入仍会被拒绝，并被报告为缺少
READ 权限，把用户引向一个本来就已打开的开关。

### `MobileClawShizuku`——屏幕自动化（已编写，**从未编译**）

由 `withMobileClawShizuku` / `withShizukuManifest` / `withShizukuGradle` 生成，从
`apps/mobile/android-native/shizuku/` 下的**真实文件**复制而来：

```
android-native/shizuku/
  IMobileClawShizukuUserService.aidl
  MobileClawShizukuModule.kt        # app process
  MobileClawShizukuUserService.kt   # shell process (uid 2000)
  MobileClawShizukuPackage.kt
```

每个插件做什么：

| 插件 | 效果 |
| --- | --- |
| `withMobileClawShizuku` | 把四个文件复制到 `app/src/main/{java,aidl}/dev/mobileclaw/app/shizuku/`，并在 `MainApplication.kt` 中注册该 package |
| `withShizukuManifest` | 添加 `<provider android:name="rikka.shizuku.ShizukuProvider">`，带 `authorities="${applicationId}.shizuku"` 和 `permission=android.permission.INTERACT_ACROSS_USERS_FULL` |
| `withShizukuGradle` | `implementation("dev.rikka.shizuku:api:13.1.5")` 和 `:provider`，外加 `buildFeatures { aidl true }` |

**接口被刻意做得极小**——只有 `exec` 和 `screenshot`。点击、滚动、`dumpsys` 解析和文本输入
都在 JS 侧组合成 `input …` 命令行（`apps/mobile/src/runtime/services/native-shizuku.ts`）。没有
Android 工具链就无法在开发机上编译这些 Kotlin 代码，因此在设备构建给出结论之前，它的每一行都是盲区
——而 JS 是有测试的。每多一个原生方法，就多一个无法验证的东西。

能省下一次调试的记录：

- **`destroy` 被刻意排除在 `.aidl` 之外。** 它曾是 `void destroy() = 16777114;`，而 AIDL 直接
  拒绝这种写法 —— 一个文件要么给所有方法都指定 id，要么一个都不指定，而 Shizuku 要的是保留的
  transaction code 而不是紧接着的下一个：
  `ERROR: ...aidl:35.9-17: You must either assign id's to all methods or to none of them.`
  这个错误直到第一次真正跑完整构建才暴露，因为写这个文件时所在的机器没有工具链。把它声明在那里本来
  也是多余的：析构实际用的是 **16777115**，而文档中的 AIDL 常量是 **16777114**，`onTransact`
  两者都接受 —— 所以这个调用在 Kotlin 侧处理，AIDL 里声明的方法永远到不了那里。
  弄错这一点，每次重连都会泄漏一个 shell 进程。
- UserService 进程**不是合法的 Android 应用进程**。`Context` 可能存在，但 `getContentResolver`
  和 `registerReceiver` 都不可用。它内部没有任何代码会去碰这些。
- uid 2000 无法写入应用的私有目录，而应用也无法读取 `/data/local/tmp`。这正是截图只能以字节而不是
  文件路径的形式跨 binder 传递的唯一原因。
- 带 `FLAG_SECURE` 的窗口返回的是单一纯色，与真的纯色屏幕无法区分。服务会把它报告为一条 `note`，
  而不是让它冒充空白屏幕。
- `buildFeatures { aidl true }` **不是可选项**：AGP 8 默认关闭它，而关闭时 `.aidl` 会被忽略——
  随后 Kotlin 会因为找不到从未生成过的 Stub 而报 “cannot find symbol”，这读起来像代码错误而不是
  配置错误。
- Shizuku 每次重启都会失效，binder 也随之消失。这是正常的“不可用”情况，而不是故障；`status()`
  会区分未安装 / 未运行 / 未授权，以便用户得到正确的指引。

`app.config.ts` 中的 `PACKAGE_QUERIES` 包含 `moe.shizuku.privileged.api`，这样应用就能区分
“未安装”和“已安装但未运行”。`<queries>` 条目在 play-safe 构建上同样有效，这一点与
`QUERY_ALL_PACKAGES` 不同。

**在这个 module 真正可用之前**，应用作为一个**文件与网页 agent**，在自己的目录内是完全可用的，
而每一项不可用的能力都会如实说明，而不是神秘地失败。这个特性值得保留：即使后端不存在，工具仍然会被
注册，并会解释缺口在哪里。

