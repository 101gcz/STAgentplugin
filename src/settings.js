/**
 * settings.js — 配置读写
 * ============================================================
 * 存进酒馆原生 extensionSettings[EXT_ID]，走 saveSettingsDebounced 落盘。
 * 这样配置可以在酒馆的设置面板里看到，也符合扩展惯例。
 *
 * 关键设计：
 *   · 每次 get 都把 DEFAULTS 合并进来 —— 加新设置项不需要写迁移代码，
 *     老配置自动补齐，新配置项立刻可用。
 *   · 未知字段保留不删。这样降级版本再升回来不会丢配置。
 *   · 所有写操作都过一遍 normalize，避免外部把类型写坏
 *     （比如把 maxTokens 存成字符串）。
 */

import { DEFAULTS, EXT_ID, LEGACY_EXT_IDS, TEMPLATE_PLACEHOLDERS, PROVIDERS, REASONING_LEVELS, SYSTEM_BLOCKS } from './constants.js';
import { ctx, logWarn, logInfo, errorText, persistSettings, safe } from './env.js';

export const PANEL_TABS = ['status', 'api', 'whitelist', 'log', 'about'];

/** 设置变更订阅者（UI 用来同步显示） */
const watchers = new Set();

/**
 * 配置存储位置：extensionSettings[EXT_ID]。
 *
 * 顺带做改名迁移：EXT_ID 从「五号预设Agent插件」改成「四号预设Agent插件」之后，
 * 老配置还躺在老 key 下面。这里在新 key 还是空的时候整份搬过来，
 * 免得改个目录名就把白名单 / 素材开关全清零。
 * 只在「新 key 不存在或没有字段」时才搬，所以不会盖掉新配置。
 */
function bucket() {
    const c = ctx();
    if (!c || !c.extensionSettings) return null;

    const cur = c.extensionSettings[EXT_ID];
    if (!cur || typeof cur !== 'object' || !Object.keys(cur).length) {
        for (const oldId of LEGACY_EXT_IDS) {
            if (oldId === EXT_ID) continue;
            const prev = c.extensionSettings[oldId];
            if (prev && typeof prev === 'object' && Object.keys(prev).length) {
                c.extensionSettings[EXT_ID] = Object.assign({}, prev);
                logInfo(`检测到旧扩展 id「${oldId}」下的配置，已整份迁移到「${EXT_ID}」` +
                    '（旧的那份保留着，没删）', 'settings');
                break;
            }
        }
    }

    if (!c.extensionSettings[EXT_ID] || typeof c.extensionSettings[EXT_ID] !== 'object') {
        c.extensionSettings[EXT_ID] = {};
    }
    return c.extensionSettings[EXT_ID];
}

/**
 * 读配置（已合并默认值）。
 * @returns {typeof DEFAULTS}
 */
export function get() {
    const b = safe('settings.get', () => bucket(), null);
    const stored = (b && typeof b === 'object') ? b : {};
    // 浅合并即可：DEFAULTS 全是标量或对象字面量，
    // presetWhitelist / presetBlocks / modelList 单独保证是对象
    const merged = Object.assign({}, DEFAULTS, stored);
    if (!merged.presetWhitelist || typeof merged.presetWhitelist !== 'object' || Array.isArray(merged.presetWhitelist)) {
        merged.presetWhitelist = {};
    }
    if (!merged.presetBlocks || typeof merged.presetBlocks !== 'object' || Array.isArray(merged.presetBlocks)) {
        merged.presetBlocks = {};
    }
    if (!merged.modelList || typeof merged.modelList !== 'object' || Array.isArray(merged.modelList)) {
        merged.modelList = {};
    }
    // template = 整份大纲提示词（v3.7.7 起没有内置底模板了）。
    // 这里只保证它是字符串；空串是合法值（= 提示词为空），不要拿任何东西顶上。
    if (typeof merged.template !== 'string') merged.template = DEFAULTS.template;
    return normalize(migrate(merged, stored));
}

/**
 * 老配置迁移。
 * v3.0 用的是 apiMode（'profile' | 'current' | 'manual'）+ manualSource，
 * v3.1 换成 connMode（'current' | 'custom'）+ provider。
 * 只在老配置里没有新字段时才动，避免覆盖用户已经改过的新值。
 */
