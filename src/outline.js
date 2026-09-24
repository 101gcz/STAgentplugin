/**
 * outline.js — 大纲生成（含防递归）+ 连接方式
 * ============================================================
 * 【为什么必须防递归】
 * 我读过酒馆源码，确认了这条调用链：
 *
 *   ctx.generateRaw()            script.js:4063
 *     → generateRawData()        script.js:3941
 *       → sendOpenAIRequest()    script.js:4012  ← 就是这里
 *         → eventSource.emit(CHAT_COMPLETION_SETTINGS_READY, generate_data)
 *                                                  openai.js:3052
 *
 * 也就是说：我们为了生成大纲而发的请求，会再次触发我们自己的
 * 拦截器。不挡就是无限套娃。
 *
 * 本版用「正在生成标记 + 时间戳」表达身份，不用时间去猜：
 *   · begin() 置位，end() 复位（finally 保证一定复位）
 *   · 拦截器一进来就问 isGenerating()，是就立刻放行
 *   · 加一个硬超时兜底，防止异常路径把标记永久卡住
 *
 * 【两种连接方式，各自的依据】
 * 1) current —— 沿用酒馆当前聊天补全来源，只临时改写
 *    chatCompletionSettings 里的「模型名」和「推理设置」，生成完还原。
 *    依据：openai.js:1698 getChatCompletionModel() 按来源取
 *    xxx_model 字段；openai.js:2518 getReasoningEffort() 读
 *    settings.reasoning_effort。
 *    ★ 推理强度还要分写法：来源是 DeepSeek 时酒馆会把 low/medium/high
 *      统一折算成 high（openai.js getReasoningEffort 的 DEEPSEEK 分支），
 *      所以插件按 DeepSeek 的写法在「请求体」上定稿
 *      （见 applyOwnRequestReasoning）。
 *
 * 2) custom —— 插件指定来源 + URL + Key + 模型。
 *    必须走酒馆助手的 generateRaw(custom_api)，依据：
 *      · 酒馆 1.18.0 原生 generateRaw 的签名里没有 custom_api
 *        （public/script.js:4063 实测）
 *      · 酒馆助手 JS-Slash-Runner 的 generateRaw 接受 custom_api
 *        { apiurl, key, model, source, max_tokens, ... }
 *        （@types/function/generate.d.ts:377-411）
 *    没有酒馆助手时自动退回 current，并在日志里说明原因 ——
 *    绝不假装用了你填的 URL。
 */

import {
    PROVIDERS, CONN_MODE,
    REASONING_LEVELS, REASONING_LEVELS_BY_SYNTAX, REASONING_ALIASES, REASONING_SYNTAX,
    SYSTEM_BLOCKS,
} from './constants.js';
import {
    ctx, tavernHelper, logInfo, logWarn, logError, errorText,
    estimateTokens, fmtNum, stopGeneration,
} from './env.js';
import { get as getSettings } from './settings.js';

// ============================================================
// 防递归闸门
// ============================================================

let generating = false;
let generatingSince = 0;
/** 兜底：超过这个时间还卡着就强制复位，避免异常路径把插件锁死 */
const GUARD_MAX_MS = 5 * 60 * 1000;

/** 当前是否正在生成大纲（防递归的唯一判据） */
export function isGenerating() {
    if (!generating) return false;
    if (Date.now() - generatingSince > GUARD_MAX_MS) {
        logWarn('防递归标记卡住超过 5 分钟，已强制复位', 'outline');
        generating = false;
        return false;
    }
    return true;
}

export function guardState() {
    return { generating, elapsedMs: generating ? Date.now() - generatingSince : 0 };
}

function beginGenerate() {
    generating = true;
    generatingSince = Date.now();
}

function endGenerate() {
    generating = false;
    generatingSince = 0;
}

// ============================================================
// Prompt 组装
// ============================================================

/**
 * 用模板拼系统提示。
 *
 * 占位符替换用「函数形式」而不是字符串，避免内容里出现
 * $& / $' / $` 时被 JS 当成替换模式展开（原版有这个坑）。
 *
 * 关于素材块 / 白名单条目（同一个规则）：
 *   模板里写了占位符 → 按你写的位置放；
 *   模板里没写、但那一块有内容 → 自动追加到末尾（附【标题】）；
 *   块被关掉或没有内容 → 留空，并把「下面什么都没有的【标题】」整行丢掉，
 *   免得提示词里顶着一串空标题浪费 tokens。
 *
 * 关于 p.template（v3.7.7 改的语义）：
 *   它就是**整份大纲提示词** —— 面板那个框里写什么，这里就收到什么。
 *   ============================================================
 *   以前插件内置一份 DEFAULT_TEMPLATE 当底，框里的内容只是「追加在底后面」，
 *   于是「发出去的到底是什么」永远看不见。现在没有底模板了：
 *   框里空 = 提示词为空（只剩下面那条自动补齐规则补进来的素材块）。
 *
 * 自动补齐规则（跟有没有模板无关，一直都在）：
 *   模板里没写占位符、但那一块确实有内容 → 追加到末尾（附【标题】）。
 *   这条是防静默丢内容的保险：trim.js 只按白名单把「只给大纲」的条目
 *   从主模型请求里删掉，不看你写了什么模板；提示词里要是也没有，
 *   那些条目就两边都没有了。
 *
 * @param {{
 *   blocks?: Record<string,string>,   // history / worldInfo / charCard / persona / examples
 *   presetBlock?: string,
 *   charName?: string,
 *   userName?: string,
 *   template?: string,   // 整份大纲提示词
 * }} p
 */
