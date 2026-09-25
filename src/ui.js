/**
 * ui.js — 界面胶水层
 * ============================================================
 * 界面本体在 panel.js（自包含悬浮窗，唯一的设置入口）。
 * 这个文件只做两件事：
 *
 *   1. 把 panel 的接口转出去，让 index.js 不用关心实现细节
 *      （index.js 里所有 ui.xxx 调用都保持原样）
 *
 *   2. 在酒馆扩展设置区挂一张小卡片：状态 + 总开关 +
 *      「打开悬浮窗」。这里刻意不放第二套完整设置 ——
 *      v3.0 就是两套界面并存，结果点不动还互相打架。
 */

import { VERSION } from './constants.js';
import { log, toast, escapeHtml, probe, getCaps, refreshCtx } from './env.js';
import { get as getSettings, set as setSettings, watch as watchSettings } from './settings.js';
import * as panel from './panel.js';

const CARD_SEL = '#dro-settings';

let card = null;
let cardEls = {};
let destroyFns = [];

// ============================================================
// 悬浮窗（转出去）
// ============================================================

export const mountBar = () => panel.mount();
export const openDrawer = () => panel.openPanel();
export const openPanel = () => panel.openPanel();
export const closePanel = () => panel.closePanel();
export const togglePanel = () => panel.togglePanel();
export const isPanelOpen = () => panel.isOpen();
export const setOutline = (...a) => panel.setOutline(...a);
export const setRunning = (...a) => panel.setRunning(...a);
export const setSkipped = (...a) => panel.setSkipped(...a);
export const setDot = (...a) => panel.setDot(...a);
export const reportRun = (...a) => panel.reportRun(...a);
export const reportPreview = (...a) => panel.reportPreview(...a);
export const reportInjected = (...a) => panel.reportInjected(...a);
export const reportRequestMap = (...a) => panel.reportRequestMap(...a);
export const refreshWhitelistView = () => panel.refreshWhitelistView();
export const renderWhitelist = () => panel.renderWhitelist();

// ============================================================
// 酒馆扩展设置区的小卡片
// ============================================================

/**
 * 把入口卡片挂进酒馆的扩展设置区。
 * @param {string} html 已渲染好的模板 HTML
 */
export function mountSettings(html) {
    const container = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');
    if (!container) {
        log('找不到 #extensions_settings2，入口卡片无法挂载', 'error', 'ui');
        return false;
    }

    // 幂等：清掉可能存在的旧面板（热重载残留）
    const old = document.getElementById(CARD_SEL.slice(1));
    if (old) old.remove();

    const wrap = document.createElement('div');
    wrap.innerHTML = html;

    // 不用 firstElementChild：模板开头有注释和空白，
    // renderExtensionTemplateAsync 也可能引入额外包裹元素。
    let node = wrap.querySelector(CARD_SEL);
    if (!node) node = Array.from(wrap.children || []).find(c => c && c.nodeType !== 3) || null;
    if (!node) {
        log('设置模板里找不到 ' + CARD_SEL, 'error', 'ui');
        return false;
    }
    if (node.id !== CARD_SEL.slice(1)) node.id = CARD_SEL.slice(1);
    container.appendChild(node);
    card = node;

    cacheCard();
    bindCard();
    renderCard();
    log('入口卡片已挂进酒馆扩展设置区（完整设置都在悬浮窗里）', 'ok', 'ui');
    return true;
}

function cacheCard() {
    const q = (id) => document.getElementById(id);
    cardEls = {
        badge: q('dro-card-status'),
        enabled: q('dro-card-enabled'),
        open: q('dro-card-open'),
        showbar: q('dro-card-showbar'),
        caps: q('dro-card-caps'),
        version: q('dro-card-version'),
    };
}

function bindCard() {
    if (cardEls.enabled) {
        cardEls.enabled.addEventListener('change', () => {
            setSettings({ enabled: cardEls.enabled.checked !== false });
            renderCard();
        });
    }
    if (cardEls.open) {
        cardEls.open.addEventListener('click', () => {
            openPanel();
            toast('悬浮窗已打开', 'info');
        });
    }
    if (cardEls.showbar) {
        cardEls.showbar.addEventListener('change', () => {
            setSettings({ showBar: cardEls.showbar.checked !== false });
            renderCard();
        });
    }
    destroyFns.push(watchSettings(() => renderCard()));
}

function renderCard() {
    if (!card) return;
    const s = getSettings();
    if (cardEls.enabled) cardEls.enabled.checked = s.enabled !== false;
    if (cardEls.showbar) cardEls.showbar.checked = s.showBar !== false;
    if (cardEls.version) cardEls.version.textContent = VERSION;

    if (cardEls.badge) {
        if (s.enabled === false) {
            cardEls.badge.className = 'dro-badge idle';
            cardEls.badge.textContent = '已停用';
        } else if (panel.isOpen()) {
            cardEls.badge.className = 'dro-badge ok';
            cardEls.badge.textContent = '悬浮窗已展开';
        } else {
            cardEls.badge.className = 'dro-badge idle';
            cardEls.badge.textContent = '待命';
        }
    }

    if (cardEls.caps) {
        const caps = getCaps();
        const miss = (caps.__missingCritical || []);
        cardEls.caps.innerHTML = miss.length
            ? '<span class="dro-badge err">缺少必需能力</span> ' + miss.map(escapeHtml).join('、')
            : '<span class="dro-badge ok">环境自检通过</span> 完整自检见悬浮窗「关于」页';
    }
}

/** 重新探测并刷新卡片（index.js 启动时用得到） */
export function refreshCard() {
    refreshCtx();
    probe(true);
    renderCard();
}

/** 清理（热重载时用） */
export function destroy() {
    for (const fn of destroyFns) {
        try { fn(); } catch (e) { /* ignore */ }
    }
    destroyFns = [];
    try { panel.destroy(); } catch (e) { /* ignore */ }
    const node = document.getElementById(CARD_SEL.slice(1));
    if (node) node.remove();
    card = null;
    cardEls = {};
}