function migrate(merged, stored) {
    const has = (k) => stored && Object.prototype.hasOwnProperty.call(stored, k);

    if (!has('connMode')) {
        // v3.0 的 manual 模式 = 现在的自定义连接
        merged.connMode = (stored && stored.apiMode === 'manual') ? 'custom' : 'current';
    }
    if (!has('provider') && stored && typeof stored.manualSource === 'string' && PROVIDERS[stored.manualSource]) {
        merged.provider = stored.manualSource;
    }
    return merged;
}

/**
 * 写入部分字段并落盘。
 * @param {Partial<typeof DEFAULTS>} patch
 */
export function set(patch) {
    const b = safe('settings.set', () => bucket(), null);
    if (!b) {
        logWarn('无法写入配置：extensionSettings 不可用', 'settings');
        return get();
    }
    Object.assign(b, patch || {});
    persistSettings();
    const next = get();
    for (const fn of watchers) {
        try { fn(next); } catch (e) { /* ignore */ }
    }
    return next;
}

/** 订阅配置变更 */
export function watch(fn) {
    watchers.add(fn);
    return () => watchers.delete(fn);
}

/**
 * 把配置规整到合法范围。任何外部来源的值都要过这里。
 */
export function normalize(s) {
    const out = Object.assign({}, s);

    out.enabled = out.enabled !== false;

    out.maxTokens = clampInt(out.maxTokens, 128, 65536, DEFAULTS.maxTokens);
    out.timeoutSec = clampInt(out.timeoutSec, 5, 900, DEFAULTS.timeoutSec);
    out.streaming = out.streaming !== false;

    out.barOpacity = clampFloat(out.barOpacity, 0.1, 1, DEFAULTS.barOpacity);
    out.collapsed = out.collapsed !== false;
    out.showBar = out.showBar !== false;
    out.panelOpen = out.panelOpen === true;
    out.panelTab = PANEL_TABS.includes(out.panelTab) ? out.panelTab : 'status';

    out.panelX = clampOrNull(out.panelX, -10000, 10000);
    out.panelY = clampOrNull(out.panelY, -10000, 10000);
    out.panelW = clampOrNull(out.panelW, 320, 4000);
    out.panelH = clampOrNull(out.panelH, 240, 4000);

    if (!['current', 'custom'].includes(out.connMode)) out.connMode = DEFAULTS.connMode;
    if (!PROVIDERS[out.provider]) out.provider = DEFAULTS.provider;
    if (!REASONING_LEVELS.some(x => x.key === out.reasoningLevel)) out.reasoningLevel = DEFAULTS.reasoningLevel;

    out.profileId = str(out.profileId);
    out.model = str(out.model);
    out.manualUrl = str(out.manualUrl);
    out.manualKey = str(out.manualKey);
    out.modelList = normalizeModelList(out.modelList);
    out.systemBlocks = normalizeLegacyBlocks(out.systemBlocks);
    out.presetBlocks = normalizePresetBlocks(out.presetBlocks);

    out.trimHistory = out.trimHistory === true;
    out.trimKeepRounds = clampInt(out.trimKeepRounds, 1, 100, DEFAULTS.trimKeepRounds);
    // 旧字段：不再参与裁剪，只保证它还是个数，别让老配置崩
    out.trimKeepFloors = clampInt(out.trimKeepFloors, 1, 200, DEFAULTS.trimKeepFloors);

    return out;
}

function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }

/** 白名单去向的合法值 —— 预设条目和素材块共用同一套 */
const VALID_TARGETS = ['outline', 'main', 'both'];

/** 素材块的默认去向：素材本来就是给大纲模型补的，默认「只给大纲」 */
const BLOCK_DEFAULT_TARGET = 'outline';

/**
 * 一条素材块的记录，兼容三种历史形态：
 *   true / false          —— v3.4 及以前（全局布尔；v3.5 的 presetBlocks 也是布尔）
 *   { enabled, target }   —— v3.5.1 起（跟预设条目同构）
 *   缺失 / 坏值           —— 默认：开着 + 只给大纲
 */
function normalizeBlockRecord(v) {
    if (v === true || v === false) return { enabled: v, target: BLOCK_DEFAULT_TARGET };
    const o = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    return {
        enabled: o.enabled !== false,
        target: VALID_TARGETS.includes(o.target) ? o.target : BLOCK_DEFAULT_TARGET,
    };
}

