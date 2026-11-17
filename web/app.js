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
  access: '完全访问', // 装饰性“权限档位”
  coverMode: localStorage.getItem('cngp_effort') === 'max', // 思考伪装（覆盖真实对话）
  coverLines: [],     // 服务端语料池（GLM 生成或内置）
  coverTimers: [],    // 未触发的覆盖定时器（切会话/关模式时统一清）
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

// 页签隐藏时：系统通知 + 标题计数；页签可见时什么都不做（消息本来就在眼前）
function notifyMessage(convID, title, body) {
  bumpUnread();
  try {
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body: body.slice(0, 120), tag: 'cngp-' + convID });
      n.onclick = () => {
        window.focus();
        resetUnread();
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
  { k: 'max', label: '最高', desc: '深度思考伪装：对话覆盖为技术分析，悬停透视' },
];

function coverKeyHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

// 按消息 id 确定性取语料：同一消息在任何人、任何次刷新下覆盖文本一致
function coverTextFor(key) {
  if (!state.coverLines.length) {
    return '正在对输入做结构化分析，比照既有模式核对边界条件与副作用…';
  }
  return state.coverLines[coverKeyHash(String(key)) % state.coverLines.length];
}

function msgKeyOf(id, nickname, content) {
  if (id) return String(id);
  return (nickname || '') + '|' + (content || '');
}

async function ensureCoverPool() {
  if (state.coverLines.length) return;
  try {
    const d = await api('/api/cover-lines');
    state.coverLines = d.lines || [];
  } catch {}
}

function clearCoverTimers() {
  for (const t of state.coverTimers) clearTimeout(t);
  state.coverTimers = [];
}

// 覆盖层 DOM（按行类型复用样式）
function makeCoverLayer(own) {
  const layer = document.createElement('div');
  layer.className = 'cover-layer ' + (own ? 'cover-own' : 'cover-ai');
  if (own) {
    const b = document.createElement('div');
    b.className = 'cover-bubble';
    layer.appendChild(b);
  } else {
    const tag = document.createElement('div');
    tag.className = 'cover-tag';
    tag.textContent = '深度分析';
    const b = document.createElement('div');
    b.className = 'cover-body';
    layer.append(tag, b);
  }
  return layer;
}

function coverTextInto(row) {
  const layer = row.querySelector('.cover-layer');
  if (!layer) return;
  const text = coverTextFor(row.dataset.msgKey || '');
  const target = layer.querySelector('.cover-bubble') || layer.querySelector('.cover-body');
  if (target) target.textContent = text;
}

// 延迟盖层：≤5s 内随机自然延迟
function scheduleCoverRow(row, delay) {
  if (!row || !row.classList.contains('msg-real') || row.classList.contains('covered')) return;
  const t = setTimeout(() => {
    coverTextInto(row);
    row.classList.add('covered');
    bindFlashlight(row);
  }, delay);
  state.coverTimers.push(t);
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
  };
  row.addEventListener('pointermove', track);
  row.addEventListener('pointerdown', e => {
    if (!row.classList.contains('covered')) return;
    track(e);
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1600);
  });
}

function uncoverAll() {
  clearCoverTimers();
  document.querySelectorAll('#messages .msg-real.covered').forEach(r => r.classList.remove('covered'));
}

async function coverAllVisible() {
  await ensureCoverPool();
  document.querySelectorAll('#messages .msg-real:not(.covered)').forEach((r, i) => {
    scheduleCoverRow(r, Math.min(400 + i * 260, 4800));
  });
}

