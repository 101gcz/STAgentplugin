/**
 * env.js — 环境适配层 + 日志 + 错误分级
 * ============================================================
 * 这是整个扩展的地基，所有其它模块都只通过这里访问酒馆。
 *
 * 设计原则（针对原版死在「隐藏依赖」上的教训）：
 *   1. 只走官方通道 SillyTavern.getContext()，不 import 酒馆内部模块。
 *      内部模块在版本升级时会变，而且官方不允许扩展直接引用。
 *   2. 酒馆助手(TavernHelper)只作为「可选增强」：
 *      它的 getPreset 比从 powerUserSettings 里挖更准，
 *      但它没装/没启用时扩展必须照样能跑。
 *   3. 任何一步失败都不抛出去，而是记一条带级别的日志 + 返回安全默认值。
 *      原版把三类完全不同的错误用同一个 catch 吞掉，全部表现为
 *      「没有大纲」，这是它最难排查的地方。
 */

import { PREFIX, REQUIRED_CAPS } from './constants.js';

// ============================================================
// 日志
// ============================================================
//
// 只记「关键部分」。判定标准（写代码前先过一遍这三条）：
//   1. 用户要不要**据此做决定**？（跳过 / 降级 / 漏网 / 失败 → 记）
//   2. 这句话在别处是不是已经说过了？（说过 → 不记）
//      · 面板「状态」页已经画了的东西（素材构成、请求逐条明细、整形结果），
//        日志里只留一行摘要 + 指针，不重复倒一遍。
//   3. 是「我自己做成了某件事」这种流水吗？（是 → 不记，除非它是本轮的唯一结论）
//
// scope 只用下面这几个 —— 不许再自造（旧代码里有 15 个，还有 'ok' 这种被
// 误当 scope 传进来的，见 index.js 的 logInfo 三参 bug）：
//   boot     启动、注册、配置迁移 / 导入导出（一次性、低频）
//   run      一轮生成：素材 → 大纲 → 注入 → 完成（每轮固定几行）
//   outline  大纲这一次请求的细节（参数覆盖、超时、失败）
//   trim     主模型请求整形 / 历史裁剪的结果
//   preset   预设读取与白名单
//   env      环境问题与内部异常（含 safe() 兜底、界面挂载失败）
//
// 级别只有四档：info 关键节点 / ok 本轮完全成功 / warn 有降级但仍可用 /
// error 用户必须知道、功能受影响。error 会同时打到控制台。

const MAX_LINES = 500;
const lines = [];
const subscribers = new Set();

/**
 * 记一条日志。
 * @param {string} msg
 * @param {'info'|'warn'|'error'|'ok'} [level]
 * @param {string} [scope] 见文件头的 scope 清单
 */
export function log(msg, level = 'info', scope = '') {
    const entry = {
        t: new Date().toLocaleTimeString(),
        msg: String(msg),
        level,
        scope,
    };
    lines.push(entry);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    for (const fn of subscribers) {
        try { fn(entry); } catch (e) { /* 订阅者自己出错不影响日志 */ }
    }
    // 错误级别同时打到控制台，方便 F12 直接看
    if (level === 'error') {
        try { console.error(`[${PREFIX}] ${scope ? scope + ': ' : ''}${entry.msg}`); } catch (e) { /* ignore */ }
    }
    return entry;
}

export function logInfo(msg, scope) { return log(msg, 'info', scope); }
export function logWarn(msg, scope) { return log(msg, 'warn', scope); }
export function logError(msg, scope) { return log(msg, 'error', scope); }
export function logOk(msg, scope) { return log(msg, 'ok', scope); }

export function getLogLines() { return lines.slice(); }
export function clearLog() { lines.length = 0; }

/**
 * 一份日志的纯文本形态。
 * ★ 面板显示和「复制日志」必须用**同一个**函数 ——
 *   以前面板只画最后 200 行、复制却拿走全部 500 行，
 *   于是「复制给我排查」的内容和用户屏幕上看到的不是一回事。
 */
export function formatLogLines(ls) {
    return (ls || getLogLines())
        .map(l => `[${l.t}] [${l.level}] ${l.scope ? l.scope + ': ' : ''}${l.msg}`)
        .join('\n');
}

