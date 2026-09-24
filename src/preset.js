/**
 * preset.js — 读取预设 + 白名单 + 宏展开 + 引用完整性检查
 * ============================================================
 * 这里解决了原版的三个问题：
 *
 *  1. 原版读 pm.collection（Power User 提示词管理器里的字段），
 *     那不是稳定接口，而且旧文档声称的 getPromptCollection() 兜底
 *     根本没实现。本版优先用酒馆助手官方 API getPreset('in_use')，
 *     它返回的每条都带 name / enabled / content / role / position。
 *
 *  2. 原版直接用条目原文，宏（{{user}} {{char}} 等）没展开，
 *     模型会照着宏名编内容。本版一律过 expandMacros()。
 *
 *  3. 条目之间会互相引用自有标签。例如你预设里
 *     「组件 - 性爱描写指导」引用了 <SexyWritingGuide>，
 *     而定义在「组件 - 色情文风指导」里。只勾引用方不勾定义方，
 *     模型会拿到一份指向不存在文件的引用，然后开始编造。
 *     本版会做引用完整性检查并在面板上给出黄色警告。
 *
 * ★ 记录一个真实教训：
 *   原版调用的 selectActivatedEntries 并不属于酒馆助手，
 *   它是 ST-Prompt-Template 扩展的内部函数。在只装酒馆助手的
 *   环境里会抛 ReferenceError，然后被 catch 吞掉，世界书功能
 *   永久失效且毫无提示。所以本版所有「能力缺失」都必须报出来。
 */

import { TARGET } from './constants.js';
import {
    ctx, tavernHelper, expandMacros,
    logInfo, logWarn, logError, errorText, safe,
} from './env.js';
import { get as getSettings } from './settings.js';

// 缓存：读预设要遍历几十条，5 秒内复用
const CACHE_MS = 5000;
let cache = null;
let cacheAt = 0;

/**
 * 读当前启用预设的条目列表。
 * @param {boolean} [force] 强制刷新缓存
 * @returns {{
 *   name: string,
 *   source: 'tavern_helper'|'power_user'|'none',
 *   error: string,
 *   prompts: Array<{
 *     idx: number, id: string, name: string, enabled: boolean,
 *     role: string, position: any, contentLength: number,
 *     hasContent: boolean, content: string
 *   }>
 * }}
 */
export function readPreset(force = false) {
    const now = Date.now();
    if (!force && cache && (now - cacheAt) < CACHE_MS) return cache;
    cache = readPresetUncached();
    cacheAt = now;
    return cache;
}

function readPresetUncached() {
    const result = {
        name: '(未知预设)',
        source: 'none',
        error: '',
        prompts: [],
    };

    // ---- 预设名 ----
    const th = tavernHelper();
    if (th && typeof th.getLoadedPresetName === 'function') {
        const n = safe('preset.name', () => th.getLoadedPresetName(), '');
        if (n) result.name = String(n);
    }
    if (result.name === '(未知预设)') {
        const c = ctx();
        const pu = c && c.powerUserSettings;
        if (pu && pu.preset_name) result.name = String(pu.preset_name);
    }

    // ---- 条目 ----
    // 路线 A：酒馆助手 getPreset('in_use')。这条最准，因为它做了
    // 占位符展开和 enabled 解析。
    if (th && typeof th.getPreset === 'function') {
        const preset = safe('preset.getPreset', () => th.getPreset('in_use'), null);
        if (preset && Array.isArray(preset.prompts)) {
            result.prompts = preset.prompts.map(normalizeEntry);
            result.source = 'tavern_helper';
            return result;
        }
        if (preset) {
            result.error = 'getPreset("in_use") 返回的对象里没有 prompts 数组';
            logWarn(result.error, 'preset');
        } else {
            result.error = 'getPreset("in_use") 返回空';
            logWarn(result.error, 'preset');
        }
    } else {
        result.error = '酒馆助手不可用（未安装或未启用），无法读取预设条目';
        logWarn(result.error, 'preset');
    }

    // 路线 B：从 powerUserSettings 里挖。
    // 这条路拿到的字段和 getPreset 不完全一样，属于降级方案，
    // 但比「静默返回空」好得多 —— 至少白名单还能用上条目名。
    const fallback = readFromPowerUser();
    if (fallback.prompts.length) {
        result.prompts = fallback.prompts;
        result.source = 'power_user';
        result.error = '（降级）酒馆助手不可用，正从 powerUserSettings 读取，部分字段可能缺失';
        logWarn('预设降级到 powerUserSettings 读取，共 ' + fallback.prompts.length + ' 条', 'preset');
        return result;
    }

    logError('无法读取预设条目：' + result.error, 'preset');
    return result;
}

function normalizeEntry(p, idx) {
    let content = '';
    if (typeof p.content === 'string') content = p.content;
    else if (p.content != null) content = String(p.content);
    return {
        idx,
        id: p.id || p.identifier || ('#' + idx),
        name: p.name || (p.identifier ? String(p.identifier) : `(条目 ${idx})`),
        enabled: p.enabled !== false,
        role: p.role || '-',
        position: p.position || null,
        injection_position: p.injection_position,
        injection_depth: p.injection_depth,
        injection_order: p.injection_order,
        contentLength: content.length,
        hasContent: content.trim().length > 0,
        content,
    };
}

