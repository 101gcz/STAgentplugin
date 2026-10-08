/**
 * panel.js — 悬浮窗（唯一的设置界面）
 * ============================================================
 * 为什么改成「自包含悬浮窗」：
 *   v3.0 把配置放在酒馆扩展设置区的 inline-drawer 里，悬浮条只负责
 *   打开它。结果悬浮条点了没反应 —— 因为打开代码判断的是
 *   内联样式 content.style.display === 'none'，而酒馆的
 *   .inline-drawer-content 是「纯 CSS 折叠」（style.css:5535），
 *   内联 display 一直是空串，条件永远不成立；
 *   后面的 toggle.click() 又挂在同一个错误条件上，也永远不执行。
 *   再加上酒馆的扩展抽屉（#rm_extensions_block）默认是关的，
 *   scrollIntoView 也滚不出任何东西 —— 用户看到的就是「点不动」。
 *
 *   而且两套界面（悬浮条 + 扩展设置区面板）本来就是同一份配置的
 *   两个入口，容易互相打架。现在只留一套：悬浮窗自己带全部设置，
 *   酒馆扩展设置区只放一张「打开悬浮窗」的小卡片。
 *
 * 交互上这一版的做法（针对 v2/v3 踩过的坑）：
 *   · 拖动用 window 上的 pointermove/pointerup 跟踪，不用
 *     setPointerCapture —— 捕获之后 click 的判定会不可靠
 *   · 点击统一用原生 click，拖动真的发生时只用标志位屏蔽掉
 *     紧随其后的那一次 click，不再靠「移动过就吃掉一次点击」
 *   · 坐标四边钳制 + 非法值回落 + 位置/尺寸持久化
 */

import {
    ROOT_ID, VERSION, EXT_ID, CONN_MODE, PROVIDERS, REASONING_LEVELS,
    TARGET, SYSTEM_BLOCKS, TRIM_KEEP_ROUNDS, TEMPLATE_PLACEHOLDERS,
} from './constants.js';
import {
    log, onLog, getLogLines, formatLogLines, clearLog, probe, getCaps,
    errorText, escapeHtml, fmtNum, estimateTokens, names, toast, refreshCtx,
    regenerateReply,
} from './env.js';
import {
    get as getSettings, set as setSettings, watch as watchSettings,
    getEntryConfig, setEntryConfig, patchEntries,
    blockConfigOf, setBlockConfig, patchBlocks, blockStatsOf,
    checkTemplate, exportJSON, importJSON, resetKeepWhitelist, PANEL_TABS,
} from './settings.js';
import { readPreset, presetStats, refreshPreset, buildEntryBlock } from './preset.js';
import { chatStats, historyStats } from './chat.js';
import {
    latestWorldInfo, charCardBlock, personaBlock, examplesBlock, collectBlocks,
} from './blocks.js';
import { lastTrimStats, outlineOnlyEntries, wantTrimHistory } from './trim.js';
import {
    listConnectionProfiles, fetchModelList, describePlan, buildSystemPrompt,
    providerConfig, currentSource, modelChoices,
    reasoningLevelsFor, reasoningLevelFor, reasoningSyntax,
} from './outline.js';
import { estimateAgainst } from './cache.js';

const $ = (id) => document.getElementById(id);

let root = null;        // #dro-root（拖动时移动的就是它）
let bar = null;         // #dro-bar 收起态竖条
let panel = null;       // #dro-panel 展开态面板
let els = {};           // 面板里的元素引用
let destroyFns = [];
let activeTab = 'status';

// ============================================================
// 装配
// ============================================================

