/**
 * constants.js — 常量与默认配置
 * ============================================================
 * 本文件不依赖任何其它模块，任何模块都可以引用它。
 * 改提示词模板、改默认参数、加新的设置项、加一个 API 来源，
 * 只需要动这里。
 */

/** 扩展的唯一标识。必须和 manifest.json 所在目录名一致，
 *  因为 extension_settings 是按这个名字存配置的，
 *  而酒馆加载 settings.html 走的是 third-party/${EXT_ID}/ —— 对不上就 404。 */
export const EXT_ID = '四号预设Agent插件';

/**
 * 改过名字之前用过的 id（从新到旧）。
 * 只在 extensionSettings[EXT_ID] 还是空的时候，把老 id 下的配置整份搬过来 ——
 * 否则改个目录名就等于把白名单、素材开关这些辛苦勾的全清零了。
 * 旧的那份不删，留着当备份。
 */
export const LEGACY_EXT_IDS = ['五号预设Agent插件'];

/**
 * 版本号。**必须和 manifest.json 的 version 一起改** ——
 * 酒馆扩展列表显示的是 manifest 那个，插件启动日志打的是这个。
 * 3.7.7：删掉内置底模板（大纲提示词框 = 整份提示词）
 * 3.7.8：补齐顺序把聊天记录排最后；注入改用 append_system；
 *        删掉死枚举 AS_SYSTEM_AT_DEPTH；删掉 preset.js 的引用检查
 * 3.7.9：修世界书取不到正文（activated.text 在真酒馆里常年是空串，
 *        改成从 activated.entries 逐条取 content）；数据诊断去掉「酒馆正则」一行
 * 3.8.0：新增「主模型本轮真实组成」诊断（diag.js）—— 逐条认领主模型请求
 *        并把「勾了只给大纲却还在请求里」的条目指名道姓列出来；
 *        面板新增「聊天记录压缩」一行，把「原文 / 插件口径 / 酒馆口径」三个
 *        数字并排显示（以前只显示原文总量，看着像正则没生效）
 * 3.9.0：① 聊天记录的正则改为**逐层传 depth**（与酒馆同口径）——
 *          以前不传 depth，带深度限制的正则会对每一层都执行，把
 *          「只留实时总结」和「去掉实时总结」两条方向相反的规则
 *          同时套在一层上 → 整层变空（实测差 6 倍）
 *        ② **「只给大纲」现在真的兑现**：世界书 / 角色卡 / Persona / 对话示例
 *          这些素材块也会从主模型请求里摘掉（以前只有预设条目会删，
 *          面板却在文案里承诺了素材也会删）
 *        ③ 「聊天记录」= 只给大纲 → 主模型只留**最近 N 轮**对话
 *          （默认 1 轮 = 一条 AI 输出 + 你的回复），旧楼层从主模型请求里删掉；
 *          裁完主模型读到的是「最近一轮 + 大纲」。轮数在面板「调用」页设
 *        ④ 面板数字不再骗人：「聊天记录」那栏显示压缩后的真值（以前显示原文总量）
 *        ⑤ 自有请求不再覆盖主请求的整形结果（以前面板每次生成完都显示
 *          「本轮是插件自己的大纲请求」）；history.tokens 也不叫 prompt 了
 * 3.10.0：**删掉「调用」页的「主模型历史裁剪」整块界面**（独立开关 +
 *        「保留最近 N 轮」输入框 + 那几段说明）—— 开关和「聊天记录」的去向
 *        是同一件事的两遍写法，实际永远是 1 轮，留着只会让人以为要调。
 *        功能不变：只在「聊天记录」= 只给大纲 时自动裁、固定留最近 1 轮
 *        （TRIM_KEEP_ROUNDS）。裁剪的那几条保护改写在「白名单」页
 *        「聊天记录」那一行下面。老配置里的 trimHistory / trimKeepRounds /
 *        trimKeepFloors 被忽略（不再读、也不再写回）
 * 3.11.0：**重写「状态」页的「数据诊断」**——原来 9 行长句、只报字数，
 *        看不出「这一轮到底要花多少」。现在只留 8 行短标签 + 悬浮提示，并补上：
 *        ① **发给两个模型的 tokens 总计**（大纲模型那份实时拼出来算，
 *           主模型那份用最近一次真实请求；见 panel.js:outlinePromptNow）
 *        ② **预计缓存命中**（cache.js）—— 按「最长相同前缀」估、向下取整到
 *           64 token 一块，命中价只有未命中的 1/50 ~ 1/120，这一行比总量值钱
 *        顺带：diag.js 的逐条认领多算一份 tokens，chat.js 的 historyStats()
 *        把压缩后的正文一起带出来（面板要拼提示词）
 *        **「白名单」页同样精简**（长句一律改成短句 + 悬浮提示）：
 *        ③ 素材状态行从「5 块逐条罗列字数」改成「上大纲 N/5 块 + 例外
 *          （不给大纲 / 只给主模型）+ 表格里看不到的数字（几层 / 激活几条）」，
 *          每块字数进悬浮提示 —— 表格里本来就有那一列
 *        ④ 预设信息行只说「几条有正文 · 多少字」，总条数 / 已开启进悬浮提示
 *        ⑤ 「聊天记录」下面那条裁剪保护缩成一句，完整判据进悬浮提示
 *        ⑥ 条目行不再挂 [role]（role / position 进悬浮提示），提示词框的
 *          可用占位符也写进悬浮提示
 *        ⑦ **全站界面文案改口径**（含悬浮窗、扩展设置区卡片、日志页）：
 *          去掉 ★ / ⚠️ / **粗体** / 感叹号等标记（判据改用数据，如 diag.leaked）；
 *          「便宜模型 / 贵模型」→「大纲模型 / 主模型」；键盘式催促语改成陈述句；
 *          徽章词表统一为「超时·已终止 / 超时·部分注入 / 超时·未注入」等。
 *          规范见 技术文档.md 第 11 节
 * 3.12.0：**日志只记关键部分**（实测：启动 16→6 行、一轮 19→6 行，
 *        真实场景里那一轮以前还要再倒最多 60 行逐条明细）。
 *        ① 修两个真 bug：index.js 里 `logInfo(msg, 'ok', 'main')` —— logInfo
 *          只吃两个参数，'ok' 被当成 scope、'main' 丢掉，面板上显示成
 *          「ok: 本轮完成」且不亮绿灯（启动完成同样）；改成 logOk(msg, 'run')
 *        ② scope 从 15 个收敛到 6 个：boot / run / outline / trim / preset / env
 *          日志页不再显示 scope，改由「谁拥有一轮谁说话」：数据各模块算，
 *          句子只在 index.js 里拼（describeMaterial / describeInjected）
 *        ③ 同一件事只说一次：删掉面板里那些「把状态页数据再抄一遍」的日志
 *          （预览｜/系统预设条目｜/请求组成｜/主模型本轮真实组成｜），
 *          逐条明细只留在面板「状态」页，日志里留一行摘要 + 指针
 *        ④ 删掉「我做成了某件事」的流水（已挂上 XXX、防递归标记已复位、
 *          已还原临时覆盖的设置、模型已是 X 无需覆盖、放行自有请求…）
 *        ⑤ 分隔线日志（'────' / '════'）删掉，轮次边界改用「第 N 轮｜…」
 *        ⑥ 日志页修两处：显示的行数 = 复制出去的行数（以前只显示 200 行、
 *          复制拿走 500 行），以及只在贴着底时才自动滚动（以前每来一行都
 *          把你拽回底部，运行中根本没法往上翻）
 *        ⑦ 新增 日志自检.cjs 守住这些规矩（scope 白名单、每轮行数上限、
 *          级别不许再被当成 scope）
 *        ⑧ 顺带删掉 15 个**从未被引用**的导出（纯减负，行为零变化）：
 *          chat.js 的 getFloorsAfter / getLastFloors / clearHistoryStats（「阶段二」的
 *          预留接口，一直没接上）、env.js 的 can / escapeRegExp、cache.js 的
 *          lastRequestAt、preset.js 的 entryContent、settings.js 的 setAllEntries /
 *          clearPresetWhitelist / whitelistStats / resetAll、outline.js 的
 *          modelFieldFor、ui.js 的 refreshCard / openDrawer / isPanelOpen
 */
