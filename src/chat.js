/**
 * chat.js — 聊天记录读取 + 正则压缩 + 体积统计
 * ============================================================
 * 供大纲模型使用。核心是「便宜模型读全量聊天」这条路线，
 * 所以要尽量把噪声正则去掉，同时如实统计压缩收益。
 *
 * 关于正则：
 *   酒馆正则引擎在 public/scripts/extensions/regex/engine.js 里，
 *   导出 getRegexedString / regex_placement。酒馆助手正是从这里
 *   import 的（见 JS-Slash-Runner/src/function/tavern_regex.ts:19）。
 *   但那属于酒馆内部模块，官方不允许扩展直接引用，版本一升就可能崩。
 *   所以本版：
 *     首选 window.TavernHelper.formatAsTavernRegexedString（官方封装）
 *     拿不到就【跳过压缩】并在面板上明确写出来，
 *     绝不静默地假装压缩过了 —— 原版就是这样骗自己的。
 */

import {
    ctx, tavernHelper, chatArray,
    logInfo, logWarn, safe, estimateTokens, fmtPct,
} from './env.js';

/**
 * 取聊天记录（原始楼层对象）。
 * @returns {Array}
 */
export function getChat() {
    const direct = chatArray();
    if (direct.length) return direct;
    const c = ctx();
    if (c && Array.isArray(c.chat)) return c.chat;
    return [];
}

/**
 * 判断一条楼层是不是用户发的。
 * 按酒馆助手类型定义里的说明：
 *   system : extra?.type === 'narrator' && !is_user
 *   user   : extra?.type !== 'narrator' && is_user
 *   assistant: 其余
 */
function classify(msg) {
    if (!msg) return 'assistant';
    const isUser = msg.is_user === true;
    const isNarrator = !!(msg.extra && msg.extra.type === 'narrator');
    if (isNarrator && !isUser) return 'system';
    return isUser ? 'user' : 'assistant';
}

function messageText(msg) {
    if (!msg) return '';
    if (typeof msg.mes === 'string') return msg.mes;
    if (typeof msg.message === 'string') return msg.message;
    return '';
}

/**
 * 取所有可见楼层。跳过隐藏楼层和 nsfw 标记等 —— 只保留真正会进上下文的。
 * @returns {Array<{idx:number, role:'user'|'assistant'|'system', text:string}>}
 */
export function getVisibleFloors() {
    const chat = getChat();
    const out = [];
    chat.forEach((msg, idx) => {
        if (!msg) return;
        if (msg.is_system === true) return;   // 隐藏楼层不发给模型
        const text = messageText(msg);
        if (!text) return;
        out.push({ idx, role: classify(msg), text, raw: msg });
    });
    return out;
}

// ============================================================
// 正则压缩
// ============================================================

/** 正则格式化器是否可用 */
export function regexAvailable() {
    const th = tavernHelper();
    return !!(th && typeof th.formatAsTavernRegexedString === 'function');
}

/**
 * 对单条文本应用酒馆正则。
 * 逐条按来源正确处理：用户楼层走 user_input，其余走 ai_output，
 * 目标为 prompt（与真实发给模型的形态一致）。
 *
 * ⚠️ 原版的问题：把整段拼接好的历史当成 ai_output 整体过一遍，
 * 用户输入也被当成 AI 输出；而且传了 depth:0，
 * 但 depth 的语义是「文本所在深度」，历史里每条深度都不同。
 *
 * ★ depth 这件事的现状（v3.7.9 之前一直是这样，别再改错）：
 *   现在**不传** depth。酒馆助手的类型文件把这件事写得很清楚
 *   （@types/function/tavern_regex.d.ts:2）：
 *     「不填则不考虑酒馆正则的 depth 选项：
 *       无论该深度是否在最小深度和最大深度范围内都生效」
 *   也就是带「最小/最大深度」的正则在这里**对每一层都执行**。
 *   而酒馆自己拼提示词时是逐层传深度的
 *   （script.js:4442-4447，depth = coreChat.length - index - 1），
 *   所以同一份聊天，两边压出来的东西可以差好几倍。
 *   → 后果与对比数字见 diag.js / 面板「状态」页的「聊天记录压缩」一行。
 */
export function regexFloor(text, isUser, depth) {
    const th = tavernHelper();
    if (!th || typeof th.formatAsTavernRegexedString !== 'function') return text;
    const opt = (typeof depth === 'number') ? { depth } : undefined;
    const r = safe('regex', () => th.formatAsTavernRegexedString(
        text,
        isUser ? 'user_input' : 'ai_output',
        'prompt',
        opt,
    ), null);
    return (typeof r === 'string') ? r : text;
}

/**
 * 构造给大纲模型的聊天记录文本。
 * @param {{compress?: boolean, quiet?: boolean}} [opt] quiet=true 时不写日志
 *        （面板刷新会频繁调用，日志不能被刷屏）
 * @returns {{
 *   text: string,            // 最终文本（压缩后或原始）
 *   rawText: string,         // 原始拼接，用于对比
 *   compressed: boolean,     // 是否真的压缩了
 *   floors: number,          // 可见楼层数
 *   rawChars: number,
 *   finalChars: number,
 *   savedPct: string,
 *   tokens: number,
 *   regexErrors: number,
 *   reason: string           // 未压缩时的原因
 * }}
 */
