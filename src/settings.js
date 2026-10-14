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
                    '（旧的那份保留着，没删）', 'boot');
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
    if (!merged.presetIndex || typeof merged.presetIndex !== 'object' || Array.isArray(merged.presetIndex)) {
        merged.presetIndex = {};
    }
    if (!merged.presetBinding || typeof merged.presetBinding !== 'object' || Array.isArray(merged.presetBinding)) {
        merged.presetBinding = {};
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
        logWarn('无法写入配置：extensionSettings 不可用', 'env');
        return get();
    }
    Object.assign(b, patch || {});
    // 配置变了 → 预设认亲的结果也可能变（新指针、新指纹都可能改写结论）
    resetKeyCache();
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
    out.presetIndex = normalizePresetIndex(out.presetIndex);
    out.presetBinding = normalizePresetBinding(out.presetBinding);

    // 历史裁剪没有设置项了（v3.10.0 起固定 1 轮、只跟「聊天记录」的去向走）。
    // 老配置里残留的 trimHistory / trimKeepRounds / trimKeepFloors 不进规整结果：
    // 它们不参与任何判断，也不会被重新写回 —— 原样躺在酒馆配置里，
    // 万一降级回旧版本还认得出来。
    delete out.trimHistory;
    delete out.trimKeepRounds;
    delete out.trimKeepFloors;

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

/** 指纹最多记几个预设、每个预设最多记几个条目名 */
const MAX_PRESET_INDEX = 200;
const MAX_INDEX_NAMES = 500;

/** 指纹：{ 预设名: [条目名…] }，只留字符串、去重、限长 */
function normalizePresetIndex(v) {
    const out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    let n = 0;
    for (const k of Object.keys(v)) {
        if (n >= MAX_PRESET_INDEX) break;
        const arr = Array.isArray(v[k]) ? v[k] : [];
        const seen = new Set();
        const names = [];
        for (const item of arr) {
            const name = str(item).trim();
            if (!name || seen.has(name)) continue;
            seen.add(name);
            names.push(name);
            if (names.length >= MAX_INDEX_NAMES) break;
        }
        if (names.length) { out[String(k)] = names; n++; }
    }
    return out;
}

/** 沿用关系：{ 预设名: 被沿用的预设名 }，两边都非空且不同 */
function normalizePresetBinding(v) {
    const out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    let n = 0;
    for (const k of Object.keys(v)) {
        if (n >= MAX_PRESET_INDEX) break;
        const from = str(v[k]).trim();
        const to = str(k).trim();
        if (!from || !to || from === to) continue;
        out[to] = from;
        n++;
    }
    return out;
}

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

// ============================================================
// 预设换代：把「白名单 / 素材去向」跟着预设走，而不是跟着预设名走
// ============================================================
//
// 用户报的问题：预设更新一代（预设12 → 预设13，名字变了、条目只是小幅增删），
// 白名单里勾好的条目和每一档去向全部归零 —— 因为配置是按**预设名**取的：
//   旧: s.presetWhitelist['预设12']['核心'] → 读的时候按 '预设13' 找不到。
//
// 修法不改存储格式（老配置、导入导出、用户看得懂的结构都不动），
// 只在**取**的时候多认一步亲：名字对不上，就比条目名。
//
// 认亲判据（保守优先，宁可不认也不乱认）：
//   · 只看**已经存过配置**的预设名（presetWhitelist / presetBlocks 里的键）；
//   · 重叠度 = 两边条目名的交集 / 较小的那一边（新增条目不拉低匹配；
//     预设13 把预设12 的条目全留着、只是又加了一堆，仍然认得出）；
//   · 认得下需要满足其一：
//       ① 重叠 ≥ 50% 且共同条目 ≥ 3 条
//       ② 重叠 ≥ 34% 且共同条目 ≥ 8 条 且 名字也像（例如「预设12 / 预设13」）
//   · 名字像不像 = 数字部分比数字部分、其余部分比字符重合（见 nameSimilarity）；
//   · 谁最像就认谁；一样像时优先「条目多的那份」（配置更攒得下信息）。
//
// 认下来的关系记在 presetBinding[新名] = 旧名，每个新预设只认一次 ——
// 免得两个相似的预设互相抢。用户在新预设下真动了哪一项，那一项就落到
// 新预设名下（setEntryConfig / patchEntries / setBlockConfig 先 materialize），
// 从此归它自己所有，不再跟随旧名。