export function buildSystemPrompt(p) {
    const tpl = String(p.template == null ? '' : p.template);
    const blocks = p.blocks || {};

    const map = {
        chat_history: blocks.history || '',
        world_info: blocks.worldInfo || '',
        char_card: blocks.charCard || '',
        persona: blocks.persona || '',
        examples: blocks.examples || '',
        preset_entries: p.presetBlock || '（无）',
        char: p.charName || '(角色)',
        user: p.userName || '(用户)',
    };

    let out = tpl.replace(
        /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
        (whole, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : whole),
    );
    out = dropEmptySections(out);

    // 模板里没写位置、但确实有内容的东西 → 追加到末尾
    const extra = [];

    /**
     * 白名单条目也按这个规则补。
     *
     * 为什么必须补：trim.js 把「只给大纲」的条目从主模型请求里删掉时
     * **只看白名单，不看模板**。如果模板里少了 {{preset_entries}}、
     * 这里又不补，那些条目就两边都没有了 —— 从主模型删掉、又没给大纲模型，
     * 这是静默丢内容，比不删还糟。
     */
    if (!/\{\{\s*preset_entries\s*\}\}/.test(tpl)) {
        const picked = String(p.presetBlock || '').trim();
        if (picked) extra.push(`【预设条目】\n${picked}`);
    }

    for (const b of SYSTEM_BLOCKS) {
        if (new RegExp('\\{\\{\\s*' + b.pl + '\\s*\\}\\}').test(tpl)) continue;
        const v = String(map[b.pl] || '').trim();
        if (v) extra.push(`【${b.label}】\n${v}`);
    }
    if (extra.length) out = out.trim() + '\n\n' + extra.join('\n\n');

    return out.trim();
}

/**
 * 把「只有【标题】、下面没有任何内容」的标题行删掉，
 * 再收掉多余空行。正常模板不受影响（有内容的标题都留着）。
 */
