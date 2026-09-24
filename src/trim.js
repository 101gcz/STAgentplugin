/**
 * trim.js — 主模型请求整形：「只给大纲」的条目从主模型请求里删掉
 * ============================================================
 * 白名单里那个「给大纲 / 给主模型 / 都给」以前只是标记，现在真的生效：
 *   给大纲   → 进大纲提示词，同时从主模型请求里移除
 *   给主模型 → 只留给主模型，不进大纲提示词
 *   都给     → 两边都有
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
 *   3. 主链路在拼完 messages、发请求之前会发 CHAT_COMPLETION_PROMPT_READY，
 *      eventData.chat 与随后 return 的 chat 是同一个数组引用
 *      （openai.js:1607-1614），就地 splice 就生效
 *
 * 【为什么不用文本替换】
 * 「从合并后的大段文本里抠掉半条」会误伤：世界书、聊天历史里可能
 * 出现同样的字。所以这里只认「整条消息内容与条目正文完全一致」，
 * 认领不到就保留并记日志，绝不猜。
 *
 * 安全边界：
 *   · 插件自己的大纲请求（isGenerating()）一律不动 —— 那是我们拼的 prompt
 *   · 最后一条 user 消息（用户真实输入）永不删除
 *   · 总开关关着 / 没有「只给大纲」的条目时，直接返回，不做任何改动
 */

import { TARGET } from './constants.js';
import { ctx, logInfo, logWarn, expandMacros, errorText } from './env.js';
import { get as getSettings } from './settings.js';
import { readPreset } from './preset.js';
import { isGenerating } from './outline.js';

/** 最近一次整形结果，给面板和日志用 */
let lastTrim = null;

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
 * @param {{chat?: any[], dryRun?: boolean}} eventData
 * @returns {{removed:number, removedChars:number, names:string[], missed:string[], skipped:string}}
 */
export function trimMainRequest(eventData) {
    const stats = { removed: 0, removedChars: 0, names: [], missed: [], skipped: '', at: Date.now() };

    if (!eventData || !Array.isArray(eventData.chat)) {
        stats.skipped = 'chat 不是数组';
        lastTrim = stats;
        return stats;
    }
    if (isGenerating()) {
        stats.skipped = '本轮是插件自己的大纲请求';
        lastTrim = stats;
        return stats;
    }

    const s = getSettings();
    if (!s.enabled) {
        stats.skipped = '插件总开关关着';
        lastTrim = stats;
        return stats;
    }

    const targets = outlineOnlyEntries(s);
    if (!targets.length) {
        stats.skipped = '没有勾选「只给大纲」的条目';
        lastTrim = stats;
        return stats;
    }

    const chat = eventData.chat;

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