/** 订阅新日志（UI 用来实时刷新） */
export function onLog(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

/** 把任意抛出物转成可读文本。
 *  注意：这里刻意不做 `e instanceof ErrorEvent` 这类判断 ——
 *  ErrorEvent 不是所有环境都有（Node、部分浏览器上下文里没有），
 *  在错误处理函数里抛 ReferenceError 是最糟的情况。改成 duck typing。 */
export function errorText(e) {
    if (e == null) return '未知错误';
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message || e.name || 'Error';
    if (typeof e === 'object') {
        // ErrorEvent 之类：有 message 就用
        if (typeof e.message === 'string' && e.message) return e.message;
        if (typeof e.error === 'string' && e.error) return e.error;
        if (e.error) return errorText(e.error);
        if (typeof e.type === 'string' && e.type) return `事件错误(${e.type})`;
        try {
            const s = JSON.stringify(e);
            return s === '{}' ? String(e) : s;
        } catch (x) { /* 循环引用等 */ }
    }
    try { return String(e); } catch (x) { return '(无法转成文本的错误)'; }
}

/** 包一层 try/catch，失败时记日志并返回 fallback。绝不让异常穿透。 */
export function safe(scope, fn, fallback = null) {
    try {
        return fn();
    } catch (e) {
        logError(`${scope} 失败: ${errorText(e)}`, scope);
        return fallback;
    }
}

/** 同 safe，但用于 async 函数 */
export async function safeAsync(scope, fn, fallback = null) {
    try {
        return await fn();
    } catch (e) {
        logError(`${scope} 失败: ${errorText(e)}`, scope);
        return fallback;
    }
}

// ============================================================
// 酒馆上下文
// ============================================================

let _ctx = null;

/**
 * 取酒馆上下文。官方通道优先，老版本退回全局函数。
 * 故意不缓存失败结果，这样酒馆就绪后重试能成功。
 */
export function ctx() {
    if (_ctx) return _ctx;
    try {
        if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
            _ctx = SillyTavern.getContext();
            return _ctx;
        }
    } catch (e) {
        logWarn('SillyTavern.getContext() 抛异常: ' + errorText(e), 'env');
    }
    try {
        if (typeof getContext === 'function') {
            _ctx = getContext();
            return _ctx;
        }
    } catch (e) {
        logWarn('全局 getContext() 抛异常: ' + errorText(e), 'env');
    }
    return null;
}

/** 强制重新取一次上下文（酒馆重启/重载聊天后用） */
export function refreshCtx() {
    _ctx = null;
    return ctx();
}

/** 酒馆助手的全局对象，没有则 null。只作为可选增强。 */
export function tavernHelper() {
    try {
        if (typeof TavernHelper !== 'undefined' && TavernHelper) return TavernHelper;
        if (typeof window !== 'undefined' && window.TavernHelper) return window.TavernHelper;
    } catch (e) { /* ignore */ }
    return null;
}

/** 取酒馆事件系统 */
export function events() {
    const c = ctx();
    return {
        source: (c && c.eventSource) || null,
        types: (c && c.eventTypes) || null,
    };
}

// ============================================================
// 事件封装（统一 API，屏蔽版本差异）
// ============================================================

/**
 * 监听酒馆事件。
 * @param {string} type 事件名，直接用 ctx.eventTypes 里的值
 * @param {Function} handler
 * @param {{scope?:string}} [opt]
 * @returns {{stop: () => void}} 必须成对注销；原版就是漏了这一步导致监听器无限泄漏
 */
export function on(type, handler, opt = {}) {
    const { source } = events();
    const scope = opt.scope || 'event';
    if (!source || typeof source.on !== 'function') {
        logWarn(`无法监听事件 ${type}（eventSource 不可用）`, scope);
        return { stop() { } };
    }
    try {
        source.on(type, handler);
    } catch (e) {
        logError(`监听 ${type} 失败: ${errorText(e)}`, scope);
        return { stop() { } };
    }
    return {
        stop() {
            try { source.removeListener(type, handler); } catch (e) { /* ignore */ }
        },
    };
}

/** 一次性监听。用完自动注销。 */
export function once(type, handler, opt = {}) {
    const h = on(type, (...args) => {
        try { h.stop(); } catch (e) { /* ignore */ }
        handler(...args);
    }, opt);
    return h;
}

// ============================================================
// 能力探测
// ============================================================

const caps = {};

/**
 * 探测运行环境。启动时跑一次，结果给「环境」页展示。
 * 这是把原版「静默失效」变成「启动即可见」的地方。
 */
