'use strict';

/* 拾光小铺 —— 电商网站，聊天伪装成「智能客服」会话。
 * 对面的人类 = 你选择的“客服”（模型列表），他们的回复以客服气泡逐字输出。
 */

const $ = s => document.querySelector(s);

const state = {
  token: localStorage.getItem('sg_token') || '',
  me: null,
  target: null,        // 选中的客服 {id, name}
  convId: null,
  ws: null,
  pending: new Set(),
  seen: new Set(),
  lastTS: 0,
  typingTimer: 0,
  drawerOpen: false,
};

const PRODUCTS = [
  { name: '云朵慢回弹抱枕', desc: '像陷进云里的午睡体验', price: 89, tag: '热卖', seed: 3 },
  { name: '珐琅搪瓷马克杯', desc: '400ml · 适合手冲与拿铁', price: 45, tag: '新品', seed: 7 },
  { name: '户外折叠露营椅', desc: '铝合金骨架 · 仅 980g', price: 219, tag: '露营季', seed: 11 },
  { name: '手工陶土香薰炉', desc: '每一个都独一无二', price: 128, tag: '手作', seed: 5 },
  { name: '帆布旅行收纳袋三件套', desc: '水洗帆布 · 做旧五金', price: 69, tag: '出行', seed: 13 },
  { name: '黄铜书签 · 山与海', desc: '蚀刻工艺 · 附赠礼盒', price: 39, tag: '礼盒', seed: 17 },
  { name: '冷萃咖啡壶套装', desc: '冰滴 8 小时 · 附滤纸 50 张', price: 168, tag: '咖啡角', seed: 19 },
  { name: '羊毛混纺格纹围巾', desc: '澳洲羊毛 · 180×30cm', price: 149, tag: '秋冬', seed: 23 },
];

const AGENT_COLORS = ['#ff6e4a', '#3f7ae0', '#2fa96c', '#9b6ef3', '#e5533f', '#0ea5b7'];

/* ---------- utils ---------- */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function hashN(s, mod) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % mod;
}

