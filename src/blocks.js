/**
 * blocks.js — 给大纲模型的「系统提示词」素材块
 * ============================================================
 * 背景：大纲模型拿不到酒馆给主模型的那套系统提示词。
 *   · 酒馆原生 generateRaw 只做 createRawPrompt() 然后直接发
 *     （public/script.js:3941-4018）—— 不跑预设、不扫世界书、不带历史
 *   · 酒馆助手 ordered_prompts 的契约是「列什么有什么」
 *     （@types/function/generate.d.ts:319-322）
 * 所以这些素材必须由插件自己取、自己拼。本模块负责取：
 *
 *   history   聊天记录（走 chat.js，过酒馆正则压缩）
 *   worldInfo 本轮实际激活的世界书 —— 不重扫，直接听酒馆算好的结果
 *             （WORLDINFO_SCAN_DONE 的 activated.text，
 *               事件契约见酒馆助手 @types/iframe/event.d.ts:502-526）
 *   charCard  角色卡：描述 / 性格 / 场景（context.characters + characterId）
 *   persona   用户 Persona（power_user.persona_description，openai.js:1424 同一字段）
 *   examples  对话示例（角色卡 mes_example）
 *
 * 每一项都可以在「白名单」页单独关掉，默认全开；
 * 而且开关是**跟着预设走**的（presetBlocks[预设名]），
 * 换预设 = 换一套素材开关，跟白名单同一套逻辑。
 */

import { SYSTEM_BLOCKS } from './constants.js';
import { blockConfigOf, blockGoesToOutline } from './settings.js';
import {
    ctx, logInfo, logWarn, expandMacros, estimateTokens, fmtNum,
} from './env.js';

// ============================================================
// 世界书：听酒馆自己算出来的结果
// ============================================================

/**
 * 酒馆扫完世界书后会发 WORLDINFO_SCAN_DONE，
 * activated.text 就是这一轮真正注入的世界书正文。
 * 我们只缓存最近一次，不重扫、不自己判关键词。
 */
let lastScan = null;

/** 缓存有效期：超过这个时间就认为「这一轮没有世界书激活」，不再往上贴 */
const SCAN_MAX_AGE_MS = 180 * 1000;

/** 挂监听。boot 时调一次。 */
export function installWorldInfoWatcher() {
    const c = ctx();
    const source = c && c.eventSource;
    const types = c && c.eventTypes;
    if (!source || !types || !types.WORLDINFO_SCAN_DONE || typeof source.on !== 'function') {
        logWarn('拿不到 WORLDINFO_SCAN_DONE，大纲模型将拿不到世界书（其它功能不受影响）', 'blocks');
        return null;
    }

    const handler = (data) => {
        try {
            const activated = data && data.activated;
            const text = String((activated && activated.text) || '');
            let count = 0;
            if (activated && activated.entries && typeof activated.entries.forEach === 'function') {
                activated.entries.forEach(() => { count++; });
            } else if (Array.isArray(data && data.sortedEntries)) {
                count = data.sortedEntries.length;
            }
            lastScan = {
                text,
                count,
                chars: text.length,
                overflowed: !!(data && data.budget && data.budget.overflowed),
                budget: (data && data.budget) ? data.budget.current : null,
                at: Date.now(),
            };
            if (text) {
                logInfo(`世界书扫描完成：激活 ${count} 条｜${fmtNum(text.length)} 字｜` +
                    `≈${fmtNum(estimateTokens(text))} tokens` +
                    (lastScan.overflowed ? '｜⚠️ 预算溢出，有条目被丢弃' : ''), 'blocks');
            }
        } catch (e) {
            logWarn('解析 WORLDINFO_SCAN_DONE 失败: ' + (e && e.message), 'blocks');
        }
    };

    try {
        source.on(types.WORLDINFO_SCAN_DONE, handler);
    } catch (e) {
        logWarn('注册 WORLDINFO_SCAN_DONE 失败: ' + (e && e.message), 'blocks');
        return null;
    }

    logInfo('已挂上世界书监听（扫完后把本轮激活的正文交给大纲模型）', 'blocks');
    return () => { try { source.removeListener(types.WORLDINFO_SCAN_DONE, handler); } catch (e) { /* ignore */ } };
}

/**
 * 取本轮激活的世界书正文。
 * @returns {{text:string, count:number, chars:number, ageMs:number, overflowed:boolean, stale:boolean}}
 */
export function latestWorldInfo() {
    const empty = { text: '', count: 0, chars: 0, ageMs: -1, overflowed: false, stale: false };
    if (!lastScan) return empty;
    const ageMs = Date.now() - lastScan.at;
    if (ageMs > SCAN_MAX_AGE_MS) return Object.assign({}, empty, { stale: true, ageMs });
    return {
        text: lastScan.text,
        count: lastScan.count,
        chars: lastScan.chars,
        ageMs,
        overflowed: lastScan.overflowed,
        stale: false,
    };
}

