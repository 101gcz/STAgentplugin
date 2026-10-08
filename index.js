/**
 * index.js — 扩展入口
 * ============================================================
 * 职责：加载设置模板 → 装配各模块 → 注册拦截器 → 收尾。
 *
 * 这里刻意做得很薄。所有实际逻辑都在 src/ 里，
 * 改 UI 只看 ui.js + settings.html + style.css，
 * 改大纲提示词只看 constants.js，
 * 改白名单只看 preset.js —— 这样每次改动都不用读整个项目。
 *
 * ★ 装配顺序很重要：
 *   先注册拦截器，再挂 UI。
 *   因为 UI 涉及大量 DOM 操作、出错概率高，而拦截功能才是本体。
 *   如果 UI 抛异常导致拦截器没注册上，插件就整体失效了。
 *   （v2 就踩过这个坑。）
 */

import { EXT_ID, VERSION, INJECT_MODE } from './src/constants.js';
import {
    ctx, probe, log, logInfo, logWarn, logError, logOk, errorText, fmtNum, estimateTokens,
    events, on, getCaps, toast, refreshCtx, stopGeneration,
} from './src/env.js';
import { get as getSettings } from './src/settings.js';
import { reportPreset, buildEntryBlock, readPreset } from './src/preset.js';
import { buildHistory, chatStats } from './src/chat.js';
import {
    installWorldInfoWatcher, collectBlocks, latestWorldInfo,
} from './src/blocks.js';
import { installMainTrim } from './src/trim.js';
import {
    buildSystemPrompt, generateOutline, isGenerating, guardState, OutlineError,
    applyOwnRequestReasoning,
} from './src/outline.js';
import { injectOutline, hasOutline } from './src/inject.js';
import { mapMainRequest } from './src/diag.js';
import * as ui from './src/ui.js';

// TavernHelper 的扩展模板渲染器。它导出在 extensions.js 里，
// 是官方给扩展用的接口。若导入失败会在 boot() 里退回 fetch 手写路径。
let renderExtensionTemplateAsync = null;
if (globalThis.__droTestMode === true) {
    // 离线测试环境：没有酒馆，跳过这个 import
    console.warn(`[${EXT_ID}] 离线测试模式：跳过酒馆 extensions.js 的导入`);
} else {
    try {
        ({ renderExtensionTemplateAsync } = await import('../../../extensions.js'));
    } catch (e) {
        // 不能在这里 log，因为 env 还没初始化；boot 里会报
        console.warn(`[${EXT_ID}] 无法 import 酒馆的 renderExtensionTemplateAsync，将退回 fetch 路径: ${e && e.message}`);
    }
}

// ============================================================
// 运行状态
// ============================================================

const state = {
    active: false,
    lastRunAt: 0,
    runCount: 0,
    skipCount: 0,
    failCount: 0,
};

/** 已注册的监听器句柄，供卸载时注销 */
const handles = [];

// ============================================================
// 取模板 HTML
// ============================================================

async function loadSettingsHtml() {
    // 首选：酒馆官方渲染器
    let why = '';
    if (typeof renderExtensionTemplateAsync === 'function') {
        try {
            const html = await renderExtensionTemplateAsync(`third-party/${EXT_ID}`, 'settings');
            if (html && String(html).trim()) return String(html);
            why = '官方渲染器返回空';
        } catch (e) {
            why = '官方渲染器不可用: ' + errorText(e);
        }
    } else {
        why = '官方渲染器没导进来（extensions.js 导入失败）';
    }
    // 退回：直接 fetch 同目录的 settings.html
    try {
        const url = `/scripts/extensions/third-party/${encodeURIComponent(EXT_ID)}/settings.html`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        if (html && html.trim()) return html;
        throw new Error('内容为空');
    } catch (e) {
        // 两条路都断了才报，而且把「为什么没走官方路」一并写清楚 ——
        // 否则用户只看到一句「读不到」，没法判断是酒馆版本问题还是文件缺失。
        logError(`无法读取 settings.html（${why}；fetch 也失败: ${errorText(e)}）`, 'boot');
        return '<div id="dro-settings"><div class="dro-hint">设置模板加载失败，请查看控制台。</div></div>';
    }
}

