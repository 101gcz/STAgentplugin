/**
 * trim.js — 主模型请求整形
 * ============================================================
 * 这个文件管三件事，都发生在**同一个钩子**上
 * （CHAT_COMPLETION_PROMPT_READY，成品 messages 拼好、发请求之前）：
 *
 *   一、「只给大纲」的**预设条目**从主模型请求里删掉
 *       给大纲   → 进大纲提示词，同时从主模型请求里移除
 *       给主模型 → 只留给主模型，不进大纲提示词
 *       都给     → 两边都有
 *
 *   二、「只给大纲」的**素材块**（世界书 / 角色卡 / Persona / 对话示例）
 *       同样从主模型请求里删掉（v3.9.0 真正实装）。这三个去向对素材块
 *       是有意义的：酒馆本来就会把世界书、角色卡注入主模型，
 *       插件要「只给大纲」就得自己把它摘掉。
 *
 *   三、**聊天记录**：主模型只留最近 N 轮（默认 1 轮 = 一条 AI 输出 +
 *       你的回复），旧楼层全部删掉。这也正是素材块「聊天记录」=
 *       只给大纲 的承诺 —— 对聊天记录而言「删」只能是「只留最近几轮」，
 *       整段删掉会让主模型连你刚说的话都看不到。见 trimHistoryFloors()。
 *
 * 【为什么能干净地删】
 * 对着酒馆 1.18.0 源码核对过三点：
 *   1. 每个相对位置的预设条目在成品 chat 里各自是一条独立消息
 *      —— populateChatCompletion 对每条 prompt 调
 *         Message.fromPromptAsync → chatCompletion.insert(...)
 *         （openai.js:1256-1259）
 *   2. 那条消息的 content 就是「宏展开后的条目正文」，原样不加工
 *      —— Message.fromPromptAsync(prompt) = createAsync(role, prompt.content, id)
 *         （openai.js:3697-3699），而 prompt.content 在
 *         PromptManager.preparePrompt 里已经过 substituteParams（PromptManager.js:1277）
 *      聊天楼层同理：content 就是那一层过完正则的正文
 *      （script.js:4442-4447，逐层带 depth）
 *   3. 主链路在拼完 messages、发请求之前会发 CHAT_COMPLETION_PROMPT_READY，
 *      eventData.chat 与随后 return 的 chat 是同一个数组引用
 *      （openai.js:1607-1614），就地 splice 就生效
 *
 * 【为什么不用文本替换】
 * 「从合并后的大段文本里抠掉半条」会误伤：世界书、聊天历史里可能
 * 出现同样的字。所以这里只认「整条消息内容与目标正文完全一致」，
 * 认领不到就保留并记日志，绝不猜。
 *
 * 安全边界：
 *   · 插件自己的大纲请求（isGenerating()）一律不动 —— 那是我们拼的 prompt
 *   · 最后一条 user 消息（用户真实输入）永不删除
 *   · 总开关关着时直接返回，不做任何改动
 *   · 历史裁剪另有上限：删掉的消息条数绝不超过「该裁的楼层数」
 */

import { TARGET, SYSTEM_BLOCKS } from './constants.js';
import { ctx, logInfo, logWarn, expandMacros, errorText, fmtNum } from './env.js';
import { get as getSettings, blockConfigOf } from './settings.js';
import { readPreset } from './preset.js';
import { isGenerating } from './outline.js';
import { getVisibleFloors, regexFloor } from './chat.js';
import { latestWorldInfo, charCardBlock, personaBlock, examplesBlock } from './blocks.js';

/** 最近一次整形结果，给面板和日志用 */
let lastTrim = null;

/**
 * 被放行的「插件自己的请求」次数。
 * ============================================================
 * ★ 为什么不把这类轮次写进 lastTrim：
 *   插件自己的大纲请求也会走同一个钩子（generateRaw → 主链路），
 *   以前这里直接 `lastTrim = {skipped:'本轮是插件自己的大纲请求'}` ——
 *   于是每次生成**结束后**，面板上的「主模型请求整形」那一行
 *   显示的都是「上次未改动：本轮是插件自己的大纲请求」，
 *   把真正的结果（删了几条、省了多少字）覆盖掉了。
 *   v3.9.0 起：自有请求只计数，不覆盖主请求的结果。
 */
