# eng/ — 仓库自动化

这里有两个脚本，它们共用同一套「提交并推送本仓库」的实现。Android 构建工具链也放在这个目录下 —— 见下文。

## Android 工具链

| 脚本 | 作用 |
| --- | --- |
| `toolchain.cjs` | 解析 JDK / Android SDK / Gradle 的位置：显式传入的 `-Jdk`/`-Sdk`/`-GradleHome` → 环境变量 → 被 git 忽略的 `<repo>/.toolchain/` → 平台默认位置。运行 `node eng/toolchain.cjs print` 可查看结果。 |
| `toolchain-versions.cjs` | 各组件版本的唯一来源（JDK 21、`sdkmanager` 包列表、CMake 3.30.5、ninja ≥ 1.12.1、Gradle 9.3.1）。 |
| `setup-toolchain.ps1` | 把 JDK 和 Android SDK 安装到 `<repo>/.toolchain/`；`-DryRun` 只打印安装计划，`-FixNinja` 还会替换 SDK 自带的 ninja。 |
| `build-local.ps1` | 在本地构建 APK，并通过 `toolchain.cjs` 解析工具链位置。 |

版本信息、ninja/路径长度相关的坑，以及十四个环境怪癖，都记录在
[`BUILD.md`](./BUILD.md) 和 [`../docs/dev-environment.md`](../docs/dev-environment.md) 中。

## 周期性提交

**该功能目前已停用。** Windows 计划任务 **MobileClaw auto-commit** 已被禁用，因此不会再发生周期性自动提交。
`eng/schedule.ps1` 脚本仍保留在仓库中，将来可以重新启用；下列命令在重新启用后仍然适用。

```powershell
.\eng\schedule.ps1                      # commit+push every 30 minutes when dirty
.\eng\schedule.ps1 -IntervalMinutes 60  # hourly
.\eng\schedule.ps1 -IntervalMinutes 10  # chatty (minimum 5)
.\eng\schedule.ps1 -Remove              # stop periodic commits
```

启用后，该脚本会注册一个名为 **MobileClaw auto-commit** 的 Windows 计划任务，按设定间隔以无交互方式运行
`commit.ps1`。任务以当前用户身份运行，因此提交使用的是本账号的 git 身份和已保存的凭据 ——
若以 SYSTEM 身份运行则做不到这一点。

只有工作区有改动时才会提交，因此空闲的仓库不会产生空提交。输出写入 `.logs/auto-commit.log`
（已被 git 忽略）。

**凭据要求：** 计划任务无法应答交互式提示，因此推送必须在非交互模式下完成。这里通过
HTTPS + Git Credential Manager 满足该要求，它已经保存了本账号的凭据（`credential.helper = manager`，
在系统范围内设置）。使用 SSH 密钥也可以，前提是该密钥已注册到 GitHub 账号且没有口令 ——
本机上的密钥*未*注册，所以这里采用 HTTPS。

无需等待下一次触发，即可端到端验证整个流程：

```powershell
Start-ScheduledTask -TaskName 'MobileClaw auto-commit'
Start-Sleep -Seconds 20
Get-Content .logs\auto-commit.log -Tail 5     # expect 'pushed <sha> to <remote>'
(Get-ScheduledTaskInfo -TaskName 'MobileClaw auto-commit').LastTaskResult   # expect 0
```

## 手动检查点

```powershell
.\eng\commit.ps1 -Checkpoint "feat: add Shizuku UserService bridge"
.\eng\commit.ps1 -Checkpoint "fix: guard empty path" -NoPush
.\eng\commit.ps1                       # scheduled-style: generated message, then push
```

失败时会以非零状态码退出，这样调用方（或智能体）就能察觉，而不会误以为推送已经成功。

凡是以后会由人来阅读的提交，都应使用 `-Checkpoint`。计划任务模式生成的是
`chore: checkpoint <time>` 这类提交信息，作为兜底手段尚可，但不能替代真正的提交信息。

## `commit.ps1` 中的防护措施

| 防护措施 | 原因 |
| --- | --- |
| 带过期超时的锁文件 | 计划任务的触发不会与一次缓慢的推送发生重叠。 |
| Git 身份断言 | 否则提交会失败，或者被错误地归属到他人名下。 |
| `-MaxFiles`（默认 500） | 当生成的目录树绕过了 `.gitignore` 时，拒绝提交。 |
| 原生命令运行器 | 在 `$ErrorActionPreference = 'Stop'` 下，git 写入 stderr 会抛出异常，从而完全跳过错误处理。 |
| 显式检查 push 的退出码 | 不检查 `git push` 的结果，正是「成功」的运行实际上从未上传的原因。 |
| 推送失败后本地提交仍然保留 | 提交会被保留；日志中会注明它仅存在于本地，以便之后重新推送。 |
