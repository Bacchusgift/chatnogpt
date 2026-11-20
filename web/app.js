'use strict';

/* ChatNoGPT 前端
 * 对外呈现为一个普通的 AI 聊天网站（形似 ChatGPT）：
 *  - 输入框左下角是“模型选择器”，实际是在选择与自己对话的另一个用户；
 *    选中谁，消息就发给谁，对方那边的列表会自动出现这条聊天
 *  - 自己发的消息 → 右侧气泡；别人发的消息 → 左侧平铺 + 模型名标签
 *  - 对方打字时显示“思考中 · Ns”，消息到达后无缝变为“已思考 N 秒”+ 打字机
 *  - 会话不手动创建：第一条消息即创建；侧栏通过轮询自动出现新聊天
 */

const $ = (s, el = document) => el.querySelector(s);

const state = {
  token: localStorage.getItem('cngp_token') || '',
  me: null,
  convs: [],
  cur: null,          // 当前聊天 id
  curInfo: null,      // 当前聊天详情（含 peer 信息）
  target: null,       // 模型选择器当前选中 {id, name}
  ws: null,
  wsConv: null,
  pending: new Set(), // 已发出、等待服务器回显的 client_msg_id
  seenMsg: new Set(), // 当前聊天已渲染过的消息 id（去重/断线补拉）
  lastTS: 0,          // 当前聊天已收到的最大时间戳（断线补拉用）
  lastRenderTS: 0,    // 当前聊天已渲染的最大时间戳（时间分割线用）
  unread: 0,          // 页签隐藏期间累计的新消息数（标题计数）
  baseTitle: '',      // 页面原始标题
  queue: [],          // 等待播放的消息
  animating: false,
  gen: 0,             // 切换聊天时 +1，让旧的动画自行作废
  lastTypingSent: 0,
  thinkingHideTimer: 0,
  thinkingTimer: 0,
  thinkingStart: 0,
  thinkingRow: null,
  thinkingSecEl: null,
  pendingSend: null,  // 会话尚未连上 WS 时暂存待发消息
  attachment: null,   // 待发送的已压缩 WebP
  imageURLs: new Map(), // 已认证图片的本地 blob URL
  access: '完全访问', // 装饰性“权限档位”
  coverMode: localStorage.getItem('cngp_effort') === 'max', // 思考伪装（覆盖真实对话）
  msgIndex: {},      // 消息索引（id → 摘要），引用回复用
  reactions: {},     // 表情回应聚合（msgId → {emoji: [昵称]})
  coverLines: [],     // 服务端内置文稿
  readIDs: new Set(), // 当前账号和会话中已展示的消息 id（仅本地）
};

/* ---------- 时间显示与消息通知 ---------- */

const DIVIDER_GAP_SEC = 5 * 60; // 消息间隔超过 5 分钟插入时间分割线
const pad2 = n => String(n).padStart(2, '0');

function fmtClock(ts) {
  const d = new Date(ts * 1000);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function fmtDividerLabel(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const hm = fmtClock(ts);
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.toDateString() === yest.toDateString()) return '昨天 ' + hm;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ` + hm;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ` + hm;
}

function fullStamp(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// 与上一条消息间隔超阈值（或为首条）时插入居中时间分割线；
// 只有真正插入分割线时才推进 anchor，避免连续短间隔消息被提前“顶掉”
function ensureDivider(ts) {
  if (!ts) return;
  if (state.lastRenderTS && ts - state.lastRenderTS < DIVIDER_GAP_SEC) return;
  const div = document.createElement('div');
  div.className = 'time-divider';
  div.textContent = fmtDividerLabel(ts);
  $('#messages').appendChild(div);
  state.lastRenderTS = ts;
}

function bumpUnread() {
  if (!document.hidden) return;
  state.unread++;
  document.title = `(${state.unread}) ${state.baseTitle}`;
  updateAppBadge();
}

function resetUnread() {
  if (state.unread) {
    state.unread = 0;
    document.title = state.baseTitle;
  }
  updateAppBadge();
}

// PWA/Mac：Dock 图标未读角标（Badging API），不支持的平台静默跳过
function updateAppBadge() {
  try {
    if (!('setAppBadge' in navigator)) return;
    const server = (state.convs || []).reduce((n, c) => n + (c.unread_count || 0), 0);
    const total = server + (state.unread || 0);
    if (total > 0) navigator.setAppBadge(total).catch(() => {});
    else navigator.clearAppBadge().catch(() => {});
  } catch {}
}

// 是否安装为独立应用（桌面 PWA / iOS 主屏）
function pwaStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
}
function isMacUA() { return /Macintosh|Mac OS X/.test(navigator.userAgent || ''); }

function unreadBadgeEl(count) {
  const badge = document.createElement('span');
  badge.className = 'conv-unread';
  badge.setAttribute('aria-label', `${count} 条未读消息`);
  return badge;
}

async function markConversationRead(id) {
  if (!id || !state.me || document.hidden) return;
  const c = state.convs.find(c => c.id === id);
  if (c && c.unread_count) { c.unread_count = 0; renderConvList(); }
  try { await api(`/api/conversations/${encodeURIComponent(id)}/read`, { method: 'POST' }); } catch {}
}

// 新消息提醒：标题计数 + 浏览器系统通知；onScreen 表示消息正显示在当前会话里，
// 页签可见时不重复弹窗（内容已在眼前），页签隐藏时照常提醒。
const NOTIF_ICON = '/icons/icon-192.png';

// 新消息提示音：短促双音，可关闭（通知声音开关在“思考强度”菜单里）
let notifyAudioCtx = null;
function playNotifySound() {
  try {
    if (localStorage.getItem('cngp_sound') !== '1') return;
    notifyAudioCtx = notifyAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (notifyAudioCtx.state === 'suspended') notifyAudioCtx.resume();
    const t = notifyAudioCtx.currentTime;
    const osc = notifyAudioCtx.createOscillator();
    const gain = notifyAudioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(660, t + 0.12);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    osc.connect(gain).connect(notifyAudioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.45);
  } catch {}
}

function notifyMessage(convID, title, body, onScreen = false) {
  bumpUnread();
  playNotifySound();
  try {
    if (!('Notification' in window)) return;
    // 只有“正在看这个会话且窗口聚焦”时才不弹（消息已在眼前），其余一律系统级弹出
    if (onScreen && !document.hidden && document.hasFocus()) return;
    if (Notification.permission !== 'granted') return;
    const n = new Notification(title, {
      body: body.slice(0, 120),
      tag: 'cngp-' + convID,
      icon: NOTIF_ICON,
      requireInteraction: true, // 常驻直到点击，不再几秒后自动消失
      silent: false,
    });n.onclick = () => {
        window.focus();
        resetUnread();
        if (convID !== state.cur) selectConv(convID);
        else markConversationRead(convID);
      n.close();
    };
  } catch {}
}

// 登录/注册成功时（用户手势内）请求通知授权；拒绝或 iOS 浏览器则静默降级为标题计数
function askNotifyPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  } catch {}
}

/* ---------- 思考伪装：覆盖层 + 手电筒透视 ---------- */

const EFFORTS = [
  { k: 'off', label: '关闭', desc: '显示真实对话' },
  { k: 'max', label: '最高', desc: '对话显示为技术分析，悬停查看原文' },
];
const archiveKey = () => 'cngp_archived_' + (state.me?.id || 'guest');
function localArchives() {
  try {
    const value = JSON.parse(localStorage.getItem(archiveKey()) || '{}');
    if (Array.isArray(value)) return Object.fromEntries(value.map(id => [id, Date.now()]));
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}
const archivedConvs = () => new Set([...state.convs.filter(c => c.archived_at).map(c => c.id), ...Object.keys(localArchives())]);
function saveLocalArchives(value) { localStorage.setItem(archiveKey(), JSON.stringify(value)); }
function purgeLocalArchives() {
  const value = localArchives(); let changed = false;
  for (const [id, at] of Object.entries(value)) {
    if (Date.now() - Number(at) < 30 * 86400000) continue;
    delete value[id]; changed = true;
    if (id.startsWith('novel:') && typeof novelSave === 'function') {
      const modelID = id.slice(6);
      delete novelHistory[modelID]; delete novelChapters[modelID]; delete novelHistorySources[modelID];
      novelSave();
    }
  }
  if (changed) saveLocalArchives(value);
}
let showArchivedConvs = false;

function coverKeyHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

// 按消息 id 确定性取语料：同一消息在任何人、任何次刷新下覆盖文本一致
function coverTextFor(key) {
  if (!state.coverLines.length) {
    return '先核对入口参数和上下游的约束，再梳理缓存、并发与持久化之间的调用顺序。对异常分支增加明确的超时和重试条件，避免重复请求改变最终状态；上线前还需对关键路径做回归验证。';
  }
  return state.coverLines[coverKeyHash(String(key)) % state.coverLines.length];
}

function msgKeyOf(id, nickname, content) {
  if (id) return String(id);
  return (nickname || '') + '|' + (content || '');
}

function readStorageKey(id) {
  return `cngp_read_${state.me.id}_${id}`;
}

function loadReadIDs(id) {
  try {
    const ids = JSON.parse(localStorage.getItem(readStorageKey(id)) || '[]');
    return new Set(Array.isArray(ids) ? ids.filter(x => typeof x === 'string') : []);
  } catch { return new Set(); }
}

function rememberRead(id) {
  if (!id || !state.cur || !state.me || state.readIDs.has(id)) return;
  state.readIDs.add(id);
  try {
    // 控制本地存储大小；旧消息即使被裁掉，历史加载仍直接以密文呈现。
    localStorage.setItem(readStorageKey(state.cur), JSON.stringify(Array.from(state.readIDs).slice(-2000)));
  } catch {}
}

async function ensureCoverPool() {
  if (state.coverLines.length) return;
  try {
    const d = await api('/api/cover-lines');
    state.coverLines = d.lines || [];
  } catch {}
}

// 按 Unicode 字符数截取文稿，不改气泡本身或消息原文。
function ownCoverText(content) {
  const length = Array.from(content).length;
  if (!length) return '';
  const source = Array.from(coverTextFor(content) + coverTextFor(content + '-more'));
  return Array.from({ length }, (_, i) => source[i % source.length]).join('');
}

function bindOwnReveal(row) {
  row.addEventListener('pointermove', () => {
    if (state.coverMode && row.classList.contains('covered')) row.classList.add('reveal-active');
  });
  row.addEventListener('pointerleave', () => row.classList.remove('reveal-active'));
  row.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    row.classList.add('flash');
    clearTimeout(row.flashTimer);
    row.flashTimer = setTimeout(() => row.classList.remove('flash'), 1600);
  });
}

// 对方回复使用整段技术文稿，悬停用原位圆孔显示原文。
function makeCoverLayer(hasImage = false) {
  const layer = document.createElement('div');
  layer.className = 'cover-layer cover-ai';
  const tag = document.createElement('div');
  tag.className = 'cover-tag';
  tag.textContent = 'AI';
  const body = document.createElement('div');
  body.className = 'cover-body';
  layer.append(tag, body);
  if (hasImage) {
    const matte = document.createElement('div');
    matte.className = 'cover-image-matte';
    matte.textContent = '[image]';
    layer.appendChild(matte);
  }
  return layer;
}

function coverTextInto(row) {
  const layer = row.querySelector('.cover-layer');
  if (!layer) return;
  const text = row.classList.contains('novel-ai') && typeof novelCoverTextFor === 'function'
    ? novelCoverTextFor(row.dataset.msgKey || '') : coverTextFor(row.dataset.msgKey || '');
  const target = layer.querySelector('.cover-body');
  if (target) target.textContent = text;
  const tag = layer.querySelector('.cover-tag');
  if (tag && row.dataset.nickname) tag.textContent = row.dataset.nickname;
}

// 手电筒：光标位置写入 CSS 变量；触屏按下也能照 1.6s
function bindFlashlight(row) {
  if (row.dataset.fxBound) return;
  row.dataset.fxBound = '1';
  const track = e => {
    if (!row.classList.contains('covered') && !row.classList.contains('novel-force-cover')) return;
    const rect = row.getBoundingClientRect();
    row.style.setProperty('--fx', (e.clientX - rect.left) + 'px');
    row.style.setProperty('--fy', (e.clientY - rect.top) + 'px');
    // 光晕用视口坐标：fixed 定位，不影响滚动高度
    row.style.setProperty('--gx', e.clientX + 'px');
    row.style.setProperty('--gy', e.clientY + 'px');
  };
  row.addEventListener('pointermove', e => {
    track(e);
    if ((state.coverMode || row.classList.contains('novel-force-cover')) && !row.classList.contains('reveal-active')) {
      const sc = document.querySelector('#msgScroll');
      const top = sc.scrollTop;
      row.classList.add('reveal-active');
      if (sc.scrollTop !== top) sc.scrollTop = top; // 遮罩切换不改变视图位置
    }
  });
  row.addEventListener('pointerleave', () => row.classList.remove('reveal-active'));
  row.addEventListener('pointerdown', e => {
    if ((!row.classList.contains('covered') && !row.classList.contains('novel-force-cover')) || e.pointerType === 'mouse') return;
    track(e);
    row.classList.add('flash');
    clearTimeout(row.flashTimer);
    row.flashTimer = setTimeout(() => row.classList.remove('flash'), 1600);
  });
}

function uncoverAll() {
  document.querySelectorAll('#messages .covered').forEach(r => r.classList.remove('covered', 'reveal-active'));
}