export const VERSION = '3.13.0';

/** DOM id 前缀，避免和其它扩展撞名 */
export const PREFIX = 'dro';

/** 悬浮窗根容器 id（幂等清理用） */
export const ROOT_ID = `${PREFIX}-root`;

/** 大纲注入时用来包裹内容的标记，便于识别与阶段二剥离 */
export const OUTLINE_MARK_OPEN = '【剧情大纲·由前置模型生成】';
export const OUTLINE_MARK_CLOSE = '【剧情大纲结束】';

/**
 * 大纲注入位置。
 * 插件实际用的是 APPEND_SYSTEM（理由见 inject.js 顶部关于前缀缓存的说明）；
 * PREPEND_USER 留着当退路 —— 万一某个后端不认末尾的 system 消息。
 * （v3.7.8 删掉了名不副实的 AS_SYSTEM_AT_DEPTH：它和 APPEND_SYSTEM 走的是
 *  同一个分支，根本没有「按深度插入」这回事。）
 */
export const INJECT_MODE = {
    PREPEND_USER: 'prepend_user',
    APPEND_SYSTEM: 'append_system',
};

/** 白名单里每个条目可以指定目标 */
export const TARGET = {
    OUTLINE: 'outline',
    MAIN: 'main',
    BOTH: 'both',
};