export function buildHistory(opt = {}) {
    const wantCompress = opt.compress !== false;
    const quiet = opt.quiet === true;
    const floors = getVisibleFloors();
    const N = floors.length;

    const rawParts = [];
    const compParts = [];
    let regexErrors = 0;
    let reason = '';

    const canRegex = regexAvailable();
    if (wantCompress && !canRegex) {
        reason = '酒馆助手不可用，无法应用酒馆正则（已跳过压缩）';
        logWarn(reason, 'chat');
    }

    for (let i = 0; i < N; i++) {
        const f = floors[i];
        const who = f.role === 'user' ? 'User' : (f.role === 'system' ? 'Narrator' : 'Assistant');
        const rawLine = `${who}: ${f.text}`;
        rawParts.push(rawLine);

        if (wantCompress && canRegex) {
            try {
                /**
                 * ★ depth 必须逐层传（v3.9.0 修的）。
                 *   depth 的语义是「这条文本在第几层」：0 = 最后一条，
                 *   1 = 倒数第二条…… 酒馆拼提示词就是这么传的
                 *   （script.js:4445：depth = coreChat.length - index - 1），
                 *   而酒馆正则引擎只在 `typeof depth === 'number'` 时才做
                 *   最小/最大深度判定（regex/engine.js:362）。
                 *
                 *   以前这里**不传** depth，等于把「最小深度 / 最大深度」这两个
                 *   限制整段关掉 —— 带深度限制的正则会对每一层都执行。
                 *   后果不只是「多压一点」：酒馆里那两条方向相反的规则
                 *   （「老楼层只留实时总结」+「最近几层去掉实时总结」）
                 *   会同时作用在同一层上，先只留总结、再把总结删掉 → **整层变空**。
                 *   实测差距：放轻松 7 层，酒馆 2132 字 / 旧口径 336 字。
                 *
                 *   现在两边口径完全一致：大纲模型看到的聊天记录
                 *   = 主模型看到的聊天记录。
                 */
                compParts.push(`${who}: ${regexFloor(f.text, f.role === 'user', N - 1 - i)}`);
            } catch (e) {
                regexErrors++;
                compParts.push(rawLine);
            }
        } else {
            compParts.push(rawLine);
        }
    }

    const rawText = rawParts.join('\n\n');
    const useComp = wantCompress && canRegex;
    const text = useComp ? compParts.join('\n\n') : rawText;

    if (!quiet) {
        logInfo(
            `聊天 ${N} 层｜${useComp ? '正则压缩（逐层带 depth，与酒馆同口径）' : '未压缩'}：` +
            `${rawText.length} → ${text.length} 字（省 ${fmtPct(rawText.length, text.length)}）` +
            (reason ? `｜原因：${reason}` : '') +
            (regexErrors ? `｜正则报错 ${regexErrors} 次` : ''),
            'chat'
        );
    }

    return {
        text,
        rawText,
        compressed: useComp,
        floors: N,
        rawChars: rawText.length,
        finalChars: text.length,
        savedPct: fmtPct(rawText.length, text.length),
        tokens: estimateTokens(text),
        regexErrors,
        reason,
    };
}

// ============================================================
// 带缓存的统计（给面板用）
// ============================================================

let histCache = null;
let histCacheAt = 0;
let histCacheSig = '';

/**
 * 给面板用的聊天记录统计：**压缩后的真实体量**。
 *
 * 为什么要缓存 + 为什么不静默：
 *   面板只要刷新就会问一次（切标签页、动一次开关都会刷新），
 *   而面板以前问的是 chatStats().rawChars —— 那是**原文总量**，
 *   数字永远不会因为正则压缩而变小，看起来就像「正则没生效」。
 *   这里返回真正会拿去拼提示词的那一份的长度，并缓存 2 秒。
 *
 * @param {number} [maxAgeMs=2000]
 */
export function historyStats(maxAgeMs = 2000) {
    const floors = getVisibleFloors();
    // 指纹：楼层数 + 最后一层长度 + 第一层长度。聊天一变就重算。
    const sig = floors.length + '|' +
        (floors.length ? floors[0].text.length : 0) + '|' +
        (floors.length ? floors[floors.length - 1].text.length : 0);

    const now = Date.now();
    if (histCache && histCacheSig === sig && (now - histCacheAt) < maxAgeMs) return histCache;

    const h = buildHistory({ compress: true, quiet: true });
    histCache = {
        floors: h.floors,
        rawChars: h.rawChars,
        finalChars: h.finalChars,
        savedPct: h.savedPct,
        tokens: h.tokens,
        compressed: h.compressed,
        reason: h.reason,
    };
    histCacheAt = now;
    histCacheSig = sig;
    return histCache;
}

/** 清掉缓存（测试与「换聊天」时用） */
export function clearHistoryStats() {
    histCache = null;
    histCacheSig = '';
    histCacheAt = 0;
}

/**
 * 上一轮回复之后新产生的楼层（阶段二做增量大纲时会用到）。
 * @param {number} sinceIdx 从这个楼层号之后开始（不含）
 */
export function getFloorsAfter(sinceIdx) {
    return getVisibleFloors().filter(f => f.idx > sinceIdx);
}

/**
 * 取最后 N 层（阶段二裁剪历史时用）。
 * @param {number} n
 */
export function getLastFloors(n) {
    const all = getVisibleFloors();
    const k = Math.max(1, Math.round(Number(n) || 1));
    return all.slice(Math.max(0, all.length - k));
}

/** 给 UI 的概览 */
export function chatStats() {
    const floors = getVisibleFloors();
    const rawChars = floors.reduce((s, f) => s + f.text.length, 0);
    return {
        floors: floors.length,
        rawChars,
        tokens: estimateTokens(floors.map(f => f.text).join('\n\n')),
        regexAvailable: regexAvailable(),
        lastIdx: floors.length ? floors[floors.length - 1].idx : -1,
    };
}
