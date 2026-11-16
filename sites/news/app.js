'use strict';

/* 今闻日报 —— 新闻门户，聊天伪装成「评论区互动」。
 * 热门评论 = 其他用户（模型列表，假评论文案）；
 * 点「回复」即与之建立会话：你的评论是你的消息，对方的回复以
 * 新评论卡片的形式逐字出现在你的评论下面（含“正在撰写评论…”指示）。
 */

const $ = s => document.querySelector(s);

const state = {
  token: localStorage.getItem('jm_token') || '',
  me: null,
  threads: {},        // peerId -> {agent, convId, ws, seen:Set, lastTS, repliesEl}
  target: null,       // 当前回复目标 {id, name}
  pending: new Set(),
};

const AVA_COLORS = ['#b8860b', '#3f7ae0', '#2fa96c', '#9b6ef3', '#e5533f', '#0ea5b7', '#d97706'];
const FAKE_COMMENTS = [
  'AI 不会取代人类，但会用 AI 的人会取代不会用的人。与其焦虑，不如先学着用起来。',
  '说个亲身经历：客服十秒回复，语气好到不像话，后来才知道对面挂的是大模型。时代的眼泪。',
  '辨认 AI 与人这件事，往后大概会变成一种新的社交礼仪：不问，不失礼。',
  '游戏 NPC 能陪你聊到凌晨三点，哪怕明知是真人扮演，那种陪伴感也是真实的。',
  '我倒觉得重点是“像不像”不重要，“负责不负责”才重要。AI 说了错话谁担责？',
  '科技向善的前提是设计者向善。界面可以伪装，动机不能。',
];

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

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return '今天 ' + d.toTimeString().slice(0, 5);
  return `${d.getMonth() + 1}-${d.getDate()} ${d.toTimeString().slice(0, 5)}`;
}

