'use strict';

/* NEXUS TERMINAL
 * 伪装成一个 AI 命令行终端：attach 到某个“智能代理”（实际是另一个用户）后，
 * 你输入的每一行都会发给对方；对方敲的字以“代理输出”的形式逐字打印回来。
 */

const $ = s => document.querySelector(s);

const state = {
  token: localStorage.getItem('nx_token') || '',
  me: null,
  models: [],              // 其他用户（= 可 attach 的代理）
  attached: null,          // {id, name, color, convId}
  ws: null,
  pending: new Set(),
  lastTS: {},              // convId -> ts（离线通知轮询）
  seen: new Set(),
  spinTimer: 0,
  spinFrame: 0,
  typingBy: null,
  colors: ['#48e08b', '#5ad7ff', '#ff9bd2', '#ffd166', '#b49bff', '#7fe1e8'],
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
  if (res.status === 401) { doLogout(); throw new Error('session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('request failed (' + res.status + ')'));
  return data;
}

/* ---------- terminal output ---------- */
const linesEl = $('#lines'), scrollEl = $('#scroll'), cmdEl = $('#cmd'), promptEl = $('#promptEl');

function addLine(text, cls = '', html = false) {
  const div = document.createElement('div');
  div.className = 'line' + (cls ? ' ' + cls : '');
  if (html) div.innerHTML = text; else div.textContent = text;
  linesEl.appendChild(div);
  scrollEl.scrollTop = scrollEl.scrollHeight;
  return div;
}

function printPrompt(cmdText) {
  const div = document.createElement('div');
  div.className = 'line cmd';
  const p = document.createElement('span');
  p.className = 'p';
  p.textContent = promptText();
  const t = document.createElement('span');
  t.textContent = ' ' + cmdText;
  div.append(p, t);
  linesEl.appendChild(div);
  scrollEl.scrollTop = scrollEl.scrollHeight;
}

function promptText() {
  return state.attached
    ? `${state.me.username}@nexus:~/session/${state.attached.name}$`
    : `${state.me ? state.me.username : 'visitor'}@nexus:~$`;
}

function refreshPrompt() { promptEl.textContent = promptText(); }

const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinEl = null;
function startSpin(text) {
  stopSpin();
  spinEl = addLine('', 'sys');
  state.spinFrame = 0;
  state.spinTimer = setInterval(() => {
    state.spinFrame = (state.spinFrame + 1) % spinFrames.length;
    spinEl.textContent = spinFrames[state.spinFrame] + ' ' + text;
  }, 90);
  spinEl.textContent = spinFrames[0] + ' ' + text;
}
function stopSpin() {
  clearInterval(state.spinTimer);
  if (spinEl) { spinEl.remove(); spinEl = null; }
}

/* agent output block with typewriter */
function printAgent(name, color, text, dim = false, instant = false) {
  const block = document.createElement('div');
  block.className = 'agent-block' + (dim ? ' dim' : '');
  block.style.setProperty('--ac', color);
  const head = document.createElement('div');
  head.className = 'a-head';
  head.textContent = '[ ' + name + ' ]';
  const body = document.createElement('div');
  body.className = 'a-body';
  const meta = document.createElement('div');
  meta.className = 'a-meta';
  meta.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' · 推理完成';
  block.append(head, body, meta);
  linesEl.appendChild(block);
  scrollEl.scrollTop = scrollEl.scrollHeight;

  if (instant) { body.textContent = text; return Promise.resolve(); }
  return new Promise(resolve => {
    let i = 0;
    const chunk = Math.max(1, Math.round(text.length / 220));
    const step = () => {
      i = Math.min(text.length, i + chunk);
      body.textContent = text.slice(0, i);
      scrollEl.scrollTop = scrollEl.scrollHeight;
      if (i < text.length) setTimeout(step, 10);
      else resolve();
    };
    setTimeout(step, 120);
  });
}

/* ---------- boot ---------- */
const bootLine = $('#bootLine'), bootEl = $('#boot'), termEl = $('#term');

async function bootSeq() {
  const steps = [
    'initializing secure shell ...',
    'loading agent runtime v3.2.1 ...',
    'mounting neural bus ... ok',
    'link established. authentication required.',
  ];
  for (const s of steps) {
    bootLine.textContent = s;
    await new Promise(r => setTimeout(r, 260));
  }
  if (state.token) {
    try {
      const d = await api('/api/me');
      state.me = d.user;
      bootEl.classList.add('hidden');
      termEl.classList.remove('hidden');
      motd();
      return;
    } catch {}
  }
  bootLine.textContent = 'authentication required.';
  $('#authForm').classList.remove('hidden');
  $('#authName').focus();
}
motd.toString();

function motd() {
  addLine('Welcome to NEXUS Terminal (agent-runtime 3.2.1)', 'ok');
  addLine('已登录身份: ' + state.me.nickname, 'sys');
  addLine('输入 help 查看可用命令。', 'sys');
  refreshPrompt();
  cmdEl.focus();
}

/* ---------- auth ---------- */
let regMode = false;
$('#btnToggleReg').onclick = () => {
  regMode = !regMode;
  $('#regActions').classList.toggle('hidden', !regMode);
  $('#btnToggleReg').textContent = regMode ? 'return to login' : 'register a new agent identity';
  $('#authMsg').textContent = '';
};

$('#authForm').onsubmit = async e => {
  e.preventDefault();
  const name = $('#authName').value.trim();
  const pass = $('#authPass').value;
  const msg = $('#authMsg');
  msg.textContent = '';
  try {
    let d;
    if (regMode) {
      if ($('#authPass2').value !== pass) throw new Error('passwords do not match');
      d = await api('/api/register', { body: { name, password: pass } });
    } else {
      d = await api('/api/login', { body: { name, password: pass } });
    }
    state.token = d.token;
    localStorage.setItem('nx_token', d.token);
    state.me = d.user;
    bootEl.classList.add('hidden');
    termEl.classList.remove('hidden');
    motd();
  } catch (err) {
    msg.textContent = 'auth failed: ' + err.message;
  }
};

function doLogout() {
  localStorage.removeItem('nx_token');
  state.token = '';
  location.reload();
}

/* ---------- models / attach ---------- */
async function loadModels() {
  const d = await api('/api/models');
  state.models = d.models || [];
  return state.models;
}

async function attach(name) {
  const m = state.models.find(x => x.name === name || x.id === name);
  if (!m) { addLine('attach: agent not found. run `models` to list agents.', 'err'); return; }
  if (state.attached && state.attached.id === m.id) {
    addLine('already attached to ' + m.name, 'warn');
    return;
  }
  if (state.attached) detach(true);
  startSpin('establishing agent session with ' + m.name + ' ...');
  try {
    const d = await api('/api/conversations/with', { body: { peer_id: m.id } });
    stopSpin();
    const color = state.colors[m.name.length % state.colors.length];
    state.attached = { id: m.id, name: m.name, color, convId: d.conversation.id };
    state.seen = new Set();
    addLine('attached to agent [' + m.name + '] · session ' + d.conversation.id.slice(0, 8), 'ok');
    addLine('此后你输入的每一行都会发送给该代理；代理的回复会实时打印到终端。`detach` 断开。', 'sys');
    // 回放历史
    const h = await api(`/api/conversations/${state.attached.convId}/messages`);
    for (const msg of h.messages || []) {
      state.seen.add(msg.id);
      if (msg.ts > (state.lastTS[state.attached.convId] || 0)) state.lastTS[state.attached.convId] = msg.ts;
      if (msg.sender_id === state.me.id) {
        addLine(' you ▸ ' + msg.content, 'sys');
      } else {
        await printAgent(state.attached.name, state.attached.color, msg.content, true, true);
      }
    }
    refreshPrompt();
    connectWS();
  } catch (err) {
    stopSpin();
    addLine('attach failed: ' + err.message, 'err');
  }
}

function detach(silent = false) {
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  if (state.attached) {
    if (!silent) addLine('detached from ' + state.attached.name, 'sys');
    state.attached = null;
  }
  state.seen = new Set();
  refreshPrompt();
}

/* ---------- websocket ---------- */
function connectWS() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${proto}://${location.host}/ws?conv=${encodeURIComponent(state.attached.convId)}&token=${encodeURIComponent(state.token)}`
  );
  state.ws = ws;
  ws.onmessage = e => { try { handleEvent(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    if (state.attached && state.ws === ws) setTimeout(() => { if (state.attached) connectWS(); }, 2500);
  };
}

function handleEvent(ev) {
  if (!state.attached) return;
  if (ev.type === 'typing') {
    if (ev.sender_id !== state.me.id && !spinEl) {
      startSpin(state.attached.name + ' is thinking ... (ESC detach)');
    }
  } else if (ev.type === 'msg') {
    if (state.seen.has(ev.id)) return;
    state.seen.add(ev.id);
    if (ev.ts > (state.lastTS[state.attached.convId] || 0)) state.lastTS[state.attached.convId] = ev.ts;
    if (ev.sender_id === state.me.id) {
      if (ev.client_msg_id && state.pending.has(ev.client_msg_id)) { state.pending.delete(ev.client_msg_id); return; }
      addLine(' you ▸ ' + ev.content, 'sys');
    } else {
      stopSpin();
      printAgent(state.attached.name, state.attached.color, ev.content);
    }
  }
}

function sendLine(text) {
  if (!state.attached) { addLine('not attached to any agent. run: attach <agent>', 'err'); return; }
  if (!state.ws || state.ws.readyState !== 1) { addLine('link down, retrying ...', 'warn'); return; }
  const cmid = Date.now() + '-' + Math.random().toString(36).slice(2);
  state.pending.add(cmid);
  state.ws.send(JSON.stringify({ type: 'msg', content: text, client_msg_id: cmid }));
}

/* ---------- commands ---------- */
const HELP = [
  ['help', '显示本帮助'],
  ['models', '列出可用的智能代理'],
  ['attach <agent>', '接入某个代理的会话（之后输入的行会发给它）'],
  ['detach', '断开当前代理会话'],
  ['status', '查看当前会话状态'],
  ['whoami', '查看当前身份'],
  ['clear', '清屏'],
];

async function exec(raw) {
  const line = raw.trim();
  printPrompt(line);
  if (!line) return;
  const [cmd, ...args] = line.split(/\s+/);
  const arg = args.join(' ');

  if (cmd === 'clear') { linesEl.innerHTML = ''; return; }
  if (cmd === 'help') {
    for (const [c, d] of HELP) addLine('  ' + c.padEnd(18) + d, 'sys');
    return;
  }
  if (cmd === 'whoami') {
    addLine('identity : ' + state.me.nickname + ' (agent id ' + state.me.id.slice(0, 8) + ')', 'sys');
    addLine('runtime  : nexus agent-runtime 3.2.1', 'sys');
    return;
  }
  if (cmd === 'status') {
    if (state.attached) {
      addLine('session  : attached → [' + state.attached.name + '] conv ' + state.attached.convId.slice(0, 8), 'ok');
    } else {
      addLine('session  : detached (no agent). run `models` then `attach <agent>`', 'warn');
    }
    return;
  }
  if (cmd === 'models') {
    const ms = await loadModels();
    if (!ms.length) { addLine('no agents online.', 'warn'); return; }
    addLine('available agents (' + ms.length + '):', 'sys');
    for (const m of ms) {
      const color = state.colors[m.name.length % state.colors.length];
      addLine('  ● ' + m.name.padEnd(18) + 'status: online', 'ok');
      document.querySelectorAll('.line.ok');
    }
    addLine('attach 一下试试: attach ' + ms[0].name, 'sys');
    return;
  }
  if (cmd === 'attach') {
    if (!arg) { addLine('usage: attach <agent>', 'err'); return; }
    await loadModels();
    await attach(arg);
    return;
  }
  if (cmd === 'detach') { detach(); return; }
  if (cmd === 'neofetch') {
    addLine(
'      .--.        guest@nexus\n' +
'     |o_o |       ------------\n' +
'     |:_/ |       OS: NexusOS 3.2.1\n' +
'    //   \\ \\      Shell: nexus-term\n' +
'   (|     | )     Agents: ' + (await loadModels()).length + ' online\n' +
'  /\'\\_   _/`\\     Uptime: since you logged in\n' +
'  \\___)=(___/     Role: ' + state.me.nickname, 'sys');
    return;
  }

  // 附着状态下，其余输入都当作发给代理的消息
  if (state.attached) { sendLine(line); return; }
  addLine('nexus: command not found: ' + cmd + '  (try `help`)', 'err');
}

cmdEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) {
    const v = cmdEl.value;
    cmdEl.value = '';
    exec(v);
  } else if (e.key === 'Escape' && state.attached) {
    detach();
  }
});

/* ---------- 离线消息提示（轮询） ---------- */
setInterval(async () => {
  if (!state.token || !state.me || document.hidden) return;
  try {
    const d = await api('/api/conversations');
    for (const c of d.conversations || []) {
      const known = state.lastTS[c.id] || 0;
      if (c.last_ts > known && (!state.attached || state.attached.convId !== c.id)) {
        state.lastTS[c.id] = c.last_ts;
        addLine('[*] new message from ' + (c.peer_nickname || c.title) + ' — type: attach ' + (c.peer_nickname || ''), 'warn');
      }
    }
  } catch {}
}, 5000);

bootSeq();