async function coverAllVisible() {
  if (!state.coverMode) return;
  // 先同步隐藏原文，再取文稿；网络慢时也不会闪现历史聊天。
  document.querySelectorAll('#messages .msg-ai.msg-real:not(.covered)').forEach(row => {
    coverTextInto(row);
    row.classList.add('covered');
    bindFlashlight(row);
  });
  document.querySelectorAll('#messages .msg-own:not(.covered)').forEach(row => {
    const original = row.querySelector('.own-original');
    if (original) row.querySelector('.own-cover').textContent = ownCoverText(original.textContent);
    if (original || row.classList.contains('has-image')) row.classList.add('covered');
  });
  await ensureCoverPool();
  if (!state.coverMode) return;
  document.querySelectorAll('#messages .msg-ai.msg-real.covered:not(.cover-typing)').forEach(coverTextInto);
  document.querySelectorAll('#messages .msg-own.covered').forEach(row => {
    const original = row.querySelector('.own-original');
    if (original) row.querySelector('.own-cover').textContent = ownCoverText(original.textContent);
  });
}

function setEffort(k) {
  const max = k === 'max';
  state.coverMode = max;
  localStorage.setItem('cngp_effort', max ? 'max' : 'off');
  $('#effortModeLabel').textContent = max ? '最高' : '关闭';
  document.body.classList.toggle('cover-on', max);
  if (typeof novelCoverMode === 'function') novelCoverMode(max);
  if (max) {
    coverAllVisible();
    toast(state.cur?.startsWith('novel:')
      ? '思考伪装已开启：先在章节上框选透视范围并确认'
      : '思考伪装已开启：悬停消息可查看原文');
  } else {
    uncoverAll();
    toast('已显示真实对话');
  }
}

function setRevealOpacity(value) {
  const opacity = Math.max(0, Math.min(100, Number(value)));
  localStorage.setItem('cngp_reveal_opacity', String(opacity));
  document.documentElement.style.setProperty('--reveal-outline-alpha', String(opacity / 100));
  const label = document.querySelector('#revealOpacityValue');
  if (label) label.textContent = opacity + '%';
}

/* ---------- api ---------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    doLogoutLocal();
    throw new Error('登录状态已失效，请重新登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
  return data;
}

/* ---------- 视图切换 ---------- */

function showAuth() {
  $('#authView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
}

function showApp() {
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#meName').textContent = state.me.nickname;
  $('#meAvatar').textContent = (Array.from(state.me.nickname.trim())[0] || '?').toUpperCase();
  // 恢复上次选择的思考强度
  $('#effortModeLabel').textContent = state.coverMode ? '最高' : '关闭';
  document.body.classList.toggle('cover-on', state.coverMode);
  setRevealOpacity(localStorage.getItem('cngp_reveal_opacity') || 100);
  if (!state.cur) {
    $('#messages').replaceChildren();
    appendWelcome('ChatNoGPT');
  }
  if (state.coverMode) ensureCoverPool();
  loadProjects();
  loadConvs();
  // 插件脚本按目录注入：目录来自 /api/plugins（enabled 且带 script），基座零插件知识
  loadPluginCatalog().then(catalog => {
    state.pluginCatalog = catalog;
    const loads = catalog.filter(p => p.enabled && p.script)
      .map(p => ensurePluginScript(p.name, p.script));
    Promise.all(loads).then(() => window.dispatchEvent(new CustomEvent('cngp:plugins-loaded')));
  });
  maybeShowNotifBanner();
}

// 通知授权引导：未授权时在输入区上方展示，授权成功或点“暂不”后本次不再出现
function maybeShowNotifBanner() {
  try {
    if (!('Notification' in window) || Notification.permission === 'granted') return;
    if (localStorage.getItem('cngp_notif_banner') === '0') return;
    $('#notifBanner')?.remove();
    const bar = document.createElement('div');
    bar.id = 'notifBanner';
    bar.className = 'notif-banner';
    bar.append('开启系统通知，第一时间收到新消息');
    const enable = document.createElement('button');
    enable.textContent = '开启系统通知';
    enable.onclick = async () => {
      try {
        const p = await Notification.requestPermission();
        if (p === 'granted') { bar.remove(); toast('系统通知已开启'); }
        else {
          bar.textContent = pwaStandalone()
            ? (isMacUA() ? '通知已被拒绝：macOS 系统设置 → 通知 → 找到本应用并允许，然后重启应用'
                         : '通知已被拒绝：请在系统设置中允许本应用的通知后重试')
            : '通知已被浏览器拒绝：请在地址栏左侧站点设置里允许通知后刷新';
        }
      } catch {}
    };
    const later = document.createElement('button');
    later.textContent = '暂不';
    later.onclick = () => { localStorage.setItem('cngp_notif_banner', '0'); bar.remove(); };
    bar.append(enable, later);
    document.querySelector('.composer-wrap').prepend(bar);
  } catch {}
}

function doLogoutLocal() {
  localStorage.removeItem('cngp_token');
  state.token = '';
  state.me = null;
  state.cur = null;
  state.curInfo = null;
  state.convs = [];
  state.gen++;
  state.queue = [];
  state.animating = false;
  state.readIDs = new Set();
  state.seenMsg.clear();
  state.pending.clear();
  state.wsConv = null;
  state.pendingSend = null;
  state.target = null;
  for (const url of state.imageURLs.values()) URL.revokeObjectURL(url);
  state.imageURLs.clear();
  removeAttachment();
  $('#input').value = '';
  $('#messages').replaceChildren();
  $('#convList').replaceChildren();
  $('#convTitle').textContent = 'ChatNoGPT';
  $('#btnRenameConv').classList.add('hidden');
  document.body.classList.remove('cover-on');
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  showAuth();
}

/* ---------- 聊天列表（轮询自动发现新聊天） ---------- */

async function loadConvs(silent = false) {
  try {
    let d = await api('/api/conversations');
    const legacy = localArchives(); let migrated = false;
    for (const c of d.conversations || []) {
      if (!(c.id in legacy)) continue;
      if (!c.archived_at) await api('/api/conversations/' + encodeURIComponent(c.id) + '/archive', { method: 'PUT' });
      delete legacy[c.id]; migrated = true;
    }
    if (migrated) { saveLocalArchives(legacy); d = await api('/api/conversations'); }
    const hadConvs = state.convs.length > 0;
    const prevUnread = new Map(state.convs.map(c => [c.id, c.unread_count || 0]));
    state.convs = d.conversations || [];
    // 服务端未读数只计入别人发的消息，轮询可发现其他会话和其他设备上的变化。
    for (const c of state.convs) {
      if (hadConvs && (c.unread_count || 0) > (prevUnread.get(c.id) || 0)) {
        if (c.id !== state.cur || document.hidden) {
          notifyMessage(c.id, c.title, '收到新消息');
        }
      }
    }
    renderConvList();
    if (!state.cur) {
      const first = state.convs.find(c => !archivedConvs().has(c.id));
      if (first) selectConv(first.id);
    }
  } catch (e) { if (!silent) toast(e.message); }
}

// ---------- 消息搜索：⌘P / Ctrl+P 命令面板 ----------

let searchUI = null;
let searchDebounce = 0;
let searchSeq = 0;
let searchHits = [];
let searchActive = 0;
let searchQuery = '';

function magnifierSVG(size) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', '11'); c.setAttribute('cy', '11'); c.setAttribute('r', '7');
  c.setAttribute('stroke', 'currentColor'); c.setAttribute('stroke-width', '2');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M20 20l-4-4'); p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2'); p.setAttribute('stroke-linecap', 'round');
  s.append(c, p);
  return s;
}

function openSearch() {
  if (searchUI) { closeSearch(); return; }
  const root = $('#modalRoot');
  const overlay = document.createElement('div');
  overlay.className = 'search-overlay';
  const panel = document.createElement('div');
  panel.className = 'search-modal';
  const box = document.createElement('div');
  box.className = 'search-box';
  box.append(magnifierSVG(17));
  const input = document.createElement('input');
  input.id = 'searchInput';
  input.placeholder = '搜索消息…';
  input.autocomplete = 'off'; input.spellcheck = false;
  const esc = document.createElement('kbd'); esc.textContent = 'Esc';
  box.append(input, esc);
  const results = document.createElement('div');
  results.className = 'search-results';
  const foot = document.createElement('div');
  foot.className = 'search-foot';
  foot.textContent = '↑↓ 选择 · Enter 打开 · Esc 关闭';
  panel.append(box, results, foot);
  overlay.appendChild(panel);
  root.appendChild(overlay);
  searchUI = { overlay, panel, input, results, foot };
  overlay.onclick = e => { if (e.target === overlay) closeSearch(); };
  input.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => doSearch(input.value.trim()), 220);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSearchSel(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSearchSel(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); openSearchHit(searchActive); }
  });
  input.focus();
}

function closeSearch() {
  searchUI?.overlay.remove();
  searchUI = null; searchHits = []; searchActive = 0; searchQuery = '';
}

function moveSearchSel(delta) {
  if (!searchUI || !searchHits.length) return;
  searchActive = (searchActive + delta + searchHits.length) % searchHits.length;
  paintSearchHits();
}

async function doSearch(q) {
  const my = ++searchSeq;
  searchQuery = q;
  if (!searchUI) return;
  if (!q) { searchHits = []; searchActive = 0; paintSearchEmpty('输入关键词搜索历史消息'); return; }
  searchUI.foot.textContent = '搜索中…';
  try {
    const d = await api('/api/search?q=' + encodeURIComponent(q));
    if (my !== searchSeq || !searchUI) return;
    searchHits = d.hits || [];
    searchActive = 0;
    if (!searchHits.length) paintSearchEmpty('没有找到包含“' + q + '”的消息');
    else paintSearchHits();
  } catch (e) {
    if (my !== searchSeq || !searchUI) return;
    searchUI.foot.textContent = '搜索需要连接数据库后使用';
  }
}

function paintSearchEmpty(text) {
  if (!searchUI) return;
  searchUI.results.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'search-empty';
  p.textContent = text;
  searchUI.results.appendChild(p);
}

function paintSearchHits() {
  if (!searchUI) return;
  const list = searchUI.results;
  list.innerHTML = '';
  searchHits.forEach((hit, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'search-hit' + (i === searchActive ? ' active' : '');
    const title = document.createElement('div');
    title.className = 'h-title';
    title.textContent = hit.title + ' · ' + fullStamp(hit.message.ts);
    const snippet = document.createElement('div');
    snippet.className = 'h-snippet';
    snippet.append(searchSnippet(hit.message.content || '', searchQuery));
    b.append(title, snippet);
    b.onclick = () => openSearchHit(i);
    b.onmouseenter = () => { searchActive = i; paintSearchActive(); };
    list.appendChild(b);
  });
  paintSearchActive();
}

function paintSearchActive() {
  if (!searchUI) return;
  [...searchUI.results.querySelectorAll('.search-hit')].forEach((el, i) => el.classList.toggle('active', i === searchActive));
  searchUI.results.querySelector('.search-hit.active')?.scrollIntoView({ block: 'nearest' });
}

// 生成带关键词高亮的片段（纯 textContent/mark 节点，无注入风险）
function searchSnippet(content, q) {
  const frag = document.createDocumentFragment();
  const lower = content.toLowerCase(), ql = q.toLowerCase();
  const at = lower.indexOf(ql);
  if (at < 0) { frag.append(content.slice(0, 80)); return frag; }
  let start = Math.max(0, at - 24);
  const end = Math.min(content.length, at + q.length + 48);
  if (start > 0) frag.append('…');
  frag.append(content.slice(start, at));
  const mark = document.createElement('mark');
  mark.textContent = content.slice(at, at + q.length);
  frag.append(mark);
  frag.append(content.slice(at + q.length, end));
  if (end < content.length) frag.append('…');
  return frag;
}

function openSearchHit(i) {
  const hit = searchHits[i];
  if (!hit) return;
  closeSearch();
  (async () => {
    if (state.cur !== hit.conv_id) await selectConv(hit.conv_id);
    timeScrollToMessage(hit.message.id);
  })();
}

// 跳到指定消息：居中滚动 + 短暂高亮
function timeScrollToMessage(mid) {
  if (!mid) return;
  let tries = 0;
  const timer = setInterval(() => {
    const el = document.querySelector('#messages [data-mid="' + CSS.escape(mid) + '"]');
    if (el || ++tries > 40) {
      clearInterval(timer);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('search-flash');
        setTimeout(() => el.classList.remove('search-flash'), 2200);
      }
    }
  }, 100);
}

// 会话行显示名：归属优先——1:1 显示对方昵称，群聊室显示房间名
function convDisplayName(c) {
  if (c.kind !== 1 && c.peer_nickname) return c.peer_nickname;
  return c.title;
}
function convTooltip(c) {
  if (c.kind !== 1 && c.peer_nickname) return '与 ' + c.peer_nickname + ' 的对话';
  return c.title + '（双击修改标题）';
}
function convButton(c) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'conv-item' + (c.id === state.cur ? ' active' : '');
  b.dataset.id = c.id;
  b.textContent = convDisplayName(c);
  if (c.unread_count > 0) b.appendChild(unreadBadgeEl(c.unread_count));
  b.title = convTooltip(c);
  b.onclick = () => { selectConv(c.id); closeSidebarMobile(); };
  if (c.kind === 1) b.ondblclick = () => renameConv(c.id, c.title);
  if (c.kind !== 1) {
    b.draggable = true;
    b.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/chat-id', c.id);
      e.dataTransfer.effectAllowed = 'move';
      draggingConvID = c.id;
      b.classList.add('dragging');
    });
    b.addEventListener('dragend', () => b.classList.remove('dragging'));
  }
  return b;
}

function convEntry(list, c) {
  const b = convButton(c);
  appendConversationListItem(list, b, c);
}

function sectionHeader(label, extra) {
  const head = document.createElement('div');
  head.className = 'side-section-head';
  const name = document.createElement('span');
  name.className = 'side-section-label';
  name.textContent = label;
  head.append(name);
  if (extra) head.appendChild(extra);
  return head;
}

