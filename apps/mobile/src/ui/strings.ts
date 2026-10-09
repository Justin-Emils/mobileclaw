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
    /**
     * 改屏幕的操作不给「总是允许」。这行显示在原先那个按钮的位置，说明为什么没有它——
     * 直接少一个按钮而不解释，看起来像界面出了毛病。
     */
    neverRememberNote:
      "这类操作每次都重新问你，所以没有「总是允许」: 它改的是屏幕上真实的东西，一次同意不该覆盖下一次。",
  },

  /** 屏幕自动化：取点、存证、以及 Shizuku 的安装引导。 */
  automation: {
    pickTitle: "点一下你想让我点的位置",
    pickHint:
      "在下面这张截图上点选目标。这个坐标会作为这次操作的一部分交给我——我自己看不见屏幕，猜出来的位置只能靠运气。",
    pickCoordinates: (x: number, y: number) => `已选择 横向 ${x}% · 纵向 ${y}%`,
    pickConfirm: "就点这里",
    pickCancel: "取消",
    pickNoImage: "这一步没有可用的截图。让我先截一张，再回来选位置。",
    pickFromCapture: "在截图上选择位置",
    pickNeedsPoint: "还没选位置。点上面的按钮在截图上选一个——不选就没法确认，我不会自己猜。",

    shizukuTitle: "要先安装并授权 Shizuku",
    shizukuIntro:
      "屏幕自动化得靠 Shizuku 才能拿到系统级的操作权限。它是开源软件，不 root 也能用，但需要你自己装、自己授权——这一步我替不了你。",
    shizukuDownload: "打开下载页",
    shizukuSteps: [
      "安装 Shizuku（应用商店不一定搜得到，用上面的下载页）。",
      "打开「设置 → 关于手机」，连点「版本号」7 次，开启开发者选项。",
      "在「设置 → 系统 → 开发者选项」里打开「无线调试」。",
      "打开 Shizuku，按它的引导在原地启动服务——Android 11 以上不需要电脑。",
      "回到本应用点「授权」，在 Shizuku 弹出的窗口里允许。",
    ],
    shizukuRebootNote:
      "重启手机后 Shizuku 会停止，需要重做第 4、5 步。这是非 root 模式的工作方式，不是故障。",
    shizukuRiskTitle: "授权意味着什么",
    shizukuRisks: [
      "本应用会拿到 ADB（shell）级别的权限，这是普通应用拿不到的。",
      "具体来说：本应用能截取屏幕上任何应用的内容，包括聊天、密码框和银行页面。",
      "本应用能向任何应用注入点击和文字，等于替你操作手机。",
      "这些能力绕过了 Android 的应用沙箱。任何你在 Shizuku 里授权过的应用都有同等能力。",
      "非 root 模式需要一直开着开发者选项和无线调试，而部分银行、支付类应用会因为检测到开发者模式而拒绝运行。",
      "截图目前只存在本机、只给你看——这个版本不会把屏幕内容发给模型服务商。以后如果接入识别文字的能力，这个前提会变，届时会重新征求你的同意。",
    ],
    shizukuOpen: "去授权",
    shizukuLater: "以后再说",
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
    storageDenied: "读不到共享存储 —— 应用写入被系统拒绝",
    storageUnknown: "无法探测",
    storageDeniedExplain:
      "如果你已经在系统设置里打开了「所有文件访问」，那这一步不是权限问题：应用能列出目录，但创建和写入文件被系统拒绝。可以运行下面的自检把结果反馈。",
    storageEvidenceLabel: "系统返回",
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
    /** 动作类工具的存证截图。 */
    evidence: "截图存证",
  },

  /**
   * 任务复述确认。这是运行开始前的那道闸门，不是审批弹窗的另一种皮肤：
   * 审批问的是"这一步能不能做"，它问的是"你要我做的是不是这件事"。
   */
  plan: {
    kicker: "先确认我要做什么",
    title: "你让我做的是这件事吗",
    stepsTitle: "我打算这样做",
    appsTitle: "会碰到的应用",
    changesTitle: "其中这些会真的改动东西",
    readOnlyTitle: "这一步都不会改动任何东西",
    readOnlyNote:
      "整个过程只读不写：打开应用、读屏幕、翻页都不会改动任何东西，所以过程中不会再打断你。",
    changesNote:
      "上面这些会向别的应用真正写入内容。做之前我还会再问你一次，而且「总是允许」对它们无效。",
    confirm: "对，开始吧",
    cancel: "不对，我再说一遍",
    cancelledHint: "已取消。请把要求再说明一次，我会重新复述给你确认。",
    /**
     * 步数估算。给用户看的原因是成本：每次工具调用都花 token 和时间，
     * 而"这个任务比默认上限长得多"是用户该知道、也只有用户能决定要不要接受的事。
     */
    costTitle: "预计需要多少步",
    costEstimate: (steps: number) => `约 ${steps} 步`,
    costNote:
      "每一步是一次工具调用（一次读取、一次搜索、一次点击都算一步）。估多了只是多花一点额度，估少了会在任务中途被切断。如果这个数字比你设置的上限大，本次运行的上限会被提到这个数。",
  },

  /** 语义树可读性探测：勾选应用、跑一遍、把结果存下来。 */
  probe: {
    title: "应用语义树探测",
    intro:
      "有些应用会对外发布可读的界面结构（语义树），有些不会 —— 这取决于应用版本和具体页面，查不到现成资料，只能在你手机上实测。勾选几个应用跑一遍，结果会存在本机，下次直接用。",
    needShizuku: "这个功能需要 Shizuku 才能读别的应用，当前不可用。先去设置里授权，再回来跑。",
    noApps: "读不到已安装应用列表。可能是原生模块不可用（构建产物过期），也可能是系统限制。",
    pickTitle: "选择要探测的应用",
    pickHint: "建议一次别选太多：每个应用要打开、等它稳定、再读一次，选得越多越慢。",
    filterPlaceholder: "按名称或包名筛选",
    selected: (count: number) => `已选 ${count} 个`,
    run: "开始探测",
    stop: "停止",
    running: (done: number, total: number) => `探测中 ${done}/${total}…`,
    resultTitle: "本次结果",
    inventoryTitle: "已存下来的结果",
    inventoryHint: "这些是存在本机的探测记录，对话里让我读某个应用时可以直接用，不用重跑。",
    emptyInventory: "还没有探测过任何应用。",
    forget: "重测",
    statusReadable: "可读可点",
    statusLabelsOnly: "只读不能点",
    statusEmpty: "读不到内容",
    statusBlocked: "受保护",
    statusFailed: "失败",
    /** 五档状态各自意味着什么，以及下一步该怎么办。 */
    adviceReadable: "这条路可用：能读文字，也能按元素点击。",
    adviceLabelsOnly: "能读到文字，但没有可点的元素 —— 也许换个页面就有。",
    adviceEmpty: "这个页面什么都没发布。可能是自绘界面，也可能只是这一屏如此。",
    adviceBlocked: "受保护的内容（FLAG_SECURE 之类）。这条路对它无效，换别的办法或交给用户自己做。",
    adviceFailed: "没跑成，原因见下。",
    settleNote: "每个应用打开后会等 2 秒再读，否则会把「还在启动」记成「读不到」。",
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