/* canvas 头图：文字化抽象构成 */
function drawArt(cv, seed, title) {
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  const gs = ['#1b2027', '#3f4756', '#5b6472', '#b8860b', '#e8e2d4'];
  let s = seed * 7919 + 3;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
  ctx.fillStyle = gs[0];
  ctx.fillRect(0, 0, w, h);
  // 报纸式竖列
  const cols = 6 + Math.floor(rnd() * 4);
  const cw = w / cols;
  for (let i = 0; i < cols; i++) {
    ctx.fillStyle = rnd() > .82 ? gs[3] : gs[1 + Math.floor(rnd() * 2)];
    let y = 10 + rnd() * 30;
    while (y < h - 20) {
      const bh = 6 + rnd() * 26;
      if (rnd() > .25) ctx.fillRect(i * cw + 4, y, cw - 8, bh);
      y += bh + 6;
    }
  }
  ctx.fillStyle = 'rgba(232,226,212,.9)';
  ctx.font = `700 ${Math.round(h / 7)}px Georgia, "Noto Serif SC", serif`;
  ctx.fillText(title.slice(0, 12), 18, h - 22);
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

function showAuth() { $('#authOverlay').classList.remove('hidden'); }

function doLogout() {
  localStorage.removeItem('jm_token');
  state.token = '';
  state.me = null;
  renderUser();
}

let nRegMode = false;
$('#nTabLogin').onclick = () => { nRegMode = false; $('#nTabLogin').classList.add('active'); $('#nTabReg').classList.remove('active'); };
$('#nTabReg').onclick = async () => {
  nRegMode = true;
  $('#nTabReg').classList.add('active');
  $('#nTabLogin').classList.remove('active');
  if (!$('#nName').value) {
    try { const d = await api('/api/model-suggest'); $('#nName').value = d.name || ''; } catch {}
  }
};

$('#authFormN').onsubmit = async e => {
  e.preventDefault();
  $('#nErr').textContent = '';
  try {
    const d = nRegMode
      ? await api('/api/register', { body: { name: $('#nName').value.trim(), password: $('#nPass').value } })
      : await api('/api/login', { body: { name: $('#nName').value.trim(), password: $('#nPass').value } });
    state.token = d.token;
    localStorage.setItem('jm_token', d.token);
    state.me = d.user;
    $('#authOverlay').classList.add('hidden');
    renderUser();
    $('#myAva').textContent = (d.user.nickname[0] || '?').toUpperCase();
    loadThreads();
    toast('欢迎，' + d.user.nickname);
  } catch (ex) { $('#nErr').textContent = ex.message; }
};

function renderUser() {
  const box = $('#userBox');
  if (state.me) {
    box.innerHTML = `<span class="nuser">评论身份：<b>${state.me.nickname}</b></span>`;
    $('#myAva').textContent = (state.me.nickname[0] || '?').toUpperCase();
  } else {
    box.innerHTML = '<button class="nlogin" id="btnLogin">登录</button>';
    $('#btnLogin').onclick = showAuth;
  }
}

/* ---------- 首页 ---------- */
const SIDE = [
  ['国际', '多国联合发布人工智能安全评估框架，首批覆盖 12 类场景'],
  ['科技', '芯片制程竞赛进入新阶段：1.4nm 良率首次突破 80%'],
  ['生活', '城市 15 分钟生活圈指南：把菜场、书店和公园装进步行半径'],
  ['财经', '三季度消费数据解读：体验型消费增长 21%，什么在被重新买单'],
  ['评论', '当客服十秒回复：我们该如何跟"永远在线"相处'],
];

function renderHome() {
  drawArt($('#leadArt'), 11, '当 AI 开始说人话');
  const list = $('#sideList');
  list.innerHTML = '';
  SIDE.forEach((it, i) => {
    const d = document.createElement('div');
    d.className = 'side-item';
    const cat = document.createElement('div');
    cat.className = 's-meta';
    cat.textContent = it[0] + ' · ' + (2 + i) + ' 小时前';
    const h = document.createElement('h3');
    h.textContent = it[1];
    d.append(cat, h);
    d.onclick = () => openArticle();
    list.appendChild(d);
  });
  $('#leadArticle').onclick = openArticle;
}

function openArticle() {
  $('#homeView').classList.add('hidden');
  $('#articleView').classList.remove('hidden');
  window.scrollTo(0, 0);
  drawArt($('#artBanner'), 29, '智能边界');
  loadThreads();
}

$('#btnBack').onclick = () => {
  $('#articleView').classList.add('hidden');
  $('#homeView').classList.remove('hidden');
};

/* ---------- 评论区 ---------- */
async function loadThreads() {
  const box = $('#hotComments');
  box.innerHTML = '<div class="cmt-card"><div class="cmt-row"><div class="cmt-main"><div class="cmt-text" style="color:#707a86">评论加载中…</div></div></div></div>';
  try {
    const d = await api('/api/models');
    const agents = d.models || [];
    box.innerHTML = '';
    if (!agents.length) {
      box.innerHTML = '<div class="cmt-card"><div class="cmt-text" style="color:#707a86">还没有网友评论，来抢沙发？</div></div>';
      return;
    }
    // 为每个网友建立/恢复会话线程
    agents.forEach((m, i) => {
      box.appendChild(buildThreadCard(m, i));
    });
    await refreshExistingConvs(agents);
    updateCount();
  } catch (e) { toast(e.message); }
}

async function refreshExistingConvs(agents) {
  const d = await api('/api/conversations');
  for (const c of d.conversations || []) {
    const agent = agents.find(a => a.id === c.peer_id);
    if (!agent) continue;
    const th = ensureThread(agent);
    if (th.convId) continue;
    th.convId = c.id;
    const h = await api(`/api/conversations/${c.id}/messages`);
    for (const m of h.messages || []) {
      th.seen.add(m.id);
      if (m.ts > th.lastTS) th.lastTS = m.ts;
      if (m.sender_id === state.me.id) addReply(th, state.me.nickname, m.content, true, true);
      else addReply(th, agent.name, m.content, true);
    }
    if (h.messages && h.messages.length) th.repliesEl.classList.remove('hidden');
    connectWS(th);
  }
}

function buildThreadCard(agent, i) {
  const th = ensureThread(agent);
  const card = document.createElement('div');
  card.className = 'cmt-card';
  const row = document.createElement('div');
  row.className = 'cmt-row';
  const ava = document.createElement('span');
  ava.className = 'cmt-ava';
  ava.style.background = AVA_COLORS[i % AVA_COLORS.length];
  ava.textContent = (agent.name[0] || '网').toUpperCase();
  const main = document.createElement('div');
  main.className = 'cmt-main';
  const name = document.createElement('div');
  name.className = 'cmt-name';
  name.innerHTML = `<span>${agent.name}</span><span class="cmt-badge">热评</span><span class="cmt-time">${1 + i} 小时前</span>`;
  const text = document.createElement('div');
  text.className = 'cmt-text';
  text.textContent = FAKE_COMMENTS[i % FAKE_COMMENTS.length];
  const actions = document.createElement('div');
  actions.className = 'cmt-actions';
  const like = document.createElement('span');
  let likes = 40 + hashN(agent.name, 260);
  like.textContent = `👍 ${likes}`;
  like.onclick = () => { likes++; like.textContent = `👍 ${likes}`; like.style.color = '#8a6508'; };
  const reply = document.createElement('span');
  reply.textContent = '💬 回复';
  reply.onclick = () => {
    state.target = { id: agent.id, name: agent.name };
    $('#replyHint').textContent = `正在回复 ${agent.name} 的评论…`;
    $('#cmtInput').focus();
    ensureThreadLive(th, agent);
  };
  actions.append(like, reply);
  main.append(name, text, actions);
  row.append(ava, main);
  card.appendChild(row);
  // 回复容器（你与对方的往来评论）
  const replies = document.createElement('div');
  replies.className = 'replies hidden';
  card.appendChild(replies);
  th.repliesEl = replies;
  th.card = card;
  return card;
}

function ensureThread(agent) {
  if (!state.threads[agent.id]) {
    state.threads[agent.id] = { agent, convId: null, ws: null, seen: new Set(), lastTS: 0, repliesEl: null, card: null };
  }
  return state.threads[agent.id];
}

/* ---------- 发评论 / 回复 ---------- */
$('#cmtSend').onclick = async () => {
  if (!state.me) { showAuth(); return; }
  const input = $('#cmtInput');
  const text = input.value.trim();
  if (!text) return;
  if (!state.target) { toast('先点击某条热评下的「回复」，对方会认真回应你'); return; }
  const th = ensureThread(state.threads[state.target.id].agent);
  input.value = '';
  try {
    ensureThreadLive(th, agent);
    const cmid = Date.now() + '-' + Math.random().toString(36).slice(2);
    state.pending.add(cmid);
    addReply(th, state.me.nickname, text, true, true); // 乐观渲染
    const send = () => th.ws.send(JSON.stringify({ type: 'msg', content: text, client_msg_id: cmid }));
    if (th.ws && th.ws.readyState === 1) send();
    else th.pendingSend = send;
  } catch (e) { toast(e.message); }
};

function ensureThreadLive(th, agent) {
  if (th.convId) { connectWS(th); return; }
  api('/api/conversations/with', { body: { peer_id: agent.id } }).then(d => {
    th.convId = d.conversation.id;
    connectWS(th);
  }).catch(e => toast(e.message));
}

function connectWS(th) {
  if (th.ws) { try { th.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${proto}://${location.host}/ws?conv=${encodeURIComponent(th.convId)}&token=${encodeURIComponent(state.token)}`
  );
  th.ws = ws;
  ws.onmessage = e => { try { handleEvent(th, JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    if (th.convId && th.ws === ws) setTimeout(() => { if (th.ws === ws) connectWS(th); }, 3000);
  };
  ws.onopen = () => {
    if (th.pendingSend) { const f = th.pendingSend; th.pendingSend = null; f(); }
  };
}

function handleEvent(th, ev) {
  if (ev.conv_id && th.convId && ev.conv_id !== th.convId) return;
  if (ev.type === 'msg') {
    if (th.seen.has(ev.id)) return;
    th.seen.add(ev.id);
    if (ev.ts > th.lastTS) th.lastTS = ev.ts;
    if (ev.sender_id === state.me.id) {
      if (ev.client_msg_id && state.pending.has(ev.client_msg_id)) { state.pending.delete(ev.client_msg_id); return; }
      addReply(th, state.me.nickname, ev.content, true, true);
    } else {
      addReply(th, th.agent.name, ev.content, false);
    }
  }
  // typing 事件在评论区伪装为“对方正在撰写评论…”
  if (ev.type === 'typing' && ev.sender_id !== state.me.id) showTypingReply(th);
}

function showTypingReply(th) {
  if (!th.repliesEl || th.repliesEl.querySelector('.typing-reply')) return;
  th.repliesEl.classList.remove('hidden');
  const t = document.createElement('div');
  t.className = 'typing-reply';
  t.textContent = '一位网友正在撰写评论…';
  th.repliesEl.appendChild(t);
  scrollIntoViewSoft(t);
  setTimeout(() => { if (t.isConnected) t.remove(); }, 8000);
}

function scrollIntoViewSoft(el) {
  setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
}

function addReply(th, name, content, mine, instant = false) {
  th.repliesEl.classList.remove('hidden');
  const typing = th.repliesEl.querySelector('.typing-reply');
  if (typing) typing.remove();
  const row = document.createElement('div');
  row.className = 'reply' + (mine ? '' : ' flash');
  const ava = document.createElement('span');
  ava.className = 'cmt-ava';
  ava.style.background = mine ? '#b8860b' : AVA_COLORS[hashN(name, AVA_COLORS.length)];
  ava.textContent = (name[0] || '?').toUpperCase();
  const main = document.createElement('div');
  main.className = 'cmt-main';
  const meta = document.createElement('div');
  meta.className = 'cmt-name';
  meta.innerHTML = `<span>${name}</span><span class="cmt-time">${fmtTime(Math.floor(Date.now() / 1000))}</span>`;
  const text = document.createElement('div');
  text.className = 'cmt-text';
  main.append(meta, text);
  row.append(ava, main);
  th.repliesEl.appendChild(row);
  scrollIntoViewSoft(row);

  if (instant) { text.textContent = content; updateCount(); return Promise.resolve(); }
  // 网友的回复逐字“写”出来
  return new Promise(resolve => {
    let i = 0;
    const chunk = Math.max(1, Math.round(content.length / 120));
    const step = () => {
      i = Math.min(content.length, i + chunk);
      text.textContent = content.slice(0, i);
      if (i < content.length) setTimeout(step, 18);
      else { updateCount(); resolve(); }
    };
    setTimeout(step, 150);
  });
}

function updateCount() {
  let n = 0;
  for (const k in state.threads) {
    const th = state.threads[k];
    if (th.repliesEl) n += th.repliesEl.querySelectorAll('.reply').length;
    n += 1; // 热评本体
  }
  $('#cmtNum').textContent = `(${n})`;
  $('#cmtCount').textContent = `${n} 条评论`;
}

/* ---------- init ---------- */
async function init() {
  const now = new Date();
  $('#todayLine').textContent =
    `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · 星期${'日一二三四五六'[now.getDay()]}`;
  renderHome();
  if (state.token) {
    try {
      const d = await api('/api/me');
      state.me = d.user;
    } catch {}
  }
  renderUser();
}

init();
