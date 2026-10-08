/**
 * inject.js — 把大纲注入即将发出的请求
 * ============================================================
 * 拦截点是 CHAT_COMPLETION_SETTINGS_READY，它拿到的 generate_data
 * 已经是「预设已合并 + 世界书已扫描注入 + 宏已展开 + 正则已应用 +
 * token 预算已算过」的成品（依据：openai.js:3051-3052 的调用顺序）。
 * 所以直接改 messages 是最干净的做法。
 *
 * 关于位置（v3.7.8 改的）：
 *   现在用 append_system —— 作为独立 system 消息追加到 messages **最末尾**。
 *   理由（全是缓存账）：
 *     前缀缓存只认最长相同前缀，一旦某个 token 分叉，它后面的全部按未命中价
 *     重算，而 DeepSeek 的未命中价是命中价的 50~120 倍（v4f 1 vs 0.02 元/M，
 *     v4p 3 vs 0.025 元/M）。
 *
 *     以前用 prepend_user（拼进最后一条 user 消息的**内容前面**），那条消息的
 *     文本就被改了。而下一轮酒馆重建请求时用的是聊天记录里干净的原文，于是
 *     「上一轮的 user 消息」整段对不上 —— 缓存从那里断开，它后面（上一轮的
 *     回复、这一轮的全部内容）都按未命中价重算。如果酒馆把世界书注在
 *     @Depth 0，那条 user 消息里挂着全部激活条目，损失会很大。
 *
 *     append_system 一个字节都不改原有消息，缓存画像与不装插件完全一致；
 *     而位置又在最末尾、紧贴生成点，注意力权重不比拼进 user 消息差。
 *
 *   代价：末尾挂一条 role=system 消息在 chat completions 里不算常见写法。
 *   万一某个后端不认（400 或者行为异常），把 index.js 里那两处
 *   INJECT_MODE.APPEND_SYSTEM 换成 INJECT_MODE.PREPEND_USER 即可退回旧行为。
 *
 *   阶段二如果真要裁剪 user 历史，也必须用 append_system —— 大纲要是挂在某条
 *   user 消息里，裁剪时会被一起动到。
 *
 * 关于容错（原版有三个坑）：
 *   1. outline 可能是 undefined，原版直接拼进去会发出字符串 "undefined"
 *   2. content 可能是 null，原版没处理
 *   3. content 可能是数组（多模态），原版的处理顺序有问题
 *   这里逐一处理，任何异常都退化为「追加一条 system 消息」而不是崩掉。
 */

import { INJECT_MODE, OUTLINE_MARK_OPEN, OUTLINE_MARK_CLOSE } from './constants.js';
import { logWarn } from './env.js';

/**
 * 找最后一条 role === 'user' 的下标。
 * @returns {number} -1 表示没找到
 */
export function findLastUserIndex(messages) {
    if (!Array.isArray(messages)) return -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'user') return i;
    }
    return -1;
}

/** 拼成带标记的大纲块 */
export function wrapOutline(outline) {
    return `${OUTLINE_MARK_OPEN}\n${String(outline || '').trim()}\n${OUTLINE_MARK_CLOSE}`;
}

/**
 * 注入大纲。
 *
 * @param {object} generateData 拦截点拿到的 generate_data（会被就地修改）
 * @param {string} outline 大纲正文
 * @param {string} [mode] INJECT_MODE 之一，默认 append_system（缓存友好的那个）
 * @returns {{ok: boolean, how: string, reason: string}}
 */
export function injectOutline(generateData, outline, mode = INJECT_MODE.APPEND_SYSTEM) {
    // --- 前置校验：任何一条不过就不要动 messages ---
    if (!generateData || !Array.isArray(generateData.messages)) {
        return { ok: false, how: 'none', reason: 'generate_data.messages 不是数组' };
    }
    const text = String(outline == null ? '' : outline).trim();
    if (!text) {
        // 原版会把 "undefined" 拼进消息发给主模型。这里直接拒绝。
        return { ok: false, how: 'none', reason: '大纲为空，拒绝注入' };
    }

    const block = wrapOutline(text);

    // ★ 成功路径不写日志：落点由返回值 how 带出去，
    //   index.js 那行「注入｜…」统一说。这里只在**退化**时出声 ——
    //   以前四种落点各记一行 info，可用户只关心「注进去了没有」。

    if (mode === INJECT_MODE.APPEND_SYSTEM) {
        generateData.messages.push({ role: 'system', content: block });
        return { ok: true, how: 'append-system', reason: '' };
    }

    // --- 默认：拼到最后一条 user 前面 ---
    const idx = findLastUserIndex(generateData.messages);
    if (idx < 0) {
        generateData.messages.push({ role: 'system', content: block });
        logWarn('未找到 user 消息，大纲已退化为追加独立 system 消息', 'run');
        return { ok: true, how: 'append-system(fallback)', reason: '没有 user 消息' };
    }

    const target = generateData.messages[idx];
    const orig = target.content;

    if (typeof orig === 'string') {
        target.content = block + '\n\n' + orig;
        return { ok: true, how: 'prepend-user', reason: '' };
    }

    if (Array.isArray(orig)) {
        // 多模态：在开头插一个文本段，原数组整体后移
        target.content = [{ type: 'text', text: block + '\n\n' }].concat(orig);
        return { ok: true, how: 'prepend-user-array', reason: '' };
    }

    if (orig == null) {
        target.content = block;
        return { ok: true, how: 'set-user', reason: '' };
    }

    // 其它奇怪类型（对象、数字等）：不硬改，退化为独立 system
    generateData.messages.push({ role: 'system', content: block });
    logWarn(`第 ${idx} 条消息的 content 类型异常（${typeof orig}），大纲已退化为追加独立 system 消息`, 'run');
    return { ok: true, how: 'append-system(fallback)', reason: 'content 类型异常: ' + (typeof orig) };
}

/** 判断某个请求里是否已经有大纲（用于重复注入检测） */
export function hasOutline(generateData) {
    if (!generateData || !Array.isArray(generateData.messages)) return false;
    return generateData.messages.some(m => {
        const c = m && m.content;
        if (typeof c === 'string') return c.includes(OUTLINE_MARK_OPEN);
        if (Array.isArray(c)) return c.some(p => typeof (p && p.text) === 'string' && p.text.includes(OUTLINE_MARK_OPEN));
        return false;
    });
}