// ============================================================
// 日志文案（一轮只有几行，全部在这里拼，措辞唯一）
// ============================================================
//
// 以前这些数字由 chat.js / blocks.js / panel.js / index.js 各写一遍，
// 于是同一件事有 2~4 种说法，还得靠「一字不差」的约定去维护。
// 现在：**谁拥有一轮，谁负责说话** —— 数据由各模块算，句子只在 index.js 里拼。

/**
 * 「素材」一行：聊天记录压缩 + 各素材块 + 白名单命中 + 提示词体积。
 * @param {object} history buildHistory() 的返回值
 * @param {Array} stats collectBlocks() 的 stats
 * @param {number} picked 白名单命中的预设条目数
 * @param {string} systemPrompt 拼好的大纲提示词
 * @param {number} worldCount 本轮世界书激活条数（0 = 没激活）
 */
function describeMaterial(history, stats, picked, systemPrompt, worldCount) {
    // 「省 X%」只在真省了的时候写 —— 正则会替换（可能变长），
    // 写成「省 -1%」看着像坏了，其实是正则把正文加长了两个字。
    const saved = history.rawChars > history.finalChars
        ? `（省 ${history.savedPct}）` : '';
    const chat = history.compressed
        ? `聊天 ${history.floors} 层 ${fmtNum(history.rawChars)}→${fmtNum(history.finalChars)} 字${saved}`
        : `聊天 ${history.floors} 层 ${fmtNum(history.rawChars)} 字（未压缩${history.reason ? '：' + history.reason : ''}）`;

    // 聊天记录已经在上面说过了，这里不再重复列它
    const blocks = (stats || [])
        .filter(b => b.on && b.key !== 'history' && b.chars > 0)
        .map(b => `${b.label}${b.key === 'worldInfo' && worldCount ? ' ' + worldCount + ' 条' : ''} ` +
            `${fmtNum(b.chars)}字${b.note ? '（' + b.note + '）' : ''}`);

    return ['素材', chat, ...blocks, `白名单命中 ${picked} 条`,
        `大纲提示词 ≈${fmtNum(estimateTokens(systemPrompt))} tokens`].join('｜');
}

/**
 * 「注入」一行：大纲最终落在哪 + 主模型这一轮实际收到的规模。
 * 逐条清单不在这里 —— 它在面板「状态」页（日志里只留指针）。
 * @param {string} how injectOutline() 给的落点
 * @param {object|null} diag mapMainRequest() 的结果（失败传 null）
 */
function describeInjected(how, diag) {
    const where = how === 'append_system' ? 'append_system（独立 system 消息）' : String(how || '未知');
    const size = (diag && diag.ok)
        ? `主模型收到 ${diag.total.count} 条 / ${fmtNum(diag.total.chars)} 字 / ≈${fmtNum(diag.total.tokens)} tokens`
        : '';
    return ['注入', where, size, '逐条清单见「状态」页'].filter(Boolean).join('｜');
}

/** 诊断包一层：任何一种失败都不许影响本轮生成 */
function diagOf(generateData) {
    try {
        return mapMainRequest(generateData);
    } catch (e) {
        logWarn('主模型请求诊断失败（不影响生成）: ' + errorText(e), 'env');
        return null;
    }
}

/**
 * 用面板上那份「锁定的手动大纲」跑这一轮。
 * ============================================================
 * 和正常流程只差一件事：**不拼素材、不调大纲模型**。
 * 因为大纲已经在用户手上了 —— 可能是他改过的，也可能是上一次超时留下的半截。
 * 除此之外一切照旧：同样注入、同样做诊断、同样报面板和日志。
 *
 * 为什么值得单独一条路（而不是「注入覆盖」）：
 *   正常流程里大纲是这一轮**现算**的。用户说「就按这份写」时，再调一次大纲
 *   模型不但白花钱，还会把他改过的内容盖掉 —— 那正是这个功能要解决的问题。
 */