/**
 * 素材块开关：只留已知的键，每条规整成 { enabled, target }。
 * 缺失的键沿用默认（开着 + 只给大纲），这样加新块不用写迁移。
 */
function normalizeBlocks(v) {
    const src = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    const out = {};
    for (const b of SYSTEM_BLOCKS) {
        out[b.key] = normalizeBlockRecord(
            Object.prototype.hasOwnProperty.call(src, b.key) ? src[b.key] : true);
    }
    return out;
}

/**
 * 旧版的全局素材开关：**保持布尔**。
 * 它只是个历史字段，在「这个预设还没被单独配过」时当默认值用，
 * 所以别过 normalizeBlocks —— 那个产出的是 { enabled, target }。
 */
function normalizeLegacyBlocks(v) {
    const out = Object.assign({}, DEFAULTS.systemBlocks);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    for (const b of SYSTEM_BLOCKS) {
        if (Object.prototype.hasOwnProperty.call(v, b.key)) out[b.key] = v[b.key] !== false;
    }
    return out;
}

/**
 * 每个预设一套素材开关。键是预设名，值过一遍 normalizeBlocks。
 * 预设名理论上不会太多，但仍给个上限，避免坏配置把这里撑爆。
 */
const MAX_PRESET_BLOCK_RECORDS = 200;

function normalizePresetBlocks(v) {
    const out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    let n = 0;
    for (const k of Object.keys(v)) {
        if (n >= MAX_PRESET_BLOCK_RECORDS) break;
        const rec = v[k];
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
        out[String(k)] = normalizeBlocks(rec);
        n++;
    }
    return out;
}

/**
 * 取「某个预设下」素材块的实际配置（{ enabled, target }）。
 *
 * 三级取值，先到先用：
 *   1. presetBlocks[预设名]        —— 用户在这个预设下改过
 *   2. systemBlocks                —— 旧版的全局开关（升级前的选择）
 *   3. 默认                        —— 全新安装：全开 + 只给大纲
 *
 * 第 2 级是刻意的：老配置里用户可能关掉了世界书，升级后
 * 在任何一个预设下都应该还是关着的，而不是悄悄变回全开。
 * 这个预设一旦被点过一次（setBlockConfig 会把当前生效值 materialize
 * 进 presetBlocks），第 2 级就不再生效。
 *
 * @param {object} s settings.get() 的结果
 * @param {string} presetName 当前预设名
 */
export function blockConfigOf(s, presetName) {
    const all = (s && s.presetBlocks) || {};
    const name = str(presetName);
    const mine = name ? all[name] : null;
    if (mine && typeof mine === 'object' && !Array.isArray(mine)) return normalizeBlocks(mine);
    return normalizeBlocks((s && s.systemBlocks) || DEFAULTS.systemBlocks);
}

/** 这一条素材到底进不进大纲提示词 */
export function blockGoesToOutline(rec) {
    return !!rec && rec.enabled !== false && rec.target !== 'main';
}

/** 当前预设下素材块的实际配置 */
export function getBlockConfig(presetName) {
    return blockConfigOf(get(), presetName);
}

/**
 * 改某个预设下的素材块（只改传进来的那些键）。
 *
 * patch 每项可以是：
 *   布尔                —— 只改开关，去向保持原样
 *   { enabled?, target? } —— 部分字段也能改
 *
 * 写入时会把「当前生效值」整份存下来 —— 这一步同时完成了老配置迁移：
 * 老用户第一次动开关时，旧版的全局选择被固化进这个预设。
 */
export function setBlockConfig(presetName, patch) {
    const s = get();
    const all = JSON.parse(JSON.stringify(s.presetBlocks || {}));
    const name = str(presetName) || '(未知预设)';
    const next = blockConfigOf(s, name);
    const src = (patch && typeof patch === 'object') ? patch : {};

    for (const b of SYSTEM_BLOCKS) {
        if (!Object.prototype.hasOwnProperty.call(src, b.key)) continue;
        const cur = next[b.key] || { enabled: true, target: BLOCK_DEFAULT_TARGET };
        const p = src[b.key];
        if (p === true || p === false) {
            next[b.key] = { enabled: p, target: cur.target };
        } else if (p && typeof p === 'object' && !Array.isArray(p)) {
            next[b.key] = {
                enabled: Object.prototype.hasOwnProperty.call(p, 'enabled')
                    ? p.enabled !== false : cur.enabled,
                target: VALID_TARGETS.includes(p.target) ? p.target : cur.target,
            };
        }
    }

    all[name] = next;
    return set({ presetBlocks: all });
}

