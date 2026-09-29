/**
 * diag.js — 「主模型这一轮到底收到了什么」
 * ============================================================
 * 为什么需要它：
 *   在这之前，主模型请求的内容对用户是**完全黑盒**的。面板上只有一句
 *   「请求组成｜N 条消息｜合计 X 字」，看不出那 X 字里
 *     哪几条是预设条目、哪几条是聊天楼层、世界书在哪、大纲在不在，
 *   更看不出**勾了「只给大纲」的条目到底有没有被删掉**。
 *
 *   于是只能靠猜：用户看到「聊天记录 5.8k」就以为主模型收到了 5.8k 字，
 *   其实那一栏是**原文总量**（panel.js 的 blockFacts 用的是 chat.rawChars），
 *   主模型收到的是酒馆按正则+深度压过的那一份。
 *
 * 本模块做一件事：把成品 messages 逐条认领回来源，列出来。
 *
 * 认领规则（只认精确匹配，认不出就写「其它」，绝不猜）：
 *   · 大纲      正文里有 OUTLINE_MARK_OPEN
 *   · 预设条目  整条正文 == 条目正文（或宏展开后的正文）
 *   · 聊天楼层  整条正文 == 该层按**酒馆口径**（带 depth）过完正则的文本
 *   · 世界书    整条正文 == 某条激活条目的正文，或包含它
 *   · 角色卡 / Persona / 对话示例  同理
 *
 * ★ 为什么聊天楼层要用「带 depth」的口径：
 *   酒馆拼提示词时是逐层传深度的（script.js:4442-4447
 *   depth = coreChat.length - index - 1），带「最小/最大深度」的正则
 *   按各层自己的深度决定生不生效。插件拼大纲提示词时没传深度
 *   （chat.js:96-101），两者结果可以差好几倍 —— 这里两种都算出来给你看。
 */

import { OUTLINE_MARK_OPEN } from './constants.js';
import { expandMacros, fmtNum, logWarn, log, safe } from './env.js';
import { readPreset } from './preset.js';
import { get as getSettings } from './settings.js';
import { latestWorldInfo, charCardBlock, personaBlock, examplesBlock } from './blocks.js';
import { getVisibleFloors, regexFloor } from './chat.js';
import { lastTrimStats } from './trim.js';

/** 来源分类 */
export const KIND = {
    OUTLINE: 'outline',
    PRESET: 'preset',
    HISTORY: 'history',
    WORLD: 'world',
    CHAR: 'char',
    PERSONA: 'persona',
    EXAMPLES: 'examples',
    OTHER: 'other',
};

const KIND_LABEL = {
    [KIND.OUTLINE]: '大纲',
    [KIND.PRESET]: '预设条目',
    [KIND.HISTORY]: '聊天楼层',
    [KIND.WORLD]: '世界书',
    [KIND.CHAR]: '角色卡',
    [KIND.PERSONA]: 'Persona',
    [KIND.EXAMPLES]: '对话示例',
    [KIND.OTHER]: '其它',
};

/** 目标 → 短标签（和界面那三个词保持一字不差） */
function targetText(t) {
    return t === 'main' ? '只给主模型' : (t === 'outline' ? '只给大纲' : '都给');
}

function norm(s) {
    return String(s == null ? '' : s).replace(/\r\n/g, '\n').trim();
}

/** 一条消息的纯文本形态；非字符串 / 非文本数组返回 null（不参与匹配） */
function textOf(msg) {
    if (!msg) return null;
    const c = msg.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(x => (x && typeof x.text === 'string') ? x.text : '').join('');
    return null;
}

/**
 * 把主模型这一轮的成品 messages 逐条认领回来源。
 *
 * @param {object} generateData CHAT_COMPLETION_SETTINGS_READY 拿到的请求体
 * @returns {{
 *   ok: boolean, reason?: string, at: number,
 *   total: {count:number, chars:number},
 *   rows: Array<{i:number, role:string, chars:number, kind:string, label:string, warn:string}>,
 *   byKind: Array<{kind:string, label:string, count:number, chars:number}>,
 *   warnings: string[],
 *   trim: object|null,
 *   history: object|null,
 * }}
 */