function useLockedOutline(generateData, outline) {
    const t0 = Date.now();
    logInfo(`第 ${state.runCount} 轮｜使用面板上锁定的手动大纲（${outline.length} 字），` +
        '本轮不调用大纲模型', 'run');

    const injected = injectOutline(generateData, outline, INJECT_MODE.APPEND_SYSTEM);
    if (!injected.ok) {
        logError('手动大纲注入失败: ' + injected.reason, 'run');
        ui.reportRun({
            ok: false, reason: injected.reason,
            chars: outline.length, elapsedMs: Date.now() - t0, outline,
        });
        state.failCount++;
        return;
    }

    const diag = diagOf(generateData);
    ui.reportRequestMap(diag);
    logInfo(describeInjected(injected.how, diag), 'run');
    if (diag && diag.ok && diag.leaked > 0 && diag.warnings.length) {
        logWarn(diag.warnings[0], 'run');
    }
    ui.refreshWhitelistView();

    ui.reportRun({
        ok: true,
        manual: true,          // 面板据此说「本轮未调用大纲模型」
        chars: outline.length,
        elapsedMs: Date.now() - t0,
        how: injected.how,
        outline,
    });
    logOk(`第 ${state.runCount} 轮完成｜手动大纲 ${outline.length} 字｜总耗时 ${Date.now() - t0}ms`, 'run');
    // 说的是「正在」：正文是酒馆那边接着生成的，这一刻刚把请求交出去
    toast(`正在按你锁定的大纲写正文（${outline.length} 字）`, 'success');
}

// ============================================================
// 主拦截流程
// ============================================================

/**
 * 拦截 CHAT_COMPLETION_SETTINGS_READY。
 *
 * 两条必须记住的事：
 *  1. 这个事件拿到的 generate_data 已经是成品
 *     （预设已合并 + 世界书已注入 + 宏已展开 + 正则已应用）
 *     依据：openai.js:3051-3052 —— createGenerationParameters 先跑完，
 *     再 emit 事件，最后才 fetch。
 *
 *  2. 我们自己调 generateRaw 会再次触发这个事件
 *     （generateRaw → generateRawData → sendOpenAIRequest → emit，
 *      见 script.js:4018 与 openai.js:3052）
 *     所以第一件事就是问 isGenerating()，是就立刻放行。
 */