function renderConvList() {
  const list = $('#convList');
  list.innerHTML = '';
  const archived = archivedConvs();
  const rooms = state.convs.filter(c => c.kind === 1);
  const normal = state.convs.filter(c => c.kind !== 1);
  const projects = state.projects || [];
  const grouped = new Map(projects.map(p => [p.id, []]));
  const loose = [];
  for (const c of normal) {
    if (archived.has(c.id)) continue;
    if (c.project_id && grouped.has(c.project_id)) grouped.get(c.project_id).push(c);
    else loose.push(c);
  }
  // Agent Team 区（群聊室）
  const teamHead = sectionHeader('Agent Team');
  const teamNew = document.createElement('button');
  teamNew.type = 'button'; teamNew.className = 'side-section-add'; teamNew.textContent = '＋';
  teamNew.title = '创建群聊室'; teamNew.onclick = createRoomModal;
  teamHead.appendChild(teamNew);
  list.appendChild(teamHead);
  if (rooms.length) for (const r of rooms) {
    const b = convButton(r);
    b.classList.add('room-item');
    if (r.unread_count > 0) b.appendChild(unreadBadgeEl(r.unread_count));
    appendConversationListItem(list, b, r);
  } else {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = '暂无群聊室';
    list.appendChild(empty);
  }
  // 项目分组区
  const projHead = sectionHeader('项目');
  const projNew = document.createElement('button');
  projNew.type = 'button'; projNew.className = 'side-section-add'; projNew.textContent = '＋';
  projNew.title = '新建项目'; projNew.onclick = createProjectModal;
  projHead.appendChild(projNew);
  list.appendChild(projHead);
  if (projects.length) for (const p of projects) {
    const det = document.createElement('details');
    det.className = 'proj-group'; det.open = true;
    det.dataset.pid = p.id;
    const sum = document.createElement('summary');
    sum.textContent = p.name;
    sum.title = p.name + '（双击重命名 · 拖入会话归类）';
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'proj-del'; del.textContent = '✕';
    del.title = '删除项目（会话保留，移出分组）';
    del.onclick = async e => {
      e.stopPropagation(); e.preventDefault();
      if (!confirm('删除项目「' + p.name + '」？会话将移出分组。')) return;
      try { await api('/api/projects/' + encodeURIComponent(p.id), { method: 'DELETE' }); await refreshProjectsAndConvs(); }
      catch (err) { toast(err.message); }
    };
    sum.appendChild(del);
    det.addEventListener('dragover', e => { e.preventDefault(); det.classList.add('drag-over'); });
    det.addEventListener('dragleave', () => det.classList.remove('drag-over'));
    det.addEventListener('drop', async e => {
      const cid = draggingConvID || e.dataTransfer.getData('text/chat-id');
      if (!cid) return;
      try { await api('/api/conversations/' + encodeURIComponent(cid) + '/project', { body: { project_id: p.id } }); await refreshProjectsAndConvs(); }
      catch (err) { toast(err.message); }
    });
    det.append(sum);
    for (const c of grouped.get(p.id) || []) {
      const entry = document.createElement('div'); entry.className = 'conv-entry';
      const b = convButton(c);
      entry.appendChild(b);
      det.appendChild(entry);
    }
    list.appendChild(det);
  }
  // 未分组普通会话
  for (const c of loose) convEntry(list, c);
  // 归档切换
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'archive-toggle';
  toggle.textContent = showArchivedConvs ? '返回会话' : `归档 (${archived.size})`;
  toggle.onclick = () => { showArchivedConvs = !showArchivedConvs; renderConvList(); };
  list.appendChild(toggle);
  if (typeof novelRenderList === 'function') novelRenderList(list);
}
  updateAppBadge();


async function refreshProjectsAndConvs() {
  await loadConvs(true);
  await loadProjects();
  renderConvList();
}

async function loadProjects() {
  try {
    const d = await api('/api/projects');
    state.projects = d.projects || [];
  } catch {}
}

function createProjectModal() {
  const { panel, cancel, close } = openPicker('新建项目');
  const field = document.createElement('input');
  field.placeholder = '项目名称';
  field.maxLength = 60;
  const save = document.createElement('button');
  save.textContent = '创建';
  save.onclick = async () => {
    try {
      const d = await api('/api/projects', { body: { name: field.value } });
      close();
      await loadProjects(); renderConvList();
    } catch (e) { toast(e.message); }
  };
  field.onkeydown = e => { if (e.key === 'Enter') save.click(); };
  panel.insertBefore(field, cancel);
  panel.insertBefore(save, cancel);
  field.focus();
}

function appendConversationListItem(list, button, c) {
  const wrap = document.createElement('div'); wrap.className = 'conv-entry';
  const more = document.createElement('button');
  more.type = 'button'; more.className = 'conv-more';
  more.textContent = '⋯';
  more.title = '会话操作';
  more.setAttribute('aria-label', '会话操作');
  more.onclick = e => { e.stopPropagation(); openConvMenu(more, c); };
  wrap.append(button, more); list.appendChild(wrap);
}

// 当前会话被归档/删除后，自动切到下一个会话或回到欢迎页
function resetCurrentIfGone(goneId) {
  if (state.cur !== goneId) return;
  const archived = archivedConvs();
  const next = state.convs.find(cc => !archived.has(cc.id)) || pluginNovels().find(m => !archived.has('novel:' + m.id));
  if (next) {
    if (String(next.id).startsWith('novel:') && typeof novelSelect === 'function') novelSelect(next);
    else selectConv(next.id);
  } else {
    if (state.ws) { state.ws.close(); state.ws = null; }
    state.cur = null; state.curInfo = null; state.target = null;
    $('#messages').replaceChildren(); appendWelcome('ChatNoGPT'); $('#convTitle').textContent = 'ChatNoGPT';
    $('#modelBtn').style.display = 'none'; $('#btnRenameConv').classList.add('hidden');
  }
}

async function archiveConv(c) {
  const wasArchived = archivedConvs().has(c.id);
  try {
    if (c.id.startsWith('novel:')) {
      const value = localArchives();
      if (wasArchived) delete value[c.id]; else value[c.id] = Date.now();
      saveLocalArchives(value);
    } else {
      await api('/api/conversations/' + encodeURIComponent(c.id) + '/archive', { method: wasArchived ? 'DELETE' : 'PUT' });
      await loadConvs(true);
    }
  } catch (e) { toast(e.message); return; }
  if (!wasArchived) resetCurrentIfGone(c.id);
  renderConvList();
}

async function deleteConv(c, mode) {
  const isRoom = c.kind === 1 && !c.id.startsWith('novel:');
  openConfirm({
    title: mode === 'leave' ? '退出群聊' : '删除会话',
    body: isRoom
      ? '退出「' + convDisplayName(c) + '」后，将不再收到该群消息；需要重新被邀请才能进入。'
      : '删除「' + convDisplayName(c) + '」只影响你自己的列表，' + (c.peer_nickname ? '与 ' + c.peer_nickname + ' 的记录仍保留在对方那边。' : '对方仍保留对话。') + '确定删除？',
    okText: mode === 'leave' ? '退出' : '删除',
    danger: true,
    onOk: async () => {
      await api('/api/conversations/' + encodeURIComponent(c.id), { method: 'DELETE' });
      state.convs = state.convs.filter(x => x.id !== c.id);
      resetCurrentIfGone(c.id);
      renderConvList();
      toast(mode === 'leave' ? '已退出群聊' : '会话已删除');
    }
  });
}

function closeConvMenu() { const m = document.getElementById('convCtxMenu'); if (m) m.remove(); }

function openConvMenu(anchor, c) {
  closeConvMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'convCtxMenu';
  const isNovel = c.id.startsWith('novel:');
  const items = [];
  if (!isNovel && c.kind === 1) items.push({ label: '重命名', fn: () => renameConv(c.id, c.title) });
  items.push({ label: archivedConvs().has(c.id) ? '从归档还原' : '归档', fn: () => archiveConv(c) });
  if (!isNovel && c.kind !== 1 && c.project_id) {
    items.push({ label: '移出项目', fn: async () => {
      try {
        await api('/api/conversations/' + encodeURIComponent(c.id) + '/project', { body: { project_id: '' } });
        await refreshProjectsAndConvs();
        toast('已移出项目');
      } catch (e) { toast(e.message); }
    } });
  }
  if (!isNovel) items.push({ label: c.kind === 1 ? '退出群聊' : '删除会话', danger: true, fn: () => deleteConv(c, c.kind === 1 ? 'leave' : 'delete') });
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    if (it.danger) b.classList.add('danger');
    b.textContent = it.label;
    b.onclick = () => { closeConvMenu(); it.fn(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8));
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    menu.style.visibility = 'visible';
  });
  setTimeout(() => {
    document.addEventListener('pointerdown', e => { if (!menu.contains(e.target)) closeConvMenu(); }, { once: true });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeConvMenu(); }, { once: true });
  });
}

function openConfirm({ title, body, okText, danger, onOk }) {
  const root = $('#modalRoot');
  root.innerHTML = '';
  const overlay = document.createElement('div'); overlay.className = 'picker-overlay';
  const panel = document.createElement('div'); panel.className = 'picker-panel confirm-modal';
  const h = document.createElement('h3'); h.textContent = title;
  const p = document.createElement('p'); p.className = 'confirm-body'; p.textContent = body;
  const row = document.createElement('div'); row.className = 'confirm-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'confirm-cancel'; cancel.textContent = '取消';
  const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'confirm-ok' + (danger ? ' danger' : ''); ok.textContent = okText || '确定';
  const close = () => root.replaceChildren();
  cancel.onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  ok.onclick = async () => {
    ok.disabled = true;
    try { await onOk(); close(); }
    catch (e) { toast(e.message); ok.disabled = false; }
  };
  row.append(cancel, ok);
  panel.append(h, p, row);
  overlay.appendChild(panel);
  root.appendChild(overlay);
}

function openPicker(title) {
  const root = $('#modalRoot');
  root.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay';
  const panel = document.createElement('div');
  panel.className = 'picker-panel';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.textContent = '取消';
  const close = () => { root.innerHTML = ''; };
  overlay.onclick = e => { if (e.target === overlay) close(); };
  cancel.onclick = close;
  panel.append(heading, cancel);
  overlay.appendChild(panel);
  root.appendChild(overlay);
  return { panel, cancel, close };
}

async function startNewConversation() {
  closePluginPage();
  const { panel, cancel, close } = openPicker('选择模型，开始新会话');
  try {
    const d = await api('/api/models');
    const models = d.models || [];
    if (!models.length) {
      const p = document.createElement('p');
      p.textContent = '暂无其他模型账号';
      panel.insertBefore(p, cancel);
    }
    for (const model of models) {
      const btn = document.createElement('button');
      btn.textContent = model.name;
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const created = await api('/api/conversations/new', { body: { peer_id: model.id } });
          close();
          await selectConv(created.conversation.id);
          await loadConvs(true);
          closeSidebarMobile();
        } catch (e) { btn.disabled = false; toast(e.message); }
      };
      panel.insertBefore(btn, cancel);
    }
    const roomBtn = document.createElement('button');
    roomBtn.textContent = '＋ 创建群聊室';
    roomBtn.onclick = () => { close(); createRoomModal(); };
    panel.insertBefore(roomBtn, cancel);
    const sep = document.createElement('div');
    sep.className = 'time-divider';
    sep.textContent = '';
    panel.insertBefore(sep, roomBtn);
  } catch (e) { close(); toast(e.message); }
}

