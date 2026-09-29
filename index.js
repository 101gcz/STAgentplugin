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
    ctx, probe, log, logInfo, logWarn, logError, errorText,
    events, on, getCaps, toast, refreshCtx, stopGeneration,
} from './src/env.js';
import { get as getSettings } from './src/settings.js';
import { reportPreset, buildEntryBlock, readPreset } from './src/preset.js';
import { buildHistory, chatStats } from './src/chat.js';
import {
    installWorldInfoWatcher, collectBlocks, describeBlocks,
} from './src/blocks.js';
import { installMainTrim } from './src/trim.js';
import {
    buildSystemPrompt, generateOutline, isGenerating, guardState, OutlineError,
    applyOwnRequestReasoning,
} from './src/outline.js';
import { injectOutline, analyzeMessages, hasOutline } from './src/inject.js';
import { mapMainRequest, logRequest as logRequestMap } from './src/diag.js';
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
    if (typeof renderExtensionTemplateAsync === 'function') {
        try {
            const html = await renderExtensionTemplateAsync(`third-party/${EXT_ID}`, 'settings');
            if (html && String(html).trim()) return String(html);
            logWarn('renderExtensionTemplateAsync 返回空，退回手写读取', 'boot');
        } catch (e) {
            logWarn('renderExtensionTemplateAsync 失败，退回手写读取: ' + errorText(e), 'boot');
        }
    }
    // 退回：直接 fetch 同目录的 settings.html
    try {
        const url = `/scripts/extensions/third-party/${encodeURIComponent(EXT_ID)}/settings.html`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        if (html && html.trim()) {
            logInfo('已通过 fetch 读取 settings.html', 'boot');
            return html;
        }
        throw new Error('内容为空');
    } catch (e) {
        logError('无法读取 settings.html: ' + errorText(e), 'boot');
        return '<div id="dro-settings"><div class="dro-hint">设置模板加载失败，请查看控制台。</div></div>';
    }
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
        const g = guardState();
        // 走到这一支的必然是插件自己刚发出去的那份请求 ——
        // 顺手把思维链强度按「这一轮打到哪个来源」的写法定稿：
        // DeepSeek 的档位会被酒馆折算、还要 thinking 打开才生效，
        // 这两件事只能在请求体上做（改酒馆设置做不到）。
        try {
            const applied = applyOwnRequestReasoning(generateData);
            if (applied) {
                logInfo(`自有请求｜推理强度按 ${applied.source} 的写法发：${applied.effort}`, 'outline');
            }
        } catch (e) {
            logWarn('自有请求的思维链定稿失败（改回酒馆的设置）: ' + errorText(e), 'outline');
        }
        logInfo(`放行自有请求（已生成 ${Math.round(g.elapsedMs / 1000)}s）`, 'guard');
        return;
    }

    const s = getSettings();
    if (!s.enabled) return;

    if (!generateData || !Array.isArray(generateData.messages)) {
        logWarn('generate_data.messages 不是数组，本轮跳过', 'main');
        ui.setSkipped('generate_data 结构异常');
        return;
    }

    // 已经被注入过就别重复注入（比如其它插件的二次触发）
    if (hasOutline(generateData)) {
        logWarn('本次请求里已有大纲标记，跳过重复注入', 'main');
        return;
    }

    state.runCount++;
    state.lastRunAt = Date.now();
    log('─'.repeat(28), 'info', 'main');
    logInfo(`拦截到生成请求（第 ${state.runCount} 次），开始准备大纲`, 'main');

    let outline = '';
    let how = '';
    const t0 = Date.now();

    try {
        // ---- 1. 聊天记录 + 正则压缩 ----
        const history = buildHistory({ compress: true });

        // ---- 2. 白名单条目 ----
        const block = buildEntryBlock('outline');
        if (block.warnings.length) {
            for (const w of block.warnings) logWarn('白名单: ' + w, 'preset');
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
        logInfo('大纲素材｜' + describeBlocks(collected.stats), 'main');

        // ---- 4. 预览统计（这一步原版完全没有，是纯黑盒） ----
        ui.reportPreview({
            floors: history.floors,
            compressed: history.compressed,
            rawChars: history.rawChars,
            finalChars: history.finalChars,
            savedPct: history.savedPct,
            presetPicked: block.picked,
            promptChars: systemPrompt.length,
            /** ★ 这是**聊天记录**那份素材的 token 估算，不是整份提示词的（v3.9.0 改名） */
            historyTokens: history.tokens,
            reason: history.reason,
            blocks: collected.stats,
        });

        // ---- 5. 调模型 ----
        if (!chatStats().floors) {
            logWarn('聊天记录为空，跳过大纲生成', 'main');
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

        // ---- 6. 注入 ----
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
            logError('注入失败: ' + injectResult.reason, 'main');
            ui.reportRun({
                ok: false, reason: injectResult.reason,
                chars: outline.length, elapsedMs: result.elapsedMs, outline,
            });
            state.failCount++;
            return;
        }

        const analysis = analyzeMessages(generateData);
        ui.reportInjected(analysis, how);

        // ---- 7. 诊断：主模型这一轮到底收到了什么 ----
        // 逐条认领回来源（预设条目 / 聊天楼层 / 世界书 / 大纲 / 其它），
        // 并指名道姓地说出「勾了只给大纲却还在请求里」的条目。
        // 纯观测：只读 messages，一个字节都不改。
        try {
            const diag = mapMainRequest(generateData);
            logRequestMap(diag);
            ui.reportRequestMap(diag);
        } catch (e) {
            logWarn('主模型请求诊断失败（不影响生成）: ' + errorText(e), 'diag');
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
        logInfo(`本轮完成｜大纲 ${outline.length} 字｜总耗时 ${Date.now() - t0}ms｜注入=${how}`, 'ok', 'main');
        toast(`大纲已注入（${outline.length} 字）`, 'success');

    } catch (e) {
        // ---- 大纲没拿到：终止这次生成，等你下次发送 / 重新生成 ----
        state.failCount++;
        const kind = (e instanceof OutlineError) ? e.kind : 'unknown';
        const msg = errorText(e);
        const partial = (e && typeof e.partial === 'string') ? e.partial : '';
        const what = (kind === 'timeout') ? '超时' : '失败';
        logError(`大纲失败（${kind}）: ${msg}`, 'main');

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
            logWarn(`已终止本次生成（大纲${what}：${msg}）—— 正文模型没跑，` +
                '重新发送或点「重新生成」即可', 'main');
            if (partial) {
                logInfo(`中断前已经生成的 ${partial.length} 字留在「状态」页` +
                    '（可点「复制大纲」拿走），没有注入', 'main');
            }
            ui.reportRun({
                ok: false, kind, reason: msg, chars: partial.length,
                elapsedMs: Date.now() - t0, outline: partial, aborted: true,
            });
            toast(`大纲${what}，已终止本次生成（正文模型没跑）｜重新发送或点「重新生成」`, 'warn');
            return;
        }

        // ---- 兜底：这个环境停不了生成，那就退回「跳过大纲、正文照跑」 ----
        logWarn('这个酒馆没有暴露 stopGeneration，停不了这次生成 —— 退回旧办法', 'main');
        let how = '';
        if (partial) {
            const r = injectOutline(generateData, partial, INJECT_MODE.APPEND_SYSTEM);
            if (r.ok) {
                how = r.how;
                logWarn(`已把${what}前生成的 ${partial.length} 字注入主模型（这份大纲没写完）｜注入=${r.how}`, 'main');
                ui.reportInjected(analyzeMessages(generateData), r.how);
                try {
                    const diag = mapMainRequest(generateData);
                    logRequestMap(diag);
                    ui.reportRequestMap(diag);
                } catch (e) { /* 诊断失败不影响生成 */ }
            } else {
                logWarn(`已保留${what}前生成的 ${partial.length} 字，但注入失败（${r.reason}）；` +
                    '主模型收到的是未经修改的原始消息', 'main');
            }
        }
        if (!how) {
            logError('★ 本轮已跳过：主模型将收到未经修改的原始消息', 'main');
        }
        ui.reportRun({
            ok: false, kind, reason: msg,
            chars: partial.length, elapsedMs: Date.now() - t0, outline: partial,
            how,
        });
        toast(
            how ? `大纲${what}，已注入中断前的 ${partial.length} 字（没写完）`
                : (partial ? `大纲${what}，已保留 ${partial.length} 字（可复制）`
                    : '大纲生成失败，本轮已跳过：' + msg),
            partial ? 'warn' : 'error',
        );
    }
}