export function mapMainRequest(generateData) {
    const out = {
        ok: false, reason: '', at: Date.now(),
        total: { count: 0, chars: 0 },
        rows: [], byKind: [], warnings: [], trim: null, history: null,
    };

    if (!generateData || !Array.isArray(generateData.messages)) {
        out.reason = 'generate_data.messages 不是数组';
        return out;
    }

    // ---- 1. 建索引：正文 → 来源 ----
    /** 精确匹配表：归一化正文 → {kind,label} */
    const exact = new Map();
    /** 包含匹配（只对够长的块做，避免误伤短条目） */
    const loose = [];
    const put = (text, kind, label, warn) => {
        const t = norm(text);
        if (t.length < 4) return;
        if (!exact.has(t)) exact.set(t, { kind, label, warn: warn || '' });
        if (t.length >= 24) loose.push({ t, kind, label, warn: warn || '' });
    };

    // 预设条目（连白名单去向一起标出来 —— 「只给大纲」还在这儿就是没删掉）
    const preset = readPreset();
    const s = getSettings();
    const wl = s.presetWhitelist[preset.name] || {};
    for (const p of preset.prompts) {
        if (!p.hasContent) continue;
        const cfg = wl[p.name];
        const tag = (cfg && cfg.enabled === true)
            ? `·${targetText(cfg.target)}`
            : (cfg ? '·白名单没勾' : '·不在白名单');
        const label = `预设「${p.name}」${tag}`;
        put(p.content, KIND.PRESET, label);
        safe('diag.macro', () => put(expandMacros(p.content), KIND.PRESET, label), null);
    }

    // 聊天楼层：按酒馆口径（逐层带 depth）建索引，并顺带算出
    // 「旧的不传 depth 口径」会是多少 —— 那是修 B3 之前的错法，留个对照。
    let floors = [];
    let hist = null;
    try {
        floors = getVisibleFloors();
        const N = floors.length;
        let rawChars = 0, sentChars = 0, noDepthChars = 0;
        floors.forEach((f, i) => {
            const isUser = f.role === 'user';
            const depth = N - i - 1;
            rawChars += f.text.length;
            const withDepth = safe('diag.regex', () => regexFloor(f.text, isUser, depth), f.text);
            const noDepth = safe('diag.regex', () => regexFloor(f.text, isUser, undefined), f.text);
            sentChars += String(withDepth || '').length;
            noDepthChars += String(noDepth || '').length;
            const label = `聊天第 ${f.idx + 1} 层（depth ${depth}，${isUser ? '用户' : (f.role === 'system' ? '旁白' : 'AI')}）`;
            put(withDepth, KIND.HISTORY, label);
            put(noDepth, KIND.HISTORY, label);
            put(f.text, KIND.HISTORY, label);
        });
        hist = {
            floors: N,
            rawChars,
            /** 插件真正拼给大纲模型的那份（逐层带 depth，与酒馆同口径） */
            sentChars,
            /** 反事实：如果还按 v3.8.0 之前「不传 depth」的错法，会是多少 */
            noDepthChars,
        };
    } catch (e) {
        logWarn('统计聊天楼层失败（这一项留空）: ' + (e && e.message), 'diag');
    }

    // 世界书：插件手里那份是「逐条正文用 \n\n 拼起来」的，拆回去逐条认领
    try {
        const world = latestWorldInfo();
        const entries = String(world.text || '').split('\n\n').map(x => x.trim()).filter(Boolean);
        entries.forEach((c, i) => put(c, KIND.WORLD, `世界书条目 ${i + 1}/${entries.length}`));
        if (!entries.length) put(world.text, KIND.WORLD, '世界书');
    } catch (e) { /* 世界书拿不到就不认领 */ }

    // 角色卡 / Persona / 对话示例
    try {
        const c = charCardBlock();
        if (c && c.text) {
            put(c.text, KIND.CHAR, '角色卡');
            // 酒馆可能分开注入描述/性格/场景，逐个再试
            c.text.split('\n\n').forEach(part => put(part, KIND.CHAR, '角色卡'));
            c.text.split('\n\n').forEach(part => {
                const body = part.replace(/^【[^】]*】\s*/, '');
                put(body, KIND.CHAR, '角色卡');
            });
        }
    } catch (e) { /* ignore */ }
    try {
        const p = personaBlock();
        if (p && p.text) put(p.text, KIND.PERSONA, 'Persona');
    } catch (e) { /* ignore */ }
    try {
        const x = examplesBlock();
        if (x && x.text) put(x.text, KIND.EXAMPLES, '对话示例');
    } catch (e) { /* ignore */ }

    // ---- 2. 逐条认领 ----
    const messages = generateData.messages;
    let totalChars = 0;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i] || {};
        const text = textOf(m);
        const chars = text == null ? 0 : text.length;
        totalChars += chars;
        const row = { i, role: m.role || '-', chars, kind: KIND.OTHER, label: '', warn: '' };

        if (text != null) {
            const t = norm(text);
            if (t.includes(OUTLINE_MARK_OPEN)) {
                row.kind = KIND.OUTLINE;
                row.label = '插件注入的剧情大纲';
            } else if (exact.has(t)) {
                const hit = exact.get(t);
                row.kind = hit.kind;
                row.label = hit.label;
                row.warn = hit.warn;
            } else {
                // 包含匹配：世界书 / 角色卡这类会被酒馆加壳的消息靠它兜住
                const hit = loose.find(x => t.includes(x.t));
                if (hit) {
                    row.kind = hit.kind;
                    row.label = hit.label + '（部分匹配）';
                    row.warn = hit.warn;
                } else {
                    row.label = chars ? '认不出来（酒馆加壳或别的扩展注入的）' : '空消息';
                }
            }
        } else {
            row.label = '非文本 content（多模态？）';
        }
        out.rows.push(row);
    }

    // ---- 3. 汇总 ----
    const agg = new Map();
    for (const r of out.rows) {
        const a = agg.get(r.kind) || { kind: r.kind, label: KIND_LABEL[r.kind] || r.kind, count: 0, chars: 0 };
        a.count++;
        a.chars += r.chars;
        agg.set(r.kind, a);
    }
    out.byKind = Array.from(agg.values());

    out.total = { count: out.rows.length, chars: totalChars };
    out.history = hist;
    out.trim = lastTrimStats();

    // ---- 4. 值得喊出来的事 ----
    const leaked = out.rows.filter(r => r.kind === KIND.PRESET && r.label.includes('·只给大纲'));
    if (leaked.length) {
        out.warnings.push(`★ ${leaked.length} 条勾了「只给大纲」的预设条目**还在主模型请求里**：` +
            leaked.map(r => r.label.replace(/^预设「|」·只给大纲$/g, '')).join('、') +
            '（trim 没认领到 —— 位置可能不是 relative，或者正文对不上）');
    }
    const tr = out.trim;
    if (tr && tr.missed && tr.missed.length) {
        out.warnings.push(`${tr.missed.length} 条「只给大纲」的条目没能在请求里精确匹配：` + tr.missed.join('、'));
    }
    if (tr && tr.blocks) {
        if (tr.blocks.missed && tr.blocks.missed.length) {
            out.warnings.push(`「只给大纲」的素材块没认领到（已原样保留）：` + tr.blocks.missed.join('、'));
        }
        if (tr.blocks.removed > 0) {
            out.warnings.push(`素材块已从主模型请求移除 ${tr.blocks.removed} 条 / ` +
                `${fmtNum(tr.blocks.removedChars)} 字：` + tr.blocks.names.join('、'));
        }
    }
    if (tr && tr.history) {
        const h = tr.history;
        if (h.removed > 0) {
            out.warnings.push(`历史裁剪：删掉 ${h.removed} 条旧楼层 / ${fmtNum(h.removedChars)} 字，` +
                `主模型只留最近 ${h.rounds} 轮（原 ${h.totalFloors} 层）`);
        } else if (!h.skipped) {
            out.warnings.push('历史裁剪生效了，但一条都没认领到 —— 本轮历史没有被裁');
        }
    }

    out.ok = true;
    return out;
}