export function probe(force = false) {
    if (Object.keys(caps).length && !force) return caps;

    const c = safe('env', () => ctx(), null);
    const th = tavernHelper();
    const { source, types } = events();

    const check = (ok) => ok === true;

    const raw = {
        getContext: check(!!c),
        eventSource: check(!!source && typeof source.on === 'function'),
        eventTypes: check(!!types),
        generateRaw: check(!!c && typeof c.generateRaw === 'function'),
        chat_completion_settings_ready: check(!!types && !!types.CHAT_COMPLETION_SETTINGS_READY),
        chat: check(!!c && Array.isArray(c.chat)),
        extensionSettings: check(!!c && !!c.extensionSettings),
        saveSettingsDebounced: check(!!c && typeof c.saveSettingsDebounced === 'function'),
        substituteParams: check(!!c && typeof c.substituteParams === 'function'),
        powerUserSettings: check(!!c && !!c.powerUserSettings),
        ConnectionManagerRequestService: check(!!c && !!c.ConnectionManagerRequestService),
        stopGeneration: check(!!c && typeof c.stopGeneration === 'function'),
        // 「以此大纲再次生成正文」靠它把正文写到**新的一页**上（st-context.js:246-249）
        swipe: check(!!c && !!c.swipe && typeof c.swipe.to === 'function'),
        TavernHelper: check(!!th),
        tavernHelperGetPreset: check(!!th && typeof th.getPreset === 'function'),
        tavernHelperGetVariables: check(!!th && typeof th.getVariables === 'function'),
        // 自定义 URL/Key 这条路必须靠酒馆助手的 generateRaw(custom_api)：
        // 酒馆原生 generateRaw 的签名里没有 custom_api（1.18.0 实测）。
        tavernHelperGenerateRaw: check(!!th && typeof th.generateRaw === 'function'),
        tavernHelperGetModelList: check(!!th && typeof th.getModelList === 'function'),
    };

    for (const item of REQUIRED_CAPS) caps[item.key] = raw[item.key] === true;
    caps.__raw = raw;
    caps.__missingCritical = REQUIRED_CAPS.filter(x => x.critical && !raw[x.key]).map(x => x.label);
    caps.__missingOptional = REQUIRED_CAPS.filter(x => !x.critical && !raw[x.key]).map(x => x.label);
    return caps;
}

export function getCaps() { return caps; }

// ============================================================
// 常用数据快捷方式
// ============================================================

/** 角色名 / 用户名 */
export function names() {
    const c = ctx();
    return {
        char: (c && c.name2) || '',
        user: (c && c.name1) || '',
    };
}

/** 聊天数组 */
export function chatArray() {
    const c = ctx();
    return (c && Array.isArray(c.chat)) ? c.chat : [];
}

/** 宏展开。优先用酒馆原生 substituteParams，其次酒馆助手。 */
export function expandMacros(text) {
    const s = String(text == null ? '' : text);
    const c = ctx();
    if (c && typeof c.substituteParams === 'function') {
        const r = safe('expandMacros', () => c.substituteParams(s));
        if (typeof r === 'string') return r;
    }
    const th = tavernHelper();
    if (th && typeof th.substitudeMacros === 'function') {
        const r = safe('expandMacros', () => th.substitudeMacros(s));
        if (typeof r === 'string') return r;
    }
    return s;
}

/** 让酒馆保存设置（防抖）。失败也无所谓，只是慢一点落盘。 */
export function persistSettings() {
    const c = ctx();
    if (c && typeof c.saveSettingsDebounced === 'function') {
        safe('persistSettings', () => c.saveSettingsDebounced());
    }
}

/** 请求中断当前酒馆生成 */
export function stopGeneration() {
    const c = ctx();
    if (c && typeof c.stopGeneration === 'function') {
        return safe('stopGeneration', () => { c.stopGeneration(); return true; }, false);
    }
    return false;
}

