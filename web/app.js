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
  unreadConvs: new Set(), // 有未读消息的会话 id（侧栏绿点，按账号存本地）
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
}

function resetUnread() {
  if (state.unread) {
    state.unread = 0;
    document.title = state.baseTitle;
  }
}

function unreadStorageKey() {
  return `cngp_unread_${state.me.id}`;
}

function loadUnreadConvs() {
  try {
    const ids = JSON.parse(localStorage.getItem(unreadStorageKey()) || '[]');
    return new Set(Array.isArray(ids) ? ids.filter(x => typeof x === 'string') : []);
  } catch { return new Set(); }
}

function saveUnreadConvs() {
  try { localStorage.setItem(unreadStorageKey(), JSON.stringify(Array.from(state.unreadConvs))); } catch {}
}

function convDotEl() {
  const i = document.createElement('i');
  i.className = 'conv-dot';
  return i;
}

// 侧栏绿点：收到消息且还没打开该会话时点亮，打开后清除；按账号持久化。
function markUnread(id) {
  if (!id || !state.me || state.unreadConvs.has(id)) return;
  state.unreadConvs.add(id);
  saveUnreadConvs();
  const b = document.querySelector(`#convList .conv-item[data-id="${CSS.escape(id)}"]`);
  if (b && !b.querySelector('.conv-dot')) b.appendChild(convDotEl());
}

function clearUnread(id) {
  if (!id || !state.unreadConvs.delete(id)) return;
  saveUnreadConvs();
  document.querySelector(`#convList .conv-item[data-id="${CSS.escape(id)}"] .conv-dot`)?.remove();
}

// 新消息提醒：标题计数 + 浏览器系统通知；onScreen 表示消息正显示在当前会话里，
// 页签可见时不重复弹窗（内容已在眼前），页签隐藏时照常提醒。
function notifyMessage(convID, title, body, onScreen = false) {
  bumpUnread();
  try {
    if ((!onScreen || document.hidden) && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body: body.slice(0, 120), tag: 'cngp-' + convID });
      n.onclick = () => {
        window.focus();
        resetUnread();
        clearUnread(convID);
        if (convID !== state.cur) selectConv(convID);
        n.close();
      };
    }
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
  const text = coverTextFor(row.dataset.msgKey || '');
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
    if (!row.classList.contains('covered')) return;
    const rect = row.getBoundingClientRect();
    row.style.setProperty('--fx', (e.clientX - rect.left) + 'px');
    row.style.setProperty('--fy', (e.clientY - rect.top) + 'px');
    // 光晕用视口坐标：fixed 定位，不影响滚动高度
    row.style.setProperty('--gx', e.clientX + 'px');
    row.style.setProperty('--gy', e.clientY + 'px');
  };
  row.addEventListener('pointermove', e => {
    track(e);
    if (state.coverMode) row.classList.add('reveal-active');
  });
  row.addEventListener('pointerleave', () => row.classList.remove('reveal-active'));
  row.addEventListener('pointerdown', e => {
    if (!row.classList.contains('covered') || e.pointerType === 'mouse') return;
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
  $('#effortModeLabel').textContent = max ? '思考强度：最高' : '思考强度：关闭';
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
  $('#effortModeLabel').textContent = state.coverMode ? '思考强度：最高' : '思考强度：关闭';
  document.body.classList.toggle('cover-on', state.coverMode);
  state.unreadConvs = loadUnreadConvs();
  if (!state.cur) {
    $('#messages').replaceChildren();
    appendWelcome('ChatNoGPT');
  }
  if (state.coverMode) ensureCoverPool();
  loadConvs();
  novelLoad();
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
  state.unreadConvs = new Set();
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
    const d = await api('/api/conversations');
    const prevTS = new Map(state.convs.map(c => [c.id, c.last_ts || 0]));
    state.convs = d.conversations || [];
    // WS 只订阅当前聊天；侧栏轮询顺带探测其他聊天的新消息（含别人新发起的聊天）
    if (prevTS.size) {
      for (const c of state.convs) {
        if (c.id !== state.cur && (c.last_ts || 0) > (prevTS.get(c.id) || 0)) {
          markUnread(c.id);
          notifyMessage(c.id, c.title, '收到新消息');
        }
      }
    }
    renderConvList();
    if (!state.cur && state.convs.length) selectConv(state.convs[0].id);
  } catch (e) { if (!silent) toast(e.message); }
}