async function handleRequest(generateData) {
    // ---- 防递归闸门：这里必须是第一个判断，且必须立刻返回 ----
    if (isGenerating()) {
        // 走到这一支的必然是插件自己刚发出去的那份请求 ——
        // 顺手把思维链强度按「这一轮打到哪个来源」的写法定稿：
        // DeepSeek 的档位会被酒馆折算、还要 thinking 打开才生效，
        // 这两件事只能在请求体上做（改酒馆设置做不到）。
        try {
            applyOwnRequestReasoning(generateData);
        } catch (e) {
            logWarn('自有请求的思维链定稿失败（改回酒馆的设置）: ' + errorText(e), 'outline');
        }
        return;
    }

    const s = getSettings();
    if (!s.enabled) return;

    if (!generateData || !Array.isArray(generateData.messages)) {
        logWarn('generate_data.messages 不是数组，本轮跳过', 'run');
        ui.setSkipped('generate_data 结构异常');
        return;
    }

    // 已经被注入过就别重复注入（比如其它插件的二次触发）
    if (hasOutline(generateData)) {
        logWarn('本次请求里已有大纲标记，跳过重复注入', 'run');
        return;
    }

    state.runCount++;
    state.lastRunAt = Date.now();

    // ---- 0. 面板上锁定的大纲：这一轮不调大纲模型，直接注入 ----
    // 用户在面板上点了「以此大纲再次生成正文」（或自己改完后点了酒馆的
    // 「重新生成」）时走这条。取走即解锁 —— 单次有效，用完就回到正常流程
    // （理由见 panel.js 里 outlineLocked 那段注释）。
    const locked = ui.takeLockedOutline();
    if (locked) {
        useLockedOutline(generateData, locked);
        return;
    }

    logInfo(`第 ${state.runCount} 轮｜拦截到生成请求，开始准备大纲`, 'run');

    let outline = '';
    let how = '';
    const t0 = Date.now();

    try {
        // ---- 1. 聊天记录 + 正则压缩 ----
        // （压缩过程本身不写日志：结论文下一行「素材｜…」里一并给出）
        const history = buildHistory({ compress: true });

        // ---- 2. 白名单条目 ----
        const block = buildEntryBlock('outline');
        if (block.warnings.length) {
            for (const w of block.warnings) logWarn('白名单｜' + w, 'preset');
        }

        // ---- 3. 拼 prompt ----
        // 素材块（聊天记录 / 世界书 / 角色卡 / Persona / 对话示例）默认全开，
        // 每一项都能在「白名单」页单独关掉；开关跟着当前预设走，
        // 所以这里要把预设名传进去（跟上面 buildEntryBlock 用的是同一份缓存）。
        const c = ctx();
        const names = { char: (c && c.name2) || '', user: (c && c.name1) || '' };

        const collected = collectBlocks(s, history.text, readPreset().name);
        const systemPrompt = buildSystemPrompt({
            blocks: collected.text,
            presetBlock: block.text,
            charName: names.char,
            userName: names.user,
            template: s.template,
        });

        // ★ 一轮一行：把「聊天记录压缩 / 各素材块 / 白名单命中 / 提示词体积」
        //   全部并进这一句。以前这四件事由四个模块各记一行（chat、blocks、
        //   main、panel），同一批数字要写四遍，还得保证四遍措辞一致。
        logInfo(describeMaterial(history, collected.stats, block.picked, systemPrompt,
            latestWorldInfo().count), 'run');

        // ---- 4. 调模型 ----
        if (!chatStats().floors) {
            logWarn('聊天记录为空，跳过大纲生成', 'run');
            ui.setSkipped('聊天记录为空');
            state.skipCount++;
            return;
        }

        ui.setRunning(0);
        const result = await generateOutline(systemPrompt, {
            onStream: (acc) => ui.setOutline(acc, null),
            onTick: (ms) => ui.setRunning(ms),
        });
        outline = result.text;

        // ---- 5. 注入 ----
        // 用 APPEND_SYSTEM（作为独立 system 消息追加到**最末尾**），不用 prepend_user。
        //
        // 为什么：prepend_user 是把大纲拼进最后一条 user 消息的**内容前面**，
        // 那条消息的文本就变了。而下一轮重建请求时用的是聊天记录里干净的原文，
        // 于是「上一轮的 user 消息」这一整段的 token 序列对不上 ——
        // 前缀缓存从那里断开，后面全部按未命中价重算
        // （DeepSeek 未命中价是命中价的 50~120 倍）。
        // 追加到最末尾则一个字都不动原有消息，缓存画像与不装插件完全一致。
        const injectResult = injectOutline(generateData, outline, INJECT_MODE.APPEND_SYSTEM);
        how = injectResult.how;

        if (!injectResult.ok) {
            logError('注入失败: ' + injectResult.reason, 'run');
            ui.reportRun({
                ok: false, reason: injectResult.reason,
                chars: outline.length, elapsedMs: result.elapsedMs, outline,
            });
            state.failCount++;
            return;
        }

        // ---- 6. 诊断：主模型这一轮到底收到了什么 ----
        // 逐条认领回来源（预设条目 / 聊天楼层 / 世界书 / 大纲 / 其它），
        // 并指名道姓地说出「勾了只给大纲却还在请求里」的条目。
        // 纯观测：只读 messages，一个字节都不改。
        //
        // ★ 逐条明细只进面板「状态」页（那里有完整清单），日志里只留一行
        //   摘要 + 指针 —— 以前每次生成会往日志倒最多 60 行，把关键行全冲掉了。
        const diag = diagOf(generateData);
        ui.reportRequestMap(diag);
        logInfo(describeInjected(how, diag), 'run');
        // 「只给大纲」的条目漏在请求里是必须让用户处理的事，按 warn 单独一行
        // （判据是 diag 给的 leaked 计数，不靠消息里有没有某个符号）。
        if (diag && diag.ok && diag.leaked > 0 && diag.warnings.length) {
            logWarn(diag.warnings[0], 'run');
        }

        ui.refreshWhitelistView();

        ui.reportRun({
            ok: true,
            chars: outline.length,
            elapsedMs: result.elapsedMs,
            how,
            outline,
            totalMs: Date.now() - t0,
        });
        logOk(`第 ${state.runCount} 轮完成｜大纲 ${outline.length} 字｜总耗时 ${Date.now() - t0}ms`, 'run');
        toast(`大纲已注入（${outline.length} 字）`, 'success');

    } catch (e) {
        // ---- 大纲没拿到：终止这次生成，等你下次发送 / 重新生成 ----
        state.failCount++;
        const kind = (e instanceof OutlineError) ? e.kind : 'unknown';
        const msg = errorText(e);
        const partial = (e && typeof e.partial === 'string') ? e.partial : '';
        const what = (kind === 'timeout') ? '超时' : '失败';
        logError(`大纲失败（${kind}）: ${msg}`, 'run');

        /**
         * 终止本次生成。
         * ============================================================
         * 为什么是「终止」而不是「跳过大纲、正文照跑」：
         *   大纲就是拿来指导正文的。这一轮没拿到（超时 / 模型返回空 /
         *   上游报错 / 拿不到上下文…），还让贵模型照着「没有大纲」的提示词
         *   写一大段，等于白花钱还容易跑偏。所以直接收手 ——
         *   你想接着写，重新发送或点「重新生成」就是一次干净的重来。
         *
         * 怎么终止：调酒馆自己的 stopGeneration()，跟你按「停止」同一个入口。
         * 依据（对着这份酒馆的源码核过）：
         *   · 流式：script.js:6089 sendStreamingRequest() 开头就检查
         *     abortController.signal.aborted，已 abort 就直接抛
         *     'Generation was aborted.'，请求根本发不出去；
         *   · 非流式：script.js:6059 把 abortController.signal 交给
         *     sendOpenAIRequest，signal 已被 abort → fetch 立即失败；
         *   · 我们动手的时机是 CHAT_COMPLETION_SETTINGS_READY，而
         *     openai.js:3052 的 emit 就在 fetch（3055）之前 —— 正好赶得上。
         * 结果：你刚发的那条消息留在聊天里，不会被模型回复。
         *
         * 兜底：万一这个酒馆没暴露 stopGeneration，就退回旧办法 ——
         * 有半截就注入半截继续跑，什么都没有就原样放行。
         */
        const stopped = stopGeneration();
        if (stopped) {
            logWarn(`已终止本次生成（大纲${what}：${msg}）。正文模型未运行，` +
                '重新发送或点击「重新生成」即可重试', 'run');
            if (partial) {
                logInfo(`中断前生成的 ${partial.length} 字已保留在「状态」页` +
                    '（可以直接在上面改，再点「以此大纲再次生成正文」），本轮未注入', 'run');
            }
            ui.reportRun({
                ok: false, kind, reason: msg, chars: partial.length,
                elapsedMs: Date.now() - t0, outline: partial, aborted: true,
            });
            toast(`大纲${what}，已终止本次生成。重新发送或点击「重新生成」可重试`, 'warn');
            return;
        }

        // ---- 兜底：这个环境停不了生成，那就退回「跳过大纲、正文照跑」 ----
        logWarn('当前酒馆未提供 stopGeneration，无法终止本轮生成，改用兜底方案', 'run');
        let how = '';
        if (partial) {
            const r = injectOutline(generateData, partial, INJECT_MODE.APPEND_SYSTEM);
            if (r.ok) {
                how = r.how;
                logWarn(`已将${what}前生成的 ${partial.length} 字注入主模型（内容不完整）｜注入=${r.how}`, 'run');
                ui.reportRequestMap(diagOf(generateData));
            } else {
                logWarn(`已保留${what}前生成的 ${partial.length} 字，但注入失败（${r.reason}）；` +
                    '主模型收到的是未修改的原始请求', 'run');
            }
        }
        if (!how) {
            logError('本轮已跳过：主模型将收到未修改的原始请求', 'run');
        }
        ui.reportRun({
            ok: false, kind, reason: msg,
            chars: partial.length, elapsedMs: Date.now() - t0, outline: partial,
            how,
        });
        toast(
            how ? `大纲${what}，已注入中断前生成的 ${partial.length} 字（内容不完整）`
                : (partial ? `大纲${what}，已保留 ${partial.length} 字，可复制`
                    : '大纲生成失败，本轮已跳过：' + msg),
            partial ? 'warn' : 'error',
        );
    }
}

