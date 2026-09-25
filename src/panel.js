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
    TARGET, SYSTEM_BLOCKS,
} from './constants.js';
import {
    log, onLog, getLogLines, clearLog, probe, getCaps,
    errorText, escapeHtml, fmtNum, toast, refreshCtx,
} from './env.js';
import {
    get as getSettings, set as setSettings, watch as watchSettings,
    getEntryConfig, setEntryConfig, patchEntries,
    blockConfigOf, setBlockConfig, patchBlocks, blockStatsOf,
    checkTemplate, exportJSON, importJSON, resetKeepWhitelist, PANEL_TABS,
} from './settings.js';
import { readPreset, presetStats, refreshPreset } from './preset.js';
import { chatStats } from './chat.js';
import {
    latestWorldInfo, charCardBlock, personaBlock, examplesBlock,
} from './blocks.js';
import { lastTrimStats, outlineOnlyEntries } from './trim.js';
import {
    listConnectionProfiles, fetchModelList, describePlan,
    providerConfig, currentSource, modelChoices,
    reasoningLevelsFor, reasoningLevelFor, reasoningSyntax,
} from './outline.js';

const $ = (id) => document.getElementById(id);

let root = null;        // #dro-root（拖动时移动的就是它）
let bar = null;         // #dro-bar 收起态竖条
let panel = null;       // #dro-panel 展开态面板
let els = {};           // 面板里的元素引用
let destroyFns = [];
let activeTab = 'status';
let lastPreview = null;

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
                    <div class="dro-tool dro-nodrag" id="dro-panel-reload" title="刷新：重新自检 + 重读预设 + 重算统计">⟳</div>
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
    setDot('idle');
    log('悬浮窗已就绪（点竖条展开）', 'ok', 'panel');
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

    return `
    <div class="dro-pane" id="dro-pane-status">
        <label class="checkbox_label" for="dro-enabled">
            <input type="checkbox" id="dro-enabled">
            <span>启用双请求大纲</span>
        </label>
        <div class="dro-hint" title="主模型收到的历史不会减少，所以这一步是额外增加的成本；收益在大纲质量。">
            每次生成前先用便宜模型读一遍聊天记录生成大纲，再注入本次请求。<strong>会增加成本</strong>。
        </div>
        <div class="dro-sec">当前大纲</div>
        <div class="dro-hint" id="dro-run-summary">尚未运行。</div>
        <div class="dro-outline-box" id="dro-outline-text">（空）</div>
        <div class="dro-btnrow">
            <div class="menu_button" id="dro-copy-outline">复制大纲</div>
            <div class="menu_button" id="dro-clear-outline">清空</div>
        </div>
        <div class="dro-sec">数据诊断</div>
        <div id="dro-data-stats"></div>
    </div>

    <div class="dro-pane" id="dro-pane-api">
        <div class="dro-sec">大纲用哪个来源</div>
        <label for="dro-source">来源</label>
        <select id="dro-source" class="text_pole" title="沿用酒馆当前来源：URL/Key 归酒馆管，插件只临时替换模型名，生成完立刻还原。选具体来源：URL/Key/模型都由这里决定（发送走酒馆助手，没装则自动退回沿用当前来源）。">
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
                <div class="menu_button dro-nodrag" id="dro-key-eye" title="显示/隐藏">👁</div>
            </div>
            <div class="dro-hint" title="酒馆后端会用它自己存的那个来源的钥匙，这时只有 URL 与模型来自本插件。">
                手填的 Key 会明文存在酒馆设置里；<strong>留空则用酒馆自己存的那把</strong>。
            </div>
        </div>

        <label for="dro-model">大纲模型名</label>
        <div class="dro-inline">
            <input type="text" id="dro-model" class="text_pole" placeholder="留空则用该来源当前模型；模型名以「拉取清单」为准">
            <div class="menu_button dro-nodrag" id="dro-model-refresh" title="向 API 拉一次模型清单">拉取清单</div>
        </div>
        <select id="dro-model-pick" class="text_pole"></select>

        <div class="dro-sec">思维链强度</div>
        <select id="dro-reasoning-level" class="text_pole" title="选「不改」= 插件不碰酒馆设置；选别的档位 = 发大纲前临时改酒馆的推理强度，生成完立刻还原（日志里会写「已还原临时覆盖的设置」）。自定义来源时同样生效。">${levelOptions}</select>

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
            <div class="menu_button dro-nodrag" id="dro-wl-select-all" title="勾上筛选出的全部（两组一起），不动各自的去向">全选</div>
            <div class="menu_button dro-nodrag" id="dro-wl-clear-all" title="取消筛选出的全部（两组一起），不动各自的去向">全清</div>
            <select id="dro-wl-bulk-target" class="text_pole" title="把筛选出的全部（两组一起）统一改成这个去向，不动勾选">
                <option value="">统一设为…</option>
                <option value="outline">只给大纲</option>
                <option value="main">只给主模型</option>
                <option value="both">都给</option>
            </select>
        </div>
        <div class="dro-wl-box" id="dro-whitelist"></div>
        <div class="dro-hint" id="dro-blocks-status"></div>
        <details class="dro-adv">
            <summary>「去向」怎么理解</summary>
            <div class="dro-hint">
                <strong>只给大纲</strong>：拼进大纲提示词；条目还会从主模型请求里删掉
                （整条精确匹配才删，匹配不上就保留并记日志）。<br>
                <strong>只给主模型</strong>：不进大纲；<strong>都给</strong>：两边都要。<br>
                系统预设条目（上面 5 条）和下面的预设条目是同一套行、同一套规则，
                全选 / 全清 / 统一设为对两组一视同仁。<br>
                酒馆里关掉的条目会置灰、不可勾选。
            </div>
        </details>

        <div class="dro-sec">大纲提示词</div>
        <textarea id="dro-template" class="text_pole" rows="5"></textarea>
        <div id="dro-template-warn" class="dro-hint"></div>
    </div>

    <div class="dro-pane" id="dro-pane-log">
        <div class="dro-sec">运行日志</div>
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
        'dro-copy-outline', 'dro-clear-outline',

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

        'dro-data-stats',
        'dro-caps',

        'dro-log', 'dro-log-clear', 'dro-log-copy',

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
        log('记录面板状态失败: ' + errorText(e), 'warn', 'panel');
    }
    panel.style.display = 'flex';
    bar.style.display = 'none';
    placeRoot(true);
    // 展开后把一直在后台累积的日志刷一次，省得用户以为没动静
    renderLog();
    log('悬浮窗已展开', 'info', 'panel');
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
            toast('已刷新：自检 / 预设 / 统计', 'success');
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
                log('保存设置失败: ' + errorText(e), 'error', 'panel');
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
            els['dro-model-refresh'].textContent = '…';
            const r = await fetchModelList(getSettings());
            els['dro-model-refresh'].textContent = '刷新';
            if (r.ok) {
                const s = getSettings();
                const list = Object.assign({}, s.modelList);
                list[providerConfig(s.provider).key] = r.models;
                setSettings({ modelList: list });
                renderModelOptions();
                toast(`取回 ${r.models.length} 个模型`, 'success');
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
    if (els['dro-copy-outline']) els['dro-copy-outline'].addEventListener('click', async () => {
        const ok = await copyText(els['dro-outline-text'].textContent || '');
        toast(ok ? '大纲已复制' : '复制失败', ok ? 'success' : 'warn');
    });
    if (els['dro-clear-outline']) els['dro-clear-outline'].addEventListener('click', () => setOutline('', null));

    // ---- 日志 ----
    if (els['dro-log-clear']) els['dro-log-clear'].addEventListener('click', () => { clearLog(); renderLog(); });
    if (els['dro-log-copy']) els['dro-log-copy'].addEventListener('click', async () => {
        const text = getLogLines().map(l => `[${l.t}] [${l.level}] ${l.scope ? l.scope + ': ' : ''}${l.msg}`).join('\n');
        const ok = await copyText(text);
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
 * 素材块的实时状态（字数 / 世界书激活条数 / 读不到的原因）。
 * 行里的「字数」列和下面那行状态文字共用这一份数据，避免两处算法漂移。
 */
function blockFacts() {
    const chat = chatStats();
    const world = latestWorldInfo();
    const card = charCardBlock();
    const persona = personaBlock();
    const examples = examplesBlock();

    return {
        history: {
            chars: chat.rawChars,
            title: '发大纲前会先过一遍酒馆的正则做压缩',
            brief: `聊天记录 ${chat.floors} 层 / ${fmtNum(chat.rawChars)} 字（发大纲时按正则压缩后传入）`,
            off: '聊天记录 不给大纲',
            toMain: '聊天记录 只给主模型',
        },
        worldInfo: {
            chars: world.chars,
            title: '本轮真正注入的世界书正文（听酒馆算好的结果，不重扫）',
            // 判据是「有没有激活条目」而不只是「正文非空」——
            // 条目拿到了但正文为空也要如实报出来，不能显示成「没有激活条目」
            brief: (world.count || world.text)
                ? `世界书 本轮激活 ${world.count} 条 / ${fmtNum(world.chars)} 字` +
                  (world.ageMs >= 0 ? `（${Math.round(world.ageMs / 1000)}s 前的扫描）` : '') +
                  (world.overflowed ? '｜⚠️ 预算溢出' : '') +
                  (world.stale ? '｜已过期，不拼进提示词' : '')
                : '世界书 本轮没有激活任何条目',
            off: '世界书 不给大纲',
            toMain: '世界书 只给主模型',
        },
        charCard: {
            chars: card.text.length,
            title: '角色卡的描述 / 性格 / 场景，宏已展开',
            brief: card.text ? `角色卡 ${fmtNum(card.text.length)} 字` : `角色卡 不可用（${card.note}）`,
            off: '角色卡 不给大纲',
            toMain: '角色卡 只给主模型',
        },
        persona: {
            chars: persona.text.length,
            title: '你在酒馆里设的 Persona 描述',
            brief: persona.text ? `Persona ${fmtNum(persona.text.length)} 字` : `Persona 不可用（${persona.note}）`,
            off: 'Persona 不给大纲',
            toMain: 'Persona 只给主模型',
        },
        examples: {
            chars: examples.text.length,
            title: '角色卡里的对话示例（mes_example）',
            brief: examples.text ? `对话示例 ${fmtNum(examples.text.length)} 字` : `对话示例 不可用（${examples.note}）`,
            off: '对话示例 不给大纲',
            toMain: '对话示例 只给主模型',
        },
    };
}

/** 素材块现在的实际状态：一行字，放在白名单表格下面 */
function renderBlocksStatus() {
    if (!els['dro-blocks-status']) return;
    const cfg = blockConfigOf(getSettings(), readPreset().name);
    const facts = blockFacts();

    const parts = SYSTEM_BLOCKS.map(b => {
        const rec = cfg[b.key] || {};
        if (rec.enabled === false) return facts[b.key].off;
        if (rec.target === 'main') return facts[b.key].toMain;
        return facts[b.key].brief;
    });
    els['dro-blocks-status'].textContent = parts.join('｜');
}

/** 去向下拉的三个档位 —— 全站只有这一份定义 */
const TARGET_OPTIONS = [['outline', '只给大纲'], ['main', '只给主模型'], ['both', '都给']];

/**
 * 白名单表格里的一行 —— **素材和预设条目共用这一个构造器**。
 * 两组的行长得一样、行为一样：勾选框 + 名字 + 去向 + 字数，
 * 差别只有「数据从哪来」和「字数怎么算」，都由 spec 传进来。
 *
 * spec: {
 *   cbId, labelText, labelTitle, checkTitle, off,
 *   enabled, target, disabled,
 *   lenText(enabled, target),        // 字数那一列怎么显示
 *   onChange(enabled, target),
 * }
 */
function whitelistRow(spec) {
    const row = document.createElement('div');
    row.className = 'dro-row';

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
    sel.title = '只给大纲 = 拼进大纲提示词；只给主模型 = 不进大纲；都给 = 两边都要';
    for (const [val, txt] of TARGET_OPTIONS) {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = txt;
        if ((spec.target || 'outline') === val) o.selected = true;
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
        checkTitle: '不勾 = 这块不给大纲模型（主模型那边不受影响）',
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

/** 调用页：整页只留一行实时状态，说明文字都在控件悬浮提示里 */
const REASONING_TITLE = '选「不改」= 插件不碰酒馆设置；选别的档位 = 发大纲前临时改酒馆的推理强度，' +
    '生成完立刻还原（日志里会写「已还原临时覆盖的设置」）。自定义来源时同样生效。';

/** 这套档位是哪来的（写进悬浮提示，免得用户以为选项是随便定的） */
const SYNTAX_TITLE = {
    deepseek: '当前写法：DeepSeek 官方（low / medium / high / max，没有 minimum —— 最低就是 low）。' +
        'DeepSeek 只有在「请求模型思维链」开着时才会看这个强度，插件会为大纲这一轮打开它。',
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
        log(`档位「${s.reasoningLevel || '(空)'}」不在当前来源的写法里，已换算成「${want}」`, 'info', 'panel');
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
        ? '｜推理档位临时改，生成完还原' : '';
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

function renderPresetInfo() {
    if (!els['dro-preset-info']) return;
    const st = presetStats();
    const badge = st.source === 'tavern_helper'
        ? '<span class="dro-badge ok">酒馆助手</span>'
        : st.source === 'power_user'
            ? '<span class="dro-badge warn">降级读取</span>'
            : '<span class="dro-badge err">读取失败</span>';
    els['dro-preset-info'].innerHTML =
        `预设「${escapeHtml(st.name)}」${badge} · ${st.total} 条` +
        `（有正文 ${st.hasContent} · 已开启 ${st.enabled}）· ${fmtNum(st.totalChars)} 字` +
        (st.error ? `<br><span class="dro-badge err">${escapeHtml(st.error)}</span>` : '');
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
        labelText: p.name + ' [' + p.role + ']',
        labelTitle: [
            `名称: ${p.name}`,
            `role: ${p.role}`,
            p.position ? `position: ${JSON.stringify(p.position)}` : '',
            `正文长度: ${p.contentLength} 字`,
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
        for (const b of blocks) frag.appendChild(blockRow(b, facts[b.key], cfg, preset.name));
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
            (preset.prompts.length ? '（试试清空搜索框）' : '（预设读取失败，请看「关于」页的自检）');
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
    // 「（可选）」也不每项都写，缺了必需项才红字强调。
    for (const [key, label, critical] of entries) {
        const ok = raw[key] === true;
        rows.push(
            `<span class="dro-cap ${ok ? 'dro-cap-ok' : (critical ? 'dro-cap-no dro-cap-req' : 'dro-cap-no')}"` +
            `${critical ? '' : ' title="可选能力，缺了不影响主流程"'}>` +
            `${ok ? '✔' : '✘'} ${escapeHtml(label)}</span>`
        );
    }
    rows.push('<div style="height:2px"></div>');

    const preset = presetStats();
    const chat = chatStats();
    const profiles = listConnectionProfiles();
    rows.push('<div class="dro-hint">' +
        '预设读取 ' + escapeHtml(preset.source) +
        (preset.error ? '（' + escapeHtml(preset.error) + '）' : '') +
        '｜正则 ' + (chat.regexAvailable ? '可用' : '不可用（跳过压缩）') +
        '｜补全来源 ' + escapeHtml(currentSource() || '(未知)') +
        '｜连接配置 ' + profiles.length + ' 个（不读其中的密钥）' +
        '</div>');

    els['dro-caps'].innerHTML = rows.join('');
}

function renderStats() {
    if (!els['dro-data-stats']) return;
    const preset = presetStats();
    const chat = chatStats();
    const world = latestWorldInfo();
    const s = getSettings();
    const byPreset = s.presetWhitelist[preset.name] || {};
    let wlOn = 0, wlTotal = 0;
    for (const k of Object.keys(byPreset)) {
        wlTotal++;
        if (byPreset[k] && byPreset[k].enabled === true) wlOn++;
    }
    const bs = blockStatsOf(preset.name);

    const rows = [
        kv('预设名称', preset.name),
        kv('白名单已勾选', `${wlOn} / ${wlTotal} 条`),
        kv('系统预设条目', `${bs.on} / ${bs.total} 给大纲`),
        kv('聊天楼层', chat.floors + ' 层'),
        kv('聊天正文', fmtNum(chat.rawChars) + ' 字   ≈ ' + fmtNum(chat.tokens) + ' tokens'),
        kv('世界书（本轮）', (world.count || world.text)
            ? `激活 ${world.count} 条 / ${fmtNum(world.chars)} 字` +
              (world.overflowed ? '（预算溢出）' : '') +
              (world.stale ? '（已过期，没拼进提示词）' : '')
            : '本轮没有激活条目'),
        kv('主模型请求整形', trimRow()),
    ];
    els['dro-data-stats'].innerHTML = rows.join('');
}

/** 最近一次「只给大纲 → 从主模型移除」的结果 */
function trimRow() {
    const t = lastTrimStats();
    const only = outlineOnlyEntries().length;
    if (!t) {
        return only
            ? `已勾选 ${only} 条「只给大纲」，等下一次生成时移除`
            : '没有「只给大纲」的条目，不做改动';
    }
    if (t.skipped) return `上次未改动：${t.skipped}`;
    const parts = [];
    parts.push(t.removed ? `已移除 ${t.removed} 条 / ${fmtNum(t.removedChars)} 字` : '没有可移除的条目');
    if (t.missed.length) parts.push(`未命中 ${t.missed.length} 条（已保留）`);
    return parts.join('｜');
}

function kv(k, v) {
    return `<div class="dro-kv"><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`;
}

function renderLog() {
    if (!els['dro-log']) return;
    const lines = getLogLines().slice(-200);
    els['dro-log'].innerHTML = lines.map(l =>
        `<div class="l-${l.level}">[${escapeHtml(l.t)}] ${l.scope ? escapeHtml(l.scope) + ': ' : ''}${escapeHtml(l.msg)}</div>`
    ).join('');
    els['dro-log'].scrollTop = els['dro-log'].scrollHeight;
}

/** 供 index.js 在每次运行后刷新白名单视图与统计 */
export function refreshWhitelistView() {
    try {
        renderWhitelist();
        renderStats();
    } catch (e) {
        log('刷新白名单视图失败: ' + errorText(e), 'warn', 'panel');
    }
}

// ============================================================
// 大纲显示 / 运行状态
// ============================================================

/**
 * 正在生成大纲吗。
 * 这个标志是修「状态灯一闪一闪」的关键：
 * 流式刷新会频繁调 setOutline(部分正文, null)，而 null 以前被当成
 * 「从未运行」→ 徽章和指示灯被打回「未运行」+灰灯，下一秒 ticker 又改回
 * 「生成中」+蓝灯，两者交替 = 眼睛看到的闪。
 */
let running = false;

export function setOutline(text, info) {
    if (els['dro-outline-text']) els['dro-outline-text'].textContent = text || '（空）';

    // 流式过程中的局部刷新：只更新正文，绝不碰徽章 / 指示灯
    if (info == null && running) {
        if (els['dro-run-summary']) els['dro-run-summary'].textContent = '正在生成大纲…（正文实时刷新）';
        return;
    }

    running = false;
    if (els['dro-run-summary']) {
        /**
         * 三种收场，状态行必须说清是哪一种：
         *   aborted  —— 大纲没拿到，插件已经终止了这次生成（正文模型没跑），
         *               等你重新发送 / 重新生成；中断前写出来的部分留在正文档里。
         *   how      —— 停不了生成时的兜底：把半截大纲注入主模型继续跑。
         *   都没有   —— 本轮跳过，主模型收到的是未修改的消息。
         */
        const kept = Number(info && info.chars) || 0;
        if (!info) {
            els['dro-run-summary'].textContent = '尚未运行。';
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
                tail = '已终止本次生成（正文模型没跑），重新发送或点「重新生成」就能重来。' +
                    (kept > 0
                        ? `中断前生成的 ${kept} 字留在下面「当前大纲」，可点「复制大纲」拿走。`
                        : '');
            } else if (info.how) {
                tail = `已把${label}前生成的 ${kept} 字注入主模型（注入方式 ${escapeHtml(info.how)}，` +
                    '这份大纲没写完）；见下面「当前大纲」，可点「复制大纲」拿走。';
            } else if (kept > 0) {
                tail = `已保留${label}前生成的 ${kept} 字（见下面「当前大纲」，可点「复制大纲」拿走）；` +
                    '没能注入主模型，本轮主模型收到的是未修改的消息。';
            } else {
                tail = '本轮已跳过，主模型收到的是未修改的消息。';
            }
            els['dro-run-summary'].innerHTML =
                `<span class="dro-badge ${cls}">${label}</span> ` +
                `${escapeHtml(info.reason || (isTimeout ? '请求未在超时时间内返回' : '未知原因'))}　${tail}`;
        }
    }
    setBadge(info);
}

export function setRunning(elapsedMs) {
    running = true;
    const limit = Math.round(Number(getSettings().timeoutSec) || 60);
    if (els['dro-status-badge']) {
        els['dro-status-badge'].className = 'dro-badge warn';
        els['dro-status-badge'].textContent = `生成中 ${Math.round(elapsedMs / 1000)}/${limit}s`;
        els['dro-status-badge'].title = `已生成 ${Math.round(elapsedMs / 1000)} 秒，超过 ${limit} 秒会中断这一轮`;
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
        els['dro-status-badge'].textContent = '大纲已注入';
        els['dro-status-badge'].title = '本轮大纲已生成并注入主模型请求';
        setDot('ok');
    } else if (info.kind === 'timeout') {
        // 超时是「没等到」，不是「上游报错」——给黄灯，别跟真失败一个颜色
        const kept = Number(info.chars) || 0;
        els['dro-status-badge'].className = 'dro-badge warn';
        els['dro-status-badge'].textContent = info.aborted
            ? '超时·已终止'
            : (kept > 0 ? (info.how ? '超时·注入半截' : `超时·留了 ${kept} 字`) : '超时');
        els['dro-status-badge'].title = info.aborted
            ? `超时了，已经终止这次生成（正文模型没跑）：重新发送或点「重新生成」即可` +
              (kept > 0 ? `；中断前生成的 ${kept} 字留在「状态」页，可以复制` : '')
            : (kept > 0
                ? (info.how
                    ? `超时中断，中断前生成的 ${kept} 字已经当作大纲注入主模型（没写完）；`
                      + '原文也留在「状态」页的「当前大纲」里，可以复制'
                    : `超时中断，中断前生成的 ${kept} 字留在「状态」页的「当前大纲」里，可以复制；未能注入主模型`)
                : '等满设置的秒数还没返回，已中断本轮');
        setDot('skip');
    } else {
        const kept = Number(info.chars) || 0;
        els['dro-status-badge'].className = 'dro-badge err';
        els['dro-status-badge'].textContent = info.aborted
            ? '失败·已终止'
            : (kept > 0 ? (info.how ? '失败·注入半截' : `失败·留了 ${kept} 字`) : '本轮跳过');
        els['dro-status-badge'].title = info.aborted
            ? '大纲没拿到，已经终止这次生成（正文模型没跑）：重新发送或点「重新生成」即可'
            : (kept > 0
                ? (info.how
                    ? `本轮失败，但失败前生成的 ${kept} 字已经当作大纲注入主模型（没写完）`
                    : `本轮失败，失败前生成的 ${kept} 字留在「状态」页的「当前大纲」里，可以复制；未能注入主模型`)
                : '上游报错或拿不到上下文，本轮主模型收到的是未修改的消息');
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
    setDot('skip');
}

export function setDot(kind) {
    const dot = $('dro-bar-dot');
    if (dot) dot.className = 'dro-dot' + (kind && kind !== 'idle' ? ' ' + kind : '');
}

export function reportRun(result) {
    setOutline(result.outline || '', result);
}

export function reportPreview(info) {
    lastPreview = info;
    log(
        `预览｜聊天 ${info.floors} 层｜${info.compressed ? '压缩' : '未压缩'} ${info.rawChars}→${info.finalChars} 字（省 ${info.savedPct}）` +
        `｜白名单命中 ${info.presetPicked} 条｜prompt ${fmtNum(info.promptTokens)} tokens`,
        'info', 'panel'
    );
    if (Array.isArray(info.blocks)) {
        const on = info.blocks.filter(b => b.on);
        log('系统预设条目｜' + on.map(b => `${b.label} ${fmtNum(b.chars)}字` +
            (b.note ? `（${b.note}）` : '')).join('｜'), 'info', 'panel');
    }
}

export function reportInjected(analysis, how) {
    if (!analysis || !analysis.ok) return;
    log(`请求组成｜${analysis.count} 条消息｜${analysis.roles}｜合计 ${fmtNum(analysis.totalChars)} 字｜注入=${how}`, 'info', 'panel');
}

export function getLastPreview() { return lastPreview; }

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
}