/**
 * 让酒馆把**最后一条回复**重新生成一次（正文模型）。
 * ============================================================
 * ★ 注意这条路的性质：酒馆的「重新生成」是**先删掉最后一条 AI 消息**再重新生成
 *   （见下面 regenerateReplyAsNewSwipe 的说明），所以它**不保留旧版**，
 *   页数永远停在 1。面板按钮想要「旧版留着、能翻回去看」就走
 *   regenerateReplyAsNewSwipe()；这个函数现在是它的兜底，以及
 *   「最后一条是用户消息（本来就没有可翻页的回复）」时的正常入口。
 *
 * 三条路依次试（都能走到酒馆的 Generate('regenerate')）：
 *   1. 酒馆原生 /regenerate 斜杠命令（getContext().executeSlashCommandsWithOptions）
 *      —— 最贴近用户点「重新生成」按钮的行为：它会先等生成锁、
 *      群聊里也会走群聊那套。选它当首选就是因为它把这两件事都处理了。
 *   2. 直接调 getContext().generate('regenerate')（st-context.js:142 暴露的 Generate）
 *   3. 酒馆助手的 triggerSlash('/regenerate')
 *
 * 关于「最后一条是用户消息」这个场景（大纲失败终止生成之后就是这样）：
 *   script.js:4340-4353 里，Generate('regenerate') 遇到最后一条是 user 时
 *   **不删消息**，直接为它生成回复。所以这一条路两种局面都对：
 *   有 AI 回复就重写它，只有用户消息就补一条回复。
 *
 * @returns {Promise<{ok: boolean, how: string, reason: string}>}
 */
export async function regenerateReply() {
    const c = ctx();

    // 1) 酒馆原生斜杠命令
    if (c && typeof c.executeSlashCommandsWithOptions === 'function') {
        try {
            await c.executeSlashCommandsWithOptions('/regenerate');
            return { ok: true, how: '/regenerate', reason: '' };
        } catch (e) {
            logWarn('走 /regenerate 触发正文生成失败，改试其它入口: ' + errorText(e), 'env');
        }
    }

    // 2) 酒馆的 Generate
    if (c && typeof c.generate === 'function') {
        try {
            const r = c.generate('regenerate');
            // Generate 是长活：不让它的 rejection 变成未捕获的 Promise
            if (r && typeof r.then === 'function') r.then(null, () => { });
            return { ok: true, how: 'generate(regenerate)', reason: '' };
        } catch (e) {
            logWarn('直接调酒馆 Generate 失败，改试其它入口: ' + errorText(e), 'env');
        }
    }

    // 3) 酒馆助手
    const th = tavernHelper();
    if (th && typeof th.triggerSlash === 'function') {
        try {
            await th.triggerSlash('/regenerate');
            return { ok: true, how: 'triggerSlash', reason: '' };
        } catch (e) {
            logWarn('酒馆助手 triggerSlash 失败: ' + errorText(e), 'env');
        }
    }

    return { ok: false, how: '', reason: '这个酒馆没有可用的「重新生成」入口' };
}

// ============================================================
// 「新开一页」：把正文写到新的一页上（酒馆原生的 swipe / 翻页）
// ============================================================
//
// 为什么不能靠 /regenerate 保留旧版：
//   Generate('regenerate') 在 script.js:4344-4354 是**先把最后一条 AI 消息
//   从 chat 里删掉**再重新生成（saveReply 于是走 6682 那个「新消息」分支）。
//   旧正文连同它的 swipes 一起没了 —— 所以页数永远停在 1/1。
//
// 酒馆里「不同回答各占一页、右下角 1/2」是 swipe 机制，只有**在最后一页继续
// 右划**这条路会新开一页：
//   · script.js:10336-10357 的 overswipe 分支：越过最后一页时按
//     getOverswipeBehavior（9178）判定，普通 AI 回复 = REGENERATE
//     → Generate('swipe')；
//   · 保存时 saveReply 的 `type === 'swipe'` 分支（6612-6637）只做
//     swipes.length++ 并往**新槽位**里写 —— 旧页一个字都不动；
//   · addOneMessage 顺手刷新右下角的页数（9186 的注释说计数由它更新）。
//
// 所以这里只表达「从这条消息的最后一页再往右划一页」这个意图，建 swipes /
// syncMesToSwipe / overswipe 判定 / 中止回滚全部交给酒馆自己做：
// endSwipe 在 script.js:9992-10022 会把越界的 swipe_id 回滚，中止时不会
// 在聊天里留下半个空页。酒馆版本变了也不用改这里。

/** 最后一条「可以翻页」的 AI 回复；没有（空聊天 / 用户消息 / 小系统消息）返回 null */
export function lastSwipeableMessage() {
    const c = ctx();
    const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
    if (!chat.length) return null;
    const last = chat[chat.length - 1];
    if (!last || last.is_user || last.is_system) return null;
    if (last.extra && (last.extra.isSmallSys || last.extra.swipeable === false)) return null;
    return last;
}