let ownSkips = 0;

/** 自有请求被放行的次数 */
export function ownSkipCount() { return ownSkips; }

export function lastTrimStats() { return lastTrim; }

/** 挂监听。boot 时调一次。@returns {null|(()=>void)} */
export function installMainTrim() {
    const c = ctx();
    const source = c && c.eventSource;
    const types = c && c.eventTypes;
    if (!source || !types || !types.CHAT_COMPLETION_PROMPT_READY || typeof source.on !== 'function') {
        logWarn('拿不到 CHAT_COMPLETION_PROMPT_READY，「只给大纲」的条目将无法从主模型请求里移除', 'trim');
        return null;
    }

    const handler = (eventData) => {
        try {
            trimMainRequest(eventData);
        } catch (e) {
            // 整形失败绝不能影响正常生成：原样放行
            logWarn('主模型请求整形失败（已原样放行）: ' + errorText(e), 'trim');
        }
    };

    try {
        source.on(types.CHAT_COMPLETION_PROMPT_READY, handler);
    } catch (e) {
        logWarn('注册 CHAT_COMPLETION_PROMPT_READY 失败: ' + errorText(e), 'trim');
        return null;
    }
    logInfo('已挂上主模型请求整形（「只给大纲」的条目会被移除）', 'trim');
    return () => { try { source.removeListener(types.CHAT_COMPLETION_PROMPT_READY, handler); } catch (e) { /* ignore */ } };
}

/** 消息内容的纯文本形态；非字符串/非文本数组返回 null（不参与匹配） */
function messageText(msg) {
    if (!msg) return null;
    const c = msg.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
        const parts = c.map(x => (x && typeof x.text === 'string') ? x.text : '');
        return parts.join('');
    }
    return null;
}

/**
 * 一个条目可能对应的文本形态。
 * 酒馆给条目做的是 substituteParams，和我们 expandMacros 的首选路径一致，
 * 但为了容忍换行 / 空白差异，这里多给几个等价写法。
 */
function candidateTexts(entry) {
    const set = new Set();
    const add = (s) => {
        const t = String(s == null ? '' : s).replace(/\r\n/g, '\n').trim();
        if (t) set.add(t);
    };
    const raw = String(entry.content || '');
    add(raw);
    try { add(expandMacros(raw)); } catch (e) { /* 宏展开失败就用原文 */ }
    return Array.from(set);
}

/**
 * 找白名单里「只给大纲」且勾上的条目。
 * @returns {Array} 预设条目对象
 */
export function outlineOnlyEntries(sIn) {
    const s = sIn || getSettings();
    const preset = readPreset();
    const byPreset = s.presetWhitelist[preset.name] || {};
    return preset.prompts.filter(p => {
        const cfg = byPreset[p.name];
        if (!p.hasContent || !p.enabled) return false;          // 无正文 / 酒馆里已关闭
        if (!cfg || cfg.enabled !== true) return false;         // 白名单里没勾
        return (cfg.target || TARGET.BOTH) === TARGET.OUTLINE;  // 只给大纲
    });
}

/**
 * 就地把「只给大纲」的条目从主模型请求里删掉。
 *
 * 还会顺带执行**阶段二的历史裁剪**（`trimHistory` 开关，默认关）——
 * 两者都在同一个钩子上做，因为它们动的是同一个数组，顺序必须是
 * 「先删条目，再裁历史」：条目的认领靠整条精确匹配，历史也是；
 * 先把条目清掉，剩下的同文消息就只会是楼层。
 *
 * @param {{chat?: any[], dryRun?: boolean}} eventData
 * @returns {{removed:number, removedChars:number, names:string[], missed:string[], skipped:string, history:object|null}}
 */