function createRoomModal() {
  const root = $('#modalRoot');
  root.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay rmodal-overlay';
  const panel = document.createElement('div');
  panel.className = 'picker-panel rmodal';

  const heading = document.createElement('h2');
  heading.className = 'rmodal-title';
  heading.textContent = '创建群聊室';
  const sub = document.createElement('p');
  sub.className = 'rmodal-sub';
  sub.textContent = '邀请成员一起聊天，或开启插件玩法。';

  // —— 房间名称 ——
  const lblTitle = document.createElement('label');
  lblTitle.className = 'rmodal-label';
  lblTitle.textContent = '房间名称';
  const titleField = document.createElement('input');
  titleField.className = 'rmodal-input';
  titleField.placeholder = '给这个群起个名字';
  titleField.maxLength = 60;

  // —— 邀请成员（搜索 + 标签） ——
  const lblInvite = document.createElement('label');
  lblInvite.className = 'rmodal-label';
  lblInvite.textContent = '邀请成员';
  const searchWrap = document.createElement('div');
  searchWrap.className = 'rmodal-search';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'rmodal-search-icon';
  searchIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const searchField = document.createElement('input');
  searchField.className = 'rmodal-input rmodal-search-input';
  searchField.placeholder = '搜索模型名，回车确认';
  searchField.autocomplete = 'off';
  searchWrap.append(searchIcon, searchField);
  const drop = document.createElement('div');
  drop.className = 'rmodal-drop hidden';
  const chips = document.createElement('div');
  chips.className = 'rmodal-chips';
  const selected = [];
  const renderChips = () => {
    chips.replaceChildren();
    for (const name of selected) {
      const c = document.createElement('span');
      c.className = 'rmodal-chip';
      const t = document.createElement('span');
      t.textContent = name;
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'rmodal-chip-x'; x.textContent = '×';
      x.setAttribute('aria-label', '移除 ' + name);
      x.onclick = () => { selected.splice(selected.indexOf(name), 1); renderChips(); };
      c.append(t, x);
      chips.appendChild(c);
    }
    if (!selected.length) {
      const hint = document.createElement('span');
      hint.className = 'rmodal-chips-hint';
      hint.textContent = '还没邀请成员，可留空稍后邀请';
      chips.appendChild(hint);
    }
  };
  renderChips();
  let searchTimer = null;
  const renderDrop = users => {
    drop.replaceChildren();
    if (!users.length) { drop.classList.add('hidden'); return; }
    for (const u of users) {
      if (selected.includes(u.nickname)) continue;
      const item = document.createElement('button');
      item.type = 'button'; item.className = 'rmodal-drop-item';
      const av = document.createElement('span');
      av.className = 'rmodal-drop-av';
      av.textContent = (u.nickname[0] || '?').toUpperCase();
      const nm = document.createElement('span');
      nm.textContent = u.nickname;
      item.append(av, nm);
      item.onclick = () => {
        selected.push(u.nickname);
        renderChips();
        searchField.value = '';
        drop.classList.add('hidden');
      };
      drop.appendChild(item);
    }
    drop.classList.remove('hidden');
  };
  searchField.oninput = () => {
    clearTimeout(searchTimer);
    const q = searchField.value.trim();
    if (!q) { drop.classList.add('hidden'); return; }
    searchTimer = setTimeout(async () => {
      try {
        const d = await api('/api/users?q=' + encodeURIComponent(q));
        renderDrop(d.users || []);
      } catch (e) { drop.classList.add('hidden'); }
    }, 160);
  };
  searchField.onkeydown = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = searchField.value.trim();
      if (q && !selected.includes(q)) { selected.push(q); renderChips(); searchField.value = ''; }
      drop.classList.add('hidden');
    } else if (e.key === 'Escape') {
      drop.classList.add('hidden');
    }
  };

  // —— 对话模式（分段选择器） ——
  const lblMode = document.createElement('label');
  lblMode.className = 'rmodal-label';
  lblMode.textContent = '对话模式';
  const extraModes = Array.isArray(window.cngpRoomModes) ? window.cngpRoomModes.filter(m => m && m.id && m.label) : [];
  let roomMode = '';
  const modeRow = document.createElement('div');
  modeRow.className = 'rmodal-seg';
  const mkMode = (id, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rmodal-seg-btn' + (roomMode === id ? ' active' : '');
    b.textContent = label;
    b.onclick = () => {
      roomMode = id;
      [...modeRow.querySelectorAll('.rmodal-seg-btn')].forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    };
    return b;
  };
  modeRow.append(mkMode('', '普通对话'));
  for (const m of extraModes) modeRow.append(mkMode(m.id, m.label));

  // —— 状态 / 按钮 ——
  const status = document.createElement('p');
  status.className = 'rmodal-status';
  const actions = document.createElement('div');
  actions.className = 'rmodal-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'rmodal-primary';
  save.textContent = '创建房间';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'rmodal-cancel';
  cancel.textContent = '取消';
  const close = () => { root.innerHTML = ''; };
  cancel.onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  panel.onkeydown = e => { if (e.key === 'Escape') close(); };
  save.onclick = async () => {
    const invite = selected.slice();
    save.disabled = true;
    status.textContent = '';
    try {
      const d = await api('/api/rooms', { body: { title: titleField.value, invite } });
      close();
      if (d.missing?.length) toast('未找到成员：' + d.missing.join('、'));
      await loadConvs(true);
      await selectConv(d.conversation.id);
      closeSidebarMobile();
      if (roomMode) window.dispatchEvent(new CustomEvent('cngp:room-created', { detail: { conv: d.conversation, mode: roomMode } }));
    } catch (e) {
      save.disabled = false;
      status.textContent = e.message;
    }
  };

  panel.append(heading, sub, lblTitle, titleField, lblInvite, searchWrap, drop, chips, lblMode, modeRow, status, actions);
  actions.append(save, cancel);
  overlay.appendChild(panel);
  root.appendChild(overlay);
  titleField.focus();
}

function renameConv(id, title) {
  const { panel, cancel, close } = openPicker('修改会话标题');
  const field = document.createElement('input');
  field.value = title;
  field.maxLength = 60;
  const save = document.createElement('button');
  save.textContent = '保存标题';
  save.onclick = async () => {
    const next = field.value.trim();
    if (!next) return;
    try {
      const result = await api('/api/conversations/' + encodeURIComponent(id), {
        method: 'PATCH', body: { title: next },
      });
      close();
      if (state.cur === id) $('#convTitle').textContent = result.conversation.title;
      await loadConvs(true);
    } catch (e) { toast(e.message); }
  };
  field.onkeydown = e => { if (e.key === 'Enter') save.click(); };
  panel.insertBefore(field, cancel);
  panel.insertBefore(save, cancel);
  field.focus();
  field.select();
}

/* ---------- 聊天切换与消息渲染 ---------- */

async function selectConv(id) {
  closePluginPage();
  state.cur = id;
  state.gen++;
  const gen = state.gen;
  state.readIDs = loadReadIDs(id);
  state.queue = [];
  state.animating = false;
  state.pending.clear();
  state.seenMsg = new Set();
  state.lastTS = 0;
  state.lastRenderTS = 0;
  state.thinkingRow = null;
  hideTyping();
  renderConvList();
  try {
    const d = await api('/api/conversations/' + id);
    if (state.cur !== id || state.gen !== gen) return;
    state.curInfo = d.conversation;
    $('#convTitle').textContent = d.conversation.title +
      (d.conversation.kind === 1 ? ' · ' + d.conversation.member_count + ' 人' : '');
    $('#btnRenameConv').classList.remove('hidden');
    // 打开某个聊天 = 选中了对方那个“模型”
    if (d.conversation.peer_id) {
      setTarget({ id: d.conversation.peer_id, name: d.conversation.peer_nickname });
    } else if (d.conversation.kind === 1) {
      // 群聊室：composer 显示全部成员模型名，超长省略号，点击查看完整列表
      state.target = null;
      const names = (d.conversation.members || [])
        .map(m => m.nickname)
        .filter(n => n && n !== state.me.nickname);
      const label = names.length > 2 ? names.slice(0, 2).join(', ') + '…' : names.join(', ');
      $('#modelLabel').textContent = label || '群聊';
      $('#modelBtn').style.display = 'flex';
      $('#modelBtn').title = '成员：' + (names.join('、') || '群聊');
      $('#modelBtn').onclick = e => {
        e.stopPropagation();
        const { panel, cancel, close } = openPicker('群聊成员 · ' + d.conversation.member_count + ' 人');
        const self = document.createElement('button');
        self.type = 'button'; self.className = 'model-item';
        const meName = document.createElement('div'); meName.className = 'm-name'; meName.textContent = state.me.nickname + '（我）';
        self.append(meName); panel.insertBefore(self, cancel);
        for (const m of d.conversation.members || []) {
          if (m.id === state.me.id) continue;
          const item = document.createElement('button');
          item.type = 'button'; item.className = 'model-item';
          const nm = document.createElement('div'); nm.className = 'm-name'; nm.textContent = m.nickname;
          item.append(nm); panel.insertBefore(item, cancel);
        }
        void close;
      };
    } else {
      // 兼容旧的多人聊天：隐藏选择器
      state.target = null;
      $('#modelBtn').style.display = 'none';
    }
    if (state.coverMode) await ensureCoverPool();
    if (state.cur !== id || state.gen !== gen) return;
    const md = await api(`/api/conversations/${id}/messages`);
    if (state.cur !== id || state.gen !== gen) return;
    const box = $('#messages');
    box.innerHTML = '';
    const msgs = md.messages || [];
    if (!msgs.length) appendWelcome(d.conversation.title);
    for (const m of msgs) {
      state.seenMsg.add(m.id);
      if (m.ts > state.lastTS) state.lastTS = m.ts;
      if (m.sender_id === state.me.id) appendOwn(m.content, m.ts, m.id, m.image_id, '', m);
      else appendAIStatic(m.nickname, m.content, m.ts, m.id, m.image_id, m);
      rememberRead(m.id);
    }
    state.firstMsg = msgs.length ? { ts: msgs[0].ts, id: msgs[0].id } : null;
    state.historyDone = msgs.length < 200;
    state.historyLoading = false;
    markConversationRead(id);
    scrollBottom(true);
    connectWS(id);
    $('#input').focus();
    window.dispatchEvent(new CustomEvent('cngp:conv-opened', { detail: { id, conv: state.curInfo } }));
  } catch (e) { toast(e.message); }
}



// 消息索引：id → {nickname, content}，供引用回复摘要与跳转
function rememberMsgIndex(id, nickname, content) {
  if (!id) return;
  state.msgIndex = state.msgIndex || {};
  state.msgIndex[id] = { nickname, content: (content || '').slice(0, 80) };
}
// 引用关联：伪装安全呈现——不插入任何常驻 DOM，仅写入悬停提示；
// 悬停消息时经操作区的 ↩ 图标跳转原消息（与操作按钮同级的悬停显隐规则）
function appendQuoteBlock(row, m) {
  if (!m || !m.reply_to) return;
  const src = (state.msgIndex || {})[m.reply_to];
  const who = src ? src.nickname : '';
  const snip = src ? src.content.replace(/\s+/g, ' ').slice(0, 60) : '原消息';
  row.dataset.replyTo = m.reply_to;
  const hint = '↩ 回应 ' + (who || '原消息') + '：' + snip;
  row.title = row.title ? row.title + '\n' + hint : hint;
}
function scrollToMsg(mid) {
  const row = document.querySelector('#messages [data-mid="' + mid + '"]');
  if (!row) { toast('原消息不在已加载范围内'); return; }
  row.scrollIntoView({ block: 'center' });
  row.classList.add('search-flash');
  setTimeout(() => row.classList.remove('search-flash'), 1600);
}
// 表情回应：聚合渲染（msgId → {emoji: [nickname...]}) 与单行刷新
function reactionsKeyed(msg) {
  const map = {};
  for (const r of msg.reactions || []) {
    (map[r.emoji] = map[r.emoji] || []).push(r.nickname);
  }
  return map;
}
function renderReactions(row, msgId) {
  const map = (state.reactions || {})[msgId];
  let box = row.querySelector('.msg-reactions');
  if (!map || !Object.keys(map).length) { if (box) box.remove(); return; }
  if (!box) {
    box = document.createElement('div');
    box.className = 'msg-reactions';
    const actions = row.querySelector('.msg-actions, .own-actions');
    if (actions) row.insertBefore(box, actions); else row.appendChild(box);
  }
  box.replaceChildren();
  const me = CNGP.context().me;
  for (const [emoji, names] of Object.entries(map)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'react-chip' + (me && names.includes(me.nickname) ? ' mine' : '');
    chip.textContent = emoji + ' ' + names.length;
    chip.title = names.join('、');
    chip.onclick = () => CNGP.react(msgId, emoji);
    box.appendChild(chip);
  }
}
function openReactPicker(anchor, msgId) {
  document.getElementById('reactPicker')?.remove();
  const pop = document.createElement('div');
  pop.id = 'reactPicker';
  pop.className = 'ctx-menu react-picker';
  for (const emoji of ['👍', '👎', '❤️', '😄', '😮', '😢']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.onclick = () => { pop.remove(); CNGP.react(msgId, emoji); };
    pop.appendChild(b);
  }
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    pop.style.top = Math.max(8, r.top - pop.offsetHeight - 6) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.visibility = 'visible';
  });
  setTimeout(() => {
    document.addEventListener('pointerdown', e => { if (!pop.contains(e.target)) pop.remove(); }, { once: true });
  });
}

function appendWelcome(title) {
  const w = document.createElement('div');
  w.id = 'welcome';
  w.className = 'welcome';
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = '有什么可以帮忙的吗？';
  w.append(h, p);
  $('#messages').appendChild(w);
}

function removeWelcome() {
  const w = $('#welcome');
  if (w) w.remove();
}

async function loadImageURL(id, token) {
  const cached = state.imageURLs.get(id);
  if (cached) return cached;
  const res = await fetch('/api/images/' + encodeURIComponent(id), {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('无法读取图片');
  const blob = await res.blob();
  if (state.token !== token) throw new Error('无法读取图片'); // 登出后不把旧账号图片放回缓存
  const url = URL.createObjectURL(blob);
  state.imageURLs.set(id, url);
  return url;
}

function alignImageMatte(img) {
  const row = img.closest('.msg-ai.msg-real.has-image');
  const layer = row?.querySelector('.cover-layer');
  const matte = layer?.querySelector('.cover-image-matte');
  if (!matte || !img.naturalWidth) return;
  const image = img.getBoundingClientRect();
  const origin = row.getBoundingClientRect();
  const top = image.top - origin.top;
  matte.style.top = top + 'px';
  matte.style.left = (image.left - origin.left) + 'px';
  matte.style.width = image.width + 'px';
  matte.style.height = image.height + 'px';
  layer.style.minHeight = (top + image.height) + 'px';
  const text = layer.querySelector('.cover-body');
  text.style.maxHeight = Math.max(0, top - text.offsetTop - 8) + 'px';
}

window.addEventListener('resize', () => {
  document.querySelectorAll('#messages .msg-ai.has-image .chat-image').forEach(alignImageMatte);
});

async function appendImage(parent, id) {
  const img = document.createElement('img');
  img.className = 'chat-image';
  img.alt = '聊天图片';
  img.decoding = 'async';
  img.addEventListener('load', () => requestAnimationFrame(() => alignImageMatte(img)));
  parent.appendChild(img);
  const token = state.token;
  try {
    img.src = await loadImageURL(id, token);
  } catch { img.alt = '图片加载失败'; return; }
  const peerCovered = () => state.coverMode && !!img.closest('.msg-ai');
  img.onclick = () => {
    // 密文模式的对方图片只能通过原位圆孔查看，不能弹出无遮罩原图。
    if (!peerCovered()) openImageLightbox(img.src);
  };
  img.oncontextmenu = e => { if (peerCovered()) e.preventDefault(); };
  img.ondragstart = e => { if (peerCovered()) e.preventDefault(); };
  // 偶发裂图兑底：缓存的 blob URL 失效时，丢弃缓存重新拉取一次。
  img.onerror = () => {
    if (img.dataset.retried) return;
    img.dataset.retried = '1';
    state.imageURLs.delete(id);
    loadImageURL(id, token).then(url => { img.src = url; }).catch(() => { img.alt = '图片加载失败'; });
  };
}

function openImageLightbox(src) {
  if (!src) return;
  document.querySelector('.image-lightbox')?.remove();
  const overlay = document.createElement('div'); overlay.className = 'image-lightbox';
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '图片预览');
  const image = document.createElement('img'); image.src = src; image.alt = '聊天图片预览';
  const close = document.createElement('button'); close.type = 'button';
  close.className = 'image-lightbox-close'; close.setAttribute('aria-label', '关闭预览'); close.textContent = '×';
  const dismiss = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = event => { if (event.key === 'Escape') dismiss(); };
  close.onclick = dismiss;
  overlay.onclick = event => { if (event.target === overlay) dismiss(); };
  overlay.append(image, close); document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey); close.focus();
}