/* canvas 商品图：按 seed 生成的几何构成 */
function drawProductArt(cv, seed) {
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  const palettes = [
    ['#ffd9c7', '#ff9a76', '#ff6e4a'], ['#d7e6ff', '#7aa7f5', '#3f7ae0'],
    ['#dcf5e7', '#7fd4a8', '#2fa96c'], ['#f3e8ff', '#c3a6f7', '#9b6ef3'],
    ['#fff2cc', '#ffd166', '#f0a202'], ['#e0f4f6', '#8fd8e0', '#0ea5b7'],
  ];
  const [bg, mid, fg] = palettes[seed % palettes.length];
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  let s = seed * 9973 + 7;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 7; i++) {
    ctx.globalAlpha = 0.25 + rnd() * 0.5;
    ctx.fillStyle = [mid, fg][i % 2];
    const x = rnd() * w, y = rnd() * h, r = 18 + rnd() * (h / 2.2);
    if (i % 3 === 0) { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
    else if (i % 3 === 1) { ctx.beginPath(); ctx.roundRect(x - r, y - r / 2, r * 2, r, r / 3); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r * .9, y + r * .7); ctx.lineTo(x - r * .9, y + r * .7); ctx.closePath(); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
}

function drawHero(cv) {
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#ff9a76'); g.addColorStop(.55, '#ffd166'); g.addColorStop(1, '#9b6ef3');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  let s = 42;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  for (let i = 0; i < 16; i++) {
    ctx.beginPath();
    ctx.arc(rnd() * w, rnd() * h, 6 + rnd() * 42, 0, 7);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(32,36,43,.8)';
  ctx.font = '700 26px ui-sans-serif, system-ui';
  ctx.fillText('LIGHT FAIR', 30, 52);
  ctx.font = '500 15px ui-sans-serif, system-ui';
  ctx.fillText('48 件夏季新品 · 两件 88 折', 30, 82);
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
  if (res.status === 401) { doLogout(); throw new Error('登录状态已失效'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
  return data;
}

/* ---------- auth ---------- */
function showAuth() { $('#authOverlay').classList.remove('hidden'); }
function hideAuth() { $('#authOverlay').classList.add('hidden'); }

function refreshMe() {
  if (state.me) {
    $('#meName').textContent = state.me.nickname;
    $('#meAvatar').textContent = (state.me.nickname[0] || '?').toUpperCase();
    $('#meChip').style.display = 'flex';
    $('#btnLogin').style.display = 'none';
  } else {
    $('#meChip').style.display = 'none';
    $('#btnLogin').style.display = 'block';
  }
}

let regMode = false;
$('#tabLogin').onclick = () => { regMode = false; $('#tabLogin').classList.add('active'); $('#tabReg').classList.remove('active'); };
$('#tabReg').onclick = () => { regMode = true; $('#tabReg').classList.add('active'); $('#tabLogin').classList.remove('active'); };

$('#authForm').onsubmit = async e => {
  e.preventDefault();
  const name = $('#authName').value.trim();
  const pass = $('#authPass').value;
  const err = $('#authErr');
  err.textContent = '';
  try {
    const d = regMode
      ? await api('/api/register', { body: { name, password: pass } })
      : await api('/api/login', { body: { name, password: pass } });
    state.token = d.token;
    localStorage.setItem('sg_token', d.token);
    state.me = d.user;
    hideAuth();
    refreshMe();
    toast('欢迎回来，' + d.user.nickname);
  } catch (ex) { err.textContent = ex.message; }
};

function doLogout() {
  localStorage.removeItem('sg_token');
  state.token = '';
  state.me = null;
  refreshMe();
  showAuth();
}

/* ---------- products ---------- */
function renderProducts() {
  const grid = $('#grid');
  grid.innerHTML = '';
  for (const p of PRODUCTS) {
    const card = document.createElement('div');
    card.className = 'product';
    const cv = document.createElement('canvas');
    cv.width = 300; cv.height = 170;
    drawProductArt(cv, p.seed);
    const body = document.createElement('div');
    body.className = 'p-body';
    const name = document.createElement('div');
    name.className = 'p-name';
    name.textContent = p.name;
    const desc = document.createElement('div');
    desc.className = 'p-desc';
    desc.textContent = p.desc;
    const row = document.createElement('div');
    row.className = 'p-row';
    const price = document.createElement('div');
    price.className = 'p-price';
    price.textContent = p.price;
    const tag = document.createElement('div');
    tag.className = 'p-tag';
    tag.textContent = p.tag;
    row.append(price, tag);
    body.append(name, desc, row);
    card.append(cv, body);
    card.onclick = () => openService(p);
    grid.appendChild(card);
  }
}

/* ---------- 客服抽屉 ---------- */
function openService(product) {
  if (!state.me) { showAuth(); return; }
  state.drawerOpen = true;
  $('#drawerMask').classList.remove('hidden');
  $('#drawer').classList.remove('hidden');
  $('#dwTitle').textContent = product ? `咨询 · ${product.name}` : '在线客服';
  showPick();
  loadAgents();
}

function closeDrawer() {
  state.drawerOpen = false;
  $('#drawerMask').classList.add('hidden');
  $('#drawer').classList.add('hidden');
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
}

$('#btnService').onclick = () => openService(null);
$('#btnDrawerClose').onclick = closeDrawer;
$('#drawerMask').onclick = closeDrawer;

async function loadAgents() {
  const list = $('#agentList');
  list.innerHTML = '<div class="sys-line">正在召回客服…</div>';
  try {
    const d = await api('/api/models');
    const agents = d.models || [];
    list.innerHTML = '';
    if (!agents.length) { list.innerHTML = '<div class="sys-line">当前没有可用的客服，请稍后再试</div>'; return; }
    agents.forEach((m, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'agent-card';
      const ava = document.createElement('span');
      ava.className = 'agent-ava';
      ava.style.background = AGENT_COLORS[i % AGENT_COLORS.length];
      ava.textContent = (m.name[0] || '客').toUpperCase();
      const info = document.createElement('div');
      info.className = 'agent-info';
      const nm = document.createElement('div');
      nm.className = 'agent-name';
      nm.textContent = '智能客服 · ' + m.name;
      const meta = document.createElement('div');
      meta.className = 'agent-meta';
      meta.textContent = '好评率 ' + (88 + hashN(m.name, 11)) + '% · 已服务 ' + (200 + hashN(m.name, 900)) + ' 人';
      info.append(nm, meta);
      const on = document.createElement('span');
      on.className = 'agent-on';
      on.textContent = '● 在线';
      card.append(ava, info, on);
      card.onclick = () => startChatWith(m);
      list.appendChild(card);
    });
  } catch (e) {
    list.innerHTML = '';
    toast(e.message);
  }
}

function showPick() {
  $('#dwPick').classList.remove('hidden');
  $('#dwChat').classList.add('hidden');
}

async function startChatWith(agent) {
  state.target = { id: agent.id, name: agent.name };
  $('#dwPick').classList.add('hidden');
  $('#dwChat').classList.remove('hidden');
  $('#csName').textContent = '智能客服 · ' + agent.name;
  $('#csAvatar').textContent = (agent.name[0] || '客').toUpperCase();
  $('#csAvatar').style.background = AGENT_COLORS[hashN(agent.name, AGENT_COLORS.length)];
  const msgs = $('#msgs');
  msgs.innerHTML = '';
  addSys('欢迎光临拾光小铺，正在为您接入智能客服…');
  try {
    const d = await api('/api/conversations/with', { body: { peer_id: agent.id } });
    state.convId = d.conversation.id;
    state.seen = new Set();
    state.lastTS = 0;
    addSys('您好，我是 ' + agent.name + ' 🙌 小铺的 AI 客服，关于商品、订单、售后的问题都可以问我～');
    const h = await api(`/api/conversations/${state.convId}/messages`);
    for (const m of h.messages || []) {
      state.seen.add(m.id);
      if (m.ts > state.lastTS) state.lastTS = m.ts;
      if (m.sender_id === state.me.id) addBubble('me', m.content, null, true);
      else addBubble('cs', m.content, agent.name, true);
    }
    connectWS();
  } catch (e) { toast(e.message); }
}

/* ---------- messages ---------- */
const msgsEl = $('#msgs');

function scrollMsgs() { msgsEl.scrollTop = msgsEl.scrollHeight; }

function addSys(text) {
  const div = document.createElement('div');
  div.className = 'sys-line';
  div.textContent = text;
  msgsEl.appendChild(div);
  scrollMsgs();
}

function addBubble(kind, text, name, instant = false) {
  const row = document.createElement('div');
  row.className = 'msg-row' + (kind === 'me' ? ' me' : '');
  if (kind !== 'me') {
    const ava = document.createElement('span');
    ava.className = 'msg-ava';
    ava.style.background = AGENT_COLORS[hashN(name || 'x', AGENT_COLORS.length)];
    ava.textContent = (name || '客')[0].toUpperCase();
    row.appendChild(ava);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  row.appendChild(bubble);
  msgsEl.appendChild(row);
  scrollMsgs();
  if (instant) { bubble.textContent = text; return Promise.resolve(); }
  // 客服回复逐字输出（AI 客服的“打字感”）
  return new Promise(resolve => {
    let i = 0;
    const chunk = Math.max(1, Math.round(text.length / 160));
    const step = () => {
      i = Math.min(text.length, i + chunk);
      bubble.textContent = text.slice(0, i);
      scrollMsgs();
      if (i < text.length) setTimeout(step, 16);
      else resolve();
    };
    setTimeout(step, 150);
  });
}

let typingEl = null;
function showCsTyping() {
  if (typingEl) return;
  const row = document.createElement('div');
  row.className = 'msg-row';
  const ava = document.createElement('span');
  ava.className = 'msg-ava';
  ava.style.background = AGENT_COLORS[hashN(state.target?.name || 'x', AGENT_COLORS.length)];
  ava.textContent = (state.target?.name || '客')[0].toUpperCase();
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = '对方正在输入…';
  row.append(ava, bubble);
  msgsEl.appendChild(row);
  typingEl = row;
  scrollMsgs();
}
function hideCsTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

function connectWS() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${proto}://${location.host}/ws?conv=${encodeURIComponent(state.convId)}&token=${encodeURIComponent(state.token)}`
  );
  state.ws = ws;
  ws.onmessage = e => { try { handleEvent(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    if (state.convId && state.ws === ws && state.drawerOpen) setTimeout(() => { if (state.drawerOpen && state.convId) connectWS(); }, 2500);
  };
}

function handleEvent(ev) {
  if (ev.conv_id && ev.conv_id !== state.convId) return;
  if (ev.type === 'typing') {
    if (ev.sender_id !== state.me.id) showCsTyping();
  } else if (ev.type === 'msg') {
    if (state.seen.has(ev.id)) return;
    state.seen.add(ev.id);
    if (ev.ts > state.lastTS) state.lastTS = ev.ts;
    if (ev.sender_id === state.me.id) {
      if (ev.client_msg_id && state.pending.has(ev.client_msg_id)) { state.pending.delete(ev.client_msg_id); return; }
      addBubble('me', ev.content, null, true);
    } else {
      hideCsTyping();
      addBubble('cs', ev.content, ev.nickname);
    }
  }
}

function csSend() {
  const input = $('#csInput');
  const text = input.value.trim();
  if (!text) return;
  if (!state.convId) { toast('请先选择一位客服'); return; }
  if (!state.ws || state.ws.readyState !== 1) { toast('连接已断开，正在重连…'); return; }
  const cmid = Date.now() + '-' + Math.random().toString(36).slice(2);
  state.pending.add(cmid);
  addBubble('me', text, null, true);
  input.value = '';
  state.ws.send(JSON.stringify({ type: 'msg', content: text, client_msg_id: cmid }));
}

$('#csSend').onclick = csSend;
$('#csInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) csSend();
});
document.querySelectorAll('.chip').forEach(ch => {
  ch.onclick = () => { $('#csInput').value = ch.dataset.fill; $('#csInput').focus(); };
});

/* ---------- init ---------- */
$('#btnLogin').onclick = () => { if (!state.me) showAuth(); };
$('#btnHeroBrowse').onclick = () => $('#grid').scrollIntoView({ behavior: 'smooth' });

async function init() {
  drawHero($('#heroArt'));
  renderProducts();
  if (state.token) {
    try {
      const d = await api('/api/me');
      state.me = d.user;
    } catch {}
  }
  refreshMe();
  // 新客服消息提醒（抽屉没开时）
  setInterval(async () => {
    if (!state.token || !state.me || document.hidden || state.drawerOpen) return;
    try {
      const d = await api('/api/conversations');
      const hot = (d.conversations || []).filter(c => c.last_ts > (c.last_seen || 0));
      if (hot.length) $('#fabBadge').style.display = 'inline';
      else $('#fabBadge').style.display = 'none';
    } catch {}
  }, 5000);
}

init();