export function trimMainRequest(eventData) {
    const stats = {
        removed: 0, removedChars: 0, names: [], missed: [],
        skipped: '', blocks: null, history: null, at: Date.now(),
    };

    if (!eventData || !Array.isArray(eventData.chat)) {
        stats.skipped = 'chat 不是数组';
        lastTrim = stats;
        return stats;
    }
    if (isGenerating()) {
        // 插件自己发的大纲请求 —— 一个字都不动，也**不覆盖**主请求的结果
        ownSkips++;
        stats.skipped = '本轮是插件自己的大纲请求';
        return stats;
    }

    const s = getSettings();
    if (!s.enabled) {
        stats.skipped = '插件总开关关着';
        lastTrim = stats;
        return stats;
    }

    // ---- 一、预设条目：「只给大纲」的从主模型请求里删掉 ----
    const targets = outlineOnlyEntries(s);
    if (!targets.length) {
        // 没勾任何「只给大纲」的条目也很正常 —— 别的部分照样要跑
        stats.skipped = '没有勾选「只给大纲」的条目';
    } else {
        trimEntries(eventData.chat, targets, stats);
    }

    // ---- 二、素材块：「只给大纲」的也从主模型请求里删掉（v3.9.0 真正实装）----
    // 四个元数据块（世界书 / 角色卡 / Persona / 对话示例）是一整条独立消息，
    // 按整条正文认领后删除；聊天记录不能用同一招（见 trimHistoryFloors）。
    try {
        stats.blocks = trimOutlineOnlyBlocks(eventData.chat, s);
    } catch (e) {
        logWarn('素材块整形失败（已原样放行）: ' + errorText(e), 'trim');
        stats.blocks = { removed: 0, removedChars: 0, names: [], missed: [] };
    }

    // ---- 三、聊天记录按轮裁剪（「只给大纲」隐含生效；也可用开关单独打开）----
    if (wantTrimHistory(s)) {
        try {
            stats.history = trimHistoryFloors(eventData, s);
        } catch (e) {
            // 裁剪失败绝不能影响正常生成：原样放行，并把原因喊出来
            logWarn('历史裁剪失败（已原样放行，本轮历史没被裁）: ' + errorText(e), 'trim');
            stats.history = { removed: 0, removedChars: 0, skipped: '出错：' + errorText(e) };
        }
    }

    if (stats.removed) {
        logInfo(`主模型请求｜已移除 ${stats.removed} 条「只给大纲」的条目｜省 ${stats.removedChars} 字｜` +
            stats.names.join('、'), 'trim');
    }
    if (stats.missed.length) {
        logWarn(`主模型请求｜${stats.missed.length} 条「只给大纲」的条目没能在请求里精确匹配，已原样保留：` +
            stats.missed.join('、') + '（可能被酒馆合并进了别的消息，或条目正文与展开结果不一致）', 'trim');
    }

    lastTrim = stats;
    return stats;
}

// ============================================================
// 素材块：「只给大纲」→ 从主模型请求里删掉
// ============================================================

/**
 * 当前预设下，某个素材块是不是「开着 + 只给大纲」。
 * 这就是「去向」三档里的第一档 —— 面板上写着「条目还会从主模型请求里删掉」，
 * 所以这里必须真的删，不能只是标记。
 */
export function isOutlineOnlyBlock(sIn, key) {
    const s = sIn || getSettings();
    let cfg;
    try {
        cfg = blockConfigOf(s, readPreset().name)[key];
    } catch (e) {
        return false;
    }
    if (!cfg || cfg.enabled === false) return false;
    return (cfg.target || TARGET.OUTLINE) === TARGET.OUTLINE;
}

/**
 * 「聊天记录」这块要不要裁主模型的历史。
 *   素材块说「只给大纲」→ 承诺了不让主模型读它 → 裁
 *   独立开关 trimHistory → 也裁
 * 两者任一成立就裁；保留多少轮由 trimKeepRounds 决定。
 */
export function wantTrimHistory(sIn) {
    const s = sIn || getSettings();
    if (s.trimHistory === true) return true;
    return isOutlineOnlyBlock(s, 'history');
}

/**
 * 把一个块的所有可能正文形态列出来（用于整条认领）。
 * @returns {string[]}
 */