function appendOwn(content, ts, msgId, imageID, localID = '', m = null) {
  m = m || { id: msgId, reply_to: '', reactions: null };
  removeWelcome();
  const wrap = document.createElement('div');
  wrap.className = 'msg-own';
  if (msgId) wrap.dataset.mid = msgId;
  if (msgId) wrap.dataset.msgId = msgId;
  if (localID) wrap.dataset.localId = localID;
  rememberMsgIndex(msgId, state.me ? state.me.nickname : '', content);
  const realWrap = document.createElement('div');
  realWrap.className = 'real-wrap';
  const b = document.createElement('div');
  b.className = 'bubble';
  if (content) {
    const original = document.createElement('span');
    original.className = 'own-original';
    original.textContent = content;
    const covered = document.createElement('span');
    covered.className = 'own-cover';
    covered.textContent = ownCoverText(content);
    b.append(original, covered);
  }
  if (imageID) {
    wrap.classList.add('has-image');
    appendImage(b, imageID);
    const marker = document.createElement('span');
    marker.className = 'image-placeholder';
    marker.textContent = '[image]';
    b.appendChild(marker);
  }
  if (ts) {
    ensureDivider(ts);
    b.title = fullStamp(ts);
  }
  realWrap.appendChild(b);
  appendQuoteBlock(wrap, m);
  wrap.appendChild(realWrap);
  if (m.reactions) { (state.reactions = state.reactions || {})[m.id] = reactionsKeyed(m); renderReactions(wrap, m.id); }
  const actions = document.createElement('div');
  actions.className = 'own-actions';
  const copy = makeMessageAction('复制', messageCopyIcon);
  copy.onclick = async () => { try { await navigator.clipboard.writeText(wrap.querySelector('.own-original')?.textContent || ''); toast('已复制'); } catch { toast('复制失败'); } };
  const recall = makeMessageAction('撤回', '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><path d="M9 9 5 13l4 4M5 13h9a5 5 0 1 0 0-10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>');
  recall.onclick = () => changeOwnMessage(wrap, true);
  const edit = makeMessageAction('编辑', '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><path d="m4 20 4.5-1 11-11a2 2 0 0 0-3-3l-11 11L4 20ZM14 7l3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>');
  edit.onclick = () => editOwnMessage(wrap);
  actions.append(copy, recall, edit);
  wrap.appendChild(actions);
  if (state.coverMode && (content || imageID)) wrap.classList.add('covered');
  $('#messages').appendChild(wrap);
  bindOwnReveal(wrap);
  if (content === '消息已撤回' && !imageID) wrap.classList.add('recalled');
  return wrap;
}

function renderOwnChange(wrap, message) {
  const bubble = wrap.querySelector('.bubble');
  bubble.replaceChildren();
  const original = document.createElement('span'); original.className = 'own-original'; original.textContent = message.content;
  const covered = document.createElement('span'); covered.className = 'own-cover'; covered.textContent = ownCoverText(message.content);
  bubble.append(original, covered);
  if (message.image_id) {
    appendImage(bubble, message.image_id); wrap.classList.add('has-image');
    const marker = document.createElement('span'); marker.className = 'image-placeholder'; marker.textContent = '[image]'; bubble.appendChild(marker);
  }
  else wrap.classList.remove('has-image');
  const recalled = message.content === '消息已撤回' && !message.image_id;
  wrap.classList.toggle('recalled', recalled);
  if (recalled) wrap.classList.remove('covered');
}

async function changeOwnMessage(wrap, recall, content = '') {
  if (wrap.classList.contains('recalled')) return;
  if (!wrap.dataset.msgId && !wrap.dataset.localId) { toast('消息正在发送，请稍后再试'); return; }
  if (recall && !window.confirm('撤回这条消息并放回输入框？')) return;
  const originalText = wrap.querySelector('.own-original')?.textContent || '';
  try {
    let message;
    if (wrap.dataset.localId && typeof novelUpdateOwnEntry === 'function') message = novelUpdateOwnEntry(wrap.dataset.localId, recall, content);
    else {
      const id = wrap.dataset.msgId;
      const d = await api(`/api/conversations/${state.cur}/messages/${id}`, recall ? { method: 'DELETE' } : { method: 'PATCH', body: { content } });
      message = d.message;
    }
    renderOwnChange(wrap, message);
    if (recall && originalText) {
      input.value = input.value.trim() ? originalText + '\n' + input.value : originalText;
      autoGrow(); updateSendButton(); input.focus();
    }
    return true;
  } catch (e) { toast(e.message); return false; }
}

function editOwnMessage(wrap) {
  if (wrap.classList.contains('recalled')) return;
  if (!wrap.dataset.msgId && !wrap.dataset.localId) { toast('消息正在发送，请稍后再试'); return; }
  document.querySelectorAll('.msg-own.editing').forEach(row => row.querySelector('.own-edit-cancel')?.click());
  wrap.classList.add('editing');
  const bubble = wrap.querySelector('.bubble');
  const editor = document.createElement('div'); editor.className = 'own-edit-box';
  const field = document.createElement('textarea'); field.className = 'own-edit-field';
  field.value = wrap.querySelector('.own-original')?.textContent || '';
  field.maxLength = 6000;
  const bar = document.createElement('div'); bar.className = 'own-edit-bar';
  const hint = document.createElement('span'); hint.textContent = '编辑后将更新这条消息';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'own-edit-cancel'; cancel.textContent = '取消';
  const save = document.createElement('button'); save.type = 'button'; save.textContent = '保存';
  const close = () => { editor.remove(); wrap.classList.remove('editing'); };
  cancel.onclick = close;
  save.onclick = async () => {
    const value = field.value.trim();
    if (!value) { toast('消息内容不能为空'); return; }
    save.disabled = true;
    if (await changeOwnMessage(wrap, false, value)) close();
    else save.disabled = false;
  };
  field.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); save.click(); }
  };
  bar.append(hint, cancel, save);
  editor.append(field, bar);
  bubble.after(editor);
  field.focus();
}

function appendAIRow(nickname) {
  removeWelcome();
  const row = document.createElement('div');
  row.className = 'msg-ai';
  const realWrap = document.createElement('div');
  realWrap.className = 'real-wrap';
  const label = document.createElement('div');
  label.className = 'ai-label';
  label.textContent = nickname;
  realWrap.appendChild(label);
  row.appendChild(realWrap);
  $('#messages').appendChild(row);
  return { row, label, realWrap };
}

const messageCopyIcon = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.8"/></svg>';
const messageRefreshIcon = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 9A7 7 0 0 1 18 7l2 2M4 15l2 2a7 7 0 0 0 12.5-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const messageThumbIcon = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><path d="M7 10v10H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h3Zm0 0 4-7a2 2 0 0 1 2-1c1.1 0 2 .9 2 2v5h4a3 3 0 0 1 2.9 3.8l-1.7 6A3 3 0 0 1 17.3 21H7" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

function makeMessageAction(label, icon) {
  const button = document.createElement('button');
  button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  return button;
}

function addMessageVotes(actions) {
  const up = makeMessageAction('点赞', messageThumbIcon);
  const down = makeMessageAction('点踩', messageThumbIcon);
  down.classList.add('thumb-down');
  for (const button of [up, down]) {
    button.setAttribute('aria-pressed', 'false');
    button.onclick = () => {
      const selected = button.getAttribute('aria-pressed') === 'true';
      up.setAttribute('aria-pressed', 'false'); down.setAttribute('aria-pressed', 'false');
      if (!selected) button.setAttribute('aria-pressed', 'true');
    };
  }
  actions.append(up, down);
}

const replyIcon = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><path d="M9 14 4 9l5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const reactIcon = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 14s1.2 1.8 3.5 1.8S15.5 14 15.5 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M9 9.5v1M15 9.5v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function addAIActions(row, content) {
  const actions = document.createElement('div'); actions.className = 'msg-actions';
  const copy = makeMessageAction('复制', messageCopyIcon);
  // 插件可通过监听 cngp:message-actions 向 actions 追加按钮（契约见 plugins/README.md）
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(content); toast('已复制'); }
    catch { toast('复制失败'); }
  };
  const refresh = makeMessageAction('刷新', messageRefreshIcon);
  refresh.onclick = () => {};
  actions.append(copy, refresh);
  addMessageVotes(actions);
  // 平台能力：引用回复 + 表情回应（iMessage tapback 式反馈）
  const reply = makeMessageAction('回复', replyIcon);
  reply.onclick = () => setReplyTo(row.dataset.mid, row.dataset.nickname, content);
  const react = makeMessageAction('表情回应', reactIcon);
  react.onclick = e => { e.stopPropagation(); openReactPicker(react, row.dataset.mid); };
  actions.append(reply, react);
  row.appendChild(actions);
  window.dispatchEvent(new CustomEvent('cngp:message-actions', { detail: { row, actions, content } }));
}

function appendAIStatic(nickname, content, ts, msgId, imageID, m = null) {
  m = m || { id: msgId, reply_to: '', reactions: null };
  if (ts) ensureDivider(ts);
  const r = appendAIRow(nickname);
  if (msgId) r.row.dataset.mid = msgId;
  const body = document.createElement('div');
  body.className = 'ai-body';
  body.textContent = content;
  if (imageID) appendImage(body, imageID);
  if (ts) body.title = fullStamp(ts);
  r.realWrap.appendChild(body);
  r.row.classList.add('msg-real');
  r.row.dataset.msgKey = msgKeyOf(msgId, nickname, content);
  r.row.dataset.nickname = nickname;
  if (imageID) r.row.classList.add('has-image');
  r.row.appendChild(makeCoverLayer(!!imageID));
  coverTextInto(r.row);
  if (state.coverMode) {
    r.row.classList.add('covered');
    bindFlashlight(r.row);
  }
  rememberMsgIndex(msgId, nickname, content);
  appendQuoteBlock(r.row, m);
  if (m.reactions) { (state.reactions = state.reactions || {})[m.id] = reactionsKeyed(m); renderReactions(r.row, m.id); }
  addAIActions(r.row, content);
}

let draggingConvID = '';

// pluginNovels 读取阅读插件模型列表（插件未加载时返回空数组）。
function pluginNovels() {
  return typeof novelModels === 'undefined' ? [] : (novelModels || []);
}

// ===== 插件管理页：侧栏「插件」入口，右侧整页设置 =====
// PWA：Service Worker 注册 + 桌面安装流程（beforeinstallprompt 捕获后供个人设置使用）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

// 插件目录缓存（Meta 来自服务端注册表；契约见 plugins/README.md）
async function loadPluginCatalog() {
  try {
    const d = await api('/api/plugins');
    return d.plugins || [];
  } catch (e) { return state.pluginCatalog || []; }
}
function openPluginPage() {
  closeSidebarMobile();
  document.querySelector('.chat-head').classList.add('hidden');
  $('#msgScroll').classList.add('hidden');
  document.querySelector('.composer-wrap').classList.add('hidden');
  $('#pluginPage').classList.remove('hidden');
  renderPluginPage();
}
function closePluginPage() {
  if ($('#pluginPage').classList.contains('hidden')) return;
  $('#pluginPage').classList.add('hidden');
  document.querySelector('.chat-head').classList.remove('hidden');
  $('#msgScroll').classList.remove('hidden');
  document.querySelector('.composer-wrap').classList.remove('hidden');
}
async function renderPluginPage() {
  const list = $('#ppList');
  list.replaceChildren();
  const loading = document.createElement('p'); loading.className = 'pp-note'; loading.textContent = '加载中…';
  list.appendChild(loading);
  let plugins = state.pluginCatalog || [];
  try { plugins = (await loadPluginCatalog()); }
  catch (e) {
    list.replaceChildren();
    const p = document.createElement('p'); p.className = 'pp-note'; p.textContent = '插件列表加载失败：' + e.message;
    list.appendChild(p);
    return;
  }
  list.replaceChildren();
  if (!plugins.length) {
    const p = document.createElement('p'); p.className = 'pp-note'; p.textContent = '暂无可用插件';
    list.appendChild(p);
    return;
  }
  for (const p of plugins) list.appendChild(buildPluginCard(p));
}
function buildPluginCard(p) {
  let stepNo = 0;
  const card = document.createElement('div'); card.className = 'pp-card';
  const head = document.createElement('div'); head.className = 'pp-card-head';
  const icon = document.createElement('div'); icon.className = 'pp-icon'; icon.textContent = p.icon || '🧩';
  const title = document.createElement('div'); title.className = 'pp-title'; title.textContent = p.title;
  const badge = document.createElement('span'); badge.className = 'pp-badge ' + (p.enabled ? 'on' : 'off'); badge.textContent = p.enabled ? '已启用' : '未启用';
  head.append(icon, title, badge);
  const desc = document.createElement('p'); desc.className = 'pp-desc'; desc.textContent = p.desc || '';
  const actions = document.createElement('div'); actions.className = 'pp-actions';
  const btnToggle = document.createElement('button'); btnToggle.type = 'button'; btnToggle.className = 'pp-btn ' + (p.enabled ? '' : 'primary'); btnToggle.textContent = p.enabled ? '停用' : '启用';
  btnToggle.onclick = async () => {
    const action = p.enabled ? 'disable' : 'enable';
    btnToggle.disabled = true;
    try {
      await api('/api/plugins', { body: { action, name: p.name } });
      p.enabled = !p.enabled;
      if (p.enabled) {
        state.enabledPlugins = [...new Set([...(state.enabledPlugins || []), p.name])];
        if (p.script) ensurePluginScript(p.name, p.script);
        toast(p.title + ' 已启用');
      } else {
        state.enabledPlugins = (state.enabledPlugins || []).filter(x => x !== p.name);
        toast(p.title + ' 已停用，刷新页面后完全生效');
      }
      card.replaceWith(buildPluginCard(p));
    } catch (e) { toast(e.message); btnToggle.disabled = false; }
  };
  actions.appendChild(btnToggle);
  let details = null;
  if (p.detail && p.detail.length) {
    const btnDetail = document.createElement('button'); btnDetail.type = 'button'; btnDetail.className = 'pp-btn ghost'; btnDetail.textContent = '查看详情';
    details = document.createElement('div'); details.className = 'pp-details';
    btnDetail.onclick = () => {
      details.classList.toggle('open');
      btnDetail.textContent = details.classList.contains('open') ? '收起详情' : '查看详情';
    };
    actions.appendChild(btnDetail);
    for (const item of p.detail) {
      if (item.type === 'step') {
        details.appendChild((() => {
          const row = document.createElement('div'); row.className = 'pp-step';
          const n = document.createElement('span'); n.className = 'pp-step-num'; n.textContent = String(++stepNo);
          const txt = document.createElement('span'); txt.textContent = item.text;
          row.append(n, txt); return row;
        })());
      } else {
        const note = document.createElement('p'); note.className = item.type === 'note' ? 'pp-note' : 'pp-desc'; note.textContent = item.text;
        details.appendChild(note);
      }
    }
    if (p.download) {
      const dl = document.createElement('a'); dl.className = 'pp-dl'; dl.href = p.download; dl.download = '';
      dl.textContent = '⬇ 下载扩展 / 资源';
      details.appendChild(dl);
    }
  }
  card.append(head, desc, actions, details || '');
  return card;
}

