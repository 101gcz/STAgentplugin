/**
 * inject.js — 把大纲注入即将发出的请求
 * ============================================================
 * 拦截点是 CHAT_COMPLETION_SETTINGS_READY，它拿到的 generate_data
 * 已经是「预设已合并 + 世界书已扫描注入 + 宏已展开 + 正则已应用 +
 * token 预算已算过」的成品（依据：openai.js:3051-3052 的调用顺序）。
 * 所以直接改 messages 是最干净的做法。
 *
 * 关于位置：
 *   阶段一用 prepend_user —— 拼进最后一条 user 消息的前面。
 *   理由：位置天然靠近生成点，注意力权重高；不用改 system prompt，
 *   不影响角色扮演基调。
 *
 *   阶段二会改成独立 system 消息。原因：阶段二要裁剪 user 历史，
 *   如果大纲就挂在某条 user 消息里，裁剪时会被一起动到。
 *   所以这里刻意把注入方式抽成独立模块，阶段二替换成本很低。
 *
 * 关于容错（原版有三个坑）：
 *   1. outline 可能是 undefined，原版直接拼进去会发出字符串 "undefined"
 *   2. content 可能是 null，原版没处理
 *   3. content 可能是数组（多模态），原版的处理顺序有问题
 *   这里逐一处理，任何异常都退化为「追加一条 system 消息」而不是崩掉。
 */

import { INJECT_MODE, OUTLINE_MARK_OPEN, OUTLINE_MARK_CLOSE } from './constants.js';
import { logInfo, logWarn } from './env.js';

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
 * @param {string} [mode] INJECT_MODE 之一，默认 prepend_user
 * @returns {{ok: boolean, how: string, reason: string}}
 */
export function injectOutline(generateData, outline, mode = INJECT_MODE.PREPEND_USER) {
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

    if (mode === INJECT_MODE.APPEND_SYSTEM || mode === INJECT_MODE.AS_SYSTEM_AT_DEPTH) {
        generateData.messages.push({ role: 'system', content: block });
        logInfo('大纲已作为独立 system 消息追加', 'inject');
        return { ok: true, how: 'append-system', reason: '' };
    }

    // --- 默认：拼到最后一条 user 前面 ---
    const idx = findLastUserIndex(generateData.messages);
    if (idx < 0) {
        generateData.messages.push({ role: 'system', content: block });
        logWarn('未找到 user 消息，已退化为追加独立 system 消息', 'inject');
        return { ok: true, how: 'append-system(fallback)', reason: '没有 user 消息' };
    }

    const target = generateData.messages[idx];
    const orig = target.content;

    if (typeof orig === 'string') {
        target.content = block + '\n\n' + orig;
        logInfo(`大纲已拼入第 ${idx} 条消息（user，字符串形态）`, 'inject');
        return { ok: true, how: 'prepend-user', reason: '' };
    }

    if (Array.isArray(orig)) {
        // 多模态：在开头插一个文本段，原数组整体后移
        target.content = [{ type: 'text', text: block + '\n\n' }].concat(orig);
        logInfo(`大纲已拼入第 ${idx} 条消息（user，数组形态，共 ${orig.length} 段）`, 'inject');
        return { ok: true, how: 'prepend-user-array', reason: '' };
    }

    if (orig == null) {
        target.content = block;
        logInfo(`大纲已写入第 ${idx} 条消息（user，原内容为空）`, 'inject');
        return { ok: true, how: 'set-user', reason: '' };
    }

    // 其它奇怪类型（对象、数字等）：不硬改，退化为独立 system
    generateData.messages.push({ role: 'system', content: block });
    logWarn(`第 ${idx} 条消息的 content 类型异常（${typeof orig}），已退化为追加独立 system 消息`, 'inject');
    return { ok: true, how: 'append-system(fallback)', reason: 'content 类型异常: ' + (typeof orig) };
}

/**
 * 统计 messages 的组成，给「预览」「成本」页用。
 * 特别标出哪部分是预设、哪部分是世界书、哪部分是历史 ——
 * 这些在原版里完全是黑盒。
 */
export function analyzeMessages(generateData) {
    if (!generateData || !Array.isArray(generateData.messages)) {
        return { ok: false, reason: 'generate_data.messages 不是数组' };
    }
    const messages = generateData.messages;
    let total = 0;
    const per = messages.map((m, i) => {
        const c = m && m.content;
        let len = 0;
        if (typeof c === 'string') len = c.length;
        else if (Array.isArray(c)) len = c.reduce((s, part) => s + String((part && part.text) || '').length, 0);
        total += len;
        return { i, role: (m && m.role) || '-', len };
    });
    const lastUser = findLastUserIndex(messages);
    const roles = messages.map(m => (m && m.role) || '?');
    return {
        ok: true,
        count: messages.length,
        roles: roles.join(','),
        totalChars: total,
        per,
        lastUser,
        model: generateData.model,
        maxTokens: generateData.max_tokens,
        stream: generateData.stream,
    };
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