/** 解析结果缓存：小对象，键是「预设名 + 指纹版本」，配置一改就整块作废 */
let keyCache = null;

/** 配置写操作会让缓存失效（新认亲 / 指纹更新都走 set()） */
function invalidateKeyCache() { keyCache = null; }

/**
 * 手工作废解析缓存。
 * 只在**绕过 set()** 直接改了扩展配置时用得到（自检脚本会这么干）；
 * 正常代码路径一律靠 set() 里的 hook。
 */
export function resetPresetCache() { invalidateKeyCache(); }

/** 这个预设名下面有没有存过白名单 */
function hasWhitelistRecord(all, name) {
    const rec = all && typeof all === 'object' ? all[name] : null;
    return !!rec && typeof rec === 'object' && !Array.isArray(rec) && Object.keys(rec).length > 0;
}

/** 这个预设名下面有没有存过素材块配置 */
function hasBlocksRecord(all, name) {
    const rec = all && typeof all === 'object' ? all[name] : null;
    return !!rec && typeof rec === 'object' && !Array.isArray(rec) && Object.keys(rec).length > 0;
}

/** 名字里的数字串（「预设12」→ '12'） */
function nameDigits(s) {
    const m = String(s == null ? '' : s).match(/\d+/g);
    return m ? m.join('') : '';
}

/** 去掉数字后的名字（「预设12」→ '预设'），用来比非数字部分 */
function stripDigits(s) { return String(s == null ? '' : s).replace(/\d+/g, '').trim(); }

/** 字符集合的重合度（Jaccard），对中文/英文标题都够用 */
function charSimilarity(a, b) {
    const A = new Set(Array.from(String(a)));
    const B = new Set(Array.from(String(b)));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const ch of A) if (B.has(ch)) inter++;
    return inter / (A.size + B.size - inter);
}

/**
 * 两个预设名有多像（0~1）。
 * 数字是这类预设的版本号（预设12 / 预设13），所以数字单独比：
 * 一样 → 1，不一样 → 按编辑距离给一点分（预设12 vs 预设2 仍有分）。
 */
function nameSimilarity(a, b) {
    const A = String(a == null ? '' : a).trim();
    const B = String(b == null ? '' : b).trim();
    if (!A || !B) return 0;
    if (A === B) return 1;
    const da = nameDigits(A), db = nameDigits(B);
    const digits = (da && db) ? (da === db ? 1 : editRatio(da, db)) : (da === db ? 1 : 0);
    const rest = charSimilarity(stripDigits(A), stripDigits(B));
    return 0.6 * digits + 0.4 * rest;
}

/** 编辑距离折算的相似度（0~1） */
function editRatio(a, b) {
    const A = String(a), B = String(b);
    const n = A.length, m = B.length;
    if (!n || !m) return 0;
    const dp = new Array(m + 1);
    for (let j = 0; j <= m; j++) dp[j] = j;
    for (let i = 1; i <= n; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= m; j++) {
            const tmp = dp[j];
            dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (A[i - 1] === B[j - 1] ? 0 : 1));
            prev = tmp;
        }
    }
    return 1 - dp[m] / Math.max(n, m);
}

/**
 * 比对两组条目名，给出够不够「同一个预设」的材料。
 * @returns {{shared:number, ratio:number, score:number}}
 *   shared 共同条目数；ratio = shared / min(两边条数)；score = ratio（比较用）
 */
function compareNames(cur, cand) {
    if (!cur.length) return { shared: 0, ratio: 0, score: 0 };
    const set = new Set(cur);
    let shared = 0;
    for (const name of cand) if (set.has(name)) shared++;
    const ratio = shared / Math.min(cur.length, cand.length);
    return { shared, ratio, score: ratio };
}

/** 认亲门槛 */
const MATCH_STRONG_RATIO = 0.5;   // 主判据：一半以上对得上
const MATCH_STRONG_SHARED = 3;    // 至少 3 条共同条目（1~2 条太容易撞）
const MATCH_WEAK_RATIO = 0.34;    // 次判据：改版动得多时放宽
const MATCH_WEAK_SHARED = 8;
const MATCH_WEAK_NAME = 0.6;      // 但名字得明显像（预设12 / 预设13）