/** 建悬浮窗（幂等：重复调用先清掉旧的） */
export function mount() {
    const old = document.getElementById(ROOT_ID);
    if (old) old.remove();

    root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
        <div id="dro-bar" tabindex="0" title="点击打开设置；拖动可移动">
            <div class="dro-dot" id="dro-bar-dot"></div>
            <div class="dro-bar-txt">大纲</div>
        </div>
        <div id="dro-panel" class="dro-panel">
            <div class="dro-panel-head" id="dro-panel-head">
                <span class="dro-panel-title">四号预设Agent</span>
                <span id="dro-status-badge" class="dro-badge idle">未运行</span>
                <div class="dro-panel-tools">
                    <div class="dro-tool dro-nodrag" id="dro-panel-reload" title="刷新：重新自检、重新读取预设并重算统计">⟳</div>
                    <div class="dro-tool dro-nodrag" id="dro-panel-close" title="收起成竖条">✕</div>
                </div>
            </div>
            <div class="dro-tabs" id="dro-tabs"></div>
            <div class="dro-panel-body" id="dro-panel-body">
                ${paneTemplates()}
            </div>
            <div class="dro-resize dro-nodrag" id="dro-resize" title="拖动调整大小"></div>
        </div>`;

    document.body.appendChild(root);

    bar = $('dro-bar');
    panel = $('dro-panel');

    cacheElements();
    bindTabs();
    bindBar();
    bindPanelHead();
    bindResize();
    bindSettings();

    applyBarVisibility();
    applyBarOpacity();
    applyGeometry();
    placeRoot(isOpen());

    if (isOpen()) panel.style.display = 'flex'; else panel.style.display = 'none';
    bar.style.display = isOpen() ? 'none' : '';

    switchTab(getSettings().panelTab, { silent: true });
    refreshForms();
    renderCaps();
    renderLog();
    renderStats();
    // 面板重建 = 大纲框是空的，锁定状态必须跟着清掉，
    // 否则会出现「锁着一份空大纲」，下一轮生成既不调大纲模型也没东西可注入。
    outlineEdited = false;
    outlineLocked = false;
    refreshOutlineHint();
    setDot('idle');
    // 挂载成功不写日志：这是每次刷新页面都会发生的例行事
    return root;
}

/** 面板里的静态结构。配置项 id 全部保留 v3.0 的名字，便于对照旧文档。 */
function paneTemplates() {
    const providerOptions = Object.keys(PROVIDERS)
        .map(k => `<option value="${escapeHtml(k)}">${escapeHtml(PROVIDERS[k].label)}</option>`)
        .join('');
    const levelOptions = REASONING_LEVELS
        .map(x => `<option value="${escapeHtml(x.key)}">${escapeHtml(x.label)}</option>`)
        .join('');
    /** 提示词框的悬浮提示：把可用占位符列全，版面就不必再放一段说明 */
    const templateTitle = '此处即完整的大纲提示词：框中写什么，发送出去的就是什么（没有内置底模板）。' +
        '留空时只发送按规则自动补入的素材块。可用占位符：' +
        TEMPLATE_PLACEHOLDERS.map(p => '{{' + p + '}}').join(' ') +
        '。写错的占位符会被原样发给模型。';

    return `
    <div class="dro-pane" id="dro-pane-status">
        <label class="checkbox_label" for="dro-enabled">
            <input type="checkbox" id="dro-enabled">
            <span>启用双请求大纲</span>
        </label>
        <div class="dro-hint" title="主模型收到的历史不会因此减少，这一步属于额外成本，收益体现在大纲质量上。">
            每次生成前先用大纲模型读取聊天记录生成大纲，再注入本轮请求。<strong>会增加 token 成本。</strong>
        </div>
        <div class="dro-sec">当前大纲</div>
        <div class="dro-hint" id="dro-run-summary">尚未运行。</div>
        <textarea class="dro-outline-box" id="dro-outline-text" spellcheck="false"
            placeholder="大纲生成后会显示在这里；也可以在这里直接改写。"></textarea>
        <div class="dro-hint" id="dro-outline-hint"></div>
        <div class="dro-btnrow">
            <div class="menu_button" id="dro-regen-outline"
                title="把上面框里这份大纲锁定，然后让正文模型按它重新生成一次。这一轮不会再调用大纲模型。">以此大纲再次生成正文</div>
            <div class="menu_button" id="dro-unlock-outline" style="display:none"
                title="不再使用面板上这份大纲：下一次生成回到「先用大纲模型生成大纲」的正常流程">取消锁定</div>
        </div>
        <div class="dro-sec">数据诊断</div>
        <div id="dro-data-stats"></div>
        <details class="dro-adv" id="dro-request-map-box">
            <summary>主模型本轮真实组成（逐条）</summary>
            <div class="dro-hint" id="dro-request-map">暂无数据。发送一条消息后，这里会列出主模型本轮收到的每一条消息。</div>
        </details>
    </div>

    <div class="dro-pane" id="dro-pane-api">
        <div class="dro-sec">大纲用哪个来源</div>
        <label for="dro-source">来源</label>
        <select id="dro-source" class="text_pole" title="沿用酒馆当前来源：URL 与 Key 由酒馆管理，插件只临时替换模型名，生成结束后还原。选择具体来源：URL / Key / 模型全部由此处决定；发送依赖酒馆助手，未安装时自动沿用当前来源。">
            <option value="current">沿用酒馆当前来源（URL / Key 交给酒馆）</option>
            ${providerOptions}
        </select>

        <div id="dro-custom-box">
            <label for="dro-manual-url">API URL</label>
            <div class="dro-inline">
                <input type="text" id="dro-manual-url" class="text_pole" placeholder="https://...">
                <div class="menu_button dro-nodrag" id="dro-url-reset" title="恢复该来源的默认地址">默认</div>
            </div>

            <label for="dro-manual-key">API Key</label>
            <div class="dro-inline">
                <input type="password" id="dro-manual-key" class="text_pole" placeholder="sk-...">
                <div class="menu_button dro-nodrag" id="dro-key-eye" title="显示 / 隐藏"><i class="fa-solid fa-eye"></i></div>
            </div>
            <div class="dro-hint" title="留空时由酒馆后端使用该来源已保存的 Key，此时只有 URL 与模型来自本插件。">
                手填的 Key 会明文保存在酒馆设置中。<strong>留空则使用酒馆已保存的 Key。</strong>
            </div>
        </div>

        <label for="dro-model">大纲模型名</label>
        <div class="dro-inline">
            <input type="text" id="dro-model" class="text_pole" placeholder="留空则使用该来源的当前模型；模型名以「拉取清单」为准">
            <div class="menu_button dro-nodrag" id="dro-model-refresh" title="向 API 拉取一次模型清单">拉取清单</div>
        </div>
        <select id="dro-model-pick" class="text_pole"></select>

        <div class="dro-sec">思维链强度</div>
        <select id="dro-reasoning-level" class="text_pole" title="选择「不改」时插件不改动酒馆设置；选择其他档位时，发送大纲前临时修改推理强度，生成结束后还原（日志中会记录「已还原临时覆盖的设置」）。自定义来源同样生效。">${levelOptions}</select>

        <details class="dro-adv">
            <summary>高级参数</summary>
            <div class="dro-grid2">
                <div>
                    <label for="dro-maxtokens">max_tokens</label>
                    <input type="number" id="dro-maxtokens" class="text_pole" min="128" max="65536" step="128">
                </div>
                <div>
                    <label for="dro-timeout">超时（秒）</label>
                    <input type="number" id="dro-timeout" class="text_pole" min="5" max="900">
                </div>
            </div>
            <label class="checkbox_label" for="dro-streaming">
                <input type="checkbox" id="dro-streaming">
                <span>流式输出（面板实时显示大纲）</span>
            </label>
        </details>

        <div class="dro-hint" id="dro-api-preview">当前将使用：—</div>
    </div>

    <div class="dro-pane" id="dro-pane-whitelist">
        <div class="dro-sec">白名单</div>
        <div class="dro-hint" id="dro-preset-info">读取中…</div>
        <div class="dro-inline">
            <input type="text" id="dro-wl-search" class="text_pole" placeholder="搜索条目…">
            <div class="menu_button dro-nodrag" id="dro-wl-select-all" title="勾选当前筛选出的全部条目（素材与预设条目），不改变各自的去向">全选</div>
            <div class="menu_button dro-nodrag" id="dro-wl-clear-all" title="取消勾选当前筛选出的全部条目，不改变各自的去向">全清</div>
            <select id="dro-wl-bulk-target" class="text_pole" title="把当前筛选出的全部条目统一改为该去向，不改变勾选状态">
                <option value="">统一设为…</option>
                <option value="outline">只给大纲</option>
                <option value="main">只给主模型</option>
                <option value="both">都给</option>
            </select>
        </div>
        <div class="dro-wl-box" id="dro-whitelist"></div>
        <div class="dro-hint" id="dro-blocks-status"></div>
        <details class="dro-adv">
            <summary>「去向」三档的含义</summary>
            <div class="dro-hint">
                <strong>只给大纲</strong>：进入大纲提示词，并从主模型请求中移除。<br>
                　· 预设条目 / 世界书 / 角色卡 / Persona / 对话示例：整条精确匹配时才会移除；
                未能匹配则保留并在日志中记录（酒馆可能把它与其他内容合并为同一条消息）。<br>
                　· <strong>聊天记录</strong>：主模型仅保留<strong>最近 1 轮</strong>
                （一条 AI 输出及之后的用户输入）。整段移除会导致本轮输入无法送达主模型。<br>
                <strong>只给主模型</strong>：不进入大纲提示词，主模型侧保持原样。<br>
                <strong>都给</strong>：两边都保留。<br>
                <br>
                素材与预设条目使用同一套行结构与同一套规则，全选 / 全清 / 统一设为对两组一视同仁。
                酒馆中已关闭的条目会置灰，不可勾选。
            </div>
        </details>

        <div class="dro-sec">大纲提示词</div>
        <textarea id="dro-template" class="text_pole" rows="5" title="${escapeHtml(templateTitle)}"></textarea>
        <div id="dro-template-warn" class="dro-hint"></div>
    </div>

    <div class="dro-pane" id="dro-pane-log">
        <div class="dro-sec">运行日志</div>
        <div class="dro-inline">
            <select id="dro-log-level" class="text_pole" title="只看关键部分用「只看问题」：一行 warn / error 都没有，就说明这一轮从头到尾没出过状况。筛选只影响显示，「复制日志」始终复制全部。">
                <option value="all">全部</option>
                <option value="warn">只看问题（warn / error）</option>
            </select>
        </div>
        <div class="dro-log" id="dro-log"></div>
        <div class="dro-btnrow">
            <div class="menu_button" id="dro-log-clear">清空日志</div>
            <div class="menu_button" id="dro-log-copy">复制日志</div>
        </div>
    </div>

    <div class="dro-pane" id="dro-pane-about">
        <div class="dro-sec">环境自检</div>
        <div id="dro-caps"></div>

        <div class="dro-sec">悬浮窗</div>
        <label class="checkbox_label" for="dro-showbar">
            <input type="checkbox" id="dro-showbar">
            <span>显示悬浮竖条</span>
        </label>
        <label for="dro-opacity">竖条透明度</label>
        <input type="range" id="dro-opacity" min="0.1" max="1" step="0.05">
        <div class="dro-btnrow">
            <div class="menu_button" id="dro-reset-layout" title="位置回到右上角，尺寸回到默认">重置位置与尺寸</div>
        </div>

        <div class="dro-sec">配置</div>
        <div class="dro-btnrow">
            <div class="menu_button" id="dro-export">导出配置</div>
            <div class="menu_button" id="dro-import">导入配置</div>
            <div class="menu_button" id="dro-reset" title="保留白名单与系统预设条目配置，其余回到默认">恢复默认</div>
        </div>
        <textarea id="dro-io-text" class="text_pole" rows="4" placeholder="导出的配置会出现在这里；也可以把配置粘贴进来后点「导入配置」。"></textarea>

        <div class="dro-hint" style="margin-top:10px;">
            ${escapeHtml(EXT_ID)}　版本 <span id="dro-version">—</span><br>
            快捷键 Ctrl+Alt+O 开/关悬浮窗；控制台 window.__dro。
        </div>
    </div>`;
}

function cacheElements() {
    const ids = [
        'dro-enabled', 'dro-status-badge', 'dro-run-summary', 'dro-outline-text',
        'dro-outline-hint', 'dro-regen-outline', 'dro-unlock-outline',

        'dro-source', 'dro-custom-box',
        'dro-manual-url', 'dro-url-reset', 'dro-manual-key', 'dro-key-eye',
        'dro-model', 'dro-model-pick', 'dro-model-refresh',
        'dro-reasoning-level', 'dro-api-preview',

        'dro-maxtokens', 'dro-timeout', 'dro-streaming',

        'dro-blocks-status',

        'dro-preset-info', 'dro-wl-search', 'dro-wl-bulk-target',
        'dro-wl-select-all', 'dro-wl-clear-all',
        'dro-whitelist',

        'dro-template', 'dro-template-warn',

        'dro-data-stats', 'dro-request-map',
        'dro-caps',

        'dro-log', 'dro-log-clear', 'dro-log-copy', 'dro-log-level',

        'dro-showbar', 'dro-opacity', 'dro-reset-layout',

        'dro-export', 'dro-import', 'dro-reset', 'dro-io-text', 'dro-version',

        'dro-panel-reload', 'dro-panel-close',
    ];
    els = {};
    for (const id of ids) els[id] = $(id);
}

// ============================================================
// 开关 / 标签页
// ============================================================

export function isOpen() {
    return getSettings().panelOpen === true;
}

export function openPanel() {
    if (!root) return;
    try {
        setSettings({ panelOpen: true });
    } catch (e) {
        log('记录面板状态失败: ' + errorText(e), 'warn', 'env');
    }
    panel.style.display = 'flex';
    bar.style.display = 'none';
    placeRoot(true);
    // 展开后把一直在后台累积的日志刷一次，省得用户以为没动静
    renderLog();
    // 「悬浮窗已展开」不写日志：用户自己刚点的，屏幕上看得见
}

export function closePanel() {
    if (!root) return;
    panel.style.display = 'none';
    bar.style.display = getSettings().showBar === false ? 'none' : '';
    try {
        setSettings({ panelOpen: false });
    } catch (e) { /* ignore */ }
    placeRoot(false);
}

export function togglePanel() {
    if (isOpen()) closePanel(); else openPanel();
}

function bindTabs() {
    const tabs = $('dro-tabs');
    if (!tabs) return;
    const labels = { status: '状态', api: '调用', whitelist: '白名单', log: '日志', about: '关于' };
    for (const key of PANEL_TABS) {
        const el = document.createElement('div');
        el.className = 'dro-tab';
        el.id = 'dro-tab-btn-' + key;
        el.textContent = labels[key] || key;
        el.addEventListener('click', () => switchTab(key));
        tabs.appendChild(el);
    }
}

/** 切标签页。@param {string} key @param {{silent?:boolean}} [opt] */
export function switchTab(key, opt = {}) {
    if (!PANEL_TABS.includes(key)) key = 'status';
    activeTab = key;
    for (const k of PANEL_TABS) {
        const btn = $('dro-tab-btn-' + k);
        const pane = $('dro-pane-' + k);
        if (btn) btn.className = 'dro-tab' + (k === key ? ' active' : '');
        if (pane) pane.style.display = (k === key) ? '' : 'none';
    }
    if (!opt.silent) {
        try { setSettings({ panelTab: key }); } catch (e) { /* ignore */ }
    }
    // 切页时刷新一次，避免看到过期内容（标题栏的 ⟳ 是「全都刷一遍」的入口）
    if (key === 'status') renderStats();
    if (key === 'whitelist') { renderPresetInfo(); renderWhitelist(); }
    if (key === 'log') renderLog();
    if (key === 'about') renderCaps();
}

// ============================================================
// 交互：拖动 + 点击
// ============================================================

/** 拖动以 window 上的 pointermove/pointerup 为准，
 *  这样快速拖动离开小元素也不会丢事件；
 *  不用 setPointerCapture（捕获后 click 判定不可靠）。 */
function bindDragTap(handle, onTap, opts = {}) {
    let st = null;
    let suppressClick = false;

    const onMove = (e) => {
        if (!st) return;
        const dx = e.clientX - st.x;
        const dy = e.clientY - st.y;
        if (!st.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        st.moved = true;
        root.classList.add('dro-dragging');
        const w = opts.width() || 40;
        const h = opts.height() || 40;
        const vw = window.innerWidth || 1200;
        const vh = window.innerHeight || 800;
        st.left = clamp(st.ox + dx, 2, Math.max(2, vw - w - 2));
        st.top = clamp(st.oy + dy, 2, Math.max(2, vh - h - 2));
        root.style.left = st.left + 'px';
        root.style.top = st.top + 'px';
        root.style.right = 'auto';
        if (typeof e.preventDefault === 'function') e.preventDefault();
    };

    const onUp = () => {
        if (!st) return;
        const moved = st.moved;
        const left = st.left;
        const top = st.top;
        st = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        root.classList.remove('dro-dragging');
        if (!moved) return;
        // 真拖过了：屏蔽掉紧随其后的那一次 click（拖动结束浏览器仍可能补发）
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        try {
            setSettings({ panelX: Math.round(left), panelY: Math.round(top) });
        } catch (e) { /* ignore */ }
    };

    handle.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('.dro-nodrag')) return;
        const r = rectOf(root);
        const ox = numOr(root.style.left, r.left);
        const oy = numOr(root.style.top, r.top);
        root.style.left = ox + 'px';
        root.style.top = oy + 'px';
        root.style.right = 'auto';
        st = { x: e.clientX, y: e.clientY, ox, oy, left: ox, top: oy, moved: false };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    });

    handle.addEventListener('click', (e) => {
        if (suppressClick) { suppressClick = false; if (typeof e.stopPropagation === 'function') e.stopPropagation(); return; }
        onTap(e);
    });
}

function bindBar() {
    bindDragTap(bar, () => openPanel(), {
        width: () => (bar.offsetWidth || 36),
        height: () => (bar.offsetHeight || 110),
    });
    bar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            openPanel();
        }
    });
    bar.addEventListener('dblclick', () => openPanel());
}

function bindPanelHead() {
    // 标题栏只负责拖动：点空白处不做事，按 .dro-nodrag 排除按钮
    bindDragTap($('dro-panel-head'), () => { }, {
        width: () => (panel.offsetWidth || 620),
        height: () => (panel.offsetHeight || 600),
    });
    if (els['dro-panel-close']) els['dro-panel-close'].addEventListener('click', () => closePanel());
    if (els['dro-panel-reload']) {
        els['dro-panel-reload'].addEventListener('click', () => {
            refreshCtx();
            probe(true);
            refreshPreset();
            refreshForms();
            renderCaps();
            renderPresetInfo();
            renderWhitelist();
            renderStats();
            toast('已刷新：重新自检、重读预设并重算统计', 'success');
        });
    }
}

/** 右下角拖拽改尺寸 */
function bindResize() {
    const grip = $('dro-resize');
    if (!grip) return;
    let st = null;

    const onMove = (e) => {
        if (!st) return;
        const vw = window.innerWidth || 1200;
        const vh = window.innerHeight || 800;
        const w = clamp(st.w + (e.clientX - st.x), 340, Math.max(360, vw - 16));
        const h = clamp(st.h + (e.clientY - st.y), 260, Math.max(300, vh - 16));
        st.cur = { w: Math.round(w), h: Math.round(h) };
        panel.style.width = st.cur.w + 'px';
        panel.style.height = st.cur.h + 'px';
        // 变大之后可能顶出屏幕，边拖边钳回来
        clampIntoView();
        if (typeof e.preventDefault === 'function') e.preventDefault();
    };

    const onUp = () => {
        if (!st) return;
        const cur = st.cur;
        st = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (cur) {
            const r = rectOf(root);
            try {
                setSettings({
                    panelW: cur.w, panelH: cur.h,
                    panelX: Math.round(numOr(root.style.left, r.left)),
                    panelY: Math.round(numOr(root.style.top, r.top)),
                });
            } catch (e) { /* ignore */ }
        }
    };

    grip.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        // 尺寸优先读内联样式（applyGeometry 一定会写），它比 offsetWidth 准：
        // offsetWidth 受布局影响，元素被隐藏时还是 0。
        const fallback = panelSize();
        st = {
            x: e.clientX, y: e.clientY,
            w: numOr(panel.style.width, panel.offsetWidth || fallback.w),
            h: numOr(panel.style.height, panel.offsetHeight || fallback.h),
            cur: null,
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    });
}

// ============================================================
// 几何：位置与尺寸
// ============================================================

function panelSize() {
    const s = getSettings();
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const w = clamp(Number(s.panelW) || Math.min(620, Math.max(360, vw - 80)), 340, Math.max(360, vw - 16));
    const h = clamp(Number(s.panelH) || Math.min(740, Math.max(420, Math.round(vh * 0.78))), 260, Math.max(300, vh - 16));
    return { w: Math.round(w), h: Math.round(h) };
}

function applyGeometry() {
    const { w, h } = panelSize();
    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
}

/**
 * 按「当前实际尺寸」把 root 钳回可视区，不改变用户在屏幕上的相对位置。
 * 和 placeRoot 的区别：placeRoot 是从配置算位置，这个是从当前 DOM 算。
 */
function clampIntoView() {
    if (!root) return;
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const r = rectOf(root);
    const w = numOr(panel.style.width, r.width || 40);
    const h = numOr(panel.style.height, r.height || 40);
    const x = clamp(numOr(root.style.left, r.left), 4, Math.max(4, vw - w - 4));
    const y = clamp(numOr(root.style.top, r.top), 4, Math.max(4, vh - h - 4));
    root.style.left = Math.round(x) + 'px';
    root.style.top = Math.round(y) + 'px';
    root.style.right = 'auto';
}

/** 把 root 摆回可视区。open=true 时按面板尺寸算，false 时按竖条尺寸算。 */
function placeRoot(open) {
    if (!root) return;
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const s = getSettings();
    const size = open
        ? panelSize()
        : { w: bar.offsetWidth || 36, h: bar.offsetHeight || 110 };

    let x = numOr(s.panelX, null);
    let y = numOr(s.panelY, null);
    if (x == null || y == null) {
        // 默认：右上角
        x = Math.max(6, vw - size.w - 14);
        y = 90;
    }
    x = clamp(x, 4, Math.max(4, vw - size.w - 4));
    y = clamp(y, 4, Math.max(4, vh - size.h - 4));
    root.style.left = Math.round(x) + 'px';
    root.style.top = Math.round(y) + 'px';
    root.style.right = 'auto';
}

function applyBarVisibility() {
    if (!bar) return;
    const show = getSettings().showBar !== false;
    // 面板打开时竖条一律收起：两个都在会显得重复
    bar.style.display = (show && !isOpen()) ? '' : 'none';
}

function applyBarOpacity() {
    if (!root) return;
    root.style.opacity = String(getSettings().barOpacity);
}

/** 视口变化：重新钳制，避免窗口缩小后悬浮窗跑到看不见的地方 */
function handleResize() {
    if (!root) return;
    applyGeometry();
    placeRoot(isOpen());
}

// ============================================================
// 设置项绑定
// ============================================================

function bindSettings() {
    const on = (el, fn, type = 'change') => {
        if (!el) return;
        el.addEventListener(type, () => {
            try { fn(); } catch (e) {
                log('保存设置失败: ' + errorText(e), 'error', 'env');
                toast('保存设置失败：' + errorText(e), 'error');
            }
        });
    };

    on(els['dro-enabled'], () => setSettings({ enabled: els['dro-enabled'].checked !== false }));

    // ---- 来源：一个下拉同时表达「沿用酒馆当前来源」与「自定义连接」 ----
    on(els['dro-source'], () => {
        const v = els['dro-source'].value;
        const cur = getSettings();
        if (v === 'current') {
            setSettings({ connMode: 'current' });
        } else {
            const before = providerConfig(cur.provider);
            const patch = { connMode: 'custom', provider: v };
            // 换来源时顺手把 URL 换成新来源的默认地址
            // （只在原来的值是空、或还是旧来源默认地址时才换）
            const urlNow = String(els['dro-manual-url'].value || '').trim();
            if (!urlNow || urlNow === before.url) patch.manualUrl = providerConfig(v).url;
            setSettings(patch);
        }
        refreshForms();
    });
    on(els['dro-manual-url'], () => setSettings({ manualUrl: els['dro-manual-url'].value.trim() }));
    on(els['dro-manual-key'], () => setSettings({ manualKey: els['dro-manual-key'].value.trim() }));
    on(els['dro-model'], () => {
        setSettings({ model: els['dro-model'].value.trim() });
        updateApiPreview();
    });
    if (els['dro-model-pick']) {
        els['dro-model-pick'].addEventListener('change', () => {
            const v = els['dro-model-pick'].value;
            if (!v) return;
            els['dro-model'].value = v;
            setSettings({ model: v });
            updateApiPreview();
        });
    }
    on(els['dro-reasoning-level'], () => {
        setSettings({ reasoningLevel: els['dro-reasoning-level'].value });
        renderReasoningHint();
        updateApiPreview();
    });

    on(els['dro-maxtokens'], () => setSettings({ maxTokens: Number(els['dro-maxtokens'].value) }));
    on(els['dro-timeout'], () => setSettings({ timeoutSec: Number(els['dro-timeout'].value) }));
    on(els['dro-streaming'], () => setSettings({ streaming: els['dro-streaming'].checked === true }));

    // ---- 模型列表 ----
    if (els['dro-model-refresh']) {
        els['dro-model-refresh'].addEventListener('click', async () => {
            const label = els['dro-model-refresh'].textContent;
            els['dro-model-refresh'].textContent = '…';
            const r = await fetchModelList(getSettings());
            els['dro-model-refresh'].textContent = label;
            if (r.ok) {
                const s = getSettings();
                const list = Object.assign({}, s.modelList);
                list[providerConfig(s.provider).key] = r.models;
                setSettings({ modelList: list });
                renderModelOptions();
                toast(`已获取 ${r.models.length} 个模型`, 'success');
            } else {
                renderModelOptions();
                toast(r.error || '拉取模型列表失败', 'error');
            }
        });
    }
    if (els['dro-url-reset']) {
        els['dro-url-reset'].addEventListener('click', () => {
            const url = providerConfig(getSettings().provider).url;
            els['dro-manual-url'].value = url;
            setSettings({ manualUrl: '' });
            updateApiPreview();
            toast(url ? '已填回默认地址' : '该来源没有内置地址', url ? 'success' : 'warn');
        });
    }
    if (els['dro-key-eye']) {
        els['dro-key-eye'].addEventListener('click', () => {
            const box = els['dro-manual-key'];
            box.type = box.type === 'password' ? 'text' : 'password';
        });
    }

    // ---- 素材块（聊天记录 / 世界书 / 角色卡 / Persona / 对话示例）----
    // 它们和白名单条目现在同在一张表里，由 renderWhitelist 一并画出来
    renderWhitelist();

    // ---- 白名单 ----
    // 三个批量控件各管一件事。**素材和预设条目一起管**（两组是同一张表、
    // 同一套行结构，批量操作要是指望人记得"这个只管下面那半张表"，
    // 那就是界面在骗人）：
    //   全选 / 全清  —— 只改勾选，不动各行自己的去向
    //   统一设为…    —— 只改去向，不动勾选；选中即生效，随后自动复位
    const bulkTargets = () => {
        const name = readPreset().name;
        const entries = visibleWhitelistNames();
        const blocks = visibleBlockKeys();
        return { name, entries, blocks, total: entries.length + blocks.length };
    };
    on(els['dro-wl-search'], () => renderWhitelist(), 'input');
    if (els['dro-wl-select-all']) els['dro-wl-select-all'].addEventListener('click', () => {
        const b = bulkTargets();
        patchEntries(b.name, b.entries, { enabled: true });
        patchBlocks(b.name, b.blocks, { enabled: true });
        renderWhitelist();
        toast(`已勾选 ${b.total} 条`, 'success');
    });
    if (els['dro-wl-clear-all']) els['dro-wl-clear-all'].addEventListener('click', () => {
        const b = bulkTargets();
        patchEntries(b.name, b.entries, { enabled: false });
        patchBlocks(b.name, b.blocks, { enabled: false });
        renderWhitelist();
        toast(`已取消 ${b.total} 条`, 'success');
    });
    on(els['dro-wl-bulk-target'], () => {
        const tgt = els['dro-wl-bulk-target'].value;
        if (!tgt) return;                       // 选回占位项 = 什么都不做
        const b = bulkTargets();
        patchEntries(b.name, b.entries, { target: tgt });
        patchBlocks(b.name, b.blocks, { target: tgt });
        els['dro-wl-bulk-target'].value = '';   // 复位，免得看起来还在生效
        renderWhitelist();
        toast(`已把 ${b.total} 条设为「${targetLabel(tgt)}」`, 'success');
    }, 'change');

    // 大纲提示词：用 input 而不是 change —— textarea 的 change 要**失焦**才触发，
    // 改完直接刷新页面就白改了（这次就是栽在这里，改成打字即存）。
    on(els['dro-template'], () => {
        setSettings({ template: els['dro-template'].value });
        renderTemplateWarn();
    }, 'input');

    // ---- 界面 ----
    on(els['dro-showbar'], () => {
        setSettings({ showBar: els['dro-showbar'].checked !== false });
        applyBarVisibility();
    });
    on(els['dro-opacity'], () => {
        setSettings({ barOpacity: Number(els['dro-opacity'].value) });
        applyBarOpacity();
    }, 'input');
    if (els['dro-reset-layout']) els['dro-reset-layout'].addEventListener('click', () => {
        setSettings({ panelX: null, panelY: null, panelW: null, panelH: null });
        applyGeometry();
        placeRoot(isOpen());
        toast('位置与尺寸已重置', 'success');
    });

    // ---- 大纲 ----
    /**
     * 框里那份是**用户的东西**：他一动手就记一笔（outlineEdited），
     * 提示行据此改口，下一轮生成之前也不会被任何模型输出盖掉
     * （见 setOutline 与 takeLockedOutline）。
     * 这里刻意不用 on()：那个包装器的报错文案是「保存设置失败」，
     * 而这里什么都没存进配置 —— 写错了会把人带偏。
     */
    if (els['dro-outline-text']) els['dro-outline-text'].addEventListener('input', () => {
        outlineEdited = true;
        refreshOutlineHint();
    });

    if (els['dro-regen-outline']) els['dro-regen-outline'].addEventListener('click', async () => {
        // 总开关关着的时候拦截器整段都不跑，这份大纲根本进不了请求。
        // 与其发一次「看起来成功了」的生成，不如当场说清为什么不行。
        if (getSettings().enabled === false) {
            toast('插件总开关是关着的：先勾上上面那个「启用双请求大纲」', 'warn');
            return;
        }
        const text = outlineBoxValue();
        if (!text) {
            toast('大纲是空的：先生成一次大纲，或自己在这个框里写一份', 'warn');
            return;
        }
        // 先锁定再触发：万一酒馆那边这一轮没跑起来，锁定状态留着，
        // 用户手动点酒馆的「重新生成」照样会用上这份大纲。
        lockOutline();
        const r = await regenerateReply();
        if (r.ok) {
            // 「已发起」而不是「已完成」：酒馆那边还要写一会儿
            toast(`已按这份大纲发起正文生成（${text.length} 字）`, 'success');
        } else {
            toast(`${r.reason}：请手动点酒馆的「重新生成」，已锁定的这份大纲下一次生成就会用上`, 'warn');
        }
        refreshOutlineHint();
    });

    if (els['dro-unlock-outline']) els['dro-unlock-outline'].addEventListener('click', () => {
        unlockOutline();
        toast('已取消锁定：下一次生成重新调用大纲模型', 'info');
    });

    // ---- 日志 ----
    if (els['dro-log-level']) {
        els['dro-log-level'].value = logFilter;
        els['dro-log-level'].addEventListener('change', () => {
            logFilter = els['dro-log-level'].value === 'warn' ? 'warn' : 'all';
            renderLog();
        });
    }
    if (els['dro-log-clear']) els['dro-log-clear'].addEventListener('click', () => { clearLog(); renderLog(); });
    if (els['dro-log-copy']) els['dro-log-copy'].addEventListener('click', async () => {
        // 和屏幕上那份是同一个来源（见 renderLog 的说明）
        const ok = await copyText(formatLogLines());
        toast(ok ? '日志已复制' : '复制失败，请手动选中文档区内容', ok ? 'success' : 'warn');
    });

    // ---- 导入导出 ----
    if (els['dro-export']) els['dro-export'].addEventListener('click', () => {
        els['dro-io-text'].value = exportJSON();
        els['dro-io-text'].select();
        toast('配置已导出到下方文本框', 'success');
    });
    if (els['dro-import']) els['dro-import'].addEventListener('click', () => {
        const r = importJSON(els['dro-io-text'].value);
        toast(r.msg, r.ok ? 'success' : 'error');
        if (r.ok) { refreshForms(); renderWhitelist(); }
    });
    if (els['dro-reset']) els['dro-reset'].addEventListener('click', () => {
        resetKeepWhitelist();
        refreshForms();
        renderWhitelist();
        toast('已恢复默认（白名单保留）', 'success');
    });

    if (els['dro-version']) els['dro-version'].textContent = VERSION;

    // 日志实时刷新
    destroyFns.push(onLog(() => renderLog()));
    // 配置在别处被改动时同步表单（比如酒馆扩展设置区那张卡片）
    destroyFns.push(watchSettings(() => syncFromSettings()));
    // 视口变化
    window.addEventListener('resize', handleResize);
    destroyFns.push(() => window.removeEventListener('resize', handleResize));
}

/**
 * 素材块的实时状态（每块真正会拼进提示词的字数 / 读不到的原因）。
 * 行里的「字数」列和表格下那行状态文字共用这一份数据，避免两处算法漂移。
 *
 * note —— 只写**表格里看不出来**的那一件事（几层 / 激活几条 / 读不到），
 *         字数别重复报：表格那列已经有了。
 */
function blockFacts() {
    const chat = chatStats();
    /**
     * ★ 聊天记录这一格的字数必须用**压缩后**的体量（historyStats），
     *   不能用 chatStats().rawChars。以前用的是 rawChars（原文总量），
     *   那个数字永远不会因为正则压缩而变小 ——
     *   于是面板上「聊天记录 5.8k」看着就像「正则压缩没生效」，
     *   而真正发给大纲模型的其实是另一个数。这是 v3.9.0 修的一个显示 bug。
     */
    const hs = historyStats();
    const world = latestWorldInfo();
    const card = charCardBlock();
    const persona = personaBlock();
    const examples = examplesBlock();

    return {
        history: {
            // 字数列只给一个数（和其它条目一样简洁），详情放在 title 里
            chars: hs.finalChars,
            title: `原文 ${fmtNum(hs.rawChars)} 字 → 过完酒馆正则（逐层带 depth，与主模型同口径）` +
                `${fmtNum(hs.finalChars)} 字` + (hs.compressed ? `（省 ${hs.savedPct}）` : '（未压缩）'),
            note: `聊天记录 ${hs.floors} 层`,
            off: '聊天记录 不给大纲',
            toMain: '聊天记录 只给主模型',
        },
        worldInfo: {
            chars: world.chars,
            title: '本轮真正注入的世界书正文（采用酒馆的扫描结果，不重复扫描）',
            // 判据是「有没有激活条目」而不只是「正文非空」——
            // 条目拿到了但正文为空也要如实报出来，不能显示成「没有激活条目」
            note: !(world.count || world.text)
                ? '世界书 本轮没激活'
                : (world.stale
                    ? '世界书 扫描已过期，未写入提示词'
                    : `世界书 激活 ${world.count} 条` + (world.overflowed ? '｜预算溢出' : '')),
            off: '世界书 不给大纲',
            toMain: '世界书 只给主模型',
        },
        charCard: {
            chars: card.text.length,
            title: '角色卡的描述 / 性格 / 场景，宏已展开',
            note: card.text ? '' : `角色卡 读不到（${card.note}）`,
            off: '角色卡 不给大纲',
            toMain: '角色卡 只给主模型',
        },
        persona: {
            chars: persona.text.length,
            title: '你在酒馆里设的 Persona 描述',
            note: persona.text ? '' : `Persona 读不到（${persona.note}）`,
            off: 'Persona 不给大纲',
            toMain: 'Persona 只给主模型',
        },
        examples: {
            chars: examples.text.length,
            title: '角色卡里的对话示例（mes_example）',
            note: examples.text ? '' : `对话示例 读不到（${examples.note}）`,
            off: '对话示例 不给大纲',
            toMain: '对话示例 只给主模型',
        },
    };
}

/**
 * 素材块现在的实际状态：一行字，放在白名单表格下面。
 * ============================================================
 * 这里只报两件事，别的不重复：
 *   · 几块上大纲
 *   · **例外**（不给大纲 / 只给主模型）和**数字异常**（读不到、过期、溢出）
 * 每块的字数不上这一行 —— 表格里就有那一列。
 * 「不给大纲 / 只给主模型」用的还是 facts 里那三个词，和去向下拉一字不差。
 */
function renderBlocksStatus() {
    if (!els['dro-blocks-status']) return;
    const cfg = blockConfigOf(getSettings(), readPreset().name);
    const facts = blockFacts();

    const on = (k) => {
        const rec = cfg[k] || {};
        return rec.enabled !== false && (rec.target || TARGET.OUTLINE) !== TARGET.MAIN;
    };

    const off = [];
    const toMain = [];
    for (const b of SYSTEM_BLOCKS) {
        const rec = cfg[b.key] || {};
        if (rec.enabled === false) off.push(facts[b.key].off);
        else if (rec.target === TARGET.MAIN) toMain.push(facts[b.key].toMain);
    }

    const onCount = SYSTEM_BLOCKS.filter(b => on(b.key)).length;
    const parts = [`上大纲 ${onCount}/${SYSTEM_BLOCKS.length} 块`];
    if (off.length) parts.push(off.join('、'));
    if (toMain.length) parts.push(toMain.join('、'));
    // 关键数字（表格里没有的那几样）只报给「真的进提示词」的块
    for (const b of SYSTEM_BLOCKS) {
        if (!on(b.key)) continue;
        const note = facts[b.key].note;
        if (note) parts.push(note);
    }

    els['dro-blocks-status'].textContent = parts.join('｜');
    // 完整账（每块多少字、去哪）放悬浮提示，不占版面
    els['dro-blocks-status'].title = SYSTEM_BLOCKS.map(b => {
        const rec = cfg[b.key] || {};
        const where = rec.enabled === false
            ? '不给大纲'
            : ((rec.target || TARGET.OUTLINE) === TARGET.MAIN ? '只给主模型' : '上大纲');
        return `${b.short} ${fmtNum(facts[b.key].chars)} 字（${where}）`;
    }).join('｜') + '｜字数：真正写入提示词的量。';
}

/** 去向下拉：三档，**预设条目和素材块都用这一套，而且都真的会执行** */
const TARGET_OPTIONS = [['outline', '只给大纲'], ['main', '只给主模型'], ['both', '都给']];

/**
 * 白名单表格里的一行 —— **素材和预设条目共用这一个构造器**。
 * 两组的行长得一样、行为一样：勾选框 + 名字 + 去向 + 字数，
 * 差别只有「数据从哪来」「去向有几档」「字数怎么算」，都由 spec 传进来。
 *
 * spec: {
 *   cbId, labelText, labelTitle, checkTitle, off,
 *   enabled, target, disabled,
 *   targetOptions,                   // 不传就用三档的 TARGET_OPTIONS
 *   selTitle,                        // 去向下拉自己的 title
 *   lenText(enabled, target),        // 字数那一列怎么显示
 *   onChange(enabled, target),
 * }
 */
function whitelistRow(spec) {
    const row = document.createElement('div');
    row.className = 'dro-row';

    const options = spec.targetOptions || TARGET_OPTIONS;
    // 值可能是老配置里的 'both'，而这一行只有两档 → 归到第一档（语义等价）
    const wantValue = (v) => options.some(o => o[0] === v) ? v : options[0][0];

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = spec.cbId;
    cb.checked = spec.enabled !== false;
    cb.disabled = !!spec.disabled;
    cb.title = spec.checkTitle || '';

    const label = document.createElement('label');
    label.htmlFor = cb.id;
    label.textContent = spec.labelText;
    label.title = spec.labelTitle || '';
    if (spec.off) label.classList.add('dro-off');

    const sel = document.createElement('select');
    sel.className = 'text_pole';
    sel.style.width = 'auto';
    sel.id = spec.selId;
    sel.disabled = !!spec.disabled;
    sel.title = spec.selTitle || '只给大纲：进入大纲提示词；只给主模型：不进入大纲提示词；都给：两边都保留';
    for (const [val, txt] of options) {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = txt;
        if (wantValue(spec.target) === val) o.selected = true;
        sel.appendChild(o);
    }

    const len = document.createElement('span');
    len.className = 'dro-len';
    len.title = spec.lenTitle || '';
    len.textContent = spec.lenText(cb.checked, sel.value);

    const save = () => {
        spec.onChange(cb.checked, sel.value);
        len.textContent = spec.lenText(cb.checked, sel.value);
    };
    cb.addEventListener('change', save);
    sel.addEventListener('change', save);
    label.addEventListener('click', () => {
        if (cb.disabled) return;
        cb.checked = !cb.checked;
        save();
    });

    row.appendChild(cb);
    row.appendChild(label);
    row.appendChild(sel);
    row.appendChild(len);
    return row;
}

/** 素材的一行（走的就是上面那个共用构造器） */
function blockRow(b, fact, cfg, presetName) {
    const rec = cfg[b.key] || { enabled: true, target: 'outline' };
    const chars = fmtNum(fact.chars) + '字';
    return whitelistRow({
        cbId: 'dro-blk-' + b.key,
        selId: 'dro-blk-tgt-' + b.key,
        labelText: b.short || b.label,
        labelTitle: [`占位符 {{${b.pl}}}`, b.label, fact.title].filter(Boolean).join('｜'),
        checkTitle: '取消勾选即该素材块不进入大纲提示词，等同于把去向设为「只给主模型」',
        selTitle: '三档均会实际执行：\n' +
            '只给大纲：进入大纲提示词，并从主模型请求中移除（聊天记录则裁剪为最近 ' +
            TRIM_KEEP_ROUNDS + ' 轮）；\n' +
            '只给主模型：不进入大纲提示词；\n' +
            '都给：两边都保留。',
        targetOptions: TARGET_OPTIONS,
        enabled: rec.enabled !== false,
        target: rec.target || 'outline',
        lenTitle: fact.title,
        lenText: (enabled, target) => (enabled && target !== 'main') ? chars : '—',
        onChange: (enabled, target) => {
            setBlockConfig(presetName, { [b.key]: { enabled, target } });
            renderBlocksStatus();
            renderStats();
        },
    });
}

/**
 * 跟着「聊天记录」那一行的一条备注 —— 说的就是历史裁剪的保护。
 * ============================================================
 * 裁剪没有开关（「调用」页那块界面已经删掉）：它只在
 * 「聊天记录」= 只给大纲 时自动发生，固定只留最近 TRIM_KEEP_ROUNDS 轮。
 * 那几条安全边界没别的地方可写，就写在这儿 —— 版面上一句，完整的进悬浮提示。
 *
 * 用 textContent 而不是 innerHTML：这条备注就是一句完整的话，
 * 而且自检脚本能直接把它读出来核对（不依赖迷你 DOM 的 innerHTML 回读）。
 */
function historyNoteRow() {
    const n = document.createElement('div');
    n.className = 'dro-hint dro-note';
    n.title = '裁剪发生在酒馆扫描世界书、拼好 messages 之后，发送请求之前，因此靠旧关键词激活的条目不会被裁掉。' +
        '只有整条正文与该楼层完全一致的消息才会被识别，未能识别的一律保留；' +
        '删除的条数不会超过应当裁剪的楼层数。';
    n.textContent =
        '去向为「只给大纲」时，主模型仅保留最近 ' + TRIM_KEEP_ROUNDS + ' 轮。' +
        '未能识别的楼层一律保留，最后一条 user 消息不会被删除。';
    return n;
}

// ============================================================
// 表单同步与渲染
// ============================================================

/** 把配置写回控件（用户操作后调用，或配置在别处变更后调用） */
export function refreshForms() {
    if (!els['dro-enabled']) return;
    const s = getSettings();

    setChecked('dro-enabled', s.enabled !== false);
    setValue('dro-source', sourceValue(s));
    setValue('dro-manual-url', s.manualUrl || providerConfig(s.provider).url);
    setValue('dro-manual-key', s.manualKey || '');
    setValue('dro-model', s.model || '');
    // 思维链强度的选项跟着来源走（DeepSeek 用自己的写法），在这里一并重建
    renderReasoningOptions();
    setValue('dro-maxtokens', s.maxTokens);
    setValue('dro-timeout', s.timeoutSec);
    setChecked('dro-streaming', s.streaming !== false);

    // 大纲提示词：框里是什么就是什么，不做任何回填/默认值顶上
    setValue('dro-template', s.template || '');

    setChecked('dro-showbar', s.showBar !== false);
    setValue('dro-opacity', s.barOpacity);

    updateConnectionVisibility();
    renderModelOptions();
    renderReasoningHint();
    renderTemplateWarn();
    updateApiPreview();
    renderPresetInfo();
    renderWhitelist();
    renderRequestMap();
}

/** 外部改了配置（比如扩展设置区那张卡片）时，只同步控件值，不重建列表 */
function syncFromSettings() {
    if (!els['dro-enabled']) return;
    const s = getSettings();
    setChecked('dro-enabled', s.enabled !== false);
    setChecked('dro-showbar', s.showBar !== false);
    setValue('dro-opacity', s.barOpacity);
    if (!isOpen()) applyBarVisibility();
}

function setValue(id, v) {
    const el = els[id];
    if (!el) return;
    el.value = (v == null) ? '' : String(v);
}

function setChecked(id, v) {
    const el = els[id];
    if (!el) return;
    el.checked = v === true;
}

/** 下拉当前该显示哪个值：'current' 或某个 provider 的 key */
function sourceValue(s) {
    return (s.connMode === CONN_MODE.CUSTOM && PROVIDERS[s.provider]) ? s.provider : 'current';
}

/** 调用页：整页只留一行实时状态，说明文字都在控件的悬浮提示里 */
const REASONING_TITLE = '选择「不改」时插件不改动酒馆设置；选择其他档位时，发送大纲前临时修改推理强度，' +
    '生成结束后还原（日志中会记录「已还原临时覆盖的设置」）。自定义来源同样生效。';

/** 这套档位是哪来的（写进悬浮提示，避免用户以为选项是随意设定的） */
const SYNTAX_TITLE = {
    deepseek: '当前使用 DeepSeek 官方档位（low / medium / high / max，没有 minimum，最低即 low）。' +
        'DeepSeek 仅在酒馆的「请求模型思维链」开启时读取该强度，插件会为大纲请求开启它。',
};

function updateConnectionVisibility() {
    const s = getSettings();
    const custom = sourceValue(s) !== 'current';
    if (els['dro-custom-box']) els['dro-custom-box'].style.display = custom ? '' : 'none';

    // 各来源对「思维链」字段的解释不一样，动态补进那个下拉的悬浮提示
    if (els['dro-reasoning-level']) {
        const cfg = providerConfig(s.provider);
        const syntaxNote = SYNTAX_TITLE[reasoningSyntax(s)] || '';
        els['dro-reasoning-level'].title = REASONING_TITLE +
            (syntaxNote ? '｜' + syntaxNote : '') +
            (cfg.reasoning ? '｜来源说明：' + cfg.reasoning : '');
    }

    // 以前这里有 3 段说明，其中一句还和底部「当前将使用」完全重复。
    // 现在整页只留底部一行实时状态，解释性文字都进了各控件的悬浮提示。
    updateApiPreview();
}

/** 模型下拉：常用/拉取到的清单，选中即写进模型输入框 */
function renderModelOptions() {
    const sel = els['dro-model-pick'];
    if (!sel) return;
    const s = getSettings();
    const list = modelChoices(s);
    sel.innerHTML = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = list.length ? '（从清单里选一个填进上面的输入框）' : '（没有可用清单，直接手填）';
    sel.appendChild(first);
    for (const name of list) {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        if (s.model === name) o.selected = true;
        sel.appendChild(o);
    }
    sel.value = '';
}

function renderReasoningHint() {
    // 说明性的部分已经挪进「思维链强度」下拉的悬浮提示；
    // 这里只保留一句会被动态改变的状态，跟底部那行合并显示。
    updateApiPreview();
}

/**
 * 思维链强度下拉：选项跟着「这一轮打到哪个来源」的写法走。
 * ============================================================
 *   DeepSeek 来源  → DeepSeek 的写法（auto / low / medium / high / max，没有 minimum）
 *   其余来源       → 酒馆 / OpenAI 兼容那套（auto / min / low / medium / high / max）
 * 换来源时如果存下来的档位在新写法里不存在（例如 DeepSeek 没有 min），
 * 就地换算一次并落盘 —— 否则下拉会显示成空白，而实际发出去的又是另一个值。
 */
function renderReasoningOptions() {
    const sel = els['dro-reasoning-level'];
    if (!sel) return;

    const s = getSettings();
    const list = reasoningLevelsFor(s);
    const want = reasoningLevelFor(s, s.reasoningLevel);

    if (want !== s.reasoningLevel) {
        // 这条留着：用户自己改了档位、插件把它换算成了当前来源认的写法，
        // 下拉里看到的将是换算后的值 —— 不说明一句就成了「我选的没生效」。
        log(`档位「${s.reasoningLevel || '(空)'}」不在当前来源的写法里，已换算成「${want}」`, 'info', 'outline');
        setSettings({ reasoningLevel: want });
    }

    // 选项内容没变就不重建（每次刷新都重建会把用户展开的下拉弹回去）
    const sig = list.map(x => x.key + '\u0001' + x.label).join('\u0002');
    if (sel.__droLevelSig !== sig) {
        sel.innerHTML = '';
        for (const x of list) {
            const o = document.createElement('option');
            o.value = x.key;
            o.textContent = x.label;
            sel.appendChild(o);
        }
        sel.__droLevelSig = sig;
    }
    sel.value = want;
}

/** 调用页唯一的一行实时状态：这一轮到底会怎么发请求 */
function updateApiPreview() {
    if (!els['dro-api-preview']) return;
    const s = getSettings();
    // describePlan 里已经有来源 / URL / 模型（沿用当前来源时还有推理档位）
    const extra = (s.reasoningLevel && s.reasoningLevel !== 'keep')
        ? '｜推理档位临时覆盖，生成后还原' : '';
    els['dro-api-preview'].textContent = '当前将使用：' + describePlan(s) + extra;
}

/**
 * 占位符提示。
 * v3.7.7 起没有内置底模板了，框里就是发出去的全部，所以这里只做一件事：
 * 揪出**写错的占位符**（`{{chat_history_typ}}` 这种会被原样发给模型）。
 * 框里空着 = 没写 = 没什么可校验的，直接不显示。
 */
function renderTemplateWarn() {
    if (!els['dro-template-warn']) return;
    const text = els['dro-template'] ? String(els['dro-template'].value || '') : '';
    if (!text.trim()) { els['dro-template-warn'].innerHTML = ''; return; }

    const r = checkTemplate(text);
    const parts = [];
    if (r.unknown.length) {
        parts.push(`<span class="dro-badge err">未知占位符</span> ` +
            r.unknown.map(x => '<code>{{' + escapeHtml(x) + '}}</code>').join(' ') +
            ' 会被原样发给模型，请检查是否写错。');
    }
    els['dro-template-warn'].innerHTML = parts.join('<br>');
}

/**
 * 预设信息：一行字，只说「有多少条能用」。
 * 来源（酒馆助手 / 降级 / 读不到）用徽章表示，其余数字进悬浮提示 ——
 * 这一行以前把「总条数 / 有正文 / 已开启 / 字数」全堆在版面上，没人看得完。
 */
function renderPresetInfo() {
    if (!els['dro-preset-info']) return;
    const st = presetStats();
    const badge = st.source === 'tavern_helper'
        ? '<span class="dro-badge ok">酒馆助手</span>'
        : st.source === 'power_user'
            ? '<span class="dro-badge warn">降级读取</span>'
            : '<span class="dro-badge err">读取失败</span>';
    els['dro-preset-info'].innerHTML =
        `预设 ${escapeHtml(st.name)} ${badge}｜${st.hasContent} 条有正文 · ${fmtNum(st.totalChars)} 字` +
        (st.error ? `<br><span class="dro-badge err">${escapeHtml(st.error)}</span>` : '');
    els['dro-preset-info'].title =
        '来源：' + (st.source === 'tavern_helper' ? '酒馆助手 getPreset("in_use")'
            : (st.source === 'power_user' ? 'powerUserSettings（降级读取，部分字段可能缺失）' : '读不到')) +
        `｜共 ${st.total} 条，其中酒馆里开着 ${st.enabled} 条` +
        '｜下面的表格只列有正文的条目（空的「——— 📘写作 ———」这类分组标记不占行）';
}

/** 搜索词匹配素材吗（表格和批量操作共用同一套条件，避免"看到的不等于操作的"） */
function blockMatches(b, kw) {
    return !kw || (b.short + ' ' + b.label + ' ' + b.pl).toLowerCase().includes(kw);
}

/** 当前搜索过滤后可见的素材 key */
function visibleBlockKeys() {
    const kw = (els['dro-wl-search'] && els['dro-wl-search'].value || '').trim().toLowerCase();
    return SYSTEM_BLOCKS.filter(b => blockMatches(b, kw)).map(b => b.key);
}

/** 当前搜索过滤后可见的条目名 */
function visibleWhitelistNames() {
    const preset = readPreset();
    const kw = (els['dro-wl-search'] && els['dro-wl-search'].value || '').trim().toLowerCase();
    return preset.prompts
        .filter(p => p.hasContent)
        .filter(p => !kw || p.name.toLowerCase().includes(kw))
        .map(p => p.name);
}

/** 分组小标题（不是 .dro-row，别混进行计数） */
function groupRow(text) {
    const d = document.createElement('div');
    d.className = 'dro-row-sec';
    d.textContent = text;
    return d;
}

/** 去向下拉用的短标签 —— 全站统一这三个词 */
function targetLabel(t) {
    return t === 'main' ? '只给主模型' : (t === 'both' ? '都给' : '只给大纲');
}

/** 预设条目的一行（同样走那个共用构造器） */
function entryRow(presetName, p) {
    const cfg = getEntryConfig(presetName, p.name);
    const chars = fmtNum(p.contentLength) + '字';
    return whitelistRow({
        cbId: 'dro-wl-cb-' + p.idx,
        selId: 'dro-wl-tgt-' + p.idx,
        // 名字后面不再挂 [role] —— 那一列每行都一样，是噪声；
        // role / position 都进了悬浮提示
        labelText: p.name,
        labelTitle: [
            `${p.role} · 正文 ${fmtNum(p.contentLength)} 字`,
            p.position ? `position: ${JSON.stringify(p.position)}` : '',
            p.enabled ? '' : '酒馆里: 已关闭',
        ].filter(Boolean).join('\n'),
        checkTitle: p.enabled ? '' : '这条在酒馆预设里是关闭状态，插件遵循该开关',
        off: !p.enabled,
        enabled: !!cfg.enabled,
        target: cfg.target || TARGET.BOTH,
        disabled: !p.enabled,          // 酒馆里关掉的条目不可勾选
        lenTitle: `正文长度 ${p.contentLength} 字`,
        lenText: () => chars,
        onChange: (enabled, target) => {
            setEntryConfig(presetName, p.name, { enabled, target });
            renderStats();
        },
    });
}

/**
 * 白名单表格。
 *
 * 两组东西在同一张表里，但来源不同，所以各占一段，中间用分组小标题隔开：
 *   系统预设条目 —— 插件自己取（blocks.js），配置按预设存（presetBlocks），
 *             去向三档只在「进不进大纲」上有区别（主模型那边酒馆自己给）
 *   预设条目 —— 预设里本来就有，配置按预设存（presetWhitelist），可选去向
 * 系统预设条目那一段不依赖预设读取成功，所以预设读失败时它照样在。
 */
export function renderWhitelist() {
    if (!els['dro-whitelist']) return;
    const preset = readPreset();
    const kw = (els['dro-wl-search'] && els['dro-wl-search'].value || '').trim().toLowerCase();

    const frag = document.createDocumentFragment();

    // ---- 第一段：素材 ----
    const cfg = blockConfigOf(getSettings(), preset.name);
    const facts = blockFacts();
    const blocks = SYSTEM_BLOCKS.filter(b => blockMatches(b, kw));
    if (blocks.length) {
        frag.appendChild(groupRow(`系统预设条目（${blocks.length} 条）`));
        for (const b of blocks) {
            frag.appendChild(blockRow(b, facts[b.key], cfg, preset.name));
            // 「聊天记录」那一行后面补一句裁剪的保护说明：界面上的裁剪开关
            // 已经删掉了（它只跟着「只给大纲」走），安全边界只能在这儿交代
            if (b.key === 'history') frag.appendChild(historyNoteRow());
        }
    }

    // ---- 第二段：预设条目 ----
    const withContent = preset.prompts
        .filter(p => p.hasContent)
        .filter(p => !kw || p.name.toLowerCase().includes(kw));

    if (withContent.length) {
        frag.appendChild(groupRow(`预设条目（${withContent.length} 条）`));
        for (const p of withContent) frag.appendChild(entryRow(preset.name, p));
    } else {
        const hint = document.createElement('div');
        hint.className = 'dro-hint';
        hint.textContent = '没有匹配的预设条目。' +
            (preset.prompts.length ? '可清空搜索框查看全部条目。' : '预设读取失败，请查看「关于」页的环境自检。');
        frag.appendChild(hint);
    }

    els['dro-whitelist'].innerHTML = '';
    els['dro-whitelist'].appendChild(frag);
    renderBlocksStatus();
}

export function renderCaps() {
    if (!els['dro-caps']) return;
    const caps = getCaps();
    const raw = caps.__raw || {};
    const rows = [];

    if (caps.__missingCritical && caps.__missingCritical.length) {
        rows.push('<div class="dro-hint"><span class="dro-badge err">缺少必需能力</span> ' +
            caps.__missingCritical.map(escapeHtml).join('、') + '　插件可能无法工作。</div>');
    }

    const entries = [
        ['getContext', '酒馆上下文', true],
        ['eventSource', '事件系统', true],
        ['eventTypes', '事件类型表', true],
        ['chat_completion_settings_ready', '拦截事件', true],
        ['generateRaw', '生成接口', true],
        ['extensionSettings', '设置存储', true],
        ['chat', '聊天记录', false],
        ['substituteParams', '宏展开', false],
        ['saveSettingsDebounced', '设置落盘', false],
        ['powerUserSettings', '预设降级读取', false],
        ['ConnectionManagerRequestService', '连接配置服务', false],
        ['stopGeneration', '中断生成', false],
        ['TavernHelper', '酒馆助手（可选）', false],
        ['tavernHelperGetPreset', '预设读取首选', false],
        ['tavernHelperGenerateRaw', '自定义 URL/Key 必需', false],
        ['tavernHelperGetModelList', '刷新模型列表', false],
    ];

    // 16 项一行一个太占地方：改成一行内自动折行的胶囊，
    // 「（可选）」也不每项都写，缺失必需项时才红字强调。
    for (const [key, label, critical] of entries) {
        const ok = raw[key] === true;
        rows.push(
            `<span class="dro-cap ${ok ? 'dro-cap-ok' : (critical ? 'dro-cap-no dro-cap-req' : 'dro-cap-no')}"` +
            `${critical ? '' : ' title="可选能力，缺失不影响主流程"'}>` +
            `${ok ? '✔' : '✘'} ${escapeHtml(label)}</span>`
        );
    }
    rows.push('<div style="height:2px"></div>');

    const preset = presetStats();
    const chat = chatStats();
    const profiles = listConnectionProfiles();
    const sourceLabel = preset.source === 'tavern_helper' ? '酒馆助手 getPreset'
        : (preset.source === 'power_user' ? 'powerUserSettings（降级读取）' : '未读到');
    rows.push('<div class="dro-hint">' +
        '预设来源：' + escapeHtml(sourceLabel) +
        (preset.error ? '（' + escapeHtml(preset.error) + '）' : '') +
        '｜酒馆正则：' + (chat.regexAvailable ? '可用' : '不可用（跳过压缩）') +
        '｜补全来源：' + escapeHtml(currentSource() || '(未知)') +
        '｜连接配置：' + profiles.length + ' 个（不读取其中的密钥）' +
        '</div>');

    els['dro-caps'].innerHTML = rows.join('');
}

// ============================================================
// 数据诊断（状态页）
// ============================================================

/**
 * 这一块只回答两个问题，其余解释全进悬浮提示（title）：
 *   1. 这一轮**要发多少** —— 分别发给大纲模型和主模型
 *   2. 其中**多少能吃到前缀缓存** —— 命中价只有未命中的 1/50 ~ 1/120
 *
 * 两个 tokens 数字的口径不一样，别混着看：
 *   · 发大纲模型：**现在这套配置**会拼出来的那份提示词（实时算，改开关立刻变）
 *   · 发主模型：**最近一次真实请求**（diag.js 逐条认领的那份成品）
 */
function renderStats() {
    if (!els['dro-data-stats']) return;
    const s = getSettings();
    const preset = presetStats();
    const rows = [];

    // ---- 预设 / 白名单 ----
    const byPreset = s.presetWhitelist[preset.name] || {};
    let wlOn = 0, wlTotal = 0;
    for (const k of Object.keys(byPreset)) {
        wlTotal++;
        if (byPreset[k] && byPreset[k].enabled === true) wlOn++;
    }
    const bs = blockStatsOf(preset.name);
    rows.push(kv('预设', `${preset.name}｜白名单 ${wlOn}/${wlTotal} 条｜素材 ${bs.on}/${bs.total} 上大纲`,
        '白名单：已勾选的预设条目数。素材：5 个素材块中会进入大纲提示词的块数（去向不为「只给主模型」）。'));

    // ---- 聊天记录：原文 → 真正送出去的那一份 ----
    const chat = chatStats();
    const hs = historyStats();
    rows.push(kv('聊天',
        `${chat.floors} 层｜原文 ${fmtNum(chat.rawChars)} 字 → 送大纲 ${fmtNum(hs.finalChars)} 字（省 ${hs.savedPct}）`,
        '原文：聊天记录总量。送大纲：过完酒馆正则（逐层带 depth，与酒馆同口径）后真正写入提示词的那一份。' +
        (hs.compressed ? '' : '注意：本轮未压缩，' + (hs.reason || '酒馆助手不可用') + '。')));

    // ---- 世界书 ----
    const world = latestWorldInfo();
    rows.push(kv('世界书', (world.count || world.text)
        ? `激活 ${world.count} 条 / ${fmtNum(world.chars)} 字` +
          (world.overflowed ? '｜预算溢出' : '') +
          (world.stale ? '｜扫描已过期，未写入提示词' : '')
        : '本轮没有激活条目',
        '采用酒馆本轮的扫描结果，不再重复扫描。' +
        (world.ageMs >= 0 ? `数据来自 ${Math.round(world.ageMs / 1000)} 秒前的扫描。` : '本轮尚未扫描。')));

    // ---- 发给两个模型的 tokens ----
    const outline = outlinePromptNow();
    rows.push(kv('发大纲模型', outline
        ? `${outline.entries} 条条目 + ${outline.blocks} 块素材｜≈ ${fmtNum(outline.tokens)} tokens`
        : '无法计算（详见日志）',
        '按当前配置实际拼出的大纲提示词，与发送时使用同一个拼装函数。tokens 为估算值，1 个汉字约 0.95。'));

    const main = (lastRequestMap && lastRequestMap.ok) ? lastRequestMap : null;
    rows.push(kv('发主模型', main
        ? `${main.total.count} 条消息｜≈ ${fmtNum(main.total.tokens)} tokens`
        : '尚无数据（发送一条消息后显示）',
        '最近一次真实请求：酒馆拼装、插件整形之后主模型实际收到的那一份。' +
        (main ? `${fmtNum(main.total.chars)} 字，逐条清单见下方「主模型本轮真实组成」。` : '')));

    // ---- 预计缓存命中 ----
    rows.push(kv('预计缓存命中', cacheRow(main, outline), CACHE_TITLE));

    // ---- 整形结果 ----
    rows.push(kv('请求整形', trimRow(),
        '「只给大纲」的条目与素材块从主模型请求中移除的结果（最近一次）。'));
    rows.push(kv('历史裁剪', trimHistoryRow(),
        '仅在「聊天记录」的去向为「只给大纲」时生效，固定保留最近 1 轮。' +
        '未能识别的楼层一律保留，最后一条 user 消息不会被删除。'));

    els['dro-data-stats'].innerHTML = rows.join('');
}

/**
 * 现在这套配置会拼给大纲模型的提示词。
 * 用的是 index.js 真发出去时的同一个函数（buildSystemPrompt），所以数字对得上。
 * 出任何错都只让那一行写「算不出来」，不连累别的行。
 */
function outlinePromptNow() {
    try {
        const s = getSettings();
        const presetName = readPreset().name;
        const hs = historyStats();
        const block = buildEntryBlock('outline');
        const collected = collectBlocks(s, hs.text || '', presetName);
        const nm = names();
        const text = buildSystemPrompt({
            blocks: collected.text,
            presetBlock: block.text,
            charName: nm.char,
            userName: nm.user,
            template: s.template,
        });
        return {
            text,
            tokens: estimateTokens(text),
            entries: block.picked,
            blocks: collected.stats.filter(b => b.on && b.chars > 0).length,
        };
    } catch (e) {
        log('算大纲提示词体积失败: ' + errorText(e), 'warn', 'env');
        return null;
    }
}

/**
 * 缓存那一行的悬浮提示。
 * 数字是估算值，就必须把算法和保守之处写清楚，否则这一行没法用来做判断。
 */
const CACHE_TITLE = '前缀缓存：命中部分按未命中价格的 1/50 ~ 1/120 计价，因此这一行比总 token 数更能反映实际成本。' +
    '算法：取最长相同前缀，再向下取整到 64 token（缓存块大小）。' +
    '主模型取上两轮真实请求对比；大纲取当前提示词与上一轮实际发送内容对比。' +
    '首轮请求，或两轮之间修改过设置，命中都会下降。';

/**
 * 「预计缓存命中」那一行的正文。
 *   主模型：diag.js 在真实发送请求时算出（上一轮对比上上轮）
 *   大纲：  在这里实时计算（当前提示词对比上一轮实际发送的那份）
 */
function cacheRow(main, outline) {
    const parts = [];

    if (!main) parts.push('主模型：尚无数据');
    else if (main.cache && main.cache.ok) {
        parts.push(`主模型 ${fmtNum(main.cache.hitTokens)} / ${fmtNum(main.cache.totalTokens)}（${main.cache.pct}%）`);
    } else parts.push('主模型：首轮，暂无可比前缀');

    if (outline) {
        const hit = estimateAgainst('outline', [outline.text]);
        parts.push(hit.ok
            ? `大纲 ${fmtNum(hit.hitTokens)} / ${fmtNum(hit.totalTokens)}（${hit.pct}%）`
            : '大纲：首轮，暂无可比前缀');
    }

    return parts.join('｜');
}

/**
 * 「历史裁剪」那一行的结果说明。
 * 是否裁剪只取决于一件事：素材块「聊天记录」的去向是否为「只给大纲」
 * （面板上没有其他开关，保留轮数固定为 1 轮）。
 */
function trimHistoryRow() {
    const s = getSettings();
    if (!wantTrimHistory(s)) return '不裁剪（「聊天记录」的去向不是「只给大纲」）';
    const why = '「聊天记录」为「只给大纲」';
    const t = lastTrimStats();
    const h = t && t.history;
    if (!h) return `${why}：保留最近 ${TRIM_KEEP_ROUNDS} 轮｜本轮尚未运行`;
    if (h.skipped) return `${why}：保留最近 ${TRIM_KEEP_ROUNDS} 轮｜上次未裁剪：${h.skipped}`;
    if (h.removed > 0) {
        return `${why}：保留最近 ${h.rounds} 轮｜上次删除 ${h.removed} 条 / ${fmtNum(h.removedChars)} 字`;
    }
    return `${why}：上次未能识别任何旧楼层，历史未被裁剪（详见日志）`;
}

/** 最近一次「只给大纲 → 从主模型移除」的结果（条目 + 素材块） */
function trimRow() {
    const t = lastTrimStats();
    const only = outlineOnlyEntries().length;
    if (!t) {
        return only ? `${only} 条已勾选「只给大纲」，将在下次生成时移除` : '没有勾选「只给大纲」的条目';
    }
    // 历史裁剪在下面单独一行，这里只说条目与素材块
    if (t.skipped && !t.removed && !(t.blocks && t.blocks.removed)) {
        return `上次未改动：${t.skipped}`;
    }
    const parts = [];
    parts.push(t.removed ? `已移除 ${t.removed} 条 / ${fmtNum(t.removedChars)} 字` : '条目：没有可移除的');
    if (t.missed.length) parts.push(`条目未识别 ${t.missed.length} 条（已保留）`);
    if (t.blocks) {
        parts.push(t.blocks.removed
            ? `素材块已移除 ${t.blocks.removed} 块（${t.blocks.names.join('、')}）`
            : '素材块：没有可移除的');
        if (t.blocks.missed.length) parts.push(`素材块未识别 ${t.blocks.missed.length} 块`);
    }
    return parts.join('｜');
}

function kv(k, v, title) {
    return `<div class="dro-kv"><span>${escapeHtml(k)}</span>` +
        `<span${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(v)}</span></div>`;
}

/**
 * 画日志页。
 * ============================================================
 * 三条规矩（都是以前踩过的坑）：
 *  1. **屏幕上的 = 复制出来的**。以前这里只画最后 200 行，而「复制日志」
 *     拿走全部 500 行 —— 用户把日志发来排查时，内容和他说看到的不是一回事。
 *     现在两边都走 getLogLines()（日志量本来就小了，全画也不心疼）。
 *  2. **只在「已经贴着底」时才自动滚到底**。以前每来一行都强制滚到底，
 *     你正往上翻看前面发生了什么，下一秒就被拽回去；一轮生成连打十几行，
 *     等于连拽十几次，根本读不了。
 *  3. **可以只看问题**。筛选只影响显示，「复制日志」始终复制全部 ——
 *     否则用户以为自己复制了完整日志，实际只有筛剩下的那几行。
 */
/** 日志页当前的显示筛选：'all' | 'warn'（只看 warn/error） */
let logFilter = 'all';

function atBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 24;
}

function renderLog() {
    const box = els['dro-log'];
    if (!box) return;
    const all = getLogLines();
    const shown = logFilter === 'warn'
        ? all.filter(l => l.level === 'warn' || l.level === 'error')
        : all;
    const stick = atBottom(box);
    box.innerHTML = shown.map(l =>
        `<div class="l-${l.level}">[${escapeHtml(l.t)}] ${l.scope ? escapeHtml(l.scope) + ': ' : ''}${escapeHtml(l.msg)}</div>`
    ).join('') + (shown.length ? '' :
        '<div class="l-info">（没有 warn / error。这一轮从头到尾没有降级，也没有跳过。）</div>');
    if (stick) box.scrollTop = box.scrollHeight;
}

/** 供 index.js 在每次运行后刷新白名单视图与统计 */
export function refreshWhitelistView() {
    try {
        renderWhitelist();
        renderStats();
        renderRequestMap();
    } catch (e) {
        log('刷新白名单视图失败: ' + errorText(e), 'warn', 'env');
    }
}

// ============================================================
// 大纲显示 / 运行状态
// ============================================================
//
// ★ 「当前大纲」这个框从 v3.13.0 起是**可编辑**的，并且多了一条「锁定 → 按它
//   重写正文」的路。所以这里有三个各自独立的标志，别混：
//
//   running       正在跑大纲模型（框里是流式输出，只读）
//   outlineEdited 用户在这个框里动过手（只用来提示，不影响任何流程）
//   outlineLocked 用户点了「以此大纲再次生成正文」：下一轮正文生成直接用框里
//                 这份，不再调大纲模型（index.js 取走即解锁 —— 单次有效）
//
//   为什么锁定是「单次有效」而不是一直粘着：粘着的话，用户改完大纲点一次
//   之后忘了，之后每一轮都拿这份旧大纲去写正文，而且面板上不显眼。单次有效
//   时按钮点几次就用几次（每次都读框里的最新内容），不想用了还有「取消锁定」。

/** 正在生成大纲吗。流式刷新靠它区分「输出中」和「本轮结束」 */
let running = false;
/** 用户在框里改过（提示用） */
let outlineEdited = false;
/** 这份大纲被锁定给下一轮正文生成（index.js 取走即解锁） */
let outlineLocked = false;

/** 框里那份大纲（去掉首尾空白） */
function outlineBoxValue() {
    const box = els['dro-outline-text'];
    return box ? String(box.value == null ? '' : box.value).trim() : '';
}

/** 锁定 / 解锁（供按钮与 index.js 用） */
export function lockOutline() {
    outlineLocked = true;
    outlineEdited = false;
    refreshOutlineHint();
}

export function unlockOutline() {
    outlineLocked = false;
    refreshOutlineHint();
}

export function isOutlineLocked() {
    return outlineLocked;
}

/**
 * index.js 用：取走锁定的那份大纲。
 * 取走即解锁（单次有效），返回空串表示「没锁定 / 框里是空的」——
 * 两种情况都该走正常流程（生成大纲）。
 */
export function takeLockedOutline() {
    if (!outlineLocked) return '';
    const text = outlineBoxValue();
    unlockOutline();
    return text;
}

/**
 * 框下面那行提示。这是用户唯一能看出「现在按哪份大纲走」的地方，
 * 所以四种状态（生成中 / 已锁定 / 已改动 / 待命）各说一句，不多不少。
 */
function refreshOutlineHint() {
    // 这个函数从事件回调、setOutline、mount 里都会被调到，
    // 所以自己吞掉异常：它坏掉最多是提示行不对，绝不该掀翻一次生成。
    try {
        if (els['dro-unlock-outline']) {
            els['dro-unlock-outline'].style.display = outlineLocked ? '' : 'none';
        }
        const box = els['dro-outline-hint'];
        if (!box) return;
        if (running) {
            box.textContent = '正在生成大纲，框里的内容生成结束后才能改。';
        } else if (outlineLocked) {
            box.textContent = '已锁定：下一次正文生成直接用框里这份大纲，不再调用大纲模型（用过自动解锁）。';
        } else if (outlineEdited) {
            box.textContent = '已改动。点「以此大纲再次生成正文」按这份大纲重写正文；直接发送消息会重新调用大纲模型，覆盖这里的改动。';
        } else {
            box.textContent = '框里可以直接改写：改完点「以此大纲再次生成正文」，正文就按这份大纲重写（这一轮不再调用大纲模型）。';
        }
    } catch (e) {
        log('刷新大纲提示失败: ' + errorText(e), 'warn', 'env');
    }
}

export function setOutline(text, info) {
    const box = els['dro-outline-text'];
    if (box) {
        // 流式输出写进框里；锁定期间那是用户自己的东西，一个字都不覆盖
        if (!outlineLocked) {
            box.value = text == null ? '' : String(text);
            // 模型写进来的这一份盖掉了用户的手改，提示不能再挂着「已改动」
            // （否则下一轮生成完了，那行字还在说他改过的东西）
            outlineEdited = false;
        }
        box.readOnly = info == null;      // 流式过程中只读，结束后可编辑
        if (info == null) {
            try { box.scrollTop = box.scrollHeight; } catch (e) { /* 非浏览器环境 */ }
        }
    }

    // 流式过程中的局部刷新：只更新正文，不改徽章与指示灯
    if (info == null && running) {
        if (els['dro-run-summary']) els['dro-run-summary'].textContent = '正在生成大纲…（正文实时刷新）';
        return;
    }

    running = false;
    if (els['dro-run-summary']) {
        /**
         * 三种收场，状态行必须说清是哪一种：
         *   aborted  —— 大纲没拿到，插件已终止本次生成（正文模型未运行），
         *               等待重新发送 / 重新生成；中断前写出的部分保留在正文档中。
         *   how      —— 停不了生成时的兜底：把未写完的大纲注入主模型继续跑。
         *   都没有   —— 本轮跳过，主模型收到的是未修改的请求。
         * manual    —— 这一轮用的是面板上锁定的大纲，没调用大纲模型。
         */
        const kept = Number(info && info.chars) || 0;
        if (!info) {
            els['dro-run-summary'].textContent = '尚未运行。';
        } else if (info.ok && info.manual) {
            els['dro-run-summary'].innerHTML =
                `<span class="dro-badge ok">手动大纲</span> 已按框里这份大纲（${info.chars} 字）注入主模型` +
                '｜本轮未调用大纲模型';
        } else if (info.ok) {
            els['dro-run-summary'].innerHTML =
                `<span class="dro-badge ok">成功</span> ${info.chars} 字｜耗时 ${info.elapsedMs}ms` +
                (info.how ? `｜注入方式 ${escapeHtml(info.how)}` : '');
        } else {
            const isTimeout = info.kind === 'timeout';
            const label = isTimeout ? '超时' : '失败';
            const cls = isTimeout ? 'warn' : 'err';
            let tail;
            if (info.aborted) {
                tail = '已终止本次生成（正文模型未运行）。重新发送或点击「重新生成」即可重试。' +
                    (kept > 0
                        ? `中断前生成的 ${kept} 字保留在下方「当前大纲」，可以直接在上面改，` +
                          '再点「以此大纲再次生成正文」。'
                        : '');
            } else if (info.how) {
                tail = `${label}前生成的 ${kept} 字已作为大纲注入主模型（内容不完整，注入方式 ` +
                    `${escapeHtml(info.how)}）。原文保留在下方「当前大纲」，可直接改写后重发。`;
            } else if (kept > 0) {
                tail = `${label}前生成的 ${kept} 字已保留（见下方「当前大纲」）：可以改一改，` +
                    '再点「以此大纲再次生成正文」。未能注入主模型，本轮主模型收到的是未修改的请求。';
            } else {
                tail = '本轮已跳过，主模型收到的是未修改的请求。';
            }
            els['dro-run-summary'].innerHTML =
                `<span class="dro-badge ${cls}">${label}</span> ` +
                `${escapeHtml(info.reason || (isTimeout ? '请求未在超时时间内返回' : '未知原因'))}　${tail}`;
        }
    }
    refreshOutlineHint();
    setBadge(info);
}

export function setRunning(elapsedMs) {
    running = true;
    const box = els['dro-outline-text'];
    if (box) box.readOnly = true;
    refreshOutlineHint();
    const limit = Math.round(Number(getSettings().timeoutSec) || 60);
    if (els['dro-status-badge']) {
        els['dro-status-badge'].className = 'dro-badge warn';
        els['dro-status-badge'].textContent = `生成中 ${Math.round(elapsedMs / 1000)}/${limit}s`;
        els['dro-status-badge'].title = `已等待 ${Math.round(elapsedMs / 1000)} 秒，超过 ${limit} 秒将中断本轮`;
    }
    setDot('run');
}

function setBadge(info) {
    if (!els['dro-status-badge']) { setDot('idle'); return; }
    if (!info) {
        els['dro-status-badge'].className = 'dro-badge idle';
        els['dro-status-badge'].textContent = '未运行';
        els['dro-status-badge'].title = '';
        setDot('idle');
        return;
    }
    if (info.ok) {
        els['dro-status-badge'].className = 'dro-badge ok';
        els['dro-status-badge'].textContent = info.manual ? '手动大纲已注入' : '大纲已注入';
        els['dro-status-badge'].title = info.manual
            ? '本轮用的是面板上锁定的大纲（未调用大纲模型）'
            : '本轮大纲已生成并注入主模型请求';
        setDot('ok');
    } else if (info.kind === 'timeout') {
        // 超时是「没等到」，不是「上游报错」——给黄灯，与真正的失败区分开
        const kept = Number(info.chars) || 0;
        els['dro-status-badge'].className = 'dro-badge warn';
        els['dro-status-badge'].textContent = info.aborted
            ? '超时·已终止'
            : (kept > 0 ? (info.how ? '超时·部分注入' : '超时·未注入') : '超时');
        els['dro-status-badge'].title = info.aborted
            ? '请求超时，已终止本次生成（正文模型未运行）。重新发送或点击「重新生成」即可重试。' +
              (kept > 0 ? `中断前生成的 ${kept} 字留在「状态」页的「当前大纲」里，可以直接改写。` : '')
            : (kept > 0
                ? (info.how
                    ? `请求超时，中断前生成的 ${kept} 字已作为大纲注入主模型（内容不完整）；` +
                      '原文留在「状态」页的「当前大纲」里，可以直接改写。'
                    : `请求超时，中断前生成的 ${kept} 字留在「状态」页的「当前大纲」里，可以直接改写；未能注入主模型。`)
                : '已超过设置的超时时间，本轮已中断。');
        setDot('skip');
    } else {
        const kept = Number(info.chars) || 0;
        els['dro-status-badge'].className = 'dro-badge err';
        els['dro-status-badge'].textContent = info.aborted
            ? '失败·已终止'
            : (kept > 0 ? (info.how ? '失败·部分注入' : '失败·未注入') : '本轮跳过');
        els['dro-status-badge'].title = info.aborted
            ? '大纲未取到，已终止本次生成（正文模型未运行）。重新发送或点击「重新生成」即可重试。'
            : (kept > 0
                ? (info.how
                    ? `本轮失败，但失败前生成的 ${kept} 字已作为大纲注入主模型（内容不完整）。`
                    : `本轮失败，失败前生成的 ${kept} 字留在「状态」页的「当前大纲」里，可以直接改写；未能注入主模型。`)
                : '上游报错或无法获取上下文，本轮主模型收到的是未修改的请求。');
        setDot('fail');
    }
}

export function setSkipped(reason) {
    running = false;
    if (els['dro-status-badge']) {
        els['dro-status-badge'].className = 'dro-badge warn';
        els['dro-status-badge'].textContent = '已跳过';
    }
    if (els['dro-run-summary']) {
        els['dro-run-summary'].innerHTML = `<span class="dro-badge warn">跳过</span> ${escapeHtml(reason)}`;
    }
    refreshOutlineHint();
    setDot('skip');
}

export function setDot(kind) {
    const dot = $('dro-bar-dot');
    if (dot) dot.className = 'dro-dot' + (kind && kind !== 'idle' ? ' ' + kind : '');
}

export function reportRun(result) {
    setOutline(result.outline || '', result);
}

// ============================================================
// 主模型本轮真实组成（诊断）
// ============================================================

/** 最近一次诊断结果，供面板重建时复用 */
let lastRequestMap = null;

/** 去向后缀在界面里不该出现，画之前统一剥掉 */
function kindClass(kind) {
    return kind === 'outline' ? 'l-ok'
        : (kind === 'preset' ? 'l-info'
            : (kind === 'history' ? 'l-info'
                : (kind === 'other' ? 'l-warn' : 'l-info')));
}

/**
 * 把 diag.mapMainRequest() 的结果画出来。
 * ============================================================
 * 面板只负责画，不自己算 —— 认领逻辑全在 diag.js 里，那边才是唯一事实来源。
 * 这里最有价值的一行是「仍出现在主模型请求中」那一条：
 * 勾了「只给大纲」却没被移除的条目会逐条列出来。
 */
export function reportRequestMap(d) {
    lastRequestMap = d;
    const box = els['dro-request-map'];
    if (!box) return;

    if (!d || !d.ok) {
        box.innerHTML = '<div class="dro-hint">诊断不可用：' +
            escapeHtml((d && d.reason) || '未知原因') + '</div>';
        return;
    }

    const html = [];

    // ---- 分类汇总 ----
    const kinds = d.byKind.slice().sort((a, b) => b.chars - a.chars);
    html.push('<div class="dro-hint">共 <strong>' + d.total.count + '</strong> 条 / ' +
        fmtNum(d.total.chars) + ' 字 / ≈ ' + fmtNum(d.total.tokens) + ' tokens｜' +
        kinds.map(k => escapeHtml(`${k.label} ${k.count}条/${fmtNum(k.chars)}字`)).join('｜') + '</div>');

    // ---- 聊天记录：原文 → 实际送出的那一份 ----
    if (d.history) {
        const h = d.history;
        html.push('<div class="dro-hint">聊天记录：原文 ' + fmtNum(h.rawChars) +
            ' 字 → 送大纲 ' + fmtNum(h.sentChars) + ' 字</div>');
    }

    // ---- 值得喊出来的事 ----
    for (const w of d.warnings) {
        html.push('<div class="dro-hint"><span class="dro-badge warn">注意</span> ' +
            escapeHtml(w) + '</div>');
    }

    // ---- 逐条明细 ----
    const rows = d.rows.map(r =>
        `<div class="${kindClass(r.kind)}">[${String(r.i).padStart(2)}] ` +
        `${escapeHtml(String(r.role).padEnd(9))}${escapeHtml(String(fmtNum(r.chars) + '字').padStart(9))}　` +
        `${escapeHtml(r.label)}</div>`).join('');
    html.push('<div class="dro-log" style="max-height:300px;margin-top:6px;">' + rows + '</div>');

    box.innerHTML = html.join('');
    // ★ 这里**不再写日志**：逐条清单只活在面板里。
    //   日志那边由 index.js 记一行「注入｜…｜逐条清单见「状态」页」，
    //   同一件事只在一处说 —— 以前这里是 info 一行 + warn 一行，
    //   加上 diag 倒出来的 60 行明细，一轮能刷掉半个日志页。
}

/** 面板重建（换标签页等）后把上一次的诊断结果重新画上，别让它丢 */
function renderRequestMap() {
    if (lastRequestMap) reportRequestMap(lastRequestMap);
}

// ============================================================
// 小工具
// ============================================================

function numOr(v, dflt) {
    const n = (typeof v === 'number') ? v : parseFloat(v);
    return isFinite(n) ? n : dflt;
}

function clamp(v, min, max) {
    const n = Number(v);
    if (!isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
}

function rectOf(el) {
    if (el && typeof el.getBoundingClientRect === 'function') {
        const r = el.getBoundingClientRect();
        if (r) return r;
    }
    return { left: 0, top: 0, width: 0, height: 0 };
}

async function copyText(text) {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) { /* 退回 execCommand */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (e) {
        return false;
    }
}

/** 清理（热重载时用） */
export function destroy() {
    for (const fn of destroyFns) {
        try { fn(); } catch (e) { /* ignore */ }
    }
    destroyFns = [];
    if (root) { root.remove(); root = null; }
    bar = null;
    panel = null;
    els = {};
    // 框没了就别再锁着：否则会留下「锁着一份空大纲」的状态
    running = false;
    outlineEdited = false;
    outlineLocked = false;
}
