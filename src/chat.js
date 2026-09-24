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
 */
function applyRegex(text, isUser) {
    const th = tavernHelper();
    if (!th || typeof th.formatAsTavernRegexedString !== 'function') return text;
    const r = safe('regex', () => th.formatAsTavernRegexedString(
        text,
        isUser ? 'user_input' : 'ai_output',
        'prompt',
        // 不传 depth：不传则不考虑深度限制，让正则自身的深度设置按默认行为生效
    ), null);
    return (typeof r === 'string') ? r : text;
}

/**
 * 构造给大纲模型的聊天记录文本。
 * @param {{compress?: boolean}} [opt]
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
    const floors = getVisibleFloors();

    const rawParts = [];
    const compParts = [];
    let regexErrors = 0;
    let reason = '';

    const canRegex = regexAvailable();
    if (wantCompress && !canRegex) {
        reason = '酒馆助手不可用，无法应用酒馆正则（已跳过压缩）';
        logWarn(reason, 'chat');
    }

    for (const f of floors) {
        const who = f.role === 'user' ? 'User' : (f.role === 'system' ? 'Narrator' : 'Assistant');
        const rawLine = `${who}: ${f.text}`;
        rawParts.push(rawLine);

        if (wantCompress && canRegex) {
            try {
                const c = applyRegex(f.text, f.role === 'user');
                compParts.push(`${who}: ${c}`);
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

    logInfo(
        `聊天 ${floors.length} 层｜${useComp ? '正则压缩' : '未压缩'}：` +
        `${rawText.length} → ${text.length} 字（省 ${fmtPct(rawText.length, text.length)}）` +
        (reason ? `｜原因：${reason}` : '') +
        (regexErrors ? `｜正则报错 ${regexErrors} 次` : ''),
        'chat'
    );

    return {
        text,
        rawText,
        compressed: useComp,
        floors: floors.length,
        rawChars: rawText.length,
        finalChars: text.length,
        savedPct: fmtPct(rawText.length, text.length),
        tokens: estimateTokens(text),
        regexErrors,
        reason,
    };
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