/** 值得认亲的候选：已经存过白名单或素材配置、且不是它自己 */
function candidateKeys(s, name) {
    const out = [];
    for (const k of Object.keys(s.presetWhitelist || {})) {
        if (k && k !== name && !out.includes(k)) out.push(k);
    }
    for (const k of Object.keys(s.presetBlocks || {})) {
        if (k && k !== name && !out.includes(k)) out.push(k);
    }
    return out;
}

/**
 * 在候选里找最像当前预设的那一个（分数不够就返回 ''）。
 * @param {string[]} [alsoTry] 额外也要试的名字（认过的那个，哪怕它的配置已经
 *        被挪到自己名下了 —— 否则第一次改动之后这份关系就断了）
 */
function bestMatch(s, key, curNames, alsoTry) {
    const idx = s.presetIndex || {};
    const cands = candidateKeys(s, key).concat(alsoTry || []);
    let best = null;
    for (const cand of cands) {
        if (!cand || cand === key) continue;
        const candNames = Array.isArray(idx[cand]) ? idx[cand] : [];
        if (!candNames.length) continue;      // 没指纹就没法比
        const m = compareNames(curNames, candNames);
        if (!m.shared) continue;
        const nameSim = nameSimilarity(key, cand);
        const strong = m.ratio >= MATCH_STRONG_RATIO && m.shared >= MATCH_STRONG_SHARED;
        const weak = m.ratio >= MATCH_WEAK_RATIO && m.shared >= MATCH_WEAK_SHARED &&
            nameSim >= MATCH_WEAK_NAME;
        if (!strong && !weak) continue;
        const score = m.score;
        if (!best || score > best.score + 1e-9 ||
            (Math.abs(score - best.score) < 1e-9 && nameSim > best.nameSim + 1e-9)) {
            best = { key: cand, score, nameSim };
        }
    }
    return best ? best.key : '';
}

function computeKeyCache(s) {
    const cache = { key: {}, bound: {} };
    const idx = s.presetIndex || {};
    const names = [];
    for (const k of Object.keys(idx)) {
        if (Array.isArray(idx[k]) && idx[k].length) names.push(k);
    }
    for (const key of names) {
        const n = str(key);            // 归一化成字符串，配置里才找得到
        const cur = idx[n];
        // 名字下面自己有记录 → 读自己那份（逐条地看，没改的条目仍然沿用，见 entryOf）
        const stored = hasWhitelistRecord(s.presetWhitelist, n) || hasBlocksRecord(s.presetBlocks, n);
        let eff = n;
        // ★ 认亲结果与「自己有没有记录」无关，一定要算出来：
        //   自己名下只改了三条时，另外几十条还是得靠这条关系去沿用那一份。
        const bound = str((s.presetBinding || {})[n]);
        if (bound && bound !== n && Array.isArray(idx[bound]) && idx[bound].length) {
            // 已经认过亲：先把关系验一遍（条目名得还对得上），
            // 对得上就继续沿用 —— 这样用户改动之后、或者两边来回切，
            // 都不会突然回到默认。
            const m = compareNames(cur, idx[bound]);
            if (m.shared > 0 && m.ratio >= MATCH_STRONG_RATIO / 2) cache.bound[n] = bound;
        }
        if (!cache.bound[n] && candidateKeys(s, n).length) {
            const hit = bestMatch(s, n, cur, bound ? [bound] : []);
            if (hit) cache.bound[n] = hit;    // 刚比出来的，等一个读操作把它记进配置
        }
        if (!stored && cache.bound[n] && cache.bound[n] !== n) eff = cache.bound[n];
        cache.key[n] = eff;
    }
    return cache;
}

/** 拿（并在必要时建）解析缓存 */
function keyCacheOf(s) {
    if (!keyCache) keyCache = computeKeyCache(s);
    return keyCache;
}

/** 让整块缓存作废 —— 只在配置真的变了（set / 指纹更新）时调用 */
function resetKeyCache() { invalidateKeyCache(); }

/** 临时调试入口：直接看解析缓存 */
export function _probeKeyCache() {
    const s = get();
    const c = keyCache || computeKeyCache(s);
    return JSON.parse(JSON.stringify({ key: c.key, bound: c.bound, s: Object.keys(s.presetIndex || {}) }));
}