// 插件脚本动态加载：按 /api/me 返回的启用插件注入
let loadedPluginScripts = {};
function ensurePluginScript(name, src) {
  if ((state.enabledPlugins || []).indexOf(name) === -1) return Promise.resolve();
  if (loadedPluginScripts[name]) return Promise.resolve();
  loadedPluginScripts[name] = new Promise(resolve => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = resolve;
    document.head.appendChild(s);
  });
  return loadedPluginScripts[name];
}

// 历史消息懒加载：滚动到顶部时按游标拉更早的 100 条，前插并保持滚动位置
async function loadOlder() {
  if (state.historyLoading || state.historyDone || !state.firstMsg) return;
  if (!state.cur || state.cur.startsWith('novel:')) return;
  state.historyLoading = true;
  const sc = $('#msgScroll');
  const before = sc.scrollHeight;
  try {
    const d = await api(`/api/conversations/${state.cur}/messages?before_ts=${state.firstMsg.ts}&before_id=${encodeURIComponent(state.firstMsg.id)}&limit=100`);
    const older = d.messages || [];
    if (!older.length) { state.historyDone = true; return; }
    prependOlder(older);
    state.firstMsg = { ts: older[0].ts, id: older[0].id };
    if (older.length < 100) state.historyDone = true;
    sc.scrollTop += sc.scrollHeight - before;
  } catch (e) { toast(e.message); } finally { state.historyLoading = false; }
}

// 把更早的消息按升序前插（复用现有渲染函数，渲染后搬进文档碎片）
function prependOlder(older) {
  const box = $('#messages');
  const first = box.firstChild;
  const frag = document.createDocumentFragment();
  let lastTS = -Infinity;
  for (const m of older) {
    if (lastTS !== -Infinity && m.ts - lastTS > 300) {
      const div = document.createElement('div');
      div.className = 'time-divider';
      div.textContent = fmtDividerLabel(m.ts);
      div.title = fullStamp(m.ts);
      frag.appendChild(div);
    }
    lastTS = m.ts;
    if (m.sender_id === state.me.id) appendOwn(m.content, m.ts, m.id, m.image_id, '', m);
    else appendAIStatic(m.nickname, m.content, m.ts, m.id, m.image_id, m);
    rememberRead(m.id);
    while (box.lastChild !== first && box.lastChild) frag.appendChild(box.lastChild);
  }
  if (first && first.classList && first.classList.contains('time-divider') === false && lastTS !== -Infinity) {
    const firstTS = state.firstMsg ? state.firstMsg.ts : 0;
    if (firstTS - lastTS > 300) {
      const div = document.createElement('div');
      div.className = 'time-divider';
      div.textContent = fmtDividerLabel(firstTS);
      div.title = fullStamp(firstTS);
      frag.appendChild(div);
    }
  }
  box.insertBefore(frag, first);
}

function scrollBottom(force) {
  const sc = $('#msgScroll');
  if (force || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140) {
    sc.scrollTop = sc.scrollHeight;
  }
}
const scrollFollow = () => scrollBottom(false);

/* ---------- WebSocket ---------- */

function connectWS(id) {
  if (state.ws) {
    const old = state.ws;
    old.onclose = null;
    try { old.close(); } catch {}
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${proto}://${location.host}/ws?conv=${encodeURIComponent(id)}&token=${encodeURIComponent(state.token)}`
  );
  state.ws = ws;
  state.wsConv = id;
  ws.onopen = () => {
    if (state.cur !== id || state.ws !== ws) { ws.close(); return; }
    syncMissed(id);
    flushPending(id);
  };
  ws.onmessage = e => {
    if (state.cur !== id || state.ws !== ws) return;
    try { handleEvent(JSON.parse(e.data)); } catch {}
  };
  ws.onclose = () => {
    if (state.cur === id && state.ws === ws) {
      setTimeout(async () => {
        if (state.cur !== id || !state.token) return;
        try {
          // 先验证登录态：token 已失效时 api() 会本地登出，避免用死 token 无限重连
          await api('/api/me');
        } catch (e) {
          if (!state.token) return;
        }
        connectWS(id);
      }, 2500);
    }
  };
}

// 断线重连后，把断开期间错过的消息补拉回来
async function syncMissed(id) {
  try {
    const d = await api(`/api/conversations/${id}/messages?after_ts=${state.lastTS}`);
    if (state.cur !== id) return;
    for (const m of d.messages || []) {
      if (state.seenMsg.has(m.id)) continue;
      if (m.client_msg_id && state.pending.has(m.client_msg_id)) {
        state.pending.delete(m.client_msg_id);
        const ownRow = [...document.querySelectorAll('#messages .msg-own')].find(row => row.dataset.clientMsgId === m.client_msg_id);
        if (ownRow) ownRow.dataset.msgId = m.id;
        state.seenMsg.add(m.id);
        if (m.ts > state.lastTS) state.lastTS = m.ts;
        rememberRead(m.id);
        continue;
      }
      state.seenMsg.add(m.id);
      if (m.ts > state.lastTS) state.lastTS = m.ts;
      if (m.sender_id === state.me.id) {
        appendOwn(m.content, m.ts, m.id, m.image_id, '', m);
        rememberRead(m.id);
      } else if (state.coverMode && state.readIDs.has(m.id)) {
        appendAIStatic(m.nickname, m.content, m.ts, m.id, m.image_id, m);
      } else {
        enqueueAI(m.nickname, m.content, null, m.ts, msgKeyOf(m.id, m.nickname, m.content), true, m.image_id);
      }
      scrollFollow();
      if (m.sender_id !== state.me.id && document.hidden) {
        const c = state.convs.find(c => c.id === id);
        if (c) { c.unread_count = (c.unread_count || 0) + 1; renderConvList(); }
        notifyMessage(state.cur, m.nickname, state.coverMode ? '收到新回复，点击查看' : m.content, true);
      }
    }
  } catch {}
}

function flushPending(id = state.cur) {
  if (state.pendingSend && state.pendingSend.convID === id && state.cur === id &&
      state.wsConv === id && state.ws && state.ws.readyState === 1) {
    const { payload } = state.pendingSend;
    state.pendingSend = null;
    doSend(payload);
  }
}

function handleEvent(ev) {
  if (ev.conv_id && ev.conv_id !== state.cur) return;
  if (ev.type === 'message_update' && ev.message) {
    const row = [...document.querySelectorAll('#messages .msg-own')].find(item => item.dataset.msgId === ev.message.id);
    if (row) renderOwnChange(row, ev.message);
    const peerRow = [...document.querySelectorAll('#messages .msg-ai')].find(item => item.dataset.msgKey === ev.message.id);
    if (peerRow) {
      const body = peerRow.querySelector('.ai-body');
      if (body) {
        body.textContent = ev.message.content;
        if (ev.message.image_id) appendImage(body, ev.message.image_id);
        peerRow.classList.toggle('has-image', !!ev.message.image_id);
        peerRow.querySelector('.msg-actions')?.remove();
        addAIActions(peerRow, ev.message.content);
        coverTextInto(peerRow);
      }
    }
    return;
  }
  if (ev.type === 'reaction') {
    state.reactions = state.reactions || {};
    const map = (state.reactions[ev.msg_id] = state.reactions[ev.msg_id] || {});
    const list = map[ev.emoji] || [];
    const i = list.indexOf(ev.nickname);
    if (ev.added) { if (i === -1) list.push(ev.nickname); }
    else if (i !== -1) list.splice(i, 1);
    if (!list.length) delete map[ev.emoji];
    const row = document.querySelector('#messages [data-mid="' + ev.msg_id + '"]');
    if (row) renderReactions(row, ev.msg_id);
  }
  if (ev.type === 'reaction') {
    state.reactions = state.reactions || {};
    const map = (state.reactions[ev.msg_id] = state.reactions[ev.msg_id] || {});
    const list = map[ev.emoji] || [];
    const i = list.indexOf(ev.nickname);
    if (ev.added) { if (i === -1) list.push(ev.nickname); }
    else if (i !== -1) list.splice(i, 1);
    if (!list.length) delete map[ev.emoji];
    const row = document.querySelector('#messages [data-mid="' + ev.msg_id + '"]');
    if (row) renderReactions(row, ev.msg_id);
  }
  if (ev.type === 'msg') {
    if (state.seenMsg.has(ev.id)) return;
    state.seenMsg.add(ev.id);
    if (ev.ts > state.lastTS) state.lastTS = ev.ts;
    if (ev.sender_id === state.me.id) {
      // 自己发的：同标签页靠乐观渲染，这里只处理回显确认和其他标签页
      if (ev.client_msg_id && state.pending.has(ev.client_msg_id)) {
        state.pending.delete(ev.client_msg_id);
        const ownRow = [...document.querySelectorAll('#messages .msg-own')].find(row => row.dataset.clientMsgId === ev.client_msg_id);
        if (ownRow) ownRow.dataset.msgId = ev.id;
        rememberRead(ev.id);
        return;
      }
      appendOwn(ev.content, ev.ts, ev.id, ev.image_id);
      rememberRead(ev.id);
      scrollFollow();
    } else {
      // 记录“思考时长”：从看到对方开始打字（或本条开始渲染思考）到现在
      let thinkSec = null;
      if (state.thinkingRow && state.thinkingRow.row.isConnected) {
        thinkSec = Math.max(1, Math.round((Date.now() - state.thinkingStart) / 1000));
      }
      hideTyping();
      enqueueAI(ev.nickname, ev.content, thinkSec, ev.ts, msgKeyOf(ev.id, ev.nickname, ev.content), true, ev.image_id);
      if (document.hidden) {
        const c = state.convs.find(c => c.id === state.cur);
        if (c) { c.unread_count = (c.unread_count || 0) + 1; renderConvList(); }
      } else {
        markConversationRead(state.cur);
      }
      notifyMessage(state.cur, ev.nickname, state.coverMode ? '收到新回复，点击查看' : ev.content, true);
    }
  } else if (ev.type === 'typing') {
    if (ev.sender_id !== state.me.id) showTyping(ev.nickname);
  }
}

/* ---------- “思考中 · Ns” → “已思考 N 秒” + 打字机 ---------- */

function showTyping(nickname) {
  removeWelcome();
  if (!state.thinkingRow || !state.thinkingRow.row.isConnected) {
    const row = document.createElement('div');
    row.className = 'msg-ai';
    const label = document.createElement('div');
    label.className = 'ai-label';
    const body = document.createElement('div');
    body.className = 'thinking-body';
    const text = document.createElement('span');
    text.className = 'thinking-text';
    text.textContent = '思考中';
    const dots = document.createElement('span');
    dots.className = 'typing-dots';
    dots.innerHTML = '<i></i><i></i><i></i>';
    const sec = document.createElement('span');
    sec.className = 'thinking-sec';
    sec.textContent = '';
    body.append(text, dots, sec);
    row.append(label, body);
    $('#messages').appendChild(row);
    state.thinkingRow = { row, label };
    state.thinkingSecEl = sec;
    state.thinkingStart = Date.now();
    clearInterval(state.thinkingTimer);
    state.thinkingTimer = setInterval(() => {
      if (state.thinkingSecEl && state.thinkingSecEl.isConnected) {
        const s = Math.max(1, Math.round((Date.now() - state.thinkingStart) / 1000));
        state.thinkingSecEl.textContent = s + 's';
      }
    }, 400);
    scrollFollow();
  }
  state.thinkingRow.label.textContent = nickname;
  clearTimeout(state.thinkingHideTimer);
  state.thinkingHideTimer = setTimeout(hideTyping, 30000);
}

function hideTyping() {
  clearTimeout(state.thinkingHideTimer);
  clearInterval(state.thinkingTimer);
  if (state.thinkingRow) {
    state.thinkingRow.row.remove();
    state.thinkingRow = null;
    state.thinkingSecEl = null;
  }
}

/* ---------- 播放队列：思考 → 已思考 N 秒 → 打字机 ---------- */

