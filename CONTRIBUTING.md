# 贡献约定

## 提交说明一律用中文

这个仓库的提交说明**统一用中文写**，包括标题和正文。

格式沿用 Conventional Commits 的类型前缀（英文小写），冒号后用中文描述：

```
fix(存储): 共享存储写入改为走原生模块

设备上无论是否授予「所有文件访问」，都无法在 Download 等目录创建文件，并且会
错误地提示"权限未开启"。根因是 expo-file-system 的权限预检用
File.canRead()/canWrite() 判断，而共享存储里的文件属于其他 uid，这个判断永远为假。
```

### 常用前缀

| 前缀 | 用途 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 修缺陷 |
| `docs` | 只改文档 |
| `chore` | 构建、依赖、杂项 |
| `test` | 只改测试 |
| `refactor` | 重构，不改行为 |

### 正文写「为什么」，不是「改了什么」

改动内容 `git diff` 自己会说。正文值得写的是：**为什么这么改**、**考虑过但否掉的方案**、
以及**踩过的坑**——尤其是那种看起来像别的问题的坑。

如果一次改动推翻了之前的判断，把旧判断也写进去（「此前以为是 X，实际是 Y」），
这样下一个人不会重复同一个错误。

### 周期性自动提交已停用

曾有一个 Windows 定时任务 `MobileClaw auto-commit`，每 30 分钟自动提交并推送一次。
**它已被停用**（任务保留着，状态为 Disabled，将来需要可重新启用）：

```powershell
Get-ScheduledTask -TaskName 'MobileClaw auto-commit'          # 查看状态
Enable-ScheduledTask -TaskName 'MobileClaw auto-commit'       # 重新启用
```

脚本 `eng/commit.ps1` 和 `eng/schedule.ps1` 都还在。`commit.ps1` 仍可用于手工提交，
自动模式生成的说明是中文（`chore: 自动存档 <时间>`）。

## 代码与文档

- **代码注释、文档正文**：中文。这个仓库的读者用中文工作。
- **标识符、类型名、API 名**：英文，不要翻译。
- **文件编码**：UTF-8 **不带 BOM**。PowerShell 的 `Set-Content -Encoding UTF8` 会写入 BOM，
  它会让配置文件的第一个键名多出一个不可见字符。用 `write` 类工具或显式去掉
  BOM（仓库里已有这个坑的记录）。
- **不要用 `Get-Content -Raw` + `Set-Content` 处理含中文的文件**：在 GBK 环境下会损坏内容。

## 提交前

```bash
pnpm check      # 类型检查 + 全部测试 + 真实 Metro 打包
```

`pnpm check` 通过是提交的前提。它包含一次真实的 Android 打包，因为类型检查和单元测试
都抓不到「Metro 不读 tsconfig 的 paths」和「无扩展名导入被加上 .js」这两类失败。

## 构建

**不要直接跑 `gradle assembleRelease`。** 用 `eng/build-local.ps1`，原因见
`docs/setup-for-teammates.md`：Gradle 不把 `packages/*` 当作 JS 打包任务的输入，
直接跑会静默地把上一版 JS 打进 APK。