/**
 * 连接方式。
 *   CURRENT —— 沿用酒馆当前聊天补全来源，插件只临时换模型/思维链参数。
 *              不需要钥匙，不会把密钥写进扩展配置。
 *   CUSTOM  —— 插件自己指定来源 + URL + Key + 模型（走酒馆助手的 custom_api）。
 *              「DeepSeek 来源自带 URL 与模型选择」就是这条路。
 */
export const CONN_MODE = {
    CURRENT: 'current',
    CUSTOM: 'custom',
};

/**
 * 内置的来源预设。
 * ============================================================
 * 为什么要有这张表：
 *   酒馆原生 generateRaw 不接受自定义 URL/Key（1.18.0 实测签名里没有
 *   custom_api），所以想「自带 URL + 模型下拉」就得自己给出这张表，
 *   并在调用时走酒馆助手的 generateRaw(custom_api)。
 *
 *   source  —— 填进 custom_api.source，必须是酒馆认得的来源名，
 *              否则酒馆后端会报「无效的来源」。
 *   url     —— 该来源的官方地址，会预填到 URL 输入框（可改）。
 *   models  —— 内置模型清单，只在「拉取清单」失败时兜底。
 *              ★ 写死模型名 = 迟早出现过期名：DeepSeek 的模型名随版本换过
 *              （deepseek-chat / deepseek-reasoner 已经是旧名，酒馆自己都会
 *              把它们迁移走），所以这里留空 —— 一律以「拉取清单」取回的
 *              真实列表为准，取不到就让用户手填。
 *   reasoning —— 该来源的思维链说明，直接显示在界面上，
 *                免得用户猜「为什么关了推理还是慢」。
 */