/**
 * 在**新的一页**上重新生成最后一条回复（旧版留在前面的页里）。
 *
 * @returns {{ok: boolean, kind: string, how: string, reason: string,
 *            page: number, pages: number}}
 *   kind 说明走不通的原因（调用方据此决定怎么措辞）：
 *     no-target   最后一条不是可翻页的 AI 回复（比如是用户消息）
 *     no-api      这个酒馆没暴露 swipe 接口
 *     busy        上一次翻页还没结束（动画或生成中）
 *     not-allowed 酒馆现在不允许翻页（正在生成 / 设置里关掉了滑动）
 *     not-taken   酒馆没接下这次翻页（DOM 里找不到这条消息等）
 *     threw       调酒馆的翻页入口直接抛了异常
 *   page/pages：新的是第几页、原来有几页（给提示语用）
 */
export function swipeReplyToNewPage() {
    const c = ctx();
    const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
    const last = lastSwipeableMessage();
    if (!last) {
        return {
            ok: false, kind: 'no-target', how: '', reason: '最后一条不是可以翻页的 AI 回复',
            page: 0, pages: 0,
        };
    }

    const swipe = c && c.swipe;
    if (!swipe || typeof swipe.to !== 'function') {
        return {
            ok: false, kind: 'no-api', how: '', reason: '这个酒馆没有暴露 swipe 接口',
            page: 0, pages: 0,
        };
    }
    // 上一次翻页还在路上（动画或生成中）：这一轮不能再点一次。
    // 否则会退回 /regenerate 去和生成锁抢道 —— 那条路等超时后什么都不做，
    // 而我们却报了「已发起」，正是这个插件一直不肯干的那种假成功。
    if (typeof swipe.state === 'function' && swipe.state() !== 'none') {
        return {
            ok: false, kind: 'busy', how: '', reason: '上一页还在生成中，等这一轮写完再点',
            page: 0, pages: 0,
        };
    }
    // 酒馆自己的闸门：正在生成、设置里关掉了滑动、上一次翻页还没结束都会为 false
    if (typeof swipe.isAllowed === 'function' && !swipe.isAllowed()) {
        return {
            ok: false, kind: 'not-allowed', how: '',
            reason: '酒馆现在不允许翻页（正在生成，或设置里关掉了滑动）',
            page: 0, pages: 0,
        };
    }

    // ★ 目标页 = 现有页数 + 1。传 forceSwipeId 是为了「即使正停在第 1 页也追加
    //   新的一页」，而不是像手动点右箭头那样「后面还有旧页就先翻过去、不生成」。
    //   这条回复从没被翻过页（没有 swipes）时不传：酒馆会自己建 [原文] 再越过它
    //   （script.js:10282-10293 与 ensureSwipes），与手动点箭头完全同路。
    const pages = (Array.isArray(last.swipes) && last.swipes.length) ? last.swipes.length : 1;
    const params = { message: last, forceMesId: chat.length - 1 };
    if (Array.isArray(last.swipes)) params.forceSwipeId = last.swipes.length;

    try {
        const p = swipe.to(null, 'right', params);
        // 翻页是长活（它内部要等这一轮生成结束），不让它的 rejection 变成未捕获的 Promise
        if (p && typeof p.then === 'function') p.then(null, () => { });
    } catch (e) {
        return {
            ok: false, kind: 'threw', how: '',
            reason: '调酒馆的翻页入口失败: ' + errorText(e), page: 0, pages: 0,
        };
    }

    // 真的接活了没有：swipe() 只在过了所有闸门、真要开始时才把内部状态设成
    // 'swiping'（script.js:9935），之前那些 return（消息不可翻页 / DOM 里找不到
    // 这条消息 / 正忙）都不会设 —— 所以调用后**同步**读一次就能知道有没有被拦掉。
    // 读不到这个状态的老酒馆就不追究了（当作接下了）。
    if (typeof swipe.state === 'function' && swipe.state() !== 'swiping') {
        return {
            ok: false, kind: 'not-taken', how: '', reason: '酒馆没有接下这次翻页',
            page: 0, pages: 0,
        };
    }

    return { ok: true, kind: '', how: 'swipe(right)', reason: '', page: pages + 1, pages };
}

