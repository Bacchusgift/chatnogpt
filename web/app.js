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
};

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
  loadConvs();
}

function doLogoutLocal() {
  localStorage.removeItem('cngp_token');
  state.token = '';
  state.cur = null;
  state.target = null;
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  showAuth();
}

/* ---------- 聊天列表（轮询自动发现新聊天） ---------- */

async function loadConvs(silent = false) {
  try {
    const d = await api('/api/conversations');
    state.convs = d.conversations || [];
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
      if (m.sender_id === state.me.id) appendOwn(m.content);
      else appendAIStatic(m.nickname, m.content);
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

function appendOwn(content) {
  removeWelcome();
  const wrap = document.createElement('div');
  wrap.className = 'msg-own';
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = content;
  wrap.appendChild(b);
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

function appendAIStatic(nickname, content) {
  const r = appendAIRow(nickname);
  const body = document.createElement('div');
  body.className = 'ai-body';
  body.textContent = content;
  r.row.appendChild(body);
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
      if (m.sender_id === state.me.id) appendOwn(m.content);
      else enqueueAI(m.nickname, m.content, null);
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
      appendOwn(ev.content);
      scrollFollow();
    } else {
      // 记录“思考时长”：从看到对方开始打字（或本条开始渲染思考）到现在
      let thinkSec = null;
      if (state.thinkingRow && state.thinkingRow.row.isConnected) {
        thinkSec = Math.max(1, Math.round((Date.now() - state.thinkingStart) / 1000));
      }
      hideTyping();
      enqueueAI(ev.nickname, ev.content, thinkSec);
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

function enqueueAI(nickname, content, thinkSec) {
  state.queue.push({ nickname, content, thinkSec, gen: state.gen });
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

/* ---------- “完全访问”选择（纯装饰，维持 AI 网站观感） ---------- */

const accessBtn = $('#btnAccess');
const accessMenu = $('#accessMenu');
const accessOpts = ['完全访问', '需要时联网', '仅对话'];

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
  appendOwn(text);
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
      showApp();
    } catch (err) { $('#regError').textContent = err.message; }
  };

  $('#btnLogout').onclick = () => {
    api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
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
    if (accessMenu.classList.contains('hidden')) { renderAccessMenu(); accessMenu.classList.remove('hidden'); }
    else accessMenu.classList.add('hidden');
  });
  document.addEventListener('click', e => {
    if (!modelMenu.contains(e.target) && !modelBtn.contains(e.target)) closeModelMenu();
    if (!accessMenu.contains(e.target) && !accessBtn.contains(e.target)) accessMenu.classList.add('hidden');
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
  // 轮询聊天列表：别人发来的新聊天会自动出现在侧栏
  setInterval(() => {
    if (state.token && state.me && !document.hidden) loadConvs(true);
  }, 5000);
  if (!state.token) { showAuth(); return; }
  try {
    const d = await api('/api/me');
    state.me = d.user;
    showApp();
  } catch (e) { toast(e.message); }
}

document.addEventListener('DOMContentLoaded', init);