/**
 * 当前预设该用哪一份配置（键）。
 * 名字一字不差 → 就是它自己；认过亲 → 被沿用的那个名字。
 * @param {object} [sIn] settings.get() 的结果
 * @param {string} presetName
 */
export function resolvePresetKey(sIn, presetName) {
    const s = sIn || get();
    const n = str(presetName);
    if (!n) return '';
    const cache = keyCacheOf(s);
    // 刚比出来的关系顺手记进配置：每个新预设只认一次，
    // 免得两个相似的预设互相抢（也免得下次读又要重算）。
    // set() 会清掉缓存，所以这里之后必须重建一次。
    // 自己名下已经有记录时也要记（那是「部分改动」，剩下的条目仍沿用）；
    // 有记录时读的是自己那份，这条关系只用来做「写不进去的历史版本」的兜底。
    const bound = cache.bound[n];
    if (bound && bound !== n) {
        set({ presetBinding: Object.assign({}, s.presetBinding, { [n]: bound }) });
        const fresh = keyCacheOf(get());
        return fresh.key[n] || n;
    }
    return cache.key[n] || n;
}

/**
 * 写入时该用哪个键。
 * ============================================================
 * **写永远落到当前预设名下**（认亲只影响读）。
 * 两个理由：
 *   · 落到旧名字下的话，用户在新预设下改的那一项会被旧名字的配置掩盖 ——
 *     改了没反应，比没改更糟；
 *   · 老名字那份保持原样，用户切回去还是原来那一套。
 * 顺带完成 materialize：新预设名下一旦有了记录，读也就直接用自己这份了。
 */
function writeKeyFor(presetName) {
    return str(presetName) || '(未知预设)';
}

/**
 * 最近一次读到的预设名（由 preset.js 在读完预设时告诉我们）。
 * ⚠️ settings.js 是底层模块，不能反向 import preset.js（会成环），
 * 所以这里只存一个名字。用途只有一个：调用方没带预设名时兜底
 * （日志那句「沿用…」就是这么被调用的）。
 */
let currentPresetName = '';

/** preset.js 读完预设后调一次 */
export function setCurrentPresetName(name) { currentPresetName = str(name); }

/**
 * 当前预设的配置是「沿用」谁的吗？（面板/日志据此说一句）
 * ============================================================
 * 「沿用」看的是认亲关系（presetBinding），不是「整份读哪一边」——
 * 用户在新预设下改过一条之后，读的那一份就是它自己的了，
 * 但剩下没改的那些条目仍然来自上一代，这件事得一直说。
 * @param {object} [sIn] 配置（不传就现取）
 * @param {string} [presetName] 预设名（不传就用最近读到的那一个）
 * @returns {{key: string, from: string}} key = 条目逐条解析用的键，from = 被沿用的预设名（无则 ''）
 */
export function presetKeyInfo(sIn, presetName) {
    const s = sIn || get();
    const n = str(presetName) || currentPresetName;
    if (!n) return { key: '', from: '' };
    const key = resolvePresetKey(s, n);
    const bound = presetKeyOfBound(s, n);
    return { key: bound || key, from: bound };
}

/**
 * 记住这次读到的预设长什么样（条目名指纹）。
 * ============================================================
 * 每次读到预设顺手记一份；只有真变了才写配置。
 * 下一次名字变了、条目还在时，就是靠这份指纹认出来的。
 *
 * @param {string} presetName
 * @param {Array<{name?:string}>} prompts
 * @returns {boolean} 是否更新了指纹（面板刷新时据此重画）
 */
export function rememberPreset(presetName, prompts) {
    const name = str(presetName);
    if (!name || name === '(未知预设)' || !Array.isArray(prompts) || !prompts.length) return false;
    const names = [];
    const seen = new Set();
    for (const p of prompts) {
        const entry = str(p && p.name).trim();
        if (!entry || seen.has(entry)) continue;
        seen.add(entry);
        names.push(entry);
        if (names.length >= MAX_INDEX_NAMES) break;
    }
    if (!names.length) return false;

    const s = get();
    const cur = (s.presetIndex || {})[name];
    const same = Array.isArray(cur) && cur.length === names.length &&
        cur.every((x, i) => x === names[i]);
    if (same) return false;
    set({ presetIndex: Object.assign({}, s.presetIndex, { [name]: names }) });
    return true;
}