function enqueueAI(nickname, content, thinkSec, ts, msgKey, isPeer, imageID) {
  state.queue.push({ nickname, content, thinkSec, ts, msgKey, isPeer, imageID, gen: state.gen });
  pumpQueue();
}

function pumpQueue() {
  if (state.animating) return;
  const item = state.queue.shift();
  if (!item) return;
  if (item.gen !== state.gen) { pumpQueue(); return; }
  state.animating = true;

  if (item.thinkSec == null) {
    // 没观察到对方打字（比如刚切进聊天）：也先渲染一小段“思考中”，更像 AI
    showTyping(item.nickname);
    const fakeMs = 800 + Math.floor(Math.random() * 1200);
    setTimeout(() => {
      if (item.gen !== state.gen) { state.animating = false; pumpQueue(); return; }
      item.thinkSec = Math.max(1, Math.round((Date.now() - state.thinkingStart) / 1000));
      hideTyping();
      setTimeout(() => animateAI(item), 120);
    }, fakeMs);
    return;
  }
  setTimeout(() => animateAI(item), 150 + Math.random() * 250);
}

function animateAI(item) {
  if (item.gen !== state.gen) { state.animating = false; pumpQueue(); return; }
  const disguised = state.coverMode;
  if (item.ts) ensureDivider(item.ts);
  const r = appendAIRow(item.nickname);
  let body;
  if (item.thinkSec >= 1) {
    const th = document.createElement('div');
    th.className = 'thought-line';
    th.textContent = `已思考 ${item.thinkSec} 秒`;
    body = document.createElement('div');
    body.className = 'ai-body';
    r.realWrap.append(th, body);
  } else {
    body = document.createElement('div');
    body.className = 'ai-body';
    r.realWrap.appendChild(body);
  }
  if (item.ts) body.title = fullStamp(item.ts);
  r.row.classList.add('msg-real');
  r.row.dataset.msgKey = item.msgKey || msgKeyOf('', item.nickname, item.content);
  r.row.dataset.nickname = item.nickname;
  if (item.imageID) r.row.classList.add('has-image');
  r.row.appendChild(makeCoverLayer(!!item.imageID));
  coverTextInto(r.row);
  // 最高档从第一个字符起就在密文层输出，不先打印原文再覆盖。
  if (disguised) {
    body.textContent = item.content;
    if (item.imageID) appendImage(body, item.imageID);
    r.row.classList.add('covered', 'cover-typing');
    bindFlashlight(r.row);
  }
  const output = disguised ? r.row.querySelector('.cover-body') : body;
  const glyphs = Array.from(disguised ? coverTextFor(r.row.dataset.msgKey) : item.content);
  if (disguised) output.textContent = '';
  const textNode = document.createTextNode('');
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  output.append(textNode, cursor);
  scrollFollow();

  const total = glyphs.length;
  let i = 0;
  const chunk = Math.max(1, Math.ceil(total / 230));
  const step = () => {
    if (item.gen !== state.gen) return;
    i = Math.min(total, i + chunk);
    textNode.data = glyphs.slice(0, i).join('');
    scrollFollow();
    if (i < total) {
      const pause = /[。！？\n]/.test(glyphs[i - 1]) ? 160 : 26;
      setTimeout(step, pause);
    } else {
      cursor.remove();
      if (!disguised && item.imageID) appendImage(body, item.imageID);
      r.row.classList.remove('cover-typing');
      addAIActions(r.row, item.content);
      rememberRead(item.msgKey);
      state.animating = false;
      if (state.coverMode && !disguised) coverAllVisible();
      pumpQueue();
    }
  };
  setTimeout(step, 26);
}

/* ---------- 模型选择器 ---------- */

const modelBtn = $('#modelBtn');
const modelLabel = $('#modelLabel');
const modelMenu = $('#modelMenu');

function setTarget(m) {
  state.target = { id: m.id, name: m.name };
  modelLabel.textContent = m.name;
  $('#effortLabel').style.display = 'inline';
  modelBtn.style.display = 'flex';
}

async function openModelMenu() {
  anchorMenu(modelMenu, modelBtn, 'right');
  modelMenu.innerHTML = '<div class="conv-empty">加载中…</div>';
  modelMenu.classList.remove('hidden');
  try {
    const d = await api('/api/models');
    const models = d.models || [];
    modelMenu.innerHTML = '';
    if (!models.length && pluginNovels().length) {
      const p = document.createElement('div');
      p.className = 'conv-empty';
      p.textContent = '暂时没有其他模型';
      modelMenu.appendChild(p);
    }
    const descs = ['适合日常问答与闲聊', '擅长推理与长文本', '创意写作与头脑风暴', '代码与技术问题', '轻量高效，响应最快'];
    models.forEach((mo, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'model-item';
      const name = document.createElement('div');
      name.className = 'm-name';
      const nm = document.createElement('span');
      nm.textContent = mo.name;
      const check = document.createElement('span');
      check.className = 'm-check';
      check.textContent = (state.target && state.target.id === mo.id) ? '✓' : '';
      name.append(nm, check);
      const desc = document.createElement('div');
      desc.className = 'm-desc';
      desc.textContent = descs[i % descs.length];
      b.append(name, desc);
      b.onclick = () => { setTarget(mo); closeModelMenu(); };
      modelMenu.appendChild(b);
    });
    novelAddToMenu(modelMenu);
  } catch (e) {
    modelMenu.classList.add('hidden');
    toast(e.message);
  }
}

function closeModelMenu() { modelMenu.classList.add('hidden'); }

// 把弹出菜单锚定到触发按钮上方：left/right 由按钮实际位置决定（修复菜单跑到左边的问题）
function anchorMenu(menu, btn, align) {
  menu.style.left = 'auto';
  menu.style.right = 'auto';
  const wrap = btn.closest('.composer-wrap') || document.querySelector('.composer-wrap');
  if (!wrap) return;
  const b = btn.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  if (align === 'right') menu.style.right = Math.max(0, w.right - b.right) + 'px';
  else menu.style.left = Math.max(0, b.left - w.left) + 'px';
}

/* ---------- “完全访问”选择（纯装饰，维持 AI 网站观感） ---------- */

const accessBtn = $('#btnAccess');
const accessMenu = $('#accessMenu');
const effortBtn = $('#btnEffort');
const effortMenu = $('#effortMenu');
const accessOpts = ['完全访问', '需要时联网', '仅对话'];

function renderEffortMenu() {
  effortMenu.innerHTML = '';
  for (const opt of EFFORTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'model-item';
    const name = document.createElement('div');
    name.className = 'm-name';
    const nm = document.createElement('span');
    nm.textContent = '思考强度：' + opt.label;
    const check = document.createElement('span');
    check.className = 'm-check';
    check.textContent = ((state.coverMode ? 'max' : 'off') === opt.k) ? '✓' : '';
    name.append(nm, check);
    const desc = document.createElement('div');
    desc.className = 'm-desc';
    desc.textContent = opt.desc;
    b.append(name, desc);
    b.onclick = () => { setEffort(opt.k); effortMenu.classList.add('hidden'); };
    effortMenu.appendChild(b);
  }
  const sliderBox = document.createElement('div'); sliderBox.className = 'reveal-slider-box';
  const sliderLabel = document.createElement('label'); sliderLabel.htmlFor = 'revealOpacity'; sliderLabel.textContent = '透视范围可见度';
  const value = document.createElement('span'); value.id = 'revealOpacityValue'; value.textContent = (localStorage.getItem('cngp_reveal_opacity') || '100') + '%';
  const slider = document.createElement('input'); slider.id = 'revealOpacity'; slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '5'; slider.value = localStorage.getItem('cngp_reveal_opacity') ?? '100';
  slider.oninput = () => setRevealOpacity(slider.value);
  sliderBox.append(sliderLabel, value, slider); effortMenu.appendChild(sliderBox);
  if (state.coverMode && typeof novelResetRevealSelection === 'function') {
    const reset = document.createElement('button'); reset.type = 'button';
    reset.className = 'model-item'; reset.textContent = '重置大小';
    reset.onclick = () => { novelResetRevealSelection(); effortMenu.classList.add('hidden'); };
    effortMenu.appendChild(reset);
  }
}

function renderAccessMenu() {
  accessMenu.innerHTML = '';
  for (const opt of accessOpts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'model-item';
    const name = document.createElement('div');
    name.className = 'm-name';
    const nm = document.createElement('span');
    nm.textContent = opt;
    const check = document.createElement('span');
    check.className = 'm-check';
    check.textContent = (state.access === opt) ? '✓' : '';
    name.append(nm, check);
    b.appendChild(name);
    b.onclick = () => {
      state.access = opt;
      $('#accessLabel').textContent = opt;
      accessMenu.classList.add('hidden');
    };
    accessMenu.appendChild(b);
  }
}

/* ---------- 发送 ---------- */

const input = $('#input');
const btnSend = $('#btnSend');
let attachmentRequest = 0;

function updateSendButton() {
  btnSend.disabled = !input.value.trim() && !state.attachment;
}

function removeAttachment() {
  attachmentRequest++;
  if (state.attachment) URL.revokeObjectURL(state.attachment.preview);
  state.attachment = null;
  $('#imagePreview').replaceChildren();
  $('#imagePreview').classList.add('hidden');
  $('.composer').classList.remove('has-image');
  $('#imageInput').value = '';
  updateSendButton();
}

async function attachImage(file) {
  const request = ++attachmentRequest;
  try {
    const blob = await compressWebP(file);
    if (request !== attachmentRequest) return;
    removeAttachment();
    const preview = URL.createObjectURL(blob);
    state.attachment = { blob, preview };
    const box = $('#imagePreview');
    const img = document.createElement('img');
    img.src = preview;
    img.alt = '待发送图片';
    const size = document.createElement('span');
    size.textContent = Math.round(blob.size / 1024) + ' KB · WebP';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '移除图片';
    remove.onclick = removeAttachment;
    box.replaceChildren(img, size, remove);
    box.classList.remove('hidden');
    $('.composer').classList.add('has-image');
    input.focus();
    updateSendButton();
  } catch (e) {
    if (request === attachmentRequest) toast(e.message);
  }
}

async function compressWebP(file) {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > 25 * 1024 * 1024) throw new Error('原图不能超过 25 MB');
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    if (image.naturalWidth * image.naturalHeight > 50_000_000) throw new Error('图片像素过大');
    let scale = Math.min(1, 1440 / Math.max(image.naturalWidth, image.naturalHeight));
    for (let attempt = 0; attempt < 5; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', Math.max(.45, .78 - attempt * .08)));
      if (!blob || blob.type !== 'image/webp') throw new Error('当前浏览器无法生成 WebP 图片');
      if (blob.size <= 900 * 1024) return blob;
      scale *= .72;
    }
    throw new Error('图片压缩后仍超过 900 KB，请换一张图片');
  } finally { URL.revokeObjectURL(source); }
}

async function uploadImage(blob) {
  const form = new FormData();
  form.append('file', blob, 'image.webp');
  const res = await fetch('/api/images', {
    method: 'POST', headers: { Authorization: 'Bearer ' + state.token }, body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '图片上传失败');
  }
  return (await res.json()).id;
}

function doSend(payload) {
  const cmid = (crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now() + '-' + Math.random().toString(36).slice(2));
  state.pending.add(cmid);
  appendOwn(payload.text, Math.floor(Date.now() / 1000), null, payload.imageID, '',
    payload.replyTo ? { reply_to: payload.replyTo, reactions: null } : null).dataset.clientMsgId = cmid;
  scrollFollow();
  btnSend.disabled = true;
  state.ws.send(JSON.stringify({ type: 'msg', content: payload.text,
    image_id: payload.imageID || '', client_msg_id: cmid, reply_to: payload.replyTo || '' }));
}

async function send() {
  if (state.sending) return;
  const text = input.value.trim();
  const attachment = state.attachment;
  if (!text && !attachment) return;
  const room = state.curInfo?.kind === 1;
  if (!room && !state.target) { toast('请先在左下角选择一个模型'); return; }
  if (state.target?.custom) {
    const targetID = state.target.id;
    const initialConv = state.cur;
    state.sending = true;
    btnSend.disabled = true;
    try {
      const imageID = attachment ? await uploadImage(attachment.blob) : '';
      if (state.cur !== initialConv || state.target?.id !== targetID) {
        throw new Error('发送期间切换了会话，请重新发送');
      }
      if (typeof novelSend !== 'function') { toast('阅读插件未加载'); return; }
      await novelSend(text, imageID);
      if (attachment === state.attachment) removeAttachment();
    } catch (e) { toast(e.message); }
    finally { state.sending = false; updateSendButton(); }
    return;
  }
  const targetID = state.target ? state.target.id : '';
  const initialConv = state.cur;
  const initialInfo = state.curInfo;
  const initialRoom = room;
  state.sending = true;
  btnSend.disabled = true;
  try {
    const imageID = attachment ? await uploadImage(attachment.blob) : '';
    // 发送期间无论怎么切换会话，消息都投递到原会话；不打断、不要求重发
    let destConv = initialConv;
    if (!initialRoom && !(initialInfo && initialInfo.peer_id === targetID)) {
      const d = await api('/api/conversations/with', { body: { peer_id: targetID } });
      destConv = d.conversation.id;
    }
    const replyTo = state.replyTo && state.replyTo.id ? state.replyTo.id : '';
    if (state.cur === destConv && state.wsConv === destConv && state.ws?.readyState === 1) {
      doSend({ text, imageID, replyTo });
    } else {
      const cmid = crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
      await api('/api/conversations/' + encodeURIComponent(destConv) + '/send',
        { body: { content: text, image_id: imageID, client_msg_id: cmid, reply_to: replyTo } });
      if (state.cur !== destConv) loadConvs(true).catch(() => {});
    }
    if (input.value === text) { input.value = ''; autoGrow(); }
    if (replyTo) clearReplyTo();
    if (attachment === state.attachment) removeAttachment();
  } catch (e) {
    toast(e.message);
    if (!input.value.trim()) { input.value = text; autoGrow(); }
  } finally { state.sending = false; updateSendButton(); }
}