function blockCandidates(key) {
    const out = [];
    const add = (t) => {
        const v = String(t == null ? '' : t).replace(/\r\n/g, '\n').trim();
        if (v.length >= 8) out.push(v);
    };
    try {
        if (key === 'worldInfo') {
            const w = latestWorldInfo();
            const joined = String(w.text || '').trim();
            add(joined);
            // 酒馆是逐条注入的，同一批条目也可能被拼成一条 —— 逐条也要认
            for (const e of joined.split('\n\n')) add(e);
        } else if (key === 'charCard') {
            const c = charCardBlock();
            add(c.text);
            for (const part of String(c.text || '').split('\n\n')) {
                add(part);
                add(part.replace(/^【[^】]*】\s*/, ''));   // 去掉插件自己加的【标题】
            }
        } else if (key === 'persona') {
            add(personaBlock().text);
        } else if (key === 'examples') {
            add(examplesBlock().text);
        }
    } catch (e) { /* 取不到就当没有可认领的正文 */ }
    return out;
}

/**
 * 这条消息是不是「就是那一块内容」（酒馆可能在前后加了标签/分隔）。
 * 判据：把候选正文抠掉之后，剩下的只能是空白或很短的标签。
 * 绝不靠「包含」就删 —— 世界书正文常常也出现在聊天楼层里。
 */
function messageIsOnly(text, cands) {
    const t = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
    if (!t) return false;
    let best = '';
    for (const c of cands) {
        if (t === c) return true;
        if (c.length > best.length && t.includes(c)) best = c;
    }
    if (!best) return false;
    const rest = t.split(best).join(' ').trim();
    if (rest.length > 32) return false;
    // 剩下的不许是一大段中文（那就是别的内容了）
    return !/[\u4e00-\u9fff]{5,}/.test(rest);
}

/**
 * 把「只给大纲」的**素材块**从主模型请求里删掉。
 *
 * 覆盖的块：世界书 / 角色卡 / Persona / 对话示例。
 * 聊天记录**不走这里** —— 它是一条条楼层消息，删法见 trimHistoryFloors()
 * （整块删掉会让主模型连你刚说的话都看不到）。
 *
 * @param {any[]} chat
 * @param {object} s
 * @returns {{removed:number, removedChars:number, names:string[], missed:string[]}}
 */
export function trimOutlineOnlyBlocks(chat, sIn) {
    const s = sIn || getSettings();
    const st = { removed: 0, removedChars: 0, names: [], missed: [] };

    const keys = SYSTEM_BLOCKS
        .map(b => b.key)
        .filter(k => k !== 'history')      // 聊天记录另走一路
        .filter(k => isOutlineOnlyBlock(s, k));

    if (!keys.length || !Array.isArray(chat)) return st;

    // 保护最后一条 user
    let protectedMsg = null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && chat[i].role === 'user') { protectedMsg = chat[i]; break; }
    }

    for (const key of keys) {
        const label = (SYSTEM_BLOCKS.find(b => b.key === key) || {}).short || key;
        const cands = blockCandidates(key);
        if (!cands.length) { st.missed.push(label + '（取不到正文）'); continue; }

        const hits = [];
        for (let i = 0; i < chat.length; i++) {
            if (chat[i] === protectedMsg) continue;
            const text = messageText(chat[i]);
            if (text == null) continue;
            if (messageIsOnly(text, cands)) hits.push(i);
        }

        if (!hits.length) {
            st.missed.push(label);
            continue;
        }
        for (let k = hits.length - 1; k >= 0; k--) {
            const i = hits[k];
            st.removedChars += String(messageText(chat[i]) || '').length;
            chat.splice(i, 1);
            st.removed++;
        }
        st.names.push(label);
    }

    if (st.removed) {
        logInfo(`主模型请求｜已移除 ${st.removed} 条「只给大纲」的素材块｜省 ${fmtNum(st.removedChars)} 字｜` +
            st.names.join('、'), 'trim');
    }
    if (st.missed.length) {
        logWarn(`主模型请求｜${st.missed.length} 个「只给大纲」的素材块没能在请求里认领到，已原样保留：` +
            st.missed.join('、') + '（酒馆可能把它和别的东西合并进同一条消息了）', 'trim');
    }
    return st;
}