/** 一行摘要，日志和面板都用它 */
export function describeRequest(d) {
    if (!d || !d.ok) return '主模型请求诊断不可用：' + ((d && d.reason) || '未知原因');
    const parts = d.byKind
        .slice()
        .sort((a, b) => b.chars - a.chars)
        .map(k => `${k.label} ${k.count} 条/${fmtNum(k.chars)}字`);
    return `主模型请求｜共 ${d.total.count} 条 / ${fmtNum(d.total.chars)} 字｜` + parts.join('｜');
}

/** 逐条明细（每行一条消息），给日志用 */
export function requestLines(d) {
    if (!d || !d.ok) return [];
    const lines = [describeRequest(d)];
    for (const r of d.rows) {
        lines.push(`  [${String(r.i).padStart(2)}] ${String(r.role).padEnd(9)}${String(fmtNum(r.chars) + '字').padStart(9)}  ` +
            `${KIND_LABEL[r.kind] || r.kind}：${r.label}`);
    }
    for (const w of d.warnings) lines.push('  ' + w);
    return lines;
}

/** 把诊断写进日志（scope=diag）。逐条会很长，所以超过 60 条只写摘要 + 头 40 条。 */
export function logRequest(d) {
    if (!d || !d.ok) {
        logWarn('主模型请求诊断失败: ' + ((d && d.reason) || '未知原因'), 'diag');
        return;
    }
    const MAX = 60;
    const lines = requestLines(d);
    const head = lines.length <= MAX ? lines : lines.slice(0, MAX).concat(
        [`  …还有 ${lines.length - MAX} 行（完整清单在面板「状态」页 > 主模型本轮真实组成）`]);
    for (const l of head) log(l, 'info', 'diag');
}