// ============================================================
// 注册事件
// ============================================================

/**
 * 注册所有监听。
 * @returns {string[]} 成功挂上的名字 —— boot 会把它们并成一行「已就绪｜…」，
 *   所以这里**不要**自己写成功日志（失败了才写，各模块自己负责）。
 */
function registerEvents() {
    const installed = [];
    const { types } = events();
    if (!types) {
        logError('eventTypes 不可用，无法注册任何监听', 'boot');
        return installed;
    }

    // 主拦截点
    const t = types.CHAT_COMPLETION_SETTINGS_READY;
    if (!t) {
        logError('找不到 CHAT_COMPLETION_SETTINGS_READY，插件无法拦截请求', 'boot');
        return installed;
    }
    handles.push(on(t, (generateData) => {
        // 注意：酒馆是 await eventSource.emit(...) 的（openai.js:3052），
        // 所以要返回 Promise 让酒馆等我们改完 messages 再 fetch。
        return handleRequest(generateData);
    }, { scope: 'env' }));
    installed.push('拦截器');

    // 主模型请求整形：把「只给大纲」的条目从主模型请求里移除。
    // 钩在 CHAT_COMPLETION_PROMPT_READY 上 —— 它在拼完 messages、
    // 发请求之前触发，eventData.chat 就是随后要发出去的那个数组。
    try {
        const offTrim = installMainTrim();
        if (offTrim) { handles.push({ stop: offTrim }); installed.push('主模型整形'); }
    } catch (e) {
        logError('挂主模型请求整形失败: ' + errorText(e), 'boot');
    }

    // 生成结束 → 状态归位（自有请求由 generateOutline 的 finally 复位）
    if (types.GENERATION_ENDED) {
        handles.push(on(types.GENERATION_ENDED, () => {
            if (isGenerating()) return;
            ui.setDot('idle');
        }, { scope: 'env' }));
    }

    // 换聊天时刷新统计（例行事件，不写日志）
    if (types.CHAT_CHANGED) {
        handles.push(on(types.CHAT_CHANGED, () => {
            refreshCtx();
            ui.renderWhitelist();
        }, { scope: 'env' }));
    }

    return installed;
}