export const PROVIDERS = {
    deepseek: {
        key: 'deepseek',
        label: 'DeepSeek（深度求索）',
        source: 'deepseek',
        url: 'https://api.deepseek.com/v1',
        /**
         * ★ 这里刻意留空。
         * 旧版写死了 ['deepseek-chat', 'deepseek-reasoner']，那是**两个过期模型名**：
         * DeepSeek 换成 V4 之后模型叫 deepseek-v4-flash / deepseek-v4-pro 这一类，
         * 酒馆自己都在做迁移（openai.js 里 oldValue: /^deepseek-(chat|reasoner|coder)$/
         * → newValue: 'deepseek-v4-flash'），插件再把旧名摆进下拉就是让人选错。
         * 现在下拉的内容只有一个来源：「拉取清单」向 API 拉回来的真实清单。
         */
        models: [],
        reasoning: 'DeepSeek 的强度只接受 low / medium / high / max，没有 minimum（最低即 low）：' +
            '来源为 DeepSeek 时，插件按这套写法发送。思维链开关对应请求中的 thinking.type，' +
            '由酒馆的「请求模型思维链」决定，该开关开启后强度才会生效。',
    },
    openai: {
        key: 'openai',
        label: 'OpenAI',
        source: 'openai',
        url: 'https://api.openai.com/v1',
        models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-5-mini'],
        reasoning: 'gpt-5 系列默认启用思考，可用强度档位调节；gpt-4o 系列本身不进行推理。',
    },
    custom: {
        key: 'custom',
        label: '自定义（OpenAI 兼容）',
        source: 'custom',
        url: '',
        models: [],
        reasoning: '自定义端点是否支持推理，取决于所连接的服务端。',
    },
};

/**
 * 思维链强度的两套写法。
 * ============================================================
 * 为什么要分两套（这是 v3.7.3 修的东西）：
 *   原来只有一套 key（auto/min/low/medium/high/max），那是**酒馆自己的写法**
 *   （index.html 的 #openai_reasoning_effort 就是这 6 个值），对自定义 /
 *   OpenAI 兼容来源是对的 —— 但**DeepSeek 官方不认这套**：
 *     · 它没有 minimum，强度就是 low / medium / high / max；
 *     · 酒馆对 deepseek 来源还会把 low/medium/high 统一折算成 high
 *       （openai.js getReasoningEffort 的 DEEPSEEK 分支：auto→不发，
 *        max→max，其余→high），所以只写酒馆那个字段是选不动的；
 *     · DeepSeek 只有在请求里带了决定思考的字段（thinking.type，酒馆由
 *        include_reasoning 生成）时，reasoning_effort 才会被后端转发。
 *   所以：来源 = DeepSeek → 自动换成 DeepSeek 的写法（选项表 + 发出去的值）；
 *   其余来源 → 保持酒馆 / OpenAI 兼容那套，一切照旧。
 */
export const REASONING_SYNTAX = {
    /** 酒馆 / OpenAI 兼容：min / low / medium / high / max */
    GENERIC: 'generic',
    /** DeepSeek 官方：low / medium / high / max */
    DEEPSEEK: 'deepseek',
};

/** 思维链强度档位（酒馆 / OpenAI 兼容写法）。'keep' 表示不动酒馆原本的设置。 */
export const REASONING_LEVELS = [
    { key: 'keep', label: '不改（沿用酒馆设置）' },
    { key: 'auto', label: '自动（交给模型决定）' },
    { key: 'min', label: '最低' },
    { key: 'low', label: '低' },
    { key: 'medium', label: '中' },
    { key: 'high', label: '高' },
    { key: 'max', label: '最高' },
];

/**
 * 思维链强度档位（DeepSeek 官方写法）。
 * 选项上直接写出 API 认的英文值，免得「最低」和「低」到底发哪个靠猜。
 */
export const REASONING_LEVELS_DEEPSEEK = [
    { key: 'keep', label: '不改（沿用酒馆设置）' },
    { key: 'auto', label: '自动 auto（不发送该字段）' },
    { key: 'low', label: '低 low' },
    { key: 'medium', label: '中 medium' },
    { key: 'high', label: '高 high' },
    { key: 'max', label: '最高 max' },
];

/** 写法 → 档位表。界面和换算都只查这张表。 */
export const REASONING_LEVELS_BY_SYNTAX = {
    [REASONING_SYNTAX.GENERIC]: REASONING_LEVELS,
    [REASONING_SYNTAX.DEEPSEEK]: REASONING_LEVELS_DEEPSEEK,
};

/**
 * 旧档位在新写法里的等价档位。
 * DeepSeek 没有 minimum —— 最低就是 low，所以别让用户白选一个没用的档。
 */