/**
 * 批量改某个预设下的素材 —— keys 里每个键都套同一份 patch，
 * 同样**只改传进来的字段**。和条目那边的 patchEntries 对称，
 * 界面上两组行的「全选 / 全清 / 统一设为」走的就是同一套语义。
 * @param {string} presetName
 * @param {string[]} blockKeys
 * @param {{enabled?: boolean, target?: string}} patch
 */
export function patchBlocks(presetName, blockKeys, patch) {
    const s = get();
    const all = JSON.parse(JSON.stringify(s.presetBlocks || {}));
    const name = str(presetName) || '(未知预设)';
    const next = blockConfigOf(s, name);
    const p = patch || {};
    const hasEnabled = Object.prototype.hasOwnProperty.call(p, 'enabled');
    const hasTarget = Object.prototype.hasOwnProperty.call(p, 'target');

    for (const key of (blockKeys || [])) {
        if (!SYSTEM_BLOCKS.some(b => b.key === key)) continue;
        const cur = next[key] || { enabled: true, target: BLOCK_DEFAULT_TARGET };
        next[key] = {
            enabled: hasEnabled ? p.enabled !== false : cur.enabled,
            target: (hasTarget && VALID_TARGETS.includes(p.target)) ? p.target : cur.target,
        };
    }

    all[name] = next;
    return set({ presetBlocks: all });
}

/** 该预设下几条素材会进大纲 / 一共几条 */
export function blockStatsOf(presetName) {
    const cfg = getBlockConfig(presetName);
    let on = 0;
    for (const b of SYSTEM_BLOCKS) if (blockGoesToOutline(cfg[b.key])) on++;
    return { on, total: SYSTEM_BLOCKS.length };
}


/** 模型清单缓存：{ 来源: [模型名] }，去重、去空、限长 */
function normalizeModelList(v) {
    const out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    for (const k of Object.keys(v)) {
        if (!PROVIDERS[k]) continue;
        const arr = Array.isArray(v[k]) ? v[k] : [];
        const seen = new Set();
        const list = [];
        for (const item of arr) {
            const name = str(item).trim();
            if (!name || seen.has(name)) continue;
            seen.add(name);
            list.push(name);
            if (list.length >= 500) break;
        }
        if (list.length) out[k] = list;
    }
    return out;
}

function clampInt(v, min, max, dflt) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
}
function clampFloat(v, min, max, dflt) {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
}
function clampOrNull(v, min, max) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!isFinite(n)) return null;
    return Math.max(min, Math.min(max, Math.round(n)));
}

// ============================================================
// 白名单
// ============================================================

/**
 * 取当前预设下某个条目的白名单配置。
 * @returns {{enabled: boolean, target: 'outline'|'main'|'both'}}
 */
export function getEntryConfig(presetName, entryName) {
    const s = get();
    const byPreset = s.presetWhitelist[presetName] || {};
    const cfg = byPreset[entryName];
    if (!cfg || typeof cfg !== 'object') return { enabled: false, target: 'both' };
    return {
        enabled: cfg.enabled === true,
        target: VALID_TARGETS.includes(cfg.target) ? cfg.target : 'both',
    };
}

/** 写某个条目的白名单配置 */
export function setEntryConfig(presetName, entryName, cfg) {
    const s = get();
    // 深拷贝一份再改，避免直接改到 extensionSettings 里的对象引用
    const wh = JSON.parse(JSON.stringify(s.presetWhitelist || {}));
    if (!wh[presetName]) wh[presetName] = {};
    wh[presetName][entryName] = {
        enabled: cfg && cfg.enabled === true,
        target: (cfg && VALID_TARGETS.includes(cfg.target)) ? cfg.target : 'both',
    };
    return set({ presetWhitelist: wh });
}

/**
 * 批量改某个预设下若干条目 —— **只改传进来的字段**，其余保持原样。
 * 界面上的「全选 / 全清」只传 enabled，「统一设为…」只传 target，
 * 这样三个控件各管一件事，不会互相覆盖。
 * @param {string} presetName
 * @param {string[]} entryNames
 * @param {{enabled?: boolean, target?: string}} patch
 */