// 引用回复：composer 上方的指示条（谁：摘要 ×），发送时附带 reply_to
function setReplyTo(mid, nickname, content) {
  const src = (state.msgIndex || {})[mid];
  state.replyTo = { id: mid, nickname: nickname || (src && src.nickname) || '', snippet: (content || '').slice(0, 60) };
  renderReplyIndicator();
  $('#input').focus();
}
function clearReplyTo() {
  state.replyTo = null;
  renderReplyIndicator();
}
function renderReplyIndicator() {
  document.getElementById('replyIndicator')?.remove();
  if (!state.replyTo) return;
  const bar = document.createElement('div');
  bar.id = 'replyIndicator';
  bar.className = 'reply-indicator';
  const txt = document.createElement('span');
  txt.textContent = '回复 ' + state.replyTo.nickname + '：' + state.replyTo.snippet;
  const x = document.createElement('button');
  x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', '取消回复');
  x.onclick = clearReplyTo;
  bar.append(txt, x);
  document.querySelector('.composer').prepend(bar);
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

/* ---------- 其他 ---------- */

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function closeSidebarMobile() {
  $('#sidebar').classList.remove('open');
  $('#sideMask').classList.remove('show');
}

function switchTab(login) {
  $('#tabLogin').classList.toggle('active', login);
  $('#tabRegister').classList.toggle('active', !login);
  $('#loginForm').classList.toggle('hidden', !login);
  $('#registerForm').classList.toggle('hidden', login);
}

async function suggestName() {
  try {
    const d = await api('/api/model-suggest');
    $('#regName').value = d.name || '';
  } catch {}
}

function bind() {
  const msgScrollEl = $('#msgScroll');
  $('#tabLogin').onclick = () => switchTab(true);
  $('#tabRegister').onclick = () => { switchTab(false); if (!$('#regName').value) suggestName(); };
  $('#btnRerollName').onclick = suggestName;

  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    $('#loginError').textContent = '';
    try {
      const d = await api('/api/login', {
        body: { name: $('#loginName').value.trim(), password: $('#loginPassword').value },
      });
      state.token = d.token;
      localStorage.setItem('cngp_token', d.token);
      state.me = d.user;
      state.enabledPlugins = d.plugins || [];
      state.projects = [];
      askNotifyPermission();
      showApp();
    } catch (err) { $('#loginError').textContent = err.message; }
  };

  $('#registerForm').onsubmit = async e => {
    e.preventDefault();
    $('#regError').textContent = '';
    try {
      const d = await api('/api/register', {
        body: { name: $('#regName').value.trim(), password: $('#regPassword').value },
      });
      if (d.user.nickname !== $('#regName').value.trim()) {
        toast(`该模型名称已被使用，已自动分配：${d.user.nickname}`);
      }
      state.token = d.token;
      localStorage.setItem('cngp_token', d.token);
      state.me = d.user;
      state.enabledPlugins = d.plugins || [];
      askNotifyPermission();
      showApp();
    } catch (err) { $('#regError').textContent = err.message; }
  };

  $('#btnLogout').onclick = () => {
    api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
    resetUnread();
    doLogoutLocal();
  };

  $('#btnSettings').onclick = async () => {
    const root = $('#modalRoot'); root.replaceChildren();
    const overlay = document.createElement('div'); overlay.className = 'overlay';
    const panel = document.createElement('div'); panel.className = 'modal';
    const title = document.createElement('h3'); title.textContent = '个人设置';
    const toggle = document.createElement('button'); toggle.type = 'button';
    toggle.className = 'model-item';
    const render = () => { toggle.textContent = '消息提示音：' + (localStorage.getItem('cngp_sound') === '1' ? '开启' : '关闭'); };
    toggle.onclick = () => {
      const enabled = localStorage.getItem('cngp_sound') !== '1';
      localStorage.setItem('cngp_sound', enabled ? '1' : '0');
      if (enabled) playNotifySound();
      render();
    };
    render();
    // 安装到桌面：PWA 安装（Chromium 触发原生弹窗；iOS 提示手动添加）
    const installRow = document.createElement('button'); installRow.type = 'button'; installRow.className = 'model-item';
    const renderInstall = () => {
      const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
      if (standalone) { installRow.textContent = '已安装为桌面应用'; installRow.disabled = true; return; }
      if (deferredInstallPrompt) { installRow.textContent = '安装到桌面（PWA 应用）'; installRow.disabled = false; return; }
      const ua = navigator.userAgent || '';
      installRow.disabled = true;
      installRow.textContent = /iPhone|iPad/.test(ua) ? 'iOS 安装：Safari 分享 → 添加到主屏幕' : '安装入口将在浏览器给出安装提示后可用';
    };
    renderInstall();
    installRow.onclick = async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try {
        const choice = await deferredInstallPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') toast('已安装到桌面');
      } catch (e) { }
      deferredInstallPrompt = null;
      renderInstall();
    };
    window.addEventListener('beforeinstallprompt', renderInstall);
    const done = document.createElement('button'); done.type = 'button'; done.className = 'btn-primary'; done.textContent = '完成';
    done.onclick = () => root.replaceChildren();
    const archiveTitle = document.createElement('h4'); archiveTitle.textContent = '已归档聊天';
    const archiveHint = document.createElement('p'); archiveHint.className = 'settings-hint';
    archiveHint.textContent = '归档满 30 天后，从你的账号永久移除；其他成员保留记录。';
    const archiveList = document.createElement('div'); archiveList.className = 'settings-archive-list';
    const archived = state.convs.filter(c => c.archived_at).map(c => ({ id: c.id, title: c.title, at: c.archived_at * 1000 }));
    for (const [id, at] of Object.entries(localArchives())) {
      if (id.startsWith('novel:') && typeof novelModels !== 'undefined') archived.push({ id, title: novelModels.find(m => m.id === id.slice(6))?.name || '阅读会话', at: Number(at) });
    }
    for (const item of archived) {
      const row = document.createElement('div'); row.className = 'settings-archive-row';
      const left = document.createElement('span');
      left.textContent = item.title + ' · 剩余 ' + Math.max(0, Math.ceil((item.at + 30 * 86400000 - Date.now()) / 86400000)) + ' 天';
      const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = '恢复';
      restore.onclick = async () => {
        try {
          if (item.id.startsWith('novel:')) { const value = localArchives(); delete value[item.id]; saveLocalArchives(value); }
          else { await api('/api/conversations/' + encodeURIComponent(item.id) + '/archive', { method: 'DELETE' }); await loadConvs(true); }
          row.remove(); renderConvList();
        } catch (e) { toast(e.message); }
      };
      row.append(left, restore); archiveList.appendChild(row);
    }
    if (!archived.length) archiveList.textContent = '暂无归档聊天';
    panel.append(title, toggle, installRow, archiveTitle, archiveHint, archiveList, done); overlay.appendChild(panel); root.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) root.replaceChildren(); };
  };

  $('#btnToggleSide').onclick = () => {
    $('#sidebar').classList.add('open');
    $('#sideMask').classList.add('show');
  };
  $('#sideMask').onclick = closeSidebarMobile;
  $('#btnNewConv').onclick = startNewConversation;
  $('#btnPlugins').onclick = openPluginPage;
  $('#btnPluginBack').onclick = closePluginPage;
  $('#btnRenameConv').onclick = () => {
    if (state.cur && state.curInfo) renameConv(state.cur, $('#convTitle').textContent);
  };
  $('#btnAttach').onclick = () => $('#imageInput').click();
  $('#imageInput').onchange = async () => {
    const file = $('#imageInput').files[0];
    if (!file) return;
    await attachImage(file);
    $('#imageInput').value = '';
  };

  modelBtn.addEventListener('click', e => {
    e.stopPropagation();
    accessMenu.classList.add('hidden');
    if (modelMenu.classList.contains('hidden')) openModelMenu();
    else closeModelMenu();
  });
  accessBtn.addEventListener('click', e => {
    e.stopPropagation();
    modelMenu.classList.add('hidden');
    effortMenu.classList.add('hidden');
    if (accessMenu.classList.contains('hidden')) { anchorMenu(accessMenu, accessBtn, 'left'); renderAccessMenu(); accessMenu.classList.remove('hidden'); }
    else accessMenu.classList.add('hidden');
  });
  effortBtn.addEventListener('click', e => {
    e.stopPropagation();
    modelMenu.classList.add('hidden');
    accessMenu.classList.add('hidden');
    if (effortMenu.classList.contains('hidden')) { anchorMenu(effortMenu, effortBtn, 'left'); renderEffortMenu(); effortMenu.classList.remove('hidden'); }
    else effortMenu.classList.add('hidden');
  });
  document.addEventListener('click', e => {
    if (!modelMenu.contains(e.target) && !modelBtn.contains(e.target)) closeModelMenu();
    if (!accessMenu.contains(e.target) && !accessBtn.contains(e.target)) accessMenu.classList.add('hidden');
    if (!effortMenu.contains(e.target) && !effortBtn.contains(e.target)) effortMenu.classList.add('hidden');
  });

  $('#btnSearch').onclick = openSearch;
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.key === 'Escape' && searchUI) {
      e.preventDefault();
      closeSearch();
    }
  });

  msgScrollEl.addEventListener('scroll', () => {
    if (msgScrollEl.scrollTop > 120) return;
    if (state.historyLoading || state.historyDone || !state.firstMsg) return;
    loadOlder();
  });

  btnSend.onclick = send;
  $('.composer').addEventListener('paste', e => {
    const data = e.clipboardData;
    const item = Array.from(data?.items || []).find(entry => entry.type.startsWith('image/'));
    const file = item?.getAsFile() || Array.from(data?.files || []).find(entry => entry.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    attachImage(file);
  });
  input.addEventListener('input', () => {
    autoGrow();
    updateSendButton();
    const nowT = Date.now();
    if (state.ws && state.ws.readyState === 1 && input.value &&
        nowT - state.lastTypingSent > 1800) {
      state.lastTypingSent = nowT;
      state.ws.send(JSON.stringify({ type: 'typing' }));
    }
  });
  input.addEventListener('keydown', e => {
    // 中文输入法组合期间不触发发送
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
}

async function init() {
  bind();
  state.baseTitle = document.title;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      resetUnread();
      if (state.cur && !state.cur.startsWith('novel:')) markConversationRead(state.cur);
    }
  });
  window.addEventListener('focus', () => {
    resetUnread();
    if (state.cur && !state.cur.startsWith('novel:')) markConversationRead(state.cur);
  });
  // 轮询聊天列表：别人发来的新聊天会自动出现在侧栏。
  // 页签隐藏时降为每 15s 一次，保证后台仍能触发新消息通知
  let pollTicks = 0;
  setInterval(() => {
    pollTicks++;
    if (!state.token || !state.me) return;
    if (document.hidden && pollTicks % 3 !== 0) return;
    loadConvs(true);
  }, 5000);
  if (!state.token) { showAuth(); return; }
  try {
    const d = await api('/api/me');
    state.me = d.user;
    state.enabledPlugins = d.plugins || [];
    showApp();
  } catch (e) { toast(e.message); }
}

document.addEventListener('DOMContentLoaded', init);


/* ---------- CNGP 插件门面：插件开发唯一依赖的稳定 API（契约见 plugins/README.md） ---------- */
window.CNGP = {
  version: 2,
  // 带鉴权的 HTTP 调用
  api: (path, opts) => api(path, opts),
  // 轻提示
  toast: msg => toast(msg),
  // 向当前会话发送一条消息（走正常通道，伪装一致；视图不在会话时自动 REST 兜底投递）
  send(text, opts = {}) {
    const conv = state.cur;
    if (!conv) { toast('请先选择一个会话'); return false; }
    if (state.wsConv === conv && state.ws && state.ws.readyState === 1) {
      doSend({ text, replyTo: opts.replyTo || '' });
      return true;
    }
    const cmid = crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
    api('/api/conversations/' + encodeURIComponent(conv) + '/send',
      { body: { content: text, client_msg_id: cmid, reply_to: opts.replyTo || '' } }).catch(e => toast(e.message));
    return true;
  },
  // 对单条消息切换表情回应（iMessage tapback 式反馈）
  react(msgID, emoji) {
    return api('/api/conversations/' + encodeURIComponent(state.cur) + '/messages/' + encodeURIComponent(msgID) + '/react',
      { body: { emoji } }).catch(e => { toast(e.message); });
  },
  // 当前上下文只读快照：{ me, conv, coverMode }
  context() {
    return { me: state.me, conv: state.curInfo, coverMode: !!state.coverMode };
  },
  // 伪装块：返回一个跟随思考伪装开关的覆盖行元素（密文呈现、悬停透视），文本不明文
  secureBlock(text, opts = {}) {
    const row = document.createElement('div');
    row.className = 'msg-ai covered' + (opts.className ? ' ' + opts.className : '');
    const rw = document.createElement('div'); rw.className = 'real-wrap';
    const body = document.createElement('div'); body.className = 'ai-body';
    body.textContent = text;
    rw.appendChild(body); row.appendChild(rw);
    row.dataset.msgKey = opts.key || ('plug-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    row.dataset.nickname = opts.tag || '密文';
    row.appendChild(makeCoverLayer(false));
    coverTextInto(row);
    row.classList.add('covered');
    bindFlashlight(row);
    return row;
  },
  // 事件订阅：conv-opened / message-actions / room-created / plugins-loaded
  on(name, fn) {
    window.addEventListener('cngp:' + name, e => fn(e.detail, e));
  },
  // 贡献群聊对话模式
  roomMode(mode) {
    (window.cngpRoomModes = window.cngpRoomModes || []).push(mode);
  },
  // 样式化确认弹窗
  confirm({ title, body, okText, danger, onOk }) {
    openConfirm({ title, body, okText, danger, onOk });
  },
};
