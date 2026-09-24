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

const MAX_LINES = 500;
const lines = [];
const subscribers = new Set();

/**
 * 记一条日志。
 * @param {string} msg
 * @param {'info'|'warn'|'error'|'ok'} [level]
 * @param {string} [scope] 来源模块名，便于定位
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

/** 某个能力是否可用 */
export function can(key) {
    if (!Object.keys(caps).length) probe();
    return caps[key] === true;
}

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

/** 正则元字符转义。原版的标签白名单没做这一步，标签名含 ( ) + 时直接抛异常。 */
export function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    log(msg, level === 'error' ? 'error' : 'info', 'toast');
}