// ============================================================
// 注册事件
// ============================================================

function registerEvents() {
    const { types } = events();
    if (!types) {
        logError('eventTypes 不可用，无法注册任何监听', 'boot');
        return false;
    }

    // 主拦截点
    const t = types.CHAT_COMPLETION_SETTINGS_READY;
    if (!t) {
        logError('找不到 CHAT_COMPLETION_SETTINGS_READY，插件无法拦截请求', 'boot');
        return false;
    }
    handles.push(on(t, (generateData) => {
        // 注意：酒馆是 await eventSource.emit(...) 的（openai.js:3052），
        // 所以要返回 Promise 让酒馆等我们改完 messages 再 fetch。
        return handleRequest(generateData);
    }, { scope: 'main' }));
    logInfo(`已注册拦截器：${t}`, 'boot');

    // 主模型请求整形：把「只给大纲」的条目从主模型请求里移除。
    // 钩在 CHAT_COMPLETION_PROMPT_READY 上 —— 它在拼完 messages、
    // 发请求之前触发，eventData.chat 就是随后要发出去的那个数组。
    try {
        const offTrim = installMainTrim();
        if (offTrim) handles.push({ stop: offTrim });
    } catch (e) {
        logError('挂主模型请求整形失败: ' + errorText(e), 'boot');
    }

    // 生成结束 → 状态归位（自有请求由 generateOutline 的 finally 复位）
    if (types.GENERATION_ENDED) {
        handles.push(on(types.GENERATION_ENDED, () => {
            if (isGenerating()) return;
            ui.setDot('idle');
        }, { scope: 'main' }));
    }

    // 换聊天时刷新统计
    if (types.CHAT_CHANGED) {
        handles.push(on(types.CHAT_CHANGED, () => {
            logInfo('聊天已切换，刷新统计', 'boot');
            refreshCtx();
            ui.renderWhitelist();
        }, { scope: 'boot' }));
    }

    return true;
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

function registerHotkey() {
    try {
        document.addEventListener('keydown', onHotkey, true);
        handles.push({ stop() { document.removeEventListener('keydown', onHotkey, true); } });
        logInfo('已注册快捷键 Ctrl+Alt+O（开/关悬浮窗）', 'boot');
    } catch (e) {
        logWarn('注册快捷键失败: ' + errorText(e), 'boot');
    }
}

// ============================================================
// 启动
// ============================================================

async function boot() {
    log('═'.repeat(30), 'info', 'boot');
    logInfo(`${EXT_ID} v${VERSION} 启动中…`, 'boot');

    // 先注销上一轮的监听器：window.__dro.reboot() 会再走一遍 boot，
    // 不注销就会挂上第二个拦截器，同一次生成被拦两遍。
    unregisterEvents();

    // ---- 1. 环境自检 ----
    refreshCtx();
    probe(true);
    // 世界书监听：酒馆扫完世界书会把「本轮真正激活的正文」交出来，
    // 大纲模型要的就是这一份（不重扫、不塞全书）。
    try {
        const off = installWorldInfoWatcher();
        if (off) handles.push({ stop: off });
    } catch (e) {
        logWarn('挂世界书监听失败: ' + errorText(e), 'boot');
    }
    const caps = getCaps();
    if (caps.__missingCritical && caps.__missingCritical.length) {
        logError('缺少必需能力：' + caps.__missingCritical.join('、'), 'boot');
        toast(`${EXT_ID}：缺少必需能力，可能无法工作（见设置面板「环境自检」）`, 'error');
    } else {
        logInfo('必需能力检查通过', 'boot');
    }
    logInfo(`酒馆助手：${caps.TavernHelper ? '可用' : '不可用（预设将降级读取，正则压缩会跳过）'}`, 'boot');

    // ---- 2. 数据概览 ----
    try {
        reportPreset();
        const cs = chatStats();
        logInfo(`当前聊天：${cs.floors} 层｜${cs.rawChars} 字｜≈${cs.tokens} tokens`, 'boot');
    } catch (e) {
        logWarn('读取数据概览失败: ' + errorText(e), 'boot');
    }

    // ---- 3. 先注册拦截器（本体），再挂 UI ----
    try {
        registerEvents();
        registerHotkey();
    } catch (e) {
        logError('注册事件失败: ' + errorText(e), 'boot');
    }

    // ---- 4. 悬浮窗（唯一的设置界面：竖条 + 展开面板） ----
    try {
        ui.mountBar();
        logInfo('悬浮窗已创建', 'boot');
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
    logInfo('启动完成', 'ok', 'boot');
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
    logInfo('调试入口已就绪：控制台输入 window.__dro', 'boot');
} catch (e) { /* ignore */ }
