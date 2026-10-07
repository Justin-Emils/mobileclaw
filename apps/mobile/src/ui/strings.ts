/**
 * 界面文案（集中管理）。
 *
 * 所有面向用户的文字都放这里，不要散落在各个页面里：
 *  - 避免同一种状态出现两种说法（按钮写 New、提示写中文那种混排）；
 *  - 以后要加多语言时只需替换这一个文件；
 *  - 代码注释与提交信息仍用英文，方便跨语言协作，只有"给人看的界面"用中文。
 */
export const strings = {
  app: {
    name: "MobileClaw",
  },

  common: {
    new: "新会话",
    settings: "设置",
    run: "发送",
    stop: "停止",
    save: "保存",
    add: "添加",
    remove: "删除",
    cancel: "取消",
    close: "关闭",
    loading: "加载中…",
    back: "返回",
  },

  /** 富文本渲染层用到的文案。 */
  code: {
    copyAction: "复制",
    copied: "已复制",
  },

  /** 历史会话列表。 */
  conversations: {
    title: "历史会话",
    open: "历史会话",
    empty: "还没有历史会话。发一条消息之后，这里会留下记录，可随时回来继续。",
    untitled: "未命名会话",
    hint: "点按打开并继续；长按可删除。",
    deleteTitle: "删除这个会话？",
    justNow: "刚刚",
    minutesAgo: (n: number) => `${n} 分钟前`,
    hoursAgo: (n: number) => `${n} 小时前`,
    daysAgo: (n: number) => `${n} 天前`,
  },

  chat: {
    starting: "启动中…",
    loadingCapabilities: "正在加载能力…",
    emptyTitle: "你的手机，装上手脚。",
    emptyHint:
      "试试：“整理我的下载目录并按类型归档”、“找出所有大于 10MB 的日志”、“把下载里的 notes.md 总结成一条待办”。",
    /** 空状态正文；与 emptyHint 分开是因为两者会分别调整排版。 */
    emptyBody:
      "试试：“整理我的下载目录并按类型归档”、“找出所有大于 10MB 的日志”、“把下载里的 notes.md 总结成一条待办”。",
    placeholder: "让 MobileClaw 在这台手机上做点什么…",
    toolActivity: "工具调用",
    step: (n: number) => `第 ${n} 步`,
    toolRunning: (name: string) => `正在执行 ${name}…`,
    denied: (name: string) => `已拒绝：${name}`,
    stoppedAfter: (steps: number) => `达到步数上限，已执行 ${steps} 步后停止。`,
    continueRun: "继续上次未完成的任务",
    continueHint: "上一轮在步数上限处停下，任务可能只做了一半。",
    continueMessage:
      "请继续完成刚才未做完的任务。先总结你已经确认的发现，然后直接执行剩下的操作，不要再重复之前的探查。",
    runFailed: "这次执行失败了",
    offlineDemo: "离线演示模式",
  },

  /** 聊天里出现的错误，转换成"下一步该做什么"。 */
  errors: {
    missingApiKey:
      "还没有配置 API 密钥。请打开「设置 → API 密钥」，粘贴密钥后点「保存密钥」——只输入不点保存是不会生效的。可用「设置 → 自检」确认是否真的存进去了。",
    unauthorized: (raw: string) => `${raw} —— 密钥被服务商拒绝了，请到服务商后台核对该密钥。`,
  },

  approval: {
    /** 权限弹窗 */
    kicker: "需要你的授权",
    moreWaiting: (n: number) => `还有 ${n} 个请求在排队`,
    deny: "拒绝",
    allowOnce: "仅本次允许",
    allowAlways: "本次会话内总是允许",
    defaultReason: "这个操作需要你确认",
  },

  settings: {
    title: "设置",
    offlineWarningTitle: "离线演示模式",
    modelProvider: "模型服务商",
    baseUrl: "接口地址（OpenAI 兼容）",
    model: "模型名称",
    maxSteps: "每轮最大步数",
    temperature: "随机性（temperature）",

    apiKeySection: "API 密钥",
    apiKeyLoaded: "✓ 密钥已加载",
    apiKeyMissing: "✗ 未配置密钥 —— 智能体无法调用模型",
    apiKeyHint:
      "粘贴密钥后，需要点「保存密钥」。只输入是不生效的。密钥存在 SecureStore（Android Keystore）里，不会写入配置文件。",
    apiKeyPlaceholder: "sk-…",
    saveKey: "保存密钥",
    testConnection: "测试连接",
    testing: "测试中…",
    testOk: (message: string) => `连接正常 —— ${message}`,
    testFailed: (message: string) => `连接失败 —— ${message}`,
    nothingToSaveTitle: "没有可保存的内容",
    nothingToSaveBody: "请先粘贴 API 密钥。",
    savedTitle: "密钥已保存",
    savedBody: (detail: string) => `${detail}。现在可以回聊天页发送消息了。`,
    notSavedTitle: "密钥未保存",
    notSavedBody: (detail: string) => `${detail}。请查看下方自检结果。`,
    saveFailedTitle: "保存密钥失败",

    selfCheck: "自检",
    selfCheckHint: "确认这台设备上的密钥存储真的可用，并显示智能体实际加载到的内容。",
    runSelfCheck: "运行自检",
    checking: "检查中…",
    selfCheckFailed: (message: string) => `自检失败 —— ${message}`,

    diagApiKey: "API 密钥",
    diagApiKeyPresent: (chars: number) => `已配置（${chars} 字符）`,
    diagApiKeyMissing: "缺失",
    diagSecretStore: "密钥存储",
    /** 一键端到端自检：用脚本模型跑一轮真实工具调用，无需密钥。 */
    runAgentSelfTest: "运行完整自检（不需要密钥）",
    runningAgentSelfTest: "自检运行中…",
    agentSelfTestHint:
      "用一段脚本代替模型，跑完一轮真实的智能体流程：调用工具、经过权限门、写入会话记录。用来确认这台设备上的工具链路和持久化是否正常。回答内容是固定的，不是真实模型。",
    agentSelfTestOk: "自检通过",
    agentSelfTestFailed: "自检未通过",
    /** 密钥后端未加密时的警示：这是安全降级，必须让用户知道。 */
    diagSecretBackend: "密钥保存方式",
    secretEncrypted: "系统加密存储（Android Keystore）",
    secretUnencrypted: "应用私有存储（未加密）",
    secretUnencryptedWarning:
      "这台设备的系统加密存储不可用，密钥已改存在应用私有目录里。应用沙箱仍然保护它，但不再有硬件加密：root 过的设备可以读取，卸载应用会一并删除。如果你在意，可以清除密钥并改用不支持密钥的功能。",
    diagProvider: "服务商",
    diagBaseUrl: "接口地址",
    diagTools: "工具",
    diagToolsValue: (n: number) => `已注册 ${n} 个`,
    diagPlugins: "插件",
    diagPluginsValue: (loaded: number, total: number) => `${loaded}/${total} 已加载`,
    diagRoots: "可访问目录",
    diagNone: "（无）",
    /** 插件列表右侧显示的工具数量。 */
    pluginToolCount: (n: number) => `${n} 个工具`,

    // --- 所有文件访问权限 ---
    // Android 11+ 没有运行时弹窗，只能跳系统设置手动开启；没有它，共享存储里的
    // 目录能列名但文件读不到，看起来像"文件夹都是空的"。
    diagStorageAccess: "所有文件访问权限",
    storageGranted: "已开启",
    storageDenied: "未开启 —— 共享存储只在系统设置里授权",
    storageUnknown: "无法探测",
    storageHint:
      "Android 11 起「所有文件访问」没有弹窗，必须去系统设置手动开启。未开启时目录能列出名字，但里面的文件全部读不到，智能体会误以为文件夹是空的。",
    openStorageSettings: "打开系统设置授权",
    storageSettingsOpened: "已打开系统设置，开启后返回即可自动生效。",
    storageSettingsFailed: (detail: string) => `无法打开系统设置 —— ${detail}`,
    recheckStorage: "重新检测",

    // --- 运行时存储权限（Android 12 及以下）---
    diagRuntimePermission: "读写存储权限",
    runtimeGranted: "已授予",
    runtimeNotNeeded: "此系统版本不需要",
    runtimeMissing: "未授予",
    runtimeHint:
      "Android 12 及以下读取共享存储还需要「读写存储权限」，它会在首次授权时弹出系统对话框。没有它，即使开了「所有文件访问」，路径能列名但文件内容依然读不到。",
    requestRuntimePermission: "申请读写权限",
    runtimeRequested: (detail: string) => `权限申请结果：${detail}`,

    capabilities: "能力",
    openPermissions: "权限与可访问目录",
    capabilitySummary: (tools: number, plugins: number) => `已注册 ${tools} 个工具，来自 ${plugins} 个插件。`,
    agentBehaviour: "智能体行为",
    systemPrompt: "系统提示词覆盖（留空则用内置）",
    systemPromptPlaceholder: "你是 MobileClaw…",
  },

  permissions: {
    title: "权限",
    riskPolicy: "风险策略",
    riskPolicyHint: "读取和联网默认放行；写入、执行、系统操作会先询问你。",
    modeAllow: "放行",
    modeAsk: "询问",
    modeDeny: "禁止",
    resetDefaults: "恢复推荐默认值",
    roots: "可访问目录",
    rootsHint:
      "路径守卫会拒绝这些目录之外的一切，无论模型请求什么。Android 上访问共享存储需要在系统设置里开启「所有文件访问权限」。",
    rootsPlaceholder: "/storage/emulated/0/Documents",
    registeredTools: "已注册工具",
    registeredToolsHint: "工具来自插件；禁用某个插件，它的工具会直接从模型可见的清单里消失。",
    limits: "需要知道的硬限制",
    limitsHint: "这些是系统层面的限制，不是设置项。",
    limitAllFiles:
      "• 「所有文件访问权限」没有授权弹窗，必须去系统设置手动开启；而且 Google Play 不接受智能体类应用申请该权限 —— 预期分发方式是侧载、F-Droid 或 GitHub 发布。",
    limitExec:
      "• Android 10 起禁止执行应用私有目录里的文件，所以内置工具必须以原生库形式打进 APK。Shell 只能通过 Termux 或 Shizuku 获得。",
    limitShizuku:
      "• Shizuku 以 shell 身份（uid 2000）运行，不是 root，且每次重启设备后都需要重新启动 Shizuku。",
    limitAccessibility:
      "• 基于无障碍服务的界面自动化被 Play 政策禁止（明确排除“自动化工具”），且 Android 17 的进阶保护模式会阻止非无障碍应用使用无障碍 API。",
  },

  tool: {
    input: "输入",
    output: "输出",
    error: "错误",
    statusRunning: "执行中",
    statusOk: "成功",
    statusError: "失败",
    statusDenied: "已拒绝",
  },

  risk: {
    read: "读取",
    write: "写入",
    execute: "执行",
    network: "联网",
    system: "系统",
  },
} as const;

/** 风险等级的中文名，找不到就回退成原值。 */
export function riskLabel(risk: string): string {
  return (strings.risk as Record<string, string | undefined>)[risk] ?? risk;
}