/**
 * 把「只给大纲」的条目从 chat 数组里就地删掉（阶段一，一直都有）。
 * @param {any[]} chat
 * @param {Array} targets outlineOnlyEntries() 的结果
 * @param {object} stats 就地累加
 */
function trimEntries(chat, targets, stats) {
    // 保护：最后一条 user 是用户的真实输入，永远不动。
    // ★ 必须按「对象引用」保护，不能记下标 —— 删除会让后面的下标整体前移，
    //   记下来的下标会指到别的消息上（这个坑是离线自检抓出来的）。
    let protectedMsg = null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && chat[i].role === 'user') { protectedMsg = chat[i]; break; }
    }

    for (const p of targets) {
        const cands = candidateTexts(p);
        if (!cands.length) { stats.missed.push(p.name + '（条目正文为空）'); continue; }

        const hits = [];
        for (let i = 0; i < chat.length; i++) {
            if (chat[i] === protectedMsg) continue;
            const text = messageText(chat[i]);
            if (text == null) continue;
            const norm = text.replace(/\r\n/g, '\n').trim();
            if (cands.includes(norm)) hits.push(i);
        }

        if (!hits.length) {
            stats.missed.push(p.name);
            continue;
        }

        // 从后往前删，避免下标位移
        for (let k = hits.length - 1; k >= 0; k--) {
            const i = hits[k];
            stats.removedChars += String(messageText(chat[i]) || '').length;
            chat.splice(i, 1);
            stats.removed++;
        }
        stats.names.push(p.name);
    }
}

// ============================================================
// 裁剪发给主模型的历史：只留最近 N 轮
// ============================================================

/**
 * 把「最近 N 轮对话」之前的楼层从**主模型请求**里删掉。
 * ============================================================
 * 「一轮」= 一条 AI 输出 + 它之后你说的那些话。默认保留 1 轮，
 * 也就是主模型最终只读到：
 *
 *     最近一条 AI 回复 + 你这一句  +  插件注入的大纲
 *
 * 这就是这个插件省钱的原理：旧剧情全部由大纲承担（大纲是便宜模型
 * 读完整聊天记录写出来的），贵模型只需要「接着最近这一轮往下写」。
 * 按「层」算会很难用（一轮到底是 2 层还是 3 层取决于有没有旁白、
 * 有没有连发），所以 v3.9.0 起按轮算。
 *
 * 什么时候会裁（wantTrimHistory）：
 *   · 素材块「聊天记录」的去向 = 只给大纲（默认）→ 自动裁
 *   · 或者独立开关 trimHistory 打开
 *
 * ★ 四条硬约束，一个都不能违反：
 *
 *  1. **时机**：必须等世界书扫完之后再裁。
 *     靠「很久以前出现过的关键词」激活的条目，是先看完整历史才判定的；
 *     先裁历史再扫，蓝绿灯判定就全变了，主模型会突然丢设定。
 *     本函数挂在 CHAT_COMPLETION_PROMPT_READY 上 —— 那是
 *     populateChatCompletion 拼完 messages、世界书早已注入完之后
 *     （openai.js:1607-1614），时机正确。
 *
 *  2. **只认领，不猜**：整条正文与「该层按酒馆口径过完正则的文本」完全一致才删。
 *     认领不到的一律保留并报数。副作用：如果酒馆在消息里加了名字前缀
 *     （names 行为不是「无」），这里会一条都认领不到 → 会明确报出来，
 *     而不是静默什么都不做。
 *
 *  3. **最后一条 user 永不删**（用户这一轮的真实输入）。
 *
 *  4. **上限**：删掉的条数绝不超过「该裁的楼层数」——
 *     万一某段文字在系统提示词里也出现过，这条闸门能挡住误删。
 *
 * @param {{chat:any[]}} eventData
 * @param {object} s settings.get() 的结果
 * @returns {{removed:number, removedChars:number, missed:number, rounds:number,
 *            totalFloors:number, keptFloors:number, droppedFloors:number, skipped:string}}
 */