export function patchEntries(presetName, entryNames, patch) {
    const s = get();
    const wh = JSON.parse(JSON.stringify(s.presetWhitelist || {}));
    if (!wh[presetName]) wh[presetName] = {};
    const p = patch || {};
    const hasEnabled = Object.prototype.hasOwnProperty.call(p, 'enabled');
    for (const name of entryNames) {
        const cur = getEntryConfig(presetName, name);
        wh[presetName][name] = {
            enabled: hasEnabled ? p.enabled === true : cur.enabled,
            target: VALID_TARGETS.includes(p.target) ? p.target : cur.target,
        };
    }
    return set({ presetWhitelist: wh });
}

/** 批量设置某个预设下所有条目的白名单（「勾上 + 指定去向」一步到位的老接口） */
export function setAllEntries(presetName, entryNames, cfg) {
    return patchEntries(presetName, entryNames, cfg || {});
}

/** 清掉某个预设的白名单 + 素材开关（预设改名或想重来） */
export function clearPresetWhitelist(presetName) {
    const s = get();
    const wh = JSON.parse(JSON.stringify(s.presetWhitelist || {}));
    const blk = JSON.parse(JSON.stringify(s.presetBlocks || {}));
    delete wh[presetName];
    delete blk[presetName];
    return set({ presetWhitelist: wh, presetBlocks: blk });
}

/** 统计白名单里配了多少条 */
export function whitelistStats(presetName) {
    const s = get();
    const byPreset = s.presetWhitelist[presetName] || {};
    let enabled = 0, total = 0;
    for (const k of Object.keys(byPreset)) {
        total++;
        if (byPreset[k] && byPreset[k].enabled === true) enabled++;
    }
    return { enabled, total, presets: Object.keys(s.presetWhitelist) };
}

// ============================================================
// 模板校验
// ============================================================

/**
 * 检查一段提示词里的占位符。写错占位符会导致它原样发给模型 —— 必须提示用户。
 * 传进来的就是面板那个框里的原文（它现在就是整份提示词）。
 * 面板只用 unknown（写错）那一项；missing 留给需要「该有没有」的场景。
 * @returns {{used: string[], unknown: string[], missing: string[]}}
 */
export function checkTemplate(template) {
    const tpl = String(template == null ? '' : template);
    const found = [];
    const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
    let m;
    while ((m = re.exec(tpl)) !== null) found.push(m[1]);
    const uniq = Array.from(new Set(found));
    return {
        used: uniq,
        unknown: uniq.filter(x => !TEMPLATE_PLACEHOLDERS.includes(x)),
        missing: TEMPLATE_PLACEHOLDERS.filter(x => !uniq.includes(x)),
    };
}

// ============================================================
// 导入 / 导出 / 重置
// ============================================================

/** 导出配置为 JSON 文本 */
export function exportJSON() {
    const s = get();
    return JSON.stringify({ __ext: EXT_ID, __version: 1, settings: s }, null, 2);
}

/**
 * 从 JSON 文本导入配置。
 * @returns {{ok: boolean, msg: string}}
 */
export function importJSON(text) {
    try {
        const obj = JSON.parse(String(text || ''));
        const src = (obj && typeof obj === 'object' && obj.settings) ? obj.settings : obj;
        if (!src || typeof src !== 'object') return { ok: false, msg: '内容不是对象' };
        const patch = {};
        for (const k of Object.keys(DEFAULTS)) {
            if (Object.prototype.hasOwnProperty.call(src, k)) patch[k] = src[k];
        }
        if (!Object.keys(patch).length) return { ok: false, msg: '没有识别到任何设置项' };
        set(patch);
        logInfo(`已导入配置，共 ${Object.keys(patch).length} 项`, 'settings');
        return { ok: true, msg: `已导入 ${Object.keys(patch).length} 项设置` };
    } catch (e) {
        const msg = errorText(e);
        logWarn('导入配置失败: ' + msg, 'settings');
        return { ok: false, msg: '解析失败：' + msg };
    }
}

/** 恢复默认（保留白名单和素材开关，避免辛苦勾的全没了） */
export function resetKeepWhitelist() {
    const s = get();
    return set(Object.assign({}, DEFAULTS, {
        presetWhitelist: s.presetWhitelist,
        presetBlocks: s.presetBlocks,
    }));
}

/** 彻底重置 */
export function resetAll() {
    return set(Object.assign({}, DEFAULTS));
}
