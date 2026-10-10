# 架构

## 唯一规则

`packages/core` 绝不能导入任何平台模块。不能是 `node:fs`，不能是
`react-native`，也不能是 `expo-*`。智能体能*做*的一切，都是**接口背后的服务**，
在构造时注入。正因如此，agent loop 才能在笔记本电脑上测试，也正因如此，
手机相关的混乱才被限制在 `apps/mobile` 里。

依赖方向严格单向：

```
apps/mobile  ──▶  packages/capabilities  ──▶  packages/core
   (Expo/RN)          (tools, guard)            (pure kernel)
```

`packages/capabilities` 为仅限 Node 的后端（`node:fs`、
`node:child_process`）提供了一个 **`./node` 子路径**。根入口必须始终能从 React Native 导入，
因此 React Native bundle 永远不会通过 `@mobileclaw/capabilities` 触达 `node:*`。

## 分层

### 1. 内核（`packages/core`）

| 模块 | 职责 |
| --- | --- |
| `context.ts` | 服务容器 + logger + 每插件 store。子 context 通过其祖先解析服务，因此插件能看到 host 发布的内容。 |
| `events.ts` | 类型化的事件总线。**要新增事件的 host 必须以类型别名声明它们**，而不是接口——TypeScript 只给类型别名隐式索引签名，而这正是 `extends EventMap` 所需要的。 |
| `plugin.ts` | `PluginHost`：加载插件，在 `apply` **之前**检查 `inject`，注册已声明的工具，在失败时回滚部分注册。出故障的插件会被隔离，绝不会致命。 |
| `tools-registry.ts` | 工具的注册 + 校验 + 执行。拒绝重名和非 snake_case 名称（静默覆盖会让行为取决于插件顺序）。手工把 Zod schema 转换成 JSON Schema。 |
| `path-guard.ts` | 纯词法、不做 I/O 的路径包含检查。包含关系是权威判定：根目录之外的路径，无论它是经由 `..` 还是直接到达，一律拒绝。 |
| `permission.ts` | 唯一回答「这段能不能跑？」的地方。判定顺序：session 允许列表 → deny 规则 → allow 规则 → `alwaysAsk` → `alwaysAskRisks` → `riskModes` → `defaultMode`。 |
| `agent.ts` | 主循环。流式调用、tool call 聚合、权限门、工具执行、transcript、停止条件。 |
| `provider/*` | `BaseProvider`（stream → 单条消息，外加 SSE 解析器）和 `OpenAiCompatibleProvider`。 |
| `store.ts` | 基于任意 `KeyValueStore` 的 `ConversationStore`，因此应用可以用 SQLite，测试可以用内存实现。 |

### 2. 能力层（`packages/capabilities`）

`GuardedFileSystem` 在一个小巧的 `FsDriver` 端口之上实现 `FileSystemService`。**工具从不自行解析路径**——
模型给出的每一条路径都会经过文件系统服务内部的守卫，这里是包含检查的唯一卡点。

驱动：

- `ExpoFsDriver`（移动端，位于 `apps/mobile`），基于 `expo-file-system` 的 `File`/`Directory` API。
- `NodeFsDriver`（`@mobileclaw/capabilities/node`），基于 `fs/promises`，用于测试和未来的 CLI。

工具被归入六个插件，这样用户可以禁用比如 shell 执行，而不失去文件管理能力。这些包由
`capabilityPlugins(deps)` 创建；host 会在加载它们*之前*发布平台服务，这正是 `inject` 得以提前校验的原因。

### 3. 应用（`apps/mobile`）

- `src/runtime/runtime.ts` — `MobileClawRuntime`：UI 与之对话的门面。持有 context、
  plugin host、registry、权限门和 agent；配置变化时重建 provider/agent。
- `src/runtime/services/*` — 各平台适配器（文件系统、HTTP、shell、系统自动化、
  SecureStore、SQLite 键值存储）。
- `src/ui/*` — React：runtime provider、授权面板、工具卡片、主题。
- `app/*` — Expo Router 页面：对话、设置、权限。

## 请求生命周期

```
user taps Run
   │
   ├─ runtime.send(text)              creates a run id + AbortController, starts the loop,
   │                                  and bridges push→pull with AsyncEventQueue
   │
   ├─ Agent.run()                     appends the user message, persists it
   │     │
   │     ├─ buildSystemPrompt()       base prompt + tool inventory + environment block
   │     ├─ provider.stream()         POST /chat/completions (SSE) via injected fetch
   │     │      └─ yields text / reasoning / tool_call / usage / done
   │     ├─ assistant message         tool calls aggregated by index across chunks
   │     ├─ for each tool call:
   │     │     ├─ registry.get()      unknown tool → E_TOOL_NOT_FOUND (as a tool result)
   │     │     ├─ permissions.evaluate() → authorize()
   │     │     │      └─ may park on the approval modal; the UI resolves the promise
   │     │     ├─ registry.execute()  Zod input parse → run → Zod output parse
   │     │     └─ tool message        result or structured error, fed back next turn
   │     └─ loop until no tool calls, step limit, cancellation, or provider error
   │
   └─ events stream to React          text deltas render live; tool cards update in place
```

每次 tool call 恰好得到一条 tool message——未应答的调用会让下一次请求非法，因此
即使发生取消，也会在返回前写入一条 `[E_CANCELLED]` 结果。

## 值得坚守的不变量

1. **`packages/core` 不导入任何平台相关的东西。** 如果你在那里需要某项能力，它应当属于
   某个接口。
2. **模型给出的每一条路径都要过守卫。** 没有例外，没有"就这一次"的捷径。
3. **工具失败是数据，不是异常。** 错误以 `[E_*]` 字符串的形式到达模型，让它能自行
   调整；只有程序员的编码错误才会抛出主循环之外。
4. **一次 tool call → 一条 tool result。** 即便被拒绝、被取消也一样。
5. **非零退出码永不抛出异常。** `shell_run` 返回 `exitCode`，让模型能读取 stderr。
6. **`[DONE]` 不会抹掉 `finish_reason`。** `BaseProvider` 保留最先上报的 reason。
7. **传输是注入的，provider 是派生出来的。** provider 是配置的投影；
   测试和 host 真正替换的是 *fetch* 实现。
8. **能力缺失要给出解释。** `python_status`、`shell_which` 和 `shizuku_status`
   的存在，就是为了让模型能发现缺了什么，并告诉用户如何启用。

## 测试策略

| 测试套件 | 它锁定了什么 |
| --- | --- |
| `packages/core/test`（56） | 事件总线语义、服务解析、路径包含、权限判定、Zod→JSON Schema、SSE 分块、agent loop（工具使用、拒绝、步数上限、取消、持久化）。 |
| `packages/capabilities/test`（34） | 真实临时目录上的受守卫文件系统、glob/grep、编辑、dry run、shell 的 stdout/退出码/超时/kill、Python 与 Shizuku 的降级表现、HTML 清洗。 |
| `apps/mobile/test`（24） | push→pull 流式桥、授权 broker、配置合并、存储适配器，以及在伪流式 `fetch` 上跑通**真实** OpenAI provider 的完整一轮对话。 |

`pnpm check` 会运行类型检查（三个包）以及全部测试套件。只有确实需要真机的功能才需要构建设备版本：
Expo 原生模块、intents，以及 Kotlin 桥。