// ============================================================
// 角色卡 / Persona / 对话示例
// ============================================================

function currentCharacter() {
    const c = ctx();
    const list = c && c.characters;
    const id = c && c.characterId;
    if (!Array.isArray(list) || id == null) return null;
    const ch = list[Number(id)];
    return (ch && typeof ch === 'object') ? ch : null;
}

/** 角色卡：描述 / 性格 / 场景 */
export function charCardBlock() {
    const ch = currentCharacter();
    if (!ch) return { text: '', note: '读不到角色卡（可能在群聊里，或没选角色）' };
    const parts = [];
    const push = (label, v) => { if (v && String(v).trim()) parts.push(`【${label}】\n${String(v).trim()}`); };
    push('角色描述', expandMacros(ch.description || ''));
    push('性格', expandMacros(ch.personality || ''));
    push('场景', expandMacros(ch.scenario || ''));
    if (!parts.length) return { text: '', note: '角色卡里描述 / 性格 / 场景都是空的' };
    return { text: parts.join('\n\n'), note: '' };
}

/** 用户 Persona */
export function personaBlock() {
    const c = ctx();
    const pu = c && c.powerUserSettings;
    const text = pu && pu.persona_description;
    if (!text || !String(text).trim()) return { text: '', note: '酒馆里没有设置 Persona 描述' };
    return { text: expandMacros(String(text).trim()), note: '' };
}

/** 对话示例 */
export function examplesBlock() {
    const ch = currentCharacter();
    const ex = ch && ch.mes_example;
    if (!ex || !String(ex).trim()) return { text: '', note: '角色卡里没有对话示例' };
    return { text: expandMacros(String(ex).trim()), note: '' };
}

// ============================================================
// 组装
// ============================================================

/**
 * 按设置收集各块内容。
 *
 * @param {object} s 设置（settings.get() 的结果）
 * @param {string} historyText chat.js 压好的聊天记录文本
 * @param {string} [presetName] 当前预设名 —— 素材配置是每个预设各一套，
 *        不传就退回旧版全局设置（只为兼容老调用方）
 * @returns {{
 *   text: Record<string,string>,   // 供模板占位符使用
 *   stats: Array<{key,label,on,chars,note}>,
 * }}
 */
export function collectBlocks(s, historyText, presetName) {
    const cfg = blockConfigOf(s, presetName);
    // 「只给主模型」对素材的含义是「别进大纲提示词」——
    // 主模型那边这些内容由酒馆自己注入，插件不插手，所以这里只判断要不要进大纲。
    const on = (key) => blockGoesToOutline(cfg[key]);

    const world = latestWorldInfo();
    const card = on('charCard') ? charCardBlock() : { text: '', note: '' };
    const persona = on('persona') ? personaBlock() : { text: '', note: '' };
    const examples = on('examples') ? examplesBlock() : { text: '', note: '' };

    const text = {
        history: on('history') ? String(historyText || '') : '',
        worldInfo: on('worldInfo') ? world.text : '',
        charCard: card.text,
        persona: persona.text,
        examples: examples.text,
    };

    const stats = SYSTEM_BLOCKS.map(b => {
        const enabled = on(b.key);
        const rec = cfg[b.key] || {};
        const v = text[b.key] || '';
        let note = '';
        if (rec.enabled === false) note = '已在白名单里关闭';
        else if (rec.target === 'main') note = '标记为「只给主模型」，不进大纲提示词';
        else if (b.key === 'worldInfo') {
            if (world.stale) note = '世界书扫描结果已过期（这一轮可能没有激活任何条目）';
            else if (!world.text) note = '本轮没有激活的世界书条目';
            else if (world.overflowed) note = '⚠️ 世界书预算溢出，有条目被酒馆丢弃';
        } else if (!v && b.key === 'charCard') note = card.note;
        else if (!v && b.key === 'persona') note = persona.note;
        else if (!v && b.key === 'examples') note = examples.note;
        else if (!v && b.key === 'history') note = '聊天记录为空';
        return { key: b.key, label: b.label, on: enabled, chars: v.length, note };
    });

    return { text, stats };
}

/** 给日志一行话，方便在「日志」页确认大纲到底吃到了什么 */
export function describeBlocks(stats) {
    return (stats || [])
        .filter(x => x.on)
        .map(x => `${x.label} ${fmtNum(x.chars)}字${x.note ? '(' + x.note + ')' : ''}`)
        .join('｜');
}