function dropEmptySections(text) {
    const lines = String(text).split('\n');
    const heading = /^\s*【[^】]{1,24}】\s*$/;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (heading.test(lines[i])) {
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            // 后面已经没内容、或者紧跟着另一个标题 → 这个标题是空的，丢掉
            if (j >= lines.length || heading.test(lines[j])) continue;
        }
        out.push(lines[i]);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ============================================================
// 连接方式：来源预设 / 实际 URL / 说明文字
// ============================================================

/** 某个来源的预设项（未知来源一律当自定义） */
export function providerConfig(key) {
    return PROVIDERS[key] || PROVIDERS.custom;
}

/** 酒馆当前聊天补全来源（deepseek / openai / custom …） */
export function currentSource() {
    const c = ctx();
    const st = c && c.chatCompletionSettings;
    const s = (st && st.chat_completion_source) || '';
    return typeof s === 'string' ? s : '';
}

/**
 * 自定义模式下实际会用的 URL。
 * 手填优先；留空则回落到该来源的官方地址（这就是「自带 URL」）。
 */
export function effectiveUrl(s) {
    const cfg = providerConfig(s && s.provider);
    return String((s && s.manualUrl) || '').trim() || cfg.url || '';
}

/** 这个来源的模型清单：拉取到的优先，其次内置 */
export function modelChoices(s) {
    const cfg = providerConfig(s && s.provider);
    const fetched = (s && s.modelList && Array.isArray(s.modelList[cfg.key])) ? s.modelList[cfg.key] : [];
    const seen = new Set();
    const out = [];
    for (const m of fetched.concat(cfg.models || [])) {
        const name = String(m || '').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}

/**
 * 一句话说明这一轮会怎么发请求。界面和日志都用它，
 * 避免「面板显示 A、实际请求是 B」这种最坑人的情况。
 */
export function describePlan(s) {
    const st = s || getSettings();
    const cfg = providerConfig(st.provider);
    const th = tavernHelper();
    const hasTh = !!(th && typeof th.generateRaw === 'function');
    const lvl = levelLabel(reasoningLevelFor(st, st.reasoningLevel), st);

    if (st.connMode === 'custom') {
        const url = effectiveUrl(st) || '(未填 URL)';
        const tail = hasTh ? '' : '｜⚠️ 没装酒馆助手，将退回沿用酒馆当前来源';
        return `自定义连接：${cfg.label}｜URL ${url}｜模型 ${st.model || '(该来源当前模型)'}` +
            `｜推理 ${lvl}${tail}`;
    }
    return `沿用酒馆当前来源（${currentSource() || '未知'}）｜模型 ${st.model || '(当前模型)'}｜` +
        `推理 ${lvl}`;
}

/** 档位 key → 该来源写法下的中文标签 */
function levelLabel(key, s) {
    const list = reasoningLevelsFor(s);
    const x = list.find(v => v.key === key);
    if (x) return x.label;
    const y = REASONING_LEVELS.find(v => v.key === key);
    return y ? y.label : key;
}

// ============================================================
// 思维链强度：按来源选写法（通用 / DeepSeek）
// ============================================================

/**
 * 这一轮大纲请求实际会打到哪个来源。
 *   custom  → 插件指定的那个来源（provider）
 *   current → 酒馆当前聊天补全来源
 * @returns {string} 来源名，例如 'deepseek' / 'custom' / 'openai'；拿不到返回 ''
 */
export function reasoningTargetSource(s) {
    const st = s || getSettings();
    if (st.connMode === CONN_MODE.CUSTOM) return providerConfig(st.provider).source;
    return currentSource();
}

/** 这个来源该用哪套思维链写法 */
export function reasoningSyntaxOf(source) {
    return String(source || '').trim().toLowerCase() === REASONING_SYNTAX.DEEPSEEK
        ? REASONING_SYNTAX.DEEPSEEK
        : REASONING_SYNTAX.GENERIC;
}

/** 当前配置下的思维链写法 */
export function reasoningSyntax(s) {
    return reasoningSyntaxOf(reasoningTargetSource(s));
}

/** 当前来源的档位表（界面拿它画下拉） */
export function reasoningLevelsFor(s) {
    return REASONING_LEVELS_BY_SYNTAX[reasoningSyntax(s)] || REASONING_LEVELS;
}

/**
 * 把存下来的档位换算成当前来源认识的档位。
 * 例：来源换成 DeepSeek 之后，旧的 'min' 不在它的写法里 → low。
 * @returns {string} 一定能在 reasoningLevelsFor() 里找到的 key
 */
export function reasoningLevelFor(s, key) {
    const list = reasoningLevelsFor(s);
    const k = String(key == null ? '' : key).trim();
    if (list.some(x => x.key === k)) return k;
    const alias = (REASONING_ALIASES[reasoningSyntax(s)] || {})[k];
    if (alias && list.some(x => x.key === alias)) return alias;
    // 认不出来就退回「不改」—— 宁可不动酒馆设置，也不要乱发一个来源不认识的值
    return (list[0] && list[0].key) || 'keep';
}

/**
 * 插件自己的大纲请求要不要在发出去之前改思维链设置。
 * null = 不改（通用来源走酒馆自己的换算，一切照旧）。
 * @type {{source:string, effort:string, forceThinking:boolean}|null}
 */
let ownReasoning = null;

/**
 * 把思维链设置套用到「插件自己发的那一份请求」上。
 * ============================================================
 * 必须在酒馆发出请求前改 generate_data，而不是只改酒馆设置：
 *   · 酒馆对 deepseek 来源会把 low/medium/high 统一折算成 high
 *     （openai.js getReasoningEffort 的 DEEPSEEK 分支），只写设置选不动；
 *   · DeepSeek 只有在 include_reasoning 为真时，后端才会把
 *     reasoning_effort 转发出去（chat-completions.js 的 deepseek 分支：
 *     `if (request.body.include_reasoning && request.body.reasoning_effort)`，
 *     同时它按 include_reasoning 写 'thinking': { type: enabled/disabled }）。
 * 所以这里一次把两件事做掉：发准时值 + 把思考打开。
 *
 * 只作用于我们自己的请求（调用点是防递归闸门里那条「放行自有请求」），
 * 主模型的请求一个字节都不碰。
 *
 * @param {object} generateData 酒馆即将发出的请求体
 * @returns {{source:string, effort:string}|null} 实际改成了什么；没改返回 null
 */
export function applyOwnRequestReasoning(generateData) {
    if (!ownReasoning || !generateData || typeof generateData !== 'object') return null;

    const src = String(generateData.chat_completion_source || '');
    if (src && ownReasoning.source && src !== ownReasoning.source) {
        logWarn(`思维链强度没有生效：这一轮请求的来源是 "${src}"，` +
            `而设置是按 "${ownReasoning.source}" 的写法算的`, 'outline');
        return null;
    }

    const applied = { source: src || ownReasoning.source, effort: ownReasoning.effort };
    if (ownReasoning.effort === 'auto') {
        // DeepSeek 的「自动」= 干脆不发这一项，让模型自己定
        delete generateData.reasoning_effort;
        applied.effort = '(不发这一项)';
    } else {
        generateData.reasoning_effort = ownReasoning.effort;
    }

    if (ownReasoning.forceThinking && generateData.include_reasoning !== true) {
        // 不开这个，DeepSeek 后端根本不会看 reasoning_effort
        generateData.include_reasoning = true;
    }
    return applied;
}

/** 仅供自检/调试：当前有没有挂着思维链覆盖 */
export function ownReasoningState() {
    return ownReasoning ? Object.assign({}, ownReasoning) : null;
}

// ============================================================
// 临时覆盖（模型名 + 推理设置）
// ============================================================

/**
 * 酒馆把「当前聊天补全源对应的模型名」放在 chatCompletionSettings
 * 的不同字段里。这张表来自 openai.js:1698 的 getChatCompletionModel()：
 *
 *   switch (settings.chat_completion_source) {
 *     case CLAUDE:    return settings.claude_model;
 *     case OPENAI:    return settings.openai_model;
 *     case CUSTOM:    return settings.custom_model;
 *     ...
 *     case DEEPSEEK:  return settings.deepseek_model;
 *   }
 *
 * context 把 oai_settings 暴露成 ctx.chatCompletionSettings，
 * 所以 ctx.chatCompletionSettings[字段] = 模型名 就能改。
 */
const MODEL_FIELD_BY_SOURCE = {
    claude: 'claude_model',
    openai: 'openai_model',
    makersuite: 'google_model',
    vertexai: 'vertexai_model',
    openrouter: 'openrouter_model',
    ai21: 'ai21_model',
    mistralai: 'mistralai_model',
    custom: 'custom_model',
    cohere: 'cohere_model',
    perplexity: 'perplexity_model',
    groq: 'groq_model',
    xai: 'xai_model',
    deepseek: 'deepseek_model',
    moonshot: 'moonshot_model',
    fireworks: 'fireworks_model',
    cometapi: 'cometapi_model',
    electronhub: 'electronhub_model',
    aimlapi: 'aimlapi_model',
    pollinations: 'pollinations_model',
};

/**
 * 生成模型名所在的字段名（按来源）。
 * @returns {string} 字段名；未知来源返回空串
 */
export function modelFieldFor(source) {
    return MODEL_FIELD_BY_SOURCE[source] || '';
}

/**
 * 临时改写酒馆设置，生成完必须还原。
 *
 * 覆盖两项：
 *   · 当前来源的模型名字段（想换便宜模型）
 *   · reasoning_effort（思维链强度），依据 openai.js:2518：
 *     该值会被写进 generate_data.reasoning_effort 发给后端。
 *     DeepSeek 分支只放行 自动/最高，其余档位折算成 high（openai.js:2548），
 *     所以来源是 DeepSeek 时真正的值由 applyOwnRequestReasoning() 定稿
 *     （那边还要一并把 thinking 打开，否则后端不看 reasoning_effort）。
 *
 * @returns {{restore: () => void, changed: string[]}}
 */
function applyTempOverrides(s, opts = {}) {
    const changed = [];
    /** 本轮的还原清单。必须是局部的：模块级会串轮。 */
    const restoreList = [];
    const c = ctx();
    const settings = c && c.chatCompletionSettings;
    if (!settings || typeof settings !== 'object') {
        if (opts.needModel) {
            logWarn('无法覆盖模型：context.chatCompletionSettings 不可用（将使用酒馆当前模型）', 'outline');
        }
        return { restore() { }, changed };
    }

    const source = settings.chat_completion_source;

    // ---- 1. 模型名 ----
    // 自定义连接由 custom_api 带模型，不在这里改，避免和它打架。
    const model = String(s.model || '').trim();
    if (opts.needModel && model && source) {
        const field = MODEL_FIELD_BY_SOURCE[source];
        if (!field) {
            logWarn(`无法覆盖模型：未知的聊天补全来源 "${source}"（大纲将使用当前模型）`, 'outline');
        } else {
            const before = settings[field];
            if (before === model) {
                logInfo(`模型已是 ${model}，无需覆盖`, 'outline');
            } else {
                try {
                    settings[field] = model;
                    changed.push(`${field}: "${before || '(空)'}" → "${model}"`);
                    restoreList.push({ holder: settings, field, before });
                } catch (e) {
                    logWarn('覆盖模型失败: ' + errorText(e), 'outline');
                }
            }
        }
    }

    // ---- 2. 思维链强度 ----
    // 'keep' = 不改酒馆的设置。只留一个下拉，选别的档位就生效。
    // 值按「这一轮要打到哪个来源」的写法换算：来源是 DeepSeek 就发 DeepSeek 认的
    // 档位（没有 minimum），别的来源保持酒馆 / OpenAI 兼容那套，一个字节都不变。
    const level = reasoningLevelFor(s, s.reasoningLevel);
    const targetSource = reasoningTargetSource(s);
    const syntax = reasoningSyntaxOf(targetSource);
    if (s.reasoningLevel && s.reasoningLevel !== 'keep') {
        if (level !== s.reasoningLevel) {
            logInfo(`档位「${s.reasoningLevel}」不在 ${targetSource || '当前来源'} 的写法里，` +
                `本轮按「${level}」发`, 'outline');
        }

        const before = settings.reasoning_effort;
        if (before === level) {
            logInfo(`推理强度已是 ${level}，无需覆盖`, 'outline');
        } else {
            try {
                settings.reasoning_effort = level;
                changed.push(`reasoning_effort: "${before || '(空)'}" → "${level}"`);
                restoreList.push({ holder: settings, field: 'reasoning_effort', before });
            } catch (e) {
                logWarn('覆盖推理强度失败: ' + errorText(e), 'outline');
            }
        }

        /**
         * DeepSeek 走「请求体里定稿」这条路：上面那个字段还会被酒馆按
         * deepseek 分支折算，所以真正发出去的值在 applyOwnRequestReasoning()
         * 里定。通用来源不用管，酒馆自己会算。
         */
        if (syntax === REASONING_SYNTAX.DEEPSEEK) {
            ownReasoning = {
                source: targetSource,
                effort: level,
                forceThinking: level !== 'auto',
            };
        }
    }

    if (changed.length) logInfo('已临时覆盖：' + changed.join('｜'), 'outline');

    return {
        changed,
        restore() {
            // 后进的先还原，保证同一个字段被改两次也能回到最初的值
            for (let i = restoreList.length - 1; i >= 0; i--) {
                const it = restoreList[i];
                try {
                    it.holder[it.field] = it.before;
                } catch (e) {
                    // 还原失败是严重问题：用户的酒馆设置被改了。必须大声报出来。
                    logError(`★ 还原 ${it.field} 失败，你的酒馆设置可能已被改动，请手动检查: ` + errorText(e), 'outline');
                }
            }
            restoreList.length = 0;
            // 思维链覆盖只活一轮：还原时一并清掉，
            // 免得下一轮请求（或主模型那条路）捡到上一轮的残留。
            ownReasoning = null;
            if (changed.length) logInfo('已还原临时覆盖的设置', 'outline');
        },
    };
}

// ============================================================
// 调用模型
// ============================================================

class OutlineError extends Error {
    constructor(message, kind) {
        super(message);
        this.name = 'OutlineError';
        this.kind = kind || 'unknown';
        /**
         * 中断 / 报错之前已经流出来的正文。
         * 有了它，超时就不再等于「白等一场」：面板照样显示、照样能复制，
         * 只是这一轮不注入主模型。空串表示这次真的什么都没收到。
         */
        this.partial = '';
    }
}

/** 酒馆助手的生成接口（没有则 null） */
function helperGenerateRaw() {
    const th = tavernHelper();
    if (th && typeof th.generateRaw === 'function') {
        return (cfg) => th.generateRaw(cfg);
    }
    return null;
}

function helperStopById() {
    const th = tavernHelper();
    if (th && typeof th.stopGenerationById === 'function') {
        return (id) => th.stopGenerationById(id);
    }
    return null;
}

/**
 * 生成大纲。
 *
 * @param {string} systemPrompt
 * @param {{onStream?: (accumulated:string)=>void, onTick?: (elapsedMs:number)=>void}} [hooks]
 * @returns {Promise<{text:string, elapsedMs:number, chars:number, via:string}>}
 * @throws {OutlineError}
 */
export async function generateOutline(systemPrompt, hooks = {}) {
    const s = getSettings();
    const c = ctx();
    if (!c) throw new OutlineError('拿不到酒馆上下文', 'nocontext');

    const timeoutMs = Math.max(5, Number(s.timeoutSec) || 60) * 1000;
    const wantCustom = s.connMode === 'custom';
    const thRaw = helperGenerateRaw();
    const useCustomApi = wantCustom && !!thRaw;
    const via = useCustomApi ? 'custom' : 'tavern';

    if (wantCustom && !thRaw) {
        logWarn('自定义连接需要酒馆助手(JS-Slash-Runner)的 generateRaw，' +
            '当前没有 → 本轮退回沿用酒馆当前来源（你填的 URL/Key 本轮不生效）', 'outline');
    }

    if (!useCustomApi && typeof c.generateRaw !== 'function') {
        throw new OutlineError('context.generateRaw 不可用', 'nocontext');
    }

    // ---- 临时覆盖：自定义连接靠 custom_api 带模型，不需要改酒馆的模型字段 ----
    const override = applyTempOverrides(s, { needModel: !useCustomApi });

    // ---- 流式监听 ----
    // 顺便把已经流出来的正文存一份：超时 / 中途报错时，这份就是「已经生成的部分」。
    // 存的是流式回调每次给的**全文**，所以直接覆盖，不用自己拼。
    const streamBox = { text: '' };
    const streamOff = attachStream((acc) => {
        streamBox.text = String(acc == null ? '' : acc);
        if (hooks.onStream) {
            try { hooks.onStream(acc); } catch (e) { /* 回调出错不影响生成 */ }
        }
    }, useCustomApi, s.streaming);

    let tickTimer = null;
    let abortTimer = null;
    let request = null;
    let timedOut = false;      // 是「等超时了」还是「上游报错」，面板要分色显示

    beginGenerate();
    const t0 = Date.now();
    logInfo(`开始生成大纲｜${describePlan(s)}｜max_tokens=${s.maxTokens}｜超时 ${s.timeoutSec}s｜` +
        `prompt ${fmtNum(estimateTokens(systemPrompt))} tokens`, 'outline');

    try {
        if (hooks.onTick) {
            tickTimer = setInterval(() => {
                try { hooks.onTick(Date.now() - t0); } catch (e) { /* ignore */ }
            }, 1000);
        }

        /**
         * 超时兜底。
         *
         * 这里**不依赖**底层接口被中断后的行为：酒馆原生会 reject，
         * 而酒馆助手的 stopGenerationById 有可能带着「半截正文」正常 resolve。
         * 所以用 Promise.race 显式判负 —— 时间到就是我们这边输，
         * 顺便请求中断上游，别让它继续白烧 token。
         */
        let timeoutGuard = null;
        abortTimer = setTimeout(() => {
            timedOut = true;
            const keptChars = streamBox.text.length;
            logWarn(`大纲请求超过 ${s.timeoutSec}s，已请求中断` +
                (keptChars ? `（中断前已经收到 ${keptChars} 字，会保留）` : ''), 'outline');
            try { abortCurrent(request); } catch (e) { /* ignore */ }
            if (timeoutGuard) {
                const te = new OutlineError(`超过 ${s.timeoutSec}s 未返回，已中断`, 'timeout');
                // 已经流出来的部分跟着错误一起交出去，上面就不会清空它
                te.partial = streamBox.text;
                timeoutGuard.reject(te);
            }
        }, timeoutMs);
        timeoutGuard = deferred();

        request = useCustomApi
            ? buildHelperRequest(systemPrompt, s)
            : { prompt: [{ role: 'system', content: systemPrompt }], responseLength: s.maxTokens, api: null };

        const gen = useCustomApi ? thRaw(request) : c.generateRaw(request);
        // 超时判负之后，原始请求可能还会迟到地 reject —— 这里兜一下，
        // 免得变成「未处理的 Promise rejection」在控制台里刷屏
        if (gen && typeof gen.catch === 'function') gen.catch(() => { });

        const result = await Promise.race([gen, timeoutGuard.promise]);

        if (typeof result !== 'string') {
            // json_schema 场景会返回字符串；tool_calls 场景会返回对象。
            // 本版没启用 tools，出现非字符串说明上游行为变了。
            throw new OutlineError('生成接口返回了非字符串结果：' + (typeof result), 'badresult');
        }

        const text = result.trim();
        if (!text) throw new OutlineError('模型返回了空内容', 'empty');

        const elapsedMs = Date.now() - t0;
        logInfo(`大纲生成完成｜${text.length} 字｜${elapsedMs}ms｜≈${fmtNum(estimateTokens(text))} tokens`, 'outline');
        return { text, elapsedMs, chars: text.length, via };
    } catch (e) {
        const oe = errorToOutlineError(e, { timedOut, timeoutSec: s.timeoutSec });
        // 不管哪种失败，中断前已经流出来的正文都挂在错误上带走 —— 别丢。
        if (!oe.partial && streamBox.text) oe.partial = streamBox.text;
        if (oe.kind === 'timeout') logError(`大纲请求超过 ${s.timeoutSec}s 未返回，已中断`, 'outline');
        else if (!(e instanceof OutlineError)) logError('大纲请求异常: ' + errorText(e), 'outline');
        throw oe;
    } finally {
        clearTimeout(abortTimer);
        clearInterval(tickTimer);
        streamOff();
        override.restore();
        endGenerate();
        logInfo('防递归标记已复位', 'outline');
    }
}

/**
 * 自定义连接的请求体（酒馆助手格式）。
 * 依据 @types/function/generate.d.ts：
 *   ordered_prompts —— 提示词数组（相当于自定义预设）
 *   custom_api      —— apiurl / key / model / source / max_tokens
 *   should_stream   —— 流式
 *   generation_id   —— 身份标识，便于按 id 停止与过滤流式事件
 */
function buildHelperRequest(systemPrompt, s) {
    const cfg = providerConfig(s.provider);
    const url = effectiveUrl(s);
    const key = String(s.manualKey || '').trim();

    /** @type {Record<string, any>} */
    const custom_api = {
        source: cfg.source,
        model: String(s.model || '').trim() || undefined,
        max_tokens: Number(s.maxTokens) || undefined,
    };
    if (url) custom_api.apiurl = url;
    if (key) custom_api.key = key;

    return {
        ordered_prompts: [{ role: 'system', content: systemPrompt }],
        custom_api,
        should_stream: s.streaming !== false,
        should_silence: false,
        generation_id: `dro-outline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
}

/**
 * 一个可以从外面 resolve / reject 的 Promise。
 * 超时判负需要一个「由定时器来 reject」的 promise，所以单独这里做一个。
 */
function deferred() {
    const box = {};
    box.promise = new Promise((resolve, reject) => {
        box.resolve = resolve;
        box.reject = reject;
    });
    return box;
}

/** 按当前计划中断生成 */
function abortCurrent(request) {    const id = request && request.generation_id;
    const stopById = helperStopById();
    if (id && stopById) {
        try { stopById(id); return; } catch (e) { /* 退回酒馆原生 */ }
    }
    stopGeneration();
}

/**
 * 订阅流式输出。两条通道都试：
 *   · 酒馆原生 STREAM_TOKEN_RECEIVED（增量文本）
 *   · 酒馆助手 iframe_events.STREAM_TOKEN_RECEIVED_FULLY（完整文本）
 * 用完必须成对注销 —— 原版就是漏了这一步导致监听器无限泄漏。
 *
 * @returns {() => void} 注销函数
 */
function attachStream(onStream, useCustomApi, streaming) {
    if (!onStream || !streaming) return () => { };
    const offs = [];
    const c = ctx();
    const source = c && c.eventSource;
    const types = c && c.eventTypes;

    if (source && types && types.STREAM_TOKEN_RECEIVED && typeof source.on === 'function') {
        const acc = { text: '' };
        const handler = (text) => {
            acc.text += String(text == null ? '' : text);
            try { onStream(acc.text); } catch (e) { /* 回调出错不影响生成 */ }
        };
        try {
            source.on(types.STREAM_TOKEN_RECEIVED, handler);
            offs.push(() => { try { source.removeListener(types.STREAM_TOKEN_RECEIVED, handler); } catch (e) { /* ignore */ } });
        } catch (e) {
            logWarn('注册流式监听失败: ' + errorText(e), 'outline');
        }
    }

    // 酒馆助手的流式事件给的是「完整文本」，直接用，不要再累加
    if (useCustomApi) {
        const th = tavernHelper();
        const iev = th && th.iframe_events;
        if (source && iev && iev.STREAM_TOKEN_RECEIVED_FULLY && typeof source.on === 'function') {
            const handler = (full) => {
                try { onStream(String(full == null ? '' : full)); } catch (e) { /* ignore */ }
            };
            try {
                source.on(iev.STREAM_TOKEN_RECEIVED_FULLY, handler);
                offs.push(() => { try { source.removeListener(iev.STREAM_TOKEN_RECEIVED_FULLY, handler); } catch (e) { /* ignore */ } });
            } catch (e) {
                logWarn('注册酒馆助手流式监听失败: ' + errorText(e), 'outline');
            }
        }
    }

    return () => { for (const off of offs) off(); };
}

// ============================================================
// 模型列表
// ============================================================

/**
 * 拉取模型清单。
 *
 * 路径一：酒馆自己的 /api/backends/chat-completions/status
 *   依据 chat-completions.js:1735 —— 不传 reverse_proxy 时，
 *   后端会用你在酒馆里存的那个来源的密钥去 ${apiUrl}/models，
 *   所以「沿用当前来源」也能刷出列表，不需要密钥进插件配置。
 *   传了 reverse_proxy + proxy_password 就用你填的地址与钥匙。
 *
 * 路径二：酒馆助手 getModelList({ apiurl, key })
 *
 * 两条都失败就返回内置清单，并说明原因 —— 不静默。
 *
 * @returns {Promise<{ok:boolean, models:string[], source:string, error:string}>}
 */
export async function fetchModelList(sIn) {
    const s = sIn || getSettings();
    const cfg = providerConfig(s.provider);
    const fallback = (cfg.models || []).slice();

    // ---- 路径一 ----
    try {
        const models = await fetchModelListViaTavern(s, cfg);
        if (models.length) {
            logInfo(`已从酒馆后端取回 ${models.length} 个模型（${cfg.label}）`, 'outline');
            return { ok: true, models, source: 'tavern', error: '' };
        }
    } catch (e) {
        logWarn('从酒馆后端取模型列表失败: ' + errorText(e), 'outline');
    }

    // ---- 路径二 ----
    try {
        const th = tavernHelper();
        if (th && typeof th.getModelList === 'function') {
            const url = effectiveUrl(s);
            const key = String(s.manualKey || '').trim();
            const models = await th.getModelList({ apiurl: url, key: key || undefined });
            if (Array.isArray(models) && models.length) {
                const list = models.map(m => String(m || '').trim()).filter(Boolean);
                logInfo(`酒馆助手取回 ${list.length} 个模型`, 'outline');
                return { ok: true, models: list, source: 'tavern_helper', error: '' };
            }
        }
    } catch (e) {
        logWarn('酒馆助手取模型列表失败: ' + errorText(e), 'outline');
    }

    return {
        ok: false, models: fallback, source: 'builtin',
        error: fallback.length ? '拉取失败，已退回内置清单' : '拉取失败，且该来源没有内置清单',
    };
}

async function fetchModelListViaTavern(s, cfg) {
    const c = ctx();
    if (typeof fetch !== 'function') throw new Error('当前环境没有 fetch');

    const st = c && c.chatCompletionSettings;
    const useCustom = s.connMode === 'custom';
    const source = useCustom ? cfg.source : (currentSource() || cfg.source);
    const url = effectiveUrl(s);
    const key = String(s.manualKey || '').trim();

    /** @type {Record<string, any>} */
    const body = { chat_completion_source: source };

    if (source === 'custom') {
        // 自定义来源：后端只认 custom_url + 请求头里的钥匙
        const customUrl = useCustom ? url : String((st && st.custom_url) || url || '');
        if (customUrl) body.custom_url = customUrl;
        if (useCustom && key) body.custom_include_headers = { Authorization: 'Bearer ' + key };
    } else if (useCustom && url) {
        // 其余来源：reverse_proxy + proxy_password 就是「自带 URL + Key」
        body.reverse_proxy = url;
        body.proxy_password = key;
    }

    const headers = Object.assign(
        { 'Content-Type': 'application/json' },
        (c && typeof c.getRequestHeaders === 'function') ? c.getRequestHeaders() : {},
    );

    const res = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);

    const json = await res.json();
    const raw = (json && Array.isArray(json.data)) ? json.data : [];
    return raw
        .map(item => (typeof item === 'string' ? item : (item && item.id)))
        .map(x => String(x || '').trim())
        .filter(Boolean);
}

// ============================================================
// 连接配置（只读，给界面做提示用）
// ============================================================

/**
 * 列出可用的连接配置（给设置界面用）。
 * 走酒馆核心的 ConnectionManagerRequestService。
 */
export function listConnectionProfiles() {
    const c = ctx();
    const out = [];
    try {
        const cm = c && c.extensionSettings && c.extensionSettings.connectionManager;
        const profiles = (cm && Array.isArray(cm.profiles)) ? cm.profiles : [];
        for (const p of profiles) {
            out.push({ id: p.id, name: p.name || p.id, api: p.api || '', model: p.model || '' });
        }
    } catch (e) {
        logWarn('读取连接配置失败: ' + errorText(e), 'outline');
    }
    return out;
}

export { OutlineError };

/**
 * 异常 → OutlineError 的分类。
 *
 * 抽成独立函数有两个原因：
 *   · 「超时中断」和「上游报错」要分开报 —— 面板靠 kind 决定亮黄灯还是红灯；
 *   · 自检里可以直接验证这个判断，不用真的等满 timeoutSec（最低 5 秒）。
 *
 * @param {*} e 捕获到的异常
 * @param {{timedOut?: boolean, timeoutSec?: number}} [ctx]
 * @returns {OutlineError}
 */
export function errorToOutlineError(e, ctx = {}) {
    if (e instanceof OutlineError) return e;
    if (ctx.timedOut) {
        return new OutlineError(`超过 ${ctx.timeoutSec || 60}s 未返回，已中断`, 'timeout');
    }
    return new OutlineError(errorText(e), 'request');
}