function unregisterEvents() {
    for (const h of handles) {
        try { h.stop(); } catch (e) { /* ignore */ }
    }
    handles.length = 0;
}

// ============================================================
// 快捷键：Ctrl+Alt+O 开/关悬浮窗
// ============================================================
// 文档里一直写着这个快捷键，但 v3.0 其实没实现 —— 面板点不动的时候
// 这是一条重要的退路，所以补上。

function onHotkey(e) {
    const key = String(e.key || '').toLowerCase();
    if (key !== 'o' || !e.altKey || !(e.ctrlKey || e.metaKey)) return;
    try {
        e.preventDefault();
        ui.togglePanel();
    } catch (err) { /* ignore */ }
}

/** @returns {boolean} 是否挂上 */
function registerHotkey() {
    try {
        document.addEventListener('keydown', onHotkey, true);
        handles.push({ stop() { document.removeEventListener('keydown', onHotkey, true); } });
        return true;
    } catch (e) {
        logWarn('注册快捷键失败: ' + errorText(e), 'boot');
        return false;
    }
}

// ============================================================
// 启动
// ============================================================

async function boot() {
    logInfo(`${EXT_ID} v${VERSION} 启动中…`, 'boot');

    // 先注销上一轮的监听器：window.__dro.reboot() 会再走一遍 boot，
    // 不注销就会挂上第二个拦截器，同一次生成被拦两遍。
    unregisterEvents();

    // ---- 1. 环境自检 ----
    // 一次说清「能不能跑」：必需能力 + 酒馆助手。探测明细（十几项）在
    // 「关于」页的环境自检里逐项列出，日志里不必再抄一遍。
    refreshCtx();
    probe(true);
    const caps = getCaps();
    const thText = caps.TavernHelper ? '可用' : '不可用（预设降级读取，正则压缩跳过）';
    if (caps.__missingCritical && caps.__missingCritical.length) {
        logError('缺少必需能力：' + caps.__missingCritical.join('、') +
            `｜酒馆助手：${thText}`, 'boot');
        toast(`${EXT_ID}：缺少必需能力，可能无法正常工作，详见设置面板的「环境自检」`, 'error');
    } else {
        logInfo(`环境自检通过｜酒馆助手：${thText}`, 'boot');
    }

    // ---- 2. 数据概览 ----
    try {
        reportPreset();
        const cs = chatStats();
        logInfo(`当前聊天：${cs.floors} 层｜${cs.rawChars} 字｜≈${cs.tokens} tokens`, 'boot');
    } catch (e) {
        logWarn('读取数据概览失败: ' + errorText(e), 'boot');
    }

    // ---- 3. 先注册拦截器（本体），再挂 UI ----
    // 两个监听各自失败时会自己按 warn 报（见 blocks.js / trim.js），
    // 成功就并成一行，别四行各报一次「我挂上了」。
    const installed = [];
    try {
        installed.push(...registerEvents());
        if (registerHotkey()) installed.push('快捷键 Ctrl+Alt+O');
    } catch (e) {
        logError('注册事件失败: ' + errorText(e), 'boot');
    }
    // 世界书监听：酒馆扫完世界书会把「本轮真正激活的正文」交出来，
    // 大纲模型要的就是这一份（不重扫、不塞全书）。
    try {
        const off = installWorldInfoWatcher();
        if (off) { handles.push({ stop: off }); installed.push('世界书监听'); }
    } catch (e) {
        logWarn('挂世界书监听失败: ' + errorText(e), 'boot');
    }
    if (installed.length) logInfo('已就绪｜' + installed.join('｜'), 'boot');

    // ---- 4. 悬浮窗（唯一的设置界面：竖条 + 展开面板） ----
    try {
        ui.mountBar();
    } catch (e) {
        logError('创建悬浮窗失败: ' + errorText(e), 'boot');
    }

    // ---- 5. 酒馆扩展设置区里的入口卡片 ----
    try {
        const html = await loadSettingsHtml();
        const ok = ui.mountSettings(html);
        if (ok) toast(`${EXT_ID} 已加载：点右上角竖条打开设置`, 'success');
    } catch (e) {
        logError('挂载入口卡片失败: ' + errorText(e), 'boot');
    }

    state.active = true;
    logOk('启动完成', 'boot');
}

// 等酒馆就绪。extensions.js 是在 APP_READY 之后才 activateExtensions 的，
// 但仍留一个兜底：如果 document 还在加载就先等 DOMContentLoaded。
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { boot(); }, { once: true });
} else {
    boot();
}

// 卸载（酒馆在扩展被禁用/热重载时会调 pagehide）
window.addEventListener('pagehide', () => {
    unregisterEvents();
    try { ui.destroy(); } catch (e) { /* ignore */ }
});

// ============================================================
// 控制台调试入口
// ============================================================

try {
    window.__dro = {
        get version() { return VERSION; },
        get state() { return Object.assign({}, state, { guard: guardState() }); },
        settings: () => getSettings(),
        caps: () => getCaps(),
        preset: () => readPreset(true),
        chat: () => chatStats(),
        history: () => buildHistory({ compress: true }),
        open: () => ui.openPanel(),
        close: () => ui.closePanel(),
        toggle: () => ui.togglePanel(),
        reboot: () => boot(),
        ui,
    };
} catch (e) { /* ignore */ }