export function trimHistoryFloors(eventData, sIn) {
    const s = sIn || getSettings();
    const out = {
        removed: 0, removedChars: 0, missed: 0,
        rounds: 0, totalFloors: 0, keptFloors: 0, droppedFloors: 0, skipped: '',
    };
    const chat = eventData && eventData.chat;
    if (!Array.isArray(chat)) { out.skipped = 'chat 不是数组'; return out; }

    const roundsRaw = Math.round(Number(s.trimKeepRounds));
    const rounds = isFinite(roundsRaw) ? Math.max(1, Math.min(100, roundsRaw)) : 1;
    out.rounds = rounds;

    const floors = getVisibleFloors();
    const N = floors.length;
    out.totalFloors = N;
    if (!N) { out.skipped = '聊天为空'; return out; }

    /**
     * 找「最近 rounds 轮的起点」：
     * 从后往前数 AI（非 user）楼层，数到第 rounds 条就是起点，
     * 起点及它之后全部保留 —— 这样「一条 AI + 它的回复」就是一轮。
     */
    let seen = 0;
    let start = 0;
    for (let i = N - 1; i >= 0; i--) {
        if (floors[i].role !== 'user') {
            seen++;
            if (seen === rounds) { start = i; break; }
        }
    }
    if (seen < rounds) start = 0;      // 轮数还不够，整段都留着

    out.keptFloors = N - start;
    out.droppedFloors = start;

    if (start <= 0) {
        out.skipped = `只有 ${seen} 轮对话 ≤ 保留 ${rounds} 轮，不用裁`;
        return out;
    }

    /** 归一化：和酒馆一样只处理换行与首尾空白 */
    const norm = (x) => String(x == null ? '' : x).replace(/\r\n/g, '\n').trim();

    // 保留的那几层的文本：既用来避免误删，也兜底「同一段文字出现两次」
    const keepSet = new Set();
    for (let i = start; i < N; i++) {
        const f = floors[i];
        const isUser = f.role === 'user';
        keepSet.add(norm(f.text));
        keepSet.add(norm(regexFloor(f.text, isUser, N - 1 - i)));
    }

    // 要裁掉的旧楼层：正则后的与原文两种形态都算候选
    const dropSet = new Set();
    for (let i = 0; i < start; i++) {
        const f = floors[i];
        const isUser = f.role === 'user';
        const d = N - 1 - i;
        const t1 = norm(regexFloor(f.text, isUser, d));
        const t2 = norm(f.text);
        if (t1.length >= 4 && !keepSet.has(t1)) dropSet.add(t1);
        if (t2.length >= 4 && !keepSet.has(t2)) dropSet.add(t2);
    }

    if (!dropSet.size) {
        out.skipped = '旧楼层正文太短，没有可认领的目标';
        return out;
    }

    // 保护最后一条 user（用户这一轮的真实输入）
    let protectedMsg = null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && chat[i].role === 'user') { protectedMsg = chat[i]; break; }
    }

    // 从后往前扫，就地删；上限 = 该裁的楼层数
    const limit = start;
    for (let i = chat.length - 1; i >= 0 && out.removed < limit; i--) {
        const m = chat[i];
        if (!m || m === protectedMsg) continue;
        const text = messageText(m);
        if (text == null) continue;
        const t = norm(text);
        if (!t || !dropSet.has(t)) { out.missed++; continue; }
        out.removedChars += text.length;
        chat.splice(i, 1);
        out.removed++;
    }

    if (out.removed) {
        logInfo(`主模型请求｜历史裁剪：删掉 ${out.removed} 条旧楼层 / ${fmtNum(out.removedChars)} 字｜` +
            `主模型只留最近 ${Math.min(rounds, seen)} 轮（原 ${N} 层）｜` +
            `世界书已在裁剪之前扫描完成`, 'trim');
    } else {
        logWarn(`主模型请求｜历史裁剪生效了，但**一条都没认领到**（该裁 ${limit} 条）。` +
            '常见原因：酒馆在消息里加了名字前缀（names 行为不是「无」），' +
            '或该楼层正文被别的扩展改过。本轮历史**没有被裁**，请检查后再用。', 'trim');
    }

    return out;
}