// ============================================================
// 白名单
// ============================================================

/**
 * 这个预设名的配置是「沿用」来的吗？是就给一句能直接写进日志/面板的话。
 * 日志与面板「状态」页共用这一句，措辞只有一处。
 */
export function bindingNotice(sIn, presetName) {
    const from = presetKeyInfo(sIn, presetName).from;
    return from ? `沿用「${from}」的配置` : '';
}

/**
 * 当前预设名下的白名单**原始记录**（不做逐条沿用回退）。缺失 = 空对象。
 * ⚠️ 拿它去判断「某条勾没勾」是错的 —— 换代沿用中、又在新预设下改过几条时，
 * 那些没改的条目只存在于沿用来的那份里。判断单条一律用 getEntryConfig()。
 */
export function whitelistOf(sIn, presetName) {
    const s = sIn || get();
    const n = str(presetName);
    const rec = n ? (s.presetWhitelist || {})[n] : null;
    return (rec && typeof rec === 'object' && !Array.isArray(rec)) ? rec : {};
}

/**
 * 当前预设「按条目逐条」沿用的是哪一份记录（没有就 null）。
 * ============================================================
 * 为什么是逐条而不是整份：用户在新预设里改一条，就只是那一条落到新名字下，
 * 别的条目仍然沿用上一代 —— 若整份二选一，改一条会让其余全部变回默认，
 * 那正是用户报的「归零」的另一种写法。
 */
function fallbackWhitelistOf(s, presetName) {
    const n = str(presetName);
    if (!n) return null;
    // 直接用认亲指针，不经过「整份读哪一边」的判断：
    // 自己名下改过一条之后，整份读的是自己那份，但剩下没改的还要沿用。
    const key = presetKeyOfBound(s, n);
    if (!key) return null;
    const rec = (s.presetWhitelist || {})[key];
    return (rec && typeof rec === 'object' && !Array.isArray(rec)) ? rec : null;
}

/**
 * 这个预设认亲认到谁（没有就 ''）。
 * 先走一遍 resolvePresetKey，保证「刚比出来的关系」已经落进配置 ——
 * 正常路径里读预设那一步就已经落过了（preset.js 的 syncPresetIdentity），
 * 这一步只是别让绕过那一步的调用（自检、老配置）漏掉。
 */
function presetKeyOfBound(s, name) {
    resolvePresetKey(s, name);
    const bound = keyCacheOf(get()).bound[name];
    return (bound && bound !== name) ? bound : '';
}

/** 一条白名单记录里，这一条条目的去向（自身 → 沿用 → 默认） */
function entryOf(s, presetName, entryName) {
    const own = whitelistOf(s, presetName)[entryName];
    if (own && typeof own === 'object') return own;
    const fb = fallbackWhitelistOf(s, presetName);
    const inh = fb ? fb[entryName] : null;
    return (inh && typeof inh === 'object') ? inh : null;
}

/**
 * 这一条在不在白名单里（在 = 用户勾过或取消过，配置里留了记录）。
 * 只给诊断文案用：区分「不在白名单」和「在白名单但没勾」。
 */
export function hasEntryConfig(presetName, entryName) {
    return !!entryOf(get(), presetName, entryName);
}

/**
 * 当前预设（把沿用算进去之后）总共记了哪些条目名。
 * 供面板统计用 —— 与 getEntryConfig 同一套语义，数字才对得上。
 */
export function whitelistNamesOf(sIn, presetName) {
    const s = sIn || get();
    const names = new Set(Object.keys(whitelistOf(s, presetName)));
    const fb = fallbackWhitelistOf(s, presetName);
    if (fb) for (const k of Object.keys(fb)) names.add(k);
    return Array.from(names);
}

/**
 * 取当前预设下某个条目的白名单配置。
 * ============================================================
 * 取值顺序：**当前预设名下这一条 → 沿用来的那一份里的这一条 → 没勾**。
 * 只认**条目名**，不按顺序回退 —— 顺序一变就串味，比「没勾」危险得多
 * （会把只给大纲的条目发给主模型）。所以换代后新增的条目就是没勾。
 *
 * @returns {{enabled: boolean, target: 'outline'|'main'|'both'}}
 */