function setEffort(k) {
  const max = k === 'max';
  state.coverMode = max;
  localStorage.setItem('cngp_effort', max ? 'max' : 'off');
  $('#effortModeLabel').textContent = max ? '思考强度：最高' : '思考强度：关闭';
  document.body.classList.toggle('cover-on', max);
  if (max) {
    coverAllVisible();
    toast('思考伪装已开启：对话将覆盖为技术分析，悬停可透视');
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
  loadConvs();
}

function doLogoutLocal() {
  localStorage.removeItem('cngp_token');
  state.token = '';
  state.cur = null;
  state.target = null;
  clearCoverTimers();
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
  if (!state.convs.length) {
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
    b.textContent = c.title;
    b.title = c.title;
    b.onclick = () => { selectConv(c.id); closeSidebarMobile(); };
    list.appendChild(b);
  }
}

/* ---------- 聊天切换与消息渲染 ---------- */

async function selectConv(id) {
  state.cur = id;
  state.gen++;
  state.queue = [];
  state.animating = false;
  state.pending.clear();
  state.seenMsg = new Set();
  state.lastTS = 0;
  state.lastRenderTS = 0;
  clearCoverTimers();
  state.thinkingRow = null;
  hideTyping();
  renderConvList();
  try {
    const d = await api('/api/conversations/' + id);
    state.curInfo = d.conversation;
    $('#convTitle').textContent = d.conversation.title;
    // 打开某个聊天 = 选中了对方那个“模型”
    if (d.conversation.peer_id) {
      setTarget({ id: d.conversation.peer_id, name: d.conversation.peer_nickname });
    } else {
      // 兼容旧的多人聊天：隐藏选择器
      state.target = null;
      $('#modelBtn').style.display = 'none';
    }
    const md = await api(`/api/conversations/${id}/messages`);
    const box = $('#messages');
    box.innerHTML = '';
    const msgs = md.messages || [];
    if (!msgs.length) appendWelcome(d.conversation.title);
    for (const m of msgs) {
      state.seenMsg.add(m.id);
      if (m.ts > state.lastTS) state.lastTS = m.ts;
      if (m.sender_id === state.me.id) appendOwn(m.content, m.ts, m.id);
      else appendAIStatic(m.nickname, m.content, m.ts, m.id);
    }
    scrollBottom(true);
    if (state.coverMode) coverAllVisible();
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

function appendOwn(content, ts, msgId) {
  removeWelcome();
  const wrap = document.createElement('div');
  wrap.className = 'msg-own msg-real';
  wrap.dataset.msgKey = msgKeyOf(msgId, state.me ? state.me.nickname : 'me', content);
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = content;
  if (ts) {
    ensureDivider(ts);
    b.title = fullStamp(ts);
  }
  wrap.appendChild(b);
  wrap.appendChild(makeCoverLayer(true));
  coverTextInto(wrap);
  $('#messages').appendChild(wrap);
}

function appendAIRow(nickname) {
  removeWelcome();
  const row = document.createElement('div');
  row.className = 'msg-ai';
  const label = document.createElement('div');
  label.className = 'ai-label';
  label.textContent = nickname;
  row.appendChild(label);
  $('#messages').appendChild(row);
  return { row, label };
}

function appendAIStatic(nickname, content, ts, msgId) {
  if (ts) ensureDivider(ts);
  const r = appendAIRow(nickname);
  const body = document.createElement('div');
  body.className = 'ai-body';
  body.textContent = content;
  if (ts) body.title = fullStamp(ts);
  r.row.appendChild(body);
  r.row.classList.add('msg-real');
  r.row.dataset.msgKey = msgKeyOf(msgId, nickname, content);
  r.row.appendChild(makeCoverLayer(false));
  coverTextInto(r.row);
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
  ws.onopen = () => { syncMissed(id); flushPending(); };
  ws.onmessage = e => { try { handleEvent(JSON.parse(e.data)); } catch {} };
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
    for (const m of d.messages || []) {
      if (state.seenMsg.has(m.id)) continue;
      if (m.client_msg_id && state.pending.has(m.client_msg_id)) {
        state.pending.delete(m.client_msg_id);
        state.seenMsg.add(m.id);
        if (m.ts > state.lastTS) state.lastTS = m.ts;
        continue;
      }
      state.seenMsg.add(m.id);
      if (m.ts > state.lastTS) state.lastTS = m.ts;
      if (m.sender_id === state.me.id) appendOwn(m.content, m.ts, m.id);
      else enqueueAI(m.nickname, m.content, null, m.ts, msgKeyOf(m.id, m.nickname, m.content), true);
      scrollFollow();
    }
  } catch {}
}

function flushPending() {
  if (state.pendingSend && state.ws && state.ws.readyState === 1) {
    const t = state.pendingSend;
    state.pendingSend = null;
    doSend(t);
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
        return;
      }
      appendOwn(ev.content, ev.ts, ev.id);
      scrollFollow();
    } else {
      // 记录“思考时长”：从看到对方开始打字（或本条开始渲染思考）到现在
      let thinkSec = null;
      if (state.thinkingRow && state.thinkingRow.row.isConnected) {
        thinkSec = Math.max(1, Math.round((Date.now() - state.thinkingStart) / 1000));
      }
      hideTyping();
      enqueueAI(ev.nickname, ev.content, thinkSec, ev.ts, msgKeyOf(ev.id, ev.nickname, ev.content), true);
      // 页签在后台时提醒：系统通知 + 标题计数（可见时不打扰）
      notifyMessage(state.cur, ev.nickname, ev.content);
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

function enqueueAI(nickname, content, thinkSec, ts, msgKey, isPeer) {
  state.queue.push({ nickname, content, thinkSec, ts, msgKey, isPeer, gen: state.gen });
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
  if (item.ts) ensureDivider(item.ts);
  const r = appendAIRow(item.nickname);
  let body;
  if (item.thinkSec >= 1) {
    const th = document.createElement('div');
    th.className = 'thought-line';
    th.textContent = `已思考 ${item.thinkSec} 秒`;
    body = document.createElement('div');
    body.className = 'ai-body';
    r.row.append(th, body);
  } else {
    body = document.createElement('div');
    body.className = 'ai-body';
    r.row.appendChild(body);
  }
  if (item.ts) body.title = fullStamp(item.ts);
  r.row.classList.add('msg-real');
  r.row.dataset.msgKey = item.msgKey || msgKeyOf('', item.nickname, item.content);
  r.row.appendChild(makeCoverLayer(false));
  coverTextInto(r.row);
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  const textNode = document.createTextNode('');
  body.append(textNode, cursor);
  scrollFollow();

  const text = item.content;
  const total = text.length;
  let i = 0;
  const chunk = Math.max(1, Math.round(total / 300)); // 长消息加速，整体不超过约 3.5 秒
  const step = () => {
    if (item.gen !== state.gen) return; // 聊天已切换，动画作废
    i = Math.min(total, i + chunk);
    textNode.data = text.slice(0, i);
    scrollFollow();
    if (i < total) setTimeout(step, 12);
    else {
      cursor.remove();
      state.animating = false;
      pumpQueue();
      // 读取完成：≤5s 内渐隐；对方消息完成时，把当前所有未覆盖行一并排程
      if (state.coverMode) {
        scheduleCoverRow(r.row, 1500 + Math.floor(Math.random() * 2500));
        if (item.isPeer) {
          document.querySelectorAll('#messages .msg-real:not(.covered)').forEach((row, i) => {
            scheduleCoverRow(row, 1800 + i * 260 + Math.floor(Math.random() * 600));
          });
        }
      }
    }
  };
  setTimeout(step, 12);
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
    if (!models.length) {
      const p = document.createElement('div');
      p.className = 'conv-empty';
      p.textContent = '暂时没有其他模型';
      modelMenu.appendChild(p);
      return;
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

function doSend(text) {
  const cmid = (crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now() + '-' + Math.random().toString(36).slice(2));
  state.pending.add(cmid);
  appendOwn(text, Math.floor(Date.now() / 1000));
  scrollFollow();
  btnSend.disabled = true;
  state.ws.send(JSON.stringify({ type: 'msg', content: text, client_msg_id: cmid }));
}

async function send() {
  const text = input.value.trim();
  if (!text) return;
  if (!state.target) { toast('请先在左下角选择一个模型'); return; }
  input.value = '';
  autoGrow();
  btnSend.disabled = true;

  // 当前打开的聊天正是与该模型的会话 → 直接发
  if (state.cur && state.curInfo && state.curInfo.peer_id === state.target.id) {
    if (state.ws && state.ws.readyState === 1) doSend(text);
    else state.pendingSend = text; // 重连后自动发出
    return;
  }
  // 否则定位（或自动创建）与该模型的会话，连上后自动发出
  try {
    const d = await api('/api/conversations/with', { body: { peer_id: state.target.id } });
    state.pendingSend = text;
    if (d.conversation.id === state.cur) {
      flushPending();
    } else {
      await loadConvs(true);
      await selectConv(d.conversation.id);
    }
  } catch (e) {
    toast(e.message);
    input.value = text;
    autoGrow();
    btnSend.disabled = false;
  }
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
  input.addEventListener('input', () => {
    autoGrow();
    btnSend.disabled = input.value.trim() === '';
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resetUnread(); });
  window.addEventListener('focus', resetUnread);
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