function renderConvList() {
  const list = $('#convList');
  list.innerHTML = '';
  if (!state.convs.length && !novelModels.length) {
    const p = document.createElement('div');
    p.className = 'conv-empty';
    p.textContent = '还没有聊天';
    list.appendChild(p);
    return;
  }
  for (const c of state.convs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'conv-item' + (c.id === state.cur ? ' active' : '');
    b.dataset.id = c.id;
    b.textContent = c.title;
    if (state.unreadConvs.has(c.id)) b.appendChild(convDotEl());
    b.title = c.title + '（双击修改标题）';
    b.onclick = () => { selectConv(c.id); closeSidebarMobile(); };
    b.ondblclick = () => renameConv(c.id, c.title);
    list.appendChild(b);
  }
  novelRenderList(list);
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
  overlay.className = 'picker-overlay';
  const panel = document.createElement('div');
  panel.className = 'picker-panel';
  const heading = document.createElement('h2');
  heading.textContent = '创建群聊室';
  const titleField = document.createElement('input');
  titleField.placeholder = '房间名称';
  titleField.maxLength = 60;
  const inviteField = document.createElement('input');
  inviteField.placeholder = '邀请成员（模型名，用逗号分隔，可留空）';
  const status = document.createElement('p');
  status.className = 'novel-hint';
  status.style.margin = '8px 0 0';
  const save = document.createElement('button');
  save.textContent = '创建房间';
  const close = () => { root.innerHTML = ''; };
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.textContent = '取消';
  cancel.onclick = close;
  save.onclick = async () => {
    const invite = inviteField.value.split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean);
    save.disabled = true;
    status.textContent = '';
    try {
      const d = await api('/api/rooms', { body: { title: titleField.value, invite } });
      close();
      if (d.missing?.length) toast('未找到成员：' + d.missing.join('、'));
      await loadConvs(true);
      await selectConv(d.conversation.id);
      closeSidebarMobile();
    } catch (e) {
      save.disabled = false;
      status.textContent = e.message;
    }
  };
  panel.append(heading, titleField, inviteField, status, save, cancel);
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
  state.cur = id;
  state.gen++;
  const gen = state.gen;
  state.readIDs = loadReadIDs(id);
  clearUnread(id);
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
      if (m.sender_id === state.me.id) appendOwn(m.content, m.ts, m.id, m.image_id);
      else appendAIStatic(m.nickname, m.content, m.ts, m.id, m.image_id);
      rememberRead(m.id);
    }
    scrollBottom(true);
    connectWS(id);
    $('#input').focus();
  } catch (e) { toast(e.message); }
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
    if (!peerCovered()) window.open(img.src, '_blank', 'noopener,noreferrer');
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

