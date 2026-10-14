/**
 * cache.js — 前缀缓存估算（「这一轮有多少 tokens 能按命中价算」）
 * ============================================================
 * 为什么值得单独算：
 *   DeepSeek 的上下文缓存按「最长相同前缀」命中，命中价只有未命中的
 *   1/50 ~ 1/120（v4f 0.02 vs 1 元/M，v4p 0.025 vs 3 元/M）。
 *   所以「一共多少 tokens」远不如「其中多少能命中」有用 ——
 *   插件整个方案（注入用 append_system、聊天记录排在提示词最后）就是
 *   围着这件事设计的，但用户一直看不到它到底值多少。
 *
 * 怎么估 —— 只问一件事：**两次请求的开头有多长完全一样**。
 *   把上一次真正发出去的那份请求逐条正文存下来，和这一次逐条比：
 *   从头开始完全一致的部分就是缓存能吃到的长度；比到第一条不一样的
 *   时候，再看这一条自己有多少前缀相同（同一层楼这轮只多了一句的情况）。
 *
 * 两个刻意的保守假设（宁可少报，不给算不到的乐观值）：
 *   · 只跟「上一次」比，不跟更早的比。更早的请求可能有更长的公共前缀，
 *     但缓存有 TTL，拿很久以前那份估会更虚。
 *   · 结果向下取整到 64 token —— DeepSeek 的缓存块大小（CACHE_CHUNK）。
 *
 * 这是估算不是账单：所以界面上写的是「预计」。
 */

import { estimateTokens } from './env.js';

/** DeepSeek 的缓存按 64 token 一块对齐 —— 命中长度取整到这个块 */
export const CACHE_CHUNK = 64;

/** 上一次真发出去的请求：key → { items: string[], at: number, hit: object } */
const mem = new Map();

/** 正文数组：非数组一律当空 */
function toList(items) {
    if (!Array.isArray(items)) return [];
    return items.map(x => String(x == null ? '' : x));
}

/** 两个字符串从头开始有多少个字符一样 */
function commonPrefixChars(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
}

/**
 * 逐条比对，返回「从头开始完全一致的那些正文」。
 * 第一条不一样时，把它自己的公共前缀也算进去，然后停。
 */
function commonPrefixParts(prev, next) {
    const parts = [];
    const n = Math.min(prev.length, next.length);
    for (let i = 0; i < n; i++) {
        if (prev[i] === next[i]) { parts.push(next[i]); continue; }
        const k = commonPrefixChars(prev[i], next[i]);
        if (k > 0) parts.push(next[i].slice(0, k));
        break;
    }
    return parts;
}

/**
 * 纯函数：拿上一份请求的正文数组和这一份比，算预计命中。
 *
 * @param {string[]} prevItems 上一次真发出去的逐条正文（没有就给空数组）
 * @param {string[]} nextItems 这一次的逐条正文
 * @returns {{
 *   ok: boolean, reason: string,
 *   hitTokens: number,      // 预计命中（已按 64 token 向下取整）
 *   rawHitTokens: number,   // 取整前
 *   totalTokens: number,    // 这一份请求的总量
 *   pct: number,            // 命中占比（整数百分比）
 *   matched: number,        // 完全一致的消息条数
 * }}
 */
export function prefixHit(prevItems, nextItems) {
    const prev = toList(prevItems);
    const next = toList(nextItems);
    const totalTokens = estimateTokens(next.join('\n'));

    if (!prev.length) {
        return {
            ok: false, reason: '还没有上一轮可比（首轮 / 插件刚启动）',
            hitTokens: 0, rawHitTokens: 0, totalTokens, pct: 0, matched: 0,
        };
    }

    const parts = commonPrefixParts(prev, next);
    const rawHitTokens = estimateTokens(parts.join('\n'));
    const hitTokens = Math.floor(rawHitTokens / CACHE_CHUNK) * CACHE_CHUNK;

    return {
        ok: true, reason: '',
        hitTokens,
        rawHitTokens,
        totalTokens,
        pct: totalTokens ? Math.round((hitTokens / totalTokens) * 100) : 0,
        matched: parts.length,
    };
}

/** 两份正文数组是不是一模一样（同一个请求被诊断两遍时用） */
function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * 记下「这一轮真发出去的那份请求」，并顺手算出它相对上一轮的预计命中。
 * 只在**真发请求**的地方调（diag.js 的主模型请求、outline.js 的大纲请求）。
 *
 * ★ 同一份请求被诊断两次时原样返回上一次的结果 ——
 *   不然就是拿自己跟自己比，会算出 100% 这种假数字。
 *
 * @param {string} key 画像名：'main' / 'outline'
 * @param {string[]} items 逐条正文
 * @returns {object} prefixHit() 的结果
 */
export function noteRequest(key, items) {
    const next = toList(items);
    const prev = mem.get(key);

    if (prev && sameList(prev.items, next)) return prev.hit;

    const hit = prev ? prefixHit(prev.items, next) : prefixHit([], next);
    mem.set(key, { items: next, at: Date.now(), hit });
    return hit;
}

/**
 * 只比不记：拿「现在这套配置会发出去的东西」跟「上一次真发出去的那份」比。
 * 面板上「预计缓存命中」的大纲那一半走的就是它（改一个开关就能立刻看到变化）。
 */
export function estimateAgainst(key, items) {
    const prev = mem.get(key);
    return prefixHit(prev ? prev.items : [], toList(items));
}

/** 清掉画像（换聊天 / 自检用） */
export function resetCacheTracking() {
    mem.clear();
}
