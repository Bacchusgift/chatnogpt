'use strict';

/* 云途 OA —— 企业协同办公平台。
 * 聊天伪装成「审批工作流」：你提交的申请事项 = 你的消息；
 * 审批员（另一个用户）的意见以流程节点卡片逐字写入时间线，
 * 打字时显示“审批员正在审阅…”；每条意见盖一枚绿色“已阅”章。
 */

const $ = s => document.querySelector(s);

const state = {
  token: localStorage.getItem('yt_token') || '',
  me: null,
  flows: {},          // convId -> flow {convId, peer, ws, seen, lastTS, nodesEl, title}
  cur: null,          // 当前打开的 convId
  pickTarget: null,   // 发起审批选择的审批员
  pending: new Set(),
};

const AUD_COLORS = ['#1f5bd7', '#2fa96c', '#9b6ef3', '#e5533f', '#0ea5b7'];
const AUD_TITLES = ['高级审批员', '资深审批员', '首席审批官', '审批专家'];

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

function fmt(ts) {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 5)}`;
}

function drawChart(cv) {
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  const data = [14, 22, 9, 28, 19, 32, 24];
  const days = ['一', '二', '三', '四', '五', '六', '日'];
  const max = Math.max(...data) * 1.2;
  const bw = 34, gap = (w - 40 - data.length * bw) / (data.length - 1);
  ctx.font = '12px sans-serif';
  data.forEach((v, i) => {
    const x = 20 + i * (bw + gap);
    const bh = (v / max) * (h - 46);
    const g = ctx.createLinearGradient(0, h - 24 - bh, 0, h - 24);
    g.addColorStop(0, '#5b8cf0'); g.addColorStop(1, '#1f5bd7');
    ctx.fillStyle = i === 5 ? '#2fa96c' : g;
    ctx.beginPath();
    ctx.roundRect(x, h - 24 - bh, bw, bh, 6);
    ctx.fill();
    ctx.fillStyle = '#7b8391';
    ctx.fillText(days[i], x + 10, h - 6);
    ctx.fillStyle = '#252b36';
    ctx.fillText(v, x + 9, h - 32 - bh);
  });
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
  if (res.status === 401) { doLogout(); throw new Error('登录已过期'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
  return data;
}

/* ---------- auth ---------- */
function showAuth() { $('#authView').classList.remove('hidden'); $('#appView').classList.add('hidden'); }
function showApp() {
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#meName').textContent = state.me.nickname;
  $('#meAva').textContent = (state.me.nickname[0] || '?').toUpperCase();
  loadFlows();
}

function doLogout() {
  localStorage.removeItem('yt_token');
  state.token = '';
  showAuth();
}

$('#authForm').onsubmit = async e => {
  e.preventDefault();
  const err = $('#authErr');
  err.textContent = '';
  try {
    const d = state.regMode
      ? await api('/api/register', { body: { name: $('#authName').value.trim(), password: $('#authPass').value } })
      : await api('/api/login', { body: { name: $('#authName').value.trim(), password: $('#authPass').value } });
    state.token = d.token;
    localStorage.setItem('yt_token', d.token);
    state.me = d.user;
    showApp();
  } catch (ex) { err.textContent = ex.message; }
};

let regModeW = false;
$('#btnRegMode').onclick = async () => {
  regModeW = !regModeW;
  state.regMode = regModeW;
  $('#authBtn').textContent = regModeW ? '注册并入职' : '安全登录';
  $('#btnRegMode').textContent = regModeW ? '已有账号？返回登录' : '新员工？自动分配审批员编号并注册';
  if (regModeW && !$('#authName').value) {
    try { const d = await api('/api/model-suggest'); $('#authName').value = d.name || ''; } catch {}
  }
};

/* ---------- views ---------- */
document.querySelectorAll('.side-nav button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.side-nav button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    const v = b.dataset.view;
    $('#dashView').classList.toggle('hidden', v !== 'dash');
    $('#flowView').classList.toggle('hidden', v !== 'flow');
    $('#viewTitle').textContent = v === 'flow' ? '审批中心' : '工作台';
  };
});

/* ---------- dashboard ---------- */
function refreshStats() {
  const n = Object.keys(state.flows).length;
  $('#statPending').textContent = n;
}

/* ---------- 审批单（会话） ---------- */
async function loadFlows() {
  try {
    const d = await api('/api/conversations');
    for (const c of d.conversations || []) {
      if (!state.flows[c.id]) {
        state.flows[c.id] = { convId: c.id, peer: c.peer_nickname || c.title, ws: null, seen: new Set(), lastTS: 0, nodesEl: null, pendingSend: null };
        const h = await api(`/api/conversations/${c.id}/messages`);
        const fl = state.flows[c.id];
        for (const m of h.messages || []) {
          fl.seen.add(m.id);
          if (m.ts > fl.lastTS) fl.lastTS = m.ts;
          if (m.sender_id === c.peer_id || m.sender_id === state.me.id) {
            if (!fl.titleText && m.sender_id === state.me.id) {
              fl.titleText = m.content.slice(0, 14) + (m.content.length > 14 ? '…' : '');
              fl.startedTS = m.ts;
            }
          }
        }
      }
    }
    renderFlowList();
    refreshStats();
  } catch (e) { toast(e.message); }
}

function renderFlowList() {
  const list = $('#flowList');
  list.innerHTML = '';
  const items = Object.values(state.flows);
  if (!items.length) {
    list.innerHTML = '<div class="flow-empty" style="padding:30px">暂无审批单<br>点击右上角 ＋ 发起</div>';
    return;
  }
  for (const fl of items) {
    const b = document.createElement('button');
    b.className = 'flow-item' + (state.cur === fl.convId ? ' on' : '');
    b.innerHTML = `<div class="fi-title">关于「${fl.titleText || '工作事项'}」的审批</div>
      <div class="fi-meta"><span class="fi-dot ${fl.awaiting ? 'active' : ''}"></span>审批员：${fl.peer} · ${fmt(fl.lastTS || Math.floor(Date.now() / 1000))}</div>`;
    b.onclick = () => openFlow(fl.convId);
    list.appendChild(b);
  }
}

/* ---------- 发起审批 ---------- */
async function openNewFlow() {
  if (!state.me) return;
  $('#newOverlay').classList.remove('hidden');
  $('#newErr').textContent = '';
  $('#flowText').value = '';
  state.pickTarget = null;
  const list = $('#auditorList');
  list.innerHTML = '<div class="a-meta">加载审批员列表…</div>';
  try {
    const d = await api('/api/models');
    const auds = d.models || [];
    list.innerHTML = '';
    if (!auds.length) { list.innerHTML = '<div class="a-meta">暂无可选审批员</div>'; return; }
    auds.forEach((m, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'auditor';
      const ava = document.createElement('span');
      ava.className = 'a-ava';
      ava.style.background = AUD_COLORS[i % AUD_COLORS.length];
      ava.textContent = (m.name[0] || '审').toUpperCase();
      const info = document.createElement('div');
      info.className = 'a-info';
      const nm = document.createElement('div');
      nm.className = 'a-name';
      nm.textContent = m.name;
      const meta = document.createElement('div');
      meta.className = 'a-meta';
      meta.textContent = AUD_TITLES[i % AUD_TITLES.length] + ' · 平均响应 ' + (5 + hashN(m.name, 50)) + ' 秒';
      info.append(nm, meta);
      b.append(ava, info);
      b.onclick = () => {
        state.pickTarget = m;
        document.querySelectorAll('.auditor').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
      };
      list.appendChild(b);
    });
  } catch (e) { toast(e.message); }
}

$('#btnNewFlow').onclick = openNewFlow;
$('#btnNewFlow2').onclick = openNewFlow;
$('#btnNewCancel').onclick = () => $('#newOverlay').classList.add('hidden');

$('#btnNewOk').onclick = async () => {
  if (!state.pickTarget) { $('#newErr').textContent = '请选择一位审批员'; return; }
  const text = $('#flowText').value.trim();
  if (!text) { $('#newErr').textContent = '请填写申请事项'; return; }
  try {
    const d = await api('/api/conversations/with', { body: { peer_id: state.pickTarget.id } });
    const convId = d.conversation.id;
    if (state.flows[convId]) {
      state.flows[convId].titleText = text.slice(0, 14) + (text.length > 14 ? '…' : '');
      state.flows[convId].startedTS = Math.floor(Date.now() / 1000);
      state.flows[convId].startedText = text;
    }
    await loadFlows();
    $('#newOverlay').classList.add('hidden');
    document.querySelector('[data-view="flow"]').click();
    await openFlow(convId);
    const fl = state.flows[convId];
    const cmid = Date.now() + '-' + Math.random().toString(36).slice(2);
    state.pending.add(cmid);
    const send = () => fl.ws.send(JSON.stringify({ type: 'msg', content: text, client_msg_id: cmid }));
    if (fl.ws && fl.ws.readyState === 1) send(); else fl.pendingSend = send;
    toast('审批单已提交');
  } catch (e) { $('#newErr').textContent = e.message; }
};

/* ---------- 审批单详情 ---------- */
async function openFlow(convId) {
  const fl = state.flows[convId];
  if (!fl) return;
  state.cur = convId;
  renderFlowList();
  $('#flowEmpty').classList.add('hidden');
  $('#flowDetail').classList.remove('hidden');
  $('#fdTitle').textContent = `关于「${fl.titleText || '工作事项'}」的审批`;
  $('#fdMeta').textContent = `单号 YT-${convId.slice(0, 8).toUpperCase()} · 审批员：${fl.peer} · 提交人：${state.me.nickname}`;
  const stamp = $('#fdStamp');
  stamp.textContent = fl.awaiting ? '审批中' : '已办结';
  stamp.style.borderColor = fl.awaiting ? '#e8a13c' : '#2fa96c';
  stamp.style.color = fl.awaiting ? '#e8a13c' : '#2fa96c';

  const tl = $('#timeline');
  tl.innerHTML = '';
  // 提交节点
  addNode(tl, '📝', state.me.nickname, fl.startedText || '（审批申请已提交）', fmt(fl.startedTS || fl.lastTS || Math.floor(Date.now() / 1000)), false, true);
  fl.nodesEl = tl;
  // 历史消息
  try {
    const h = await api(`/api/conversations/${convId}/messages`);
    for (const m of h.messages || []) {
      fl.seen.add(m.id);
      if (m.ts > fl.lastTS) fl.lastTS = m.ts;
      if (m.sender_id === state.me.id) addNode(tl, '📎', state.me.nickname + ' · 补充材料', m.content, fmt(m.ts), false, true);
      else addNode(tl, '🧑‍💼', fl.peer + ' · 审批意见', m.content, fmt(m.ts), true, true);
    }
  } catch (e) { toast(e.message); }
  connectFlowWS(fl);
}

function addNode(tl, icon, who, text, time, isAudit, instant = false) {
  const node = document.createElement('div');
  node.className = 't-node' + (isAudit ? ' audit' : '');
  const dot = document.createElement('div');
  dot.className = 't-dot';
  dot.textContent = icon;
  const body = document.createElement('div');
  body.className = 't-body';
  const head = document.createElement('div');
  head.className = 't-head';
  const whoEl = document.createElement('span');
  whoEl.className = 't-who';
  whoEl.textContent = who;
  const timeEl = document.createElement('span');
  timeEl.textContent = time;
  head.append(whoEl, timeEl);
  body.appendChild(head);
  if (isAudit) {
    const stamp = document.createElement('span');
    stamp.className = 't-stamp';
    stamp.textContent = '已阅';
    body.appendChild(stamp);
  }
  const textEl = document.createElement('div');
  textEl.className = 't-text';
  body.appendChild(textEl);
  node.append(dot, body);
  tl.appendChild(node);
  if (instant) { textEl.textContent = text; return Promise.resolve(); }
  return new Promise(resolve => {
    let i = 0;
    const chunk = Math.max(1, Math.round(text.length / 150));
    const step = () => {
      i = Math.min(text.length, i + chunk);
      textEl.textContent = text.slice(0, i);
      if (i < text.length) setTimeout(step, 16);
      else resolve();
    };
    setTimeout(step, 150);
  });
}

/* ---------- ws ---------- */
function connectFlowWS(fl) {
  if (fl.ws) { try { fl.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${proto}://${location.host}/ws?conv=${encodeURIComponent(fl.convId)}&token=${encodeURIComponent(state.token)}`
  );
  fl.ws = ws;
  ws.onmessage = e => { try { handleFlowEvent(fl, JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    if (state.cur === fl.convId && fl.ws === ws) setTimeout(() => { if (state.cur === fl.convId) connectFlowWS(fl); }, 3000);
  };
  ws.onopen = () => {
    if (fl.pendingSend) { const f = fl.pendingSend; fl.pendingSend = null; f(); }
  };
}

function handleFlowEvent(fl, ev) {
  if (ev.conv_id && ev.conv_id !== fl.convId) return;
  const tl = fl.nodesEl;
  if (!tl) return;
  if (ev.type === 'typing') {
    if (ev.sender_id !== state.me.id) {
      let t = tl.querySelector('.audit-typing');
      if (!t) {
        t = document.createElement('div');
        t.className = 't-node audit';
        t.innerHTML = `<div class="t-dot">🧑‍💼</div><div class="t-body"><div class="audit-typing">审批员 ${fl.peer} 正在审阅…</div></div>`;
        tl.appendChild(t);
        t.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(() => t.remove(), 10000);
      }
    }
  } else if (ev.type === 'msg') {
    if (fl.seen.has(ev.id)) return;
    fl.seen.add(ev.id);
    if (ev.ts > fl.lastTS) fl.lastTS = ev.ts;
    const typing = tl.querySelector('.audit-typing');
    if (typing) typing.closest('.t-node').remove();
    if (ev.sender_id === state.me.id) {
      if (ev.client_msg_id && state.pending.has(ev.client_msg_id)) { state.pending.delete(ev.client_msg_id); return; }
      addNode(tl, '📎', state.me.nickname + ' · 补充材料', ev.content, fmt(ev.ts), false);
    } else {
      fl.awaiting = false;
      addNode(tl, '🧑‍💼', fl.peer + ' · 审批意见', ev.content, fmt(ev.ts), true).then(() => {
        const stamp = $('#fdStamp');
        stamp.textContent = '已办结';
        stamp.style.borderColor = '#2fa96c';
        stamp.style.color = '#2fa96c';
      });
      toast('收到新的审批意见');
    }
  }
}

/* ---------- 补充材料 ---------- */
$('#fdSend').onclick = () => {
  const fl = state.flows[state.cur];
  if (!fl) return;
  const input = $('#fdInputText');
  const text = input.value.trim();
  if (!text) return;
  const cmid = Date.now() + '-' + Math.random().toString(36).slice(2);
  state.pending.add(cmid);
  const send = () => fl.ws.send(JSON.stringify({ type: 'msg', content: text, client_msg_id: cmid }));
  if (fl.ws && fl.ws.readyState === 1) send(); else fl.pendingSend = send;
  input.value = '';
};

$('#btnLogout').onclick = () => {
  api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
  localStorage.removeItem('yt_token');
  state.token = '';
  showAuth();
};

/* ---------- init ---------- */
async function init() {
  drawChart($('#chartCanvas'));
  if (state.token) {
    try {
      const d = await api('/api/me');
      state.me = d.user;
      showApp();
      return;
    } catch {}
  }
  showAuth();
}

init();