function appendOwn(content, ts, msgId, imageID) {
  removeWelcome();
  const wrap = document.createElement('div');
  wrap.className = 'msg-own';
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
  wrap.appendChild(realWrap);
  if (state.coverMode && (content || imageID)) wrap.classList.add('covered');
  $('#messages').appendChild(wrap);
  bindOwnReveal(wrap);
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

function appendAIStatic(nickname, content, ts, msgId, imageID) {
  if (ts) ensureDivider(ts);
  const r = appendAIRow(nickname);
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
        state.seenMsg.add(m.id);
        if (m.ts > state.lastTS) state.lastTS = m.ts;
        rememberRead(m.id);
        continue;
      }
      state.seenMsg.add(m.id);
      if (m.ts > state.lastTS) state.lastTS = m.ts;
      if (m.sender_id === state.me.id) {
        appendOwn(m.content, m.ts, m.id, m.image_id);
        rememberRead(m.id);
      } else if (state.coverMode && state.readIDs.has(m.id)) {
        appendAIStatic(m.nickname, m.content, m.ts, m.id, m.image_id);
      } else {
        enqueueAI(m.nickname, m.content, null, m.ts, msgKeyOf(m.id, m.nickname, m.content), true, m.image_id);
      }
      scrollFollow();
      if (m.sender_id !== state.me.id && document.hidden) {
        // 断线重连补拉的消息也要提醒：绿点 + 系统通知 + 标题计数
        markUnread(state.cur);
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
  if (ev.type === 'msg') {
    if (state.seenMsg.has(ev.id)) return;
    state.seenMsg.add(ev.id);
    if (ev.ts > state.lastTS) state.lastTS = ev.ts;
    if (ev.sender_id === state.me.id) {
      // 自己发的：同标签页靠乐观渲染，这里只处理回显确认和其他标签页
      if (ev.client_msg_id && state.pending.has(ev.client_msg_id)) {
        state.pending.delete(ev.client_msg_id);
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
      // 页签在后台时：绿点 + 系统通知 + 标题计数；可见时消息已在眼前，不重复提醒
      if (document.hidden) markUnread(state.cur);
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
    if (!models.length && !novelModels.length) {
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
  appendOwn(payload.text, Math.floor(Date.now() / 1000), null, payload.imageID);
  scrollFollow();
  btnSend.disabled = true;
  state.ws.send(JSON.stringify({ type: 'msg', content: payload.text,
    image_id: payload.imageID || '', client_msg_id: cmid }));
}

async function send() {
  if (state.sending) return;
  const text = input.value.trim();
  const attachment = state.attachment;
  if (!text && !attachment) return;
  const room = state.curInfo?.kind === 1;
  if (!room && !state.target) { toast('请先在左下角选择一个模型'); return; }
  if (state.target?.custom) {
    if (attachment) { toast('小说阅读会话暂不支持发送图片'); return; }
    novelSend(text);
    return;
  }
  const targetID = state.target ? state.target.id : '';
  const initialConv = state.cur;
  state.sending = true;
  btnSend.disabled = true;
  try {
    const imageID = attachment ? await uploadImage(attachment.blob) : '';
    if (state.cur !== initialConv || state.target?.id !== targetID) {
      throw new Error('发送期间切换了会话，请重新发送');
    }
    const payload = { text, imageID };
    if (room || (state.cur && state.curInfo?.peer_id === targetID)) {
      if (state.wsConv === state.cur && state.ws?.readyState === 1) doSend(payload);
      else state.pendingSend = { convID: state.cur, payload };
    } else {
      const d = await api('/api/conversations/with', { body: { peer_id: targetID } });
      if (state.cur !== initialConv || state.target?.id !== targetID) {
        throw new Error('发送期间切换了会话，请重新发送');
      }
      state.pendingSend = { convID: d.conversation.id, payload };
      if (d.conversation.id === state.cur) flushPending(d.conversation.id);
      else {
        await selectConv(d.conversation.id);
        if (state.cur !== d.conversation.id) throw new Error('会话已切换，请重新发送');
        await loadConvs(true);
      }
    }
    input.value = '';
    autoGrow();
    if (attachment === state.attachment) removeAttachment();
  } catch (e) {
    if (state.pendingSend?.payload?.text === text) state.pendingSend = null;
    toast(e.message);
  } finally { state.sending = false; updateSendButton(); }
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
      askNotifyPermission();
      showApp();
    } catch (err) { $('#regError').textContent = err.message; }
  };

  $('#btnLogout').onclick = () => {
    api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
    resetUnread();
    doLogoutLocal();
  };

  $('#btnToggleSide').onclick = () => {
    $('#sidebar').classList.add('open');
    $('#sideMask').classList.add('show');
  };
  $('#sideMask').onclick = closeSidebarMobile;
  $('#btnNewConv').onclick = startNewConversation;
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

  btnSend.onclick = send;
  input.addEventListener('paste', e => {
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
      // 回到页签时正在看的会话即已读，绿点随之消失
      if (state.cur) clearUnread(state.cur);
    }
  });
  window.addEventListener('focus', () => {
    resetUnread();
    if (state.cur) clearUnread(state.cur);
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
    showApp();
  } catch (e) { toast(e.message); }
}

document.addEventListener('DOMContentLoaded', init);