export const REASONING_ALIASES = {
    [REASONING_SYNTAX.DEEPSEEK]: { min: 'low' },
};

/**
 * 大纲提示词的「素材块」清单。
 * ============================================================
 * 这些是酒馆给主模型、但不会给大纲模型的东西，由插件自己取来拼。
 * 每一项都能在「白名单」页单独开关，默认全开。
 * 对应模板占位符见 pl。
 */
/**
 * 素材块清单。
 *
 * label —— 会出现在拼给大纲模型的提示词标题里（【…】），说清楚就行；
 * short —— 只给界面表格用，越短越好（表格里 5 行并排，长了就挤）。
 * pl    —— 模板占位符名。
 */
export const SYSTEM_BLOCKS = [
    { key: 'history', pl: 'chat_history', label: '聊天记录（正则压缩后）', short: '聊天记录' },
    { key: 'worldInfo', pl: 'world_info', label: '本轮激活的世界书', short: '世界书' },
    { key: 'charCard', pl: 'char_card', label: '角色卡（描述/性格/场景）', short: '角色卡' },
    { key: 'persona', pl: 'persona', label: '用户 Persona', short: 'Persona' },
    { key: 'examples', pl: 'examples', label: '对话示例', short: '对话示例' },
];

/** 默认配置。新增设置项时在这里加，settings.js 会自动补进老配置。 */
export const DEFAULTS = {
    /** 总开关 */
    enabled: true,

    /** ---- 调用方式 ---- */
    /** CONN_MODE.CURRENT 或 CONN_MODE.CUSTOM */
    connMode: CONN_MODE.CURRENT,
    /** connMode==='custom' 时使用的来源：deepseek / openai / custom */
    provider: 'deepseek',
    /** custom 模式的地址（选 DeepSeek 时自动预填官方地址） */
    manualUrl: '',
    /** custom 模式的密钥。⚠️ 会明文存在酒馆设置里 */
    manualKey: '',
    /** 模型名。留空 = 沿用所选来源的当前模型 */
    model: '',
    /** 拉取到的模型清单缓存：{ [provider]: string[] } */
    modelList: {},

    /** ---- 思维链 ---- */
    /**
     * 大纲模型的推理强度档位，见 REASONING_LEVELS / REASONING_LEVELS_DEEPSEEK。
     * 'keep' = 不改酒馆设置（默认）。选别的档位才会生效 ——
     * 早期版本还有一个「是否允许改写」的开关，两个控件叠在一起
     * 会出现「开了强度但开关没开」的空转，已删除，只留这一个下拉。
     * 存的是档位 key；换来源导致 key 不被新写法认识时按 REASONING_ALIASES 换算。
     */
    reasoningLevel: 'keep',

    /** ---- 兼容旧配置（v3.0 的字段，保留以免老配置报错） ---- */
    apiMode: 'current',
    profileId: '',
    manualSource: 'deepseek',

    /** ---- 参数 ---- */
    maxTokens: 2048,
    /** 请求超时（秒）。到时会请求中断并跳过本轮 */
    timeoutSec: 60,
    /** 是否流式（面板实时显示大纲） */
    streaming: true,

    /** ---- 数据来源 ---- */
    /** 预设条目白名单：{ 预设名: { 条目名: { enabled, target } } } */
    presetWhitelist: {},
    /**
     * 素材块开关：{ 预设名: { history, worldInfo, charCard, persona, examples } }
     * 跟白名单同源 —— 每个预设各存一套，换预设 = 换一套素材开关，默认全开。
     * 某个预设没有记录时，用下面的 systemBlocks 兜底（见 settings.js:blockConfigOf）。
     */
    presetBlocks: {},
    /**
     * 【历史字段，只为兼容旧配置】v3.1 之前素材开关是全局一套的。
     * 现在它只在「某个预设还没被单独改过」时充当默认值，界面不再写它。
     */
    systemBlocks: {
        history: true,
        worldInfo: true,
        charCard: true,
        persona: true,
        examples: true,
    },
    /**
     * 大纲提示词（**整份**）：面板那个「大纲提示词」框存的就是它，默认空。
     * ============================================================
     * 空 = 什么都不发（只剩插件按规则自动补到末尾的素材块）。
     * 这里没有内置底模板 —— 你看到什么，发出去的就是什么；
     * 想改提示词，改面板那个框就行，不用动代码。
     * （v3.7.7 之前它是「额外提示词」，追加在内置的 DEFAULT_TEMPLATE 后面。）
     */
    template: '',

    /** ---- 界面 ---- */
    /** 悬浮竖条透明度 */
    barOpacity: 0.85,
    /** 悬浮竖条是否显示 */
    showBar: true,
    /** 悬浮面板是否展开 */
    panelOpen: false,
    /** 当前标签页 */
    panelTab: 'status',
    /** 悬浮条位置（null = 用默认右上角） */
    panelX: null,
    panelY: null,
    /** 悬浮面板尺寸（null = 用默认尺寸） */
    panelW: null,
    panelH: null,
};