/**
 * 面板「以此大纲再次生成正文」的入口：**优先新开一页**（旧版留着、能翻回去看），
 * 走不通才退回原来的 /regenerate（那一路会覆盖旧版）。
 *
 * 两种「走不通」性质完全不同，措辞必须分开：
 *   · no-target（最后一条是用户消息，比如大纲失败被终止、消息留在聊天里）
 *     是**正常**局面：本来就没有可翻页的回复，为它生成一条新回复正是该做的事；
 *   · 其余（酒馆关了滑动 / 没暴露接口 / 没接下）是真降级 —— 这一轮会覆盖旧版。
 *
 * @returns {Promise<{ok: boolean, mode: 'swipe'|'regenerate'|'none', how: string,
 *                    reason: string, note: string, kind: string, normal: boolean,
 *                    page: number, pages: number}>}
 */
export async function regenerateReplyAsNewSwipe() {
    const r = swipeReplyToNewPage();
    if (r.ok) {
        logInfo(`这一轮新开一页：正文写到第 ${r.page} 页，旧版留在前面 ${r.pages} 页里（右边箭头可以翻回去）`, 'run');
        return {
            ok: true, mode: 'swipe', how: r.how, reason: '', note: '',
            kind: '', normal: false, page: r.page, pages: r.pages,
        };
    }

    const normal = (r.kind === 'no-target');
    if (r.kind === 'busy') {
        // 上一轮翻页还没结束：不重复触发，也不假装 —— 锁定留着，等它写完再点就是。
        logWarn('上一次翻页还没结束，这一轮不重复触发（锁定留着，等这一轮写完再点按钮）', 'run');
        return {
            ok: false, mode: 'none', how: '', reason: r.reason, note: '',
            kind: r.kind, normal: false, page: 0, pages: 0,
        };
    }
    if (normal) {
        logInfo('最后一条不是可翻页的回复（多半是用户消息），这一轮按正常流程生成新回复', 'run');
    } else {
        logWarn(`没能新开一页（${r.reason}），退回「重新生成」：这一轮会覆盖旧版`, 'env');
    }

    const f = await regenerateReply();
    return {
        ok: f.ok, mode: 'regenerate', how: f.how, reason: f.reason,
        note: r.reason, kind: r.kind, normal, page: 0, pages: 0,
    };
}

/** 估算 token。CJK 约 1 字 ≈ 0.95 token，ASCII 约 4 字符 ≈ 1 token。 */
export function estimateTokens(text) {
    const s = String(text == null ? '' : text);
    if (!s) return 0;
    let cjk = 0;
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if ((code >= 0x2e80 && code <= 0x9fff) ||
            (code >= 0xf900 && code <= 0xfaff) ||
            (code >= 0xff00 && code <= 0xffef)) cjk++;
    }
    return Math.round(cjk * 0.95 + (s.length - cjk) / 4);
}

/** 尽量用酒馆自己的 tokenizer；失败退回估算。 */
export async function countTokens(text) {
    const c = ctx();
    if (c && typeof c.getTokenCountAsync === 'function') {
        const r = await safeAsync('countTokens', () => c.getTokenCountAsync(String(text || '')), null);
        if (typeof r === 'number' && r > 0) return r;
    }
    return estimateTokens(text);
}

// ============================================================
// 文本与 HTML 小工具
// ============================================================

/** HTML 转义。所有把用户/模型内容插进 innerHTML 的地方都必须过这个。 */
export function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 数字格式化：1234 → 1.2k */
export function fmtNum(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(v);
}

/** 数字格式化：百分比 */
export function fmtPct(from, to) {
    const a = Number(from) || 0;
    if (!a) return '0%';
    return Math.round((1 - (Number(to) || 0) / a) * 100) + '%';
}

/** 简单 toast，酒馆的 toastr 不在就直接 console */
export function toast(msg, level = 'info') {
    try {
        if (typeof toastr !== 'undefined' && toastr) {
            if (level === 'error' && toastr.error) toastr.error(msg);
            else if (level === 'warn' && toastr.warning) toastr.warning(msg);
            else if (level === 'success' && toastr.success) toastr.success(msg);
            else if (toastr.info) toastr.info(msg);
            return;
        }
    } catch (e) { /* ignore */ }
    // 兜底时按级别原样记，别再统一压成 info（那会让 warn 在日志里看不出来）
    const lvl = (level === 'error') ? 'error' : (level === 'warn' ? 'warn' : 'info');
    log(msg, lvl, 'env');
}