/** 降级方案：直接读 power_user 里的提示词列表 */
function readFromPowerUser() {
    const out = { prompts: [] };
    const c = ctx();
    const pu = c && c.powerUserSettings;
    if (!pu) return out;

    // 不同酒馆版本字段名不同，几个都试一遍
    const candidates = [
        pu.prompt_manager && pu.prompt_manager.prompts,
        pu.prompts,
    ];
    let list = null;
    for (const x of candidates) {
        if (Array.isArray(x) && x.length) { list = x; break; }
    }
    if (!list) return out;

    out.prompts = list.map(normalizeEntry);
    return out;
}

/** 强制刷新预设缓存 */
export function refreshPreset() {
    return readPreset(true);
}

/** 取某条目的正文（按名字） */
export function entryContent(entryName) {
    const p = readPreset();
    const hit = p.prompts.find(x => x.name === entryName);
    return hit ? hit.content : '';
}

/**
 * 按白名单筛出要送给某个目标的条目。
 * @param {'outline'|'main'} target
 * @returns {Array} 条目数组
 */
export function selectedEntries(target) {
    const s = getSettings();
    const preset = readPreset();
    const byPreset = s.presetWhitelist[preset.name] || {};
    const out = [];
    for (const p of preset.prompts) {
        const cfg = byPreset[p.name];
        if (!cfg || cfg.enabled !== true) continue;
        const tgt = cfg.target || TARGET.BOTH;
        if (tgt !== TARGET.BOTH && tgt !== target) continue;
        if (!p.hasContent) continue;      // 空的「——— 📘写作 ———」这类分组标记跳过
        if (!p.enabled) continue;         // 遵循酒馆里的条目开关
        out.push(p);
    }
    return out;
}

/**
 * 组装白名单条目文本块，含宏展开。
 * @param {'outline'|'main'} target
 * @returns {{text: string, picked: number, warnings: string[]}}
 */
export function buildEntryBlock(target) {
    const picked = selectedEntries(target);
    const warnings = [];
    if (!picked.length) return { text: '', picked: 0, warnings };

    const parts = [];
    for (const p of picked) {
        let expanded = p.content;
        try {
            expanded = expandMacros(p.content);
        } catch (e) {
            warnings.push(`${p.name}：宏展开失败（${errorText(e)}）`);
        }
        if (!expanded.trim()) continue;
        parts.push(`### ${p.name}\n${expanded.trim()}`);
    }

    // 引用完整性检查
    const refWarnings = checkReferences(picked);
    warnings.push(...refWarnings);

    return { text: parts.join('\n\n'), picked: parts.length, warnings };
}

/**
 * 扫描已选条目里的自有标签，找出「被引用但没有定义」的。
 * 例：勾了「组件 - 性爱描写指导」（引用 <SexyWritingGuide>）
 *     但没勾「组件 - 色情文风指导」（定义 <SexyWritingGuide>）
 * @param {Array} picked
 * @returns {string[]} 警告文本
 */
export function checkReferences(picked) {
    const warnings = [];
    const presetAll = readPreset().prompts;

    // 已选条目里定义了哪些标签
    const definedHere = new Set();
    for (const p of picked) {
        for (const tag of extractDefinedTags(p.content)) definedHere.add(tag);
    }

    for (const p of picked) {
        const used = extractUsedTags(p.content);
        for (const tag of used) {
            if (definedHere.has(tag)) continue;
            // 该标签在未被选中的条目里有定义吗？
            const elsewhere = presetAll.find(q =>
                !picked.includes(q) &&
                extractDefinedTags(q.content).includes(tag)
            );
            if (elsewhere) {
                warnings.push(`「${p.name}」引用了 <${tag}>，但定义它的「${elsewhere.name}」没被选中`);
            } else {
                warnings.push(`「${p.name}」引用了 <${tag}>，但整个预设里都没有这个标签的定义`);
            }
        }
    }
    return Array.from(new Set(warnings));
}

/** 条目里定义了的标签：<Tag>...</Tag> */
export function extractDefinedTags(text) {
    const out = [];
    const re = /<([A-Za-z][A-Za-z0-9_]*)\s*>[\s\S]*?<\/\1\s*>/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) out.push(m[1]);
    return out;
}

/** 条目里引用到的标签（含定义自身） */
export function extractUsedTags(text) {
    const out = [];
    const re = /<([A-Za-z][A-Za-z0-9_]*)\s*>/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) out.push(m[1]);
    return out;
}

/**
 * 给 UI 用的条目统计。
 */
export function presetStats() {
    const p = readPreset();
    const withContent = p.prompts.filter(x => x.hasContent);
    return {
        name: p.name,
        source: p.source,
        error: p.error,
        total: p.prompts.length,
        hasContent: withContent.length,
        enabled: p.prompts.filter(x => x.enabled).length,
        enabledWithContent: withContent.filter(x => x.enabled).length,
        totalChars: p.prompts.reduce((s, x) => s + x.contentLength, 0),
        enabledChars: p.prompts.filter(x => x.enabled).reduce((s, x) => s + x.contentLength, 0),
    };
}

/**
 * 启动时把预设信息记进日志 —— 让用户一眼看到读到了什么。
 */
export function reportPreset() {
    const st = presetStats();
    logInfo(`预设「${st.name}」来源=${st.source}｜条目 ${st.total} 条（有正文 ${st.hasContent}，已开启 ${st.enabled}）｜正文合计 ${st.totalChars} 字`, 'preset');
    if (st.error) logWarn(st.error, 'preset');
    return st;
}