/**
 * 历史裁剪固定保留的轮数：**1 轮**（一条 AI 输出 + 它之后你说的那些话）。
 * ============================================================
 * 这里刻意不是一个可调设置，界面上也没有对应的控件：
 * 裁剪只在系统预设条目「聊天记录」= 只给大纲 时自动发生（见 trim.js
 * 的 wantTrimHistory），那时主模型本来就该只接着最近一轮往下写。
 * 以前「调用」页有个独立的开关 + 「保留最近 N 轮」输入框，
 * 但开关和「只给大纲」是同一件事的两遍写法，实际用起来永远是 1 轮，
 * 于是整块界面连同它的说明一起删掉了（v3.10.0）。
 */
export const TRIM_KEEP_ROUNDS = 1;

/**
 * 模板里允许出现的占位符白名单（用于校验，防止用户写错静默失效）。
 * 拼提示词时能用的占位符见 buildSystemPrompt()：
 *   {{chat_history}} {{preset_entries}} {{char}} {{user}}
 *   {{world_info}} {{char_card}} {{persona}} {{examples}}
 */
export const TEMPLATE_PLACEHOLDERS = [
    'chat_history',
    'world_info',
    'char_card',
    'persona',
    'examples',
    'preset_entries',
    'char',
    'user',
];

/** 需要探测的环境能力。缺失会在「环境」页标红。 */
export const REQUIRED_CAPS = [
    { key: 'getContext', label: 'SillyTavern.getContext', critical: true },
    { key: 'eventSource', label: 'context.eventSource', critical: true },
    { key: 'eventTypes', label: 'context.eventTypes', critical: true },
    { key: 'generateRaw', label: 'context.generateRaw', critical: true },
    { key: 'chat_completion_settings_ready', label: '事件 CHAT_COMPLETION_SETTINGS_READY', critical: true },
    { key: 'chat', label: 'context.chat', critical: false },
    { key: 'extensionSettings', label: 'context.extensionSettings', critical: true },
    { key: 'saveSettingsDebounced', label: 'context.saveSettingsDebounced', critical: false },
    { key: 'substituteParams', label: 'context.substituteParams（宏展开）', critical: false },
    { key: 'powerUserSettings', label: 'context.powerUserSettings（读预设兜底）', critical: false },
    { key: 'ConnectionManagerRequestService', label: 'context.ConnectionManagerRequestService（连接配置）', critical: false },
    { key: 'stopGeneration', label: 'context.stopGeneration', critical: false },
    { key: 'TavernHelper', label: 'window.TavernHelper（可选增强）', critical: false },
    { key: 'tavernHelperGetPreset', label: 'TavernHelper.getPreset（读预设首选）', critical: false },
    { key: 'tavernHelperGetVariables', label: 'TavernHelper.getVariables', critical: false },
    { key: 'tavernHelperGenerateRaw', label: 'TavernHelper.generateRaw（自定义 URL/Key 必需）', critical: false },
    { key: 'tavernHelperGetModelList', label: 'TavernHelper.getModelList（刷新模型列表）', critical: false },
];