export function getEntryConfig(presetName, entryName) {
    const cfg = entryOf(get(), presetName, entryName);
    if (!cfg) return { enabled: false, target: 'both' };
    return {
        enabled: cfg.enabled === true,
        target: VALID_TARGETS.includes(cfg.target) ? cfg.target : 'both',
    };
}

/** 写某个条目的白名单配置（落到当前预设名下，第一次写就 materialize） */
export function setEntryConfig(presetName, entryName, cfg) {
    const s = get();
    // 深拷贝一份再改，避免直接改到 extensionSettings 里的对象引用
    const wh = JSON.parse(JSON.stringify(s.presetWhitelist || {}));
    const key = writeKeyFor(presetName);
    if (!wh[key]) wh[key] = {};
    wh[key][entryName] = {
        enabled: cfg && cfg.enabled === true,
        target: (cfg && VALID_TARGETS.includes(cfg.target)) ? cfg.target : 'both',
    };
    return set({ presetWhitelist: wh });
}

/**
 * 批量改某个预设下若干条目 —— **只改传进来的字段**，其余保持原样。
 * 界面上的「全选 / 全清」只传 enabled，「统一设为…」只传 target，
 * 这样三个控件各管一件事，不会互相覆盖。
 * 「其余保持原样」读的是**实际生效值**（可能来自沿用），写的是当前预设名下。
 * @param {string} presetName
 * @param {string[]} entryNames
 * @param {{enabled?: boolean, target?: string}} patch
 */
export function patchEntries(presetName, entryNames, patch) {
    const s = get();
    const wh = JSON.parse(JSON.stringify(s.presetWhitelist || {}));
    const key = writeKeyFor(presetName);
    if (!wh[key]) wh[key] = {};
    const p = patch || {};
    const hasEnabled = Object.prototype.hasOwnProperty.call(p, 'enabled');
    for (const name of entryNames) {
        const cur = getEntryConfig(presetName, name);
        wh[key][name] = {
            enabled: hasEnabled ? p.enabled === true : cur.enabled,
            target: VALID_TARGETS.includes(p.target) ? p.target : cur.target,
        };
    }
    return set({ presetWhitelist: wh });
}


// ============================================================
// 素材块（按预设存）
// ============================================================

/**
 * 取「某个预设下」素材块的实际配置（{ enabled, target }）。
 *
 * 三级取值，先到先用：
 *   1. presetBlocks[解析出的配置键]  —— 用户在这个预设下改过
 *   2. systemBlocks                  —— 旧版的全局开关（升级前的选择）
 *   3. 默认                          —— 全新安装：全开 + 只给大纲
 *
 * 第 2 级是刻意的：老配置里用户可能关掉了世界书，升级后
 * 在任何一个预设下都应该还是关着的，而不是悄悄变回全开。
 * 这个预设一旦被点过一次（setBlockConfig 会把当前生效值 materialize
 * 进 presetBlocks），第 2 级就不再生效。
 *
 * 配置键不一定是预设名本身：预设换代（预设12 → 预设13）时由
 * resolvePresetKey() 认亲到上一代名下（见上面那一节），
 * 所以「换了预设名就回到默认」这件事不会再发生。
 *
 * @param {object} s settings.get() 的结果
 * @param {string} presetName 当前预设名
 */
export function blockConfigOf(s, presetName) {
    const all = (s && s.presetBlocks) || {};
    const name = resolvePresetKey(s, presetName);
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
 * 老用户第一次动开关时，旧版的全局选择被固化进这个预设；
 * 预设换代时（沿用上一代）也是同一套动作：读的是沿用来的值，
 * 写的是当前预设名 —— 从此这份配置归它自己所有。
 */
export function setBlockConfig(presetName, patch) {
    const s = get();
    const all = JSON.parse(JSON.stringify(s.presetBlocks || {}));
    const name = writeKeyFor(presetName);
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
    const name = writeKeyFor(presetName);
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
        logInfo(`已导入配置，共 ${Object.keys(patch).length} 项`, 'boot');
        return { ok: true, msg: `已导入 ${Object.keys(patch).length} 项设置` };
    } catch (e) {
        const msg = errorText(e);
        logWarn('导入配置失败: ' + msg, 'boot');
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
