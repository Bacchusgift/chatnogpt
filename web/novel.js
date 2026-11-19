'use strict';

// 浏览器扩展只读取来源网站上当前可阅读的章节。登录凭据始终留在来源网站。
let novelModels = [];
let novelHistory = {};
let novelChapters = {};
let novelHistorySources = {};
let novelDialogueBusy = false;
let novelDialogueGeneration = 0;
let novelReaderRequest = null;
const novelFontCache = new Map();
const novelBridgePending = new Map();
let novelRevealShape = localStorage.getItem('cngp_reveal_shape') === 'rect' ? 'rect' : 'circle';
let novelRevealWidth = Math.max(80, Math.min(700, Number(localStorage.getItem('cngp_reveal_width')) || 300));
let novelRevealHeight = Math.max(80, Math.min(700, Number(localStorage.getItem('cngp_reveal_height')) || 195));
let novelBridgeAvailable = false;

window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.channel === 'cngp-reader-ready') { novelBridgeAvailable = true; return; }
  if (event.data?.channel !== 'cngp-reader-response') return;
  novelBridgeAvailable = true;
  const pending = novelBridgePending.get(event.data.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  novelBridgePending.delete(event.data.id);
  pending.resolve(event.data.response);
});

async function novelLoad() {
  try {
    const d = await api('/api/custom-models');
    novelModels = d.models || [];
    try { novelHistory = JSON.parse(localStorage.getItem('cngp_novel_history_' + state.me.id) || '{}'); } catch { novelHistory = {}; }
    try { novelChapters = JSON.parse(localStorage.getItem('cngp_novel_chapters_' + state.me.id) || '{}'); } catch { novelChapters = {}; }
    try { novelHistorySources = JSON.parse(localStorage.getItem('cngp_novel_history_sources_' + state.me.id) || '{}'); } catch { novelHistorySources = {}; }
    purgeLocalArchives();
    let changed = false;
    for (const m of novelModels) {
      const oldSource = novelHistorySources[m.id];
      const staleChapter = novelChapters[m.id] && novelChapters[m.id].sourceURL !== m.url;
      if ((oldSource !== undefined && oldSource !== m.url) || staleChapter) {
        delete novelChapters[m.id];
        delete novelHistory[m.id];
        changed = true;
      } else if (novelHistory[m.id]?.some(item => item.sourceURL !== undefined && item.sourceURL !== m.url)) {
        novelHistory[m.id] = novelHistory[m.id].filter(item => item.sourceURL === undefined || item.sourceURL === m.url);
        changed = true;
      }
      if (oldSource !== m.url) { novelHistorySources[m.id] = m.url; changed = true; }
    }
    if (changed) novelSave();
    renderConvList();
  } catch (e) { toast(e.message); }
}

function novelSave() {
  try {
    localStorage.setItem('cngp_novel_history_' + state.me.id, JSON.stringify(novelHistory));
    localStorage.setItem('cngp_novel_chapters_' + state.me.id, JSON.stringify(novelChapters));
    localStorage.setItem('cngp_novel_history_sources_' + state.me.id, JSON.stringify(novelHistorySources));
  } catch { toast('浏览器存储空间不足，请减少已导入的章节'); }
}

function novelRenderList(list) {
  for (const m of novelModels) {
    if (archivedConvs().has('novel:' + m.id) !== showArchivedConvs) continue;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'conv-item' + (state.cur === 'novel:' + m.id ? ' active' : '');
    b.textContent = m.name;
    b.onclick = () => { novelSelect(m); closeSidebarMobile(); };
    appendConversationListItem(list, b, 'novel:' + m.id);
  }
}

function novelSourceKind(raw) {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    if (url.hostname === 'fanqienovel.com' && /^\/(reader|page)\/\d+$/.test(url.pathname)) return 'fanqie';
    if ((url.hostname === 'www.jjwxc.net' || url.hostname === 'jjwxc.net') &&
        url.pathname === '/onebook.php' && /^\d+$/.test(url.searchParams.get('novelid') || '') &&
        (!url.searchParams.has('chapterid') || /^\d+$/.test(url.searchParams.get('chapterid') || ''))) return 'jinjiang';
  } catch {}
  return '';
}

function novelSourceLabel(m) { return novelSourceKind(m.url) === 'jinjiang' ? '晋江' : '番茄'; }

function novelSelect(m) {
  novelDialogueGeneration++;
  novelDialogueBusy = false;
  hideTyping();
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.cur = 'novel:' + m.id;
  state.gen++; state.queue = []; state.animating = false;
  state.thinkingRow = null;
  hideTyping();
  state.curInfo = null;
  state.lastRenderTS = 0;
  $('#btnRenameConv').classList.add('hidden');
  setTarget(m);
  state.target.custom = true;
  $('#convTitle').textContent = m.name;
  const box = $('#messages'); box.innerHTML = '';
  const controls = document.createElement('div'); controls.className = 'novel-controls';
  if (novelSourceKind(m.url)) {
    novelAddFanqieControls(controls, m);
  } else if (m.url) {
    const link = document.createElement('a'); link.href = m.url;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '打开来源 ↗';
    controls.appendChild(link);
  } else {
    const upload = document.createElement('button'); upload.type = 'button'; upload.textContent = '上传 TXT';
    upload.onclick = () => novelUploadTXT(m); controls.appendChild(upload);
  }
  box.appendChild(controls);
  if (novelSourceKind(m.url)) novelReaderPanel(box, m);
  $('#msgScroll').onclick = event => {
    if (state.cur !== 'novel:' + m.id || event.target.closest('button, a, .novel-browser')) return;
    novelDialogueNext(m);
  };
  for (const item of novelHistory[m.id] || []) {
    if (item.own) {
      if (!item.localID) item.localID = crypto.randomUUID();
      appendOwn(item.text, item.ts, null, item.imageID, item.localID);
    } else {
      for (const paragraph of item.text.split(/\n\s*\n/).filter(Boolean)) novelReply(m, paragraph, item.ts, item.fontURL, !!item.dialogue);
    }
  }
  renderConvList(); scrollBottom(true);
}

function novelBridgeRequest(op, m) {
  return new Promise(resolve => {
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
    const timer = setTimeout(() => {
      novelBridgePending.delete(id);
      const injected = document.documentElement.dataset.cngpReaderBridge === 'ready';
      resolve({ error: injected
        ? '聊天页未收到扩展回复（桥接版本 ' +
          (document.documentElement.dataset.cngpReaderBridgeVersion || '未知') + '）；请重新加载扩展并刷新聊天页。'
        : '扩展脚本尚未进入聊天页；请重新加载扩展并强制刷新聊天页（⌘⇧R）。' });
    }, novelBridgeAvailable ? 45000 : 2500);
    novelBridgePending.set(id, { resolve, timer });
    const current = novelChapters[m.id];
    const chapterURL = (op === 'next' || op === 'previous') && current?.sourceURL === m.url &&
      novelSourceKind(current.url) === novelSourceKind(m.url)
      ? current.url : m.url;
    window.postMessage({ channel: 'cngp-reader-request', id, op, url: chapterURL,
      before: current?.sourceURL === m.url ? { url: current.url, text: current.text } : null }, location.origin);
  });
}

function novelReaderPanel(box, m) {
  const panel = document.createElement('section'); panel.className = 'novel-browser'; panel.dataset.modelId = m.id;
  const toolbar = document.createElement('div'); toolbar.className = 'novel-browser-toolbar';
  const title = document.createElement('strong'); title.className = 'novel-browser-title'; title.textContent = '浏览器预览';
  const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '上一章';
  previous.onclick = () => novelReaderControl('previous', m);
  const next = document.createElement('button'); next.type = 'button'; next.textContent = '下一章';
  next.onclick = () => novelReaderControl('next', m);
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '连接 / 刷新';
  refresh.onclick = () => novelReaderControl('attach', m);
  const collapse = document.createElement('button'); collapse.type = 'button'; collapse.textContent = '折叠阅读框';
  collapse.onclick = () => {
    if (panel.dataset.chapterReady !== '1') { toast('请先连接并读取正文'); return; }
    panel.classList.add('collapsed', 'dialogue-on');
    novelDialogueStatus(m);
  };
  const source = document.createElement('a'); source.href = m.url; source.target = '_blank';
  source.rel = 'noopener noreferrer'; source.textContent = '在浏览器中打开 ↗';
  toolbar.append(title, previous, next, refresh, collapse, source);
  const status = document.createElement('div'); status.className = 'novel-browser-status';
  status.textContent = '点击“连接 / 刷新”，读取已登录的' + novelSourceLabel(m) + '标签页。';
  const content = document.createElement('article'); content.className = 'novel-browser-content';
  const compact = document.createElement('div'); compact.className = 'novel-compact';
  const compactLabel = document.createElement('div'); compactLabel.className = 'ai-label';
  compactLabel.textContent = m.name;
  const compactBubble = document.createElement('button'); compactBubble.type = 'button';
  compactBubble.className = 'novel-compact-bubble';
  compactBubble.textContent = '我们可以从一个简单的问题开始，逐步整理相关信息。';
  compactBubble.onclick = () => novelDialogueNext(m);
  const compactActions = document.createElement('div'); compactActions.className = 'novel-compact-actions';
  const compactCopy = document.createElement('button'); compactCopy.type = 'button';
  compactCopy.title = '复制'; compactCopy.setAttribute('aria-label', '复制');
  compactCopy.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.8"/></svg>';
  compactCopy.onclick = async () => { try { await navigator.clipboard.writeText(compactBubble.textContent); toast('已复制'); } catch { toast('复制失败'); } };
  const compactRefresh = document.createElement('button'); compactRefresh.type = 'button';
  compactRefresh.title = '展开阅读框'; compactRefresh.setAttribute('aria-label', '展开阅读框');
  compactRefresh.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 9A7 7 0 0 1 18 7l2 2M4 15l2 2a7 7 0 0 0 12.5-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  compactRefresh.onclick = () => { panel.classList.remove('collapsed', 'dialogue-on'); novelDialogueStatus(m); };
  const compactPrevious = document.createElement('button'); compactPrevious.type = 'button';
  compactPrevious.textContent = '<'; compactPrevious.title = '上一章'; compactPrevious.setAttribute('aria-label', '上一章');
  compactPrevious.onclick = () => novelReaderControl('previous', m);
  const compactNext = document.createElement('button'); compactNext.type = 'button';
  compactNext.textContent = '>'; compactNext.title = '下一章'; compactNext.setAttribute('aria-label', '下一章');
  compactNext.onclick = () => novelReaderControl('next', m);
  compactActions.append(compactCopy, compactPrevious, compactNext, compactRefresh);
  addMessageVotes(compactActions);
  compact.append(compactLabel, compactBubble, compactActions);
  panel.append(toolbar, status, content, compact);
  panel.dataset.chapterReady = '0';
  novelCoverSetup(panel);
  box.appendChild(panel);
  const saved = novelChapters[m.id]?.sourceURL === m.url ? novelChapters[m.id] : null;
  if (saved?.text) novelReaderRender(m, saved, false);
}

const novelScienceParagraphs = [
  '我们每天看到的天空颜色，来自阳光与大气分子的相互作用。太阳光包含多种颜色；波长较短的蓝光更容易被空气散射，因此白天从不同方向进入眼睛的光常带有蓝色。',
  '到了日落时，阳光穿过的大气路径变长。蓝光在途中被散射得更多，抵达观察者的直射光便更偏向橙色和红色。这也是傍晚云层常显得温暖的原因。',
  '海洋能够储存大量热量。水的比热容较高，同样吸收一份能量时，它的温度上升幅度通常比陆地小。沿海地区因而常有较温和的昼夜与季节温差。',
  '植物利用叶绿体进行光合作用，把光能转化为化学能。这个过程还会吸收二氧化碳并释放氧气，是许多生态系统食物和能量的起点。',
  '人体的生物钟并不是一只真正的钟，而是一套约二十四小时循环的调节系统。光线、进食和活动时间都能影响它，所以规律作息有助于稳定睡眠节律。',
  '声音需要介质传播。空气里的振动让我们听见说话声，水和固体也能传声；真空中缺少传递振动的粒子，因此普通声音无法穿过真空。',
  '温度描述的是物体内部粒子运动状态的一个宏观量。热量总会自发地从高温处流向低温处，直到两者逐渐接近平衡。保温材料的作用，是放慢这一过程。',
  '地球的四季主要由地轴倾斜造成。地球公转时，不同地区接收阳光的角度和时长发生变化。夏季白昼较长、太阳位置较高，地面获得的太阳能也更多。',
  '互联网传输信息时，会把数据拆成许多小包。每个包带有目标地址，经过网络设备转发后在目的地重新组合。分包方式使网络能够灵活处理不同路径和负载。',
  '科学解释通常从可检验的问题开始。提出假设后，通过观察或实验收集证据，再根据结果修正认识。一个可靠的结论，也应当经得起其他人重复检验。'
];

function novelCoverTextFor(key) {
  return novelScienceParagraphs[coverKeyHash(String(key)) % novelScienceParagraphs.length];
}

function novelDialogueText(text) {
  return String(text || '');
}

function novelCoverSetup(panel) {
  const cover = document.createElement('div'); cover.className = 'novel-cover';
  const heading = document.createElement('div'); heading.className = 'novel-cover-heading';
  heading.textContent = '日常知识 · 科学如何解释身边的现象';
  const intro = document.createElement('div'); intro.className = 'novel-cover-intro';
  intro.textContent = '下面从光、声音、生命与地球环境几个角度，了解常见现象背后的原理。';
  const body = document.createElement('div'); body.className = 'novel-cover-body';
  for (const paragraph of novelScienceParagraphs) {
    const p = document.createElement('p'); p.textContent = paragraph; body.appendChild(p);
  }
  cover.append(heading, intro, body);
  panel.appendChild(cover);
  const outline = document.createElement('div'); outline.className = 'novel-reveal-outline';
  panel.appendChild(outline);
  panel.dataset.revealShape = novelRevealShape;
  panel.dataset.revealMode = 'setup';
  panel.dataset.revealHasSelection = '0';
  const setup = document.createElement('div'); setup.className = 'novel-reveal-setup';
  const prompt = document.createElement('span'); prompt.textContent = '拖动鼠标选择透视范围';
  const circle = document.createElement('button'); circle.type = 'button'; circle.textContent = '圆形';
  const rect = document.createElement('button'); rect.type = 'button'; rect.textContent = '矩形';
  const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = '确认'; confirm.disabled = true;
  const chooseShape = shape => {
    novelRevealShape = shape;
    localStorage.setItem('cngp_reveal_shape', shape);
    panel.dataset.revealShape = shape;
    circle.classList.toggle('active', shape === 'circle');
    rect.classList.toggle('active', shape === 'rect');
  };
  circle.onclick = () => chooseShape('circle');
  rect.onclick = () => chooseShape('rect');
  chooseShape(novelRevealShape);
  confirm.onclick = () => {
    if (panel.dataset.revealHasSelection !== '1') return;
    panel.dataset.revealMode = 'active';
  };
  setup.append(prompt, circle, rect, confirm); panel.appendChild(setup);
  let dragStart = null;
  const position = event => {
    const rect = panel.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    if (dragStart) {
      const left = Math.min(x, dragStart.x), top = Math.min(y, dragStart.y);
      const width = Math.max(40, Math.abs(x - dragStart.x));
      const height = Math.max(40, Math.abs(y - dragStart.y));
      novelSetReveal(panel, left + width / 2, top + height / 2,
        novelRevealShape === 'circle' ? Math.max(width, height) : width,
        novelRevealShape === 'circle' ? Math.max(width, height) : height);
    } else if (panel.dataset.revealMode === 'active') {
      novelSetReveal(panel, x, y, novelRevealWidth,
        novelRevealShape === 'circle' ? novelRevealWidth : novelRevealHeight);
    }
  };
  panel.addEventListener('pointermove', position);
  cover.addEventListener('pointerdown', event => {
    if (!state.coverMode || panel.dataset.revealMode !== 'setup' || event.button !== 0) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    dragStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    panel.dataset.revealHasSelection = '1';
    cover.setPointerCapture(event.pointerId);
    position(event);
  });
  cover.addEventListener('pointerup', event => {
    if (!dragStart) return;
    position(event);
    novelRevealWidth = Math.round(parseFloat(panel.style.getPropertyValue('--novel-w')) || novelRevealWidth);
    novelRevealHeight = Math.round(parseFloat(panel.style.getPropertyValue('--novel-h')) || novelRevealHeight);
    localStorage.setItem('cngp_reveal_width', String(novelRevealWidth));
    localStorage.setItem('cngp_reveal_height', String(novelRevealHeight));
    dragStart = null;
    confirm.disabled = false;
  });
  cover.addEventListener('pointercancel', () => {
    dragStart = null;
    panel.dataset.revealHasSelection = '0';
    confirm.disabled = true;
  });
  cover.addEventListener('scroll', () => {
    const content = panel.querySelector('.novel-browser-content');
    const limit = cover.scrollHeight - cover.clientHeight;
    content.scrollTop = limit > 0 ? cover.scrollTop / limit * (content.scrollHeight - content.clientHeight) : 0;
  });
}

function novelSetReveal(panel, x, y, width, height) {
  panel.style.setProperty('--novel-fx', x + 'px');
  panel.style.setProperty('--novel-fy', y + 'px');
  panel.style.setProperty('--novel-w', width + 'px');
  panel.style.setProperty('--novel-h', height + 'px');
  panel.style.setProperty('--novel-left', (x - width / 2) + 'px');
  panel.style.setProperty('--novel-top', (y - height / 2) + 'px');
}

function novelCoverMode(max) {
  if (max) novelResetRevealSelection();
  document.querySelectorAll('#messages .novel-ai .novel-disguise-toggle').forEach(button => {
    const disguised = novelDisguiseActive(button.closest('.novel-ai'));
    button.title = disguised ? '除去伪装' : '穿上伪装';
    button.setAttribute('aria-label', button.title);
  });
}

function novelDisguiseActive(row) {
  return row.classList.contains('novel-force-cover') ||
    (state.coverMode && !row.classList.contains('novel-force-clear'));
}

function novelResetRevealSelection() {
  document.querySelectorAll('.novel-browser').forEach(panel => {
    panel.dataset.revealMode = 'setup';
    panel.dataset.revealHasSelection = '0';
    panel.querySelector('.novel-reveal-setup button:last-child').disabled = true;
    panel.querySelector('.novel-cover').scrollTop = 0;
  });
}

async function novelReaderControl(op, m) {
  const panel = document.querySelector('.novel-browser[data-model-id="' + CSS.escape(m.id) + '"]');
  if (!panel || novelReaderRequest) return;
  const status = panel.querySelector('.novel-browser-status');
  status.textContent = op === 'next' ? '正在读取下一章…' : op === 'previous' ? '正在读取上一章…' :
    '正在连接' + novelSourceLabel(m) + '标签页…';
  const requestedURL = m.url;
  const request = {};
  novelReaderRequest = request;
  let progress = null;
  let timer = null;
  if (panel.classList.contains('collapsed') && panel.classList.contains('dialogue-on')) {
    progress = document.createElement('div'); progress.className = 'novel-reader-progress';
    const progressLabel = document.createElement('div'); progressLabel.className = 'ai-label'; progressLabel.textContent = m.name;
    const heading = document.createElement('div'); heading.className = 'novel-reader-progress-heading';
    const spinner = document.createElement('span'); spinner.className = 'novel-reader-spinner';
    const thinking = document.createElement('span'); thinking.className = 'thinking-text'; thinking.textContent = '思考中';
    const elapsed = document.createElement('span'); elapsed.className = 'thinking-sec';
    elapsed.textContent = '1s';
    const started = Date.now();
    timer = setInterval(() => { elapsed.textContent = Math.max(1, Math.round((Date.now() - started) / 1000)) + 's'; }, 400);
    heading.append(spinner, thinking, elapsed);
    const hint = document.createElement('div'); hint.className = 'novel-reader-progress-hint';
    hint.textContent = op === 'next' ? '正在读取下一章，请稍候…' : op === 'previous' ? '正在读取上一章，请稍候…' : '正在读取当前章节，请稍候…';
    progress.append(progressLabel, heading, hint);
    $('#messages').appendChild(progress);
    scrollFollow();
  }
  let result;
  try { result = await novelBridgeRequest(op, m); }
  finally { if (timer) clearInterval(timer); progress?.remove(); if (novelReaderRequest === request) novelReaderRequest = null; }
  if (state.cur !== 'novel:' + m.id || novelModels.find(model => model.id === m.id)?.url !== requestedURL) return;
  if (result?.error) { status.textContent = result.error; toast(result.error); return; }
  if (result?.opened) { status.textContent = result.message; toast(result.message); return; }
  if (typeof result?.text !== 'string' || result.text.length < 100) {
    status.textContent = novelSourceLabel(m) + '标签页没有可显示的完整章节'; toast(status.textContent); return;
  }
  if ((op === 'next' || op === 'previous') && novelChapters[m.id]?.url === result.url && novelChapters[m.id]?.text === result.text) {
    status.textContent = '来源页面仍是当前章节，请检查来源标签页'; toast(status.textContent); return;
  }
  novelReaderRender(m, result, true);
}

function novelReaderRender(m, chapter, save) {
  const panel = document.querySelector('.novel-browser[data-model-id="' + CSS.escape(m.id) + '"]');
  if (!panel) return;
  const family = novelFontFamily(chapter.fontURL);
  if (novelSourceKind(m.url) === 'fanqie' && !family && /[\uE000-\uF8FF]/.test(chapter.text)) {
    panel.querySelector('.novel-browser-status').textContent = '无法加载番茄章节字体'; return;
  }
  panel.querySelector('.novel-browser-title').textContent = chapter.title || '浏览器预览';
  panel.querySelector('.novel-browser-status').textContent = '已连接 · ' +
    (chapter.paragraphs || chapter.text.split('\n\n').length) + ' 段';
  const content = panel.querySelector('.novel-browser-content');
  content.textContent = chapter.text;
  content.style.fontFamily = family || '';
  content.scrollTop = 0;
  panel.dataset.chapterReady = '1';
  const changedChapter = !!novelChapters[m.id]?.text &&
    (novelChapters[m.id].url !== chapter.url || novelChapters[m.id].text !== chapter.text);
  if (changedChapter) {
    novelDialogueGeneration++;
    novelDialogueBusy = false;
    hideTyping();
    const box = $('#messages');
    box.querySelectorAll('.novel-ai').forEach(row => row.remove());
    novelHistory[m.id] = (novelHistory[m.id] || []).filter(item => item.own);
    box.querySelectorAll('.time-divider').forEach(divider => {
      if (!divider.nextElementSibling || divider.nextElementSibling.classList.contains('time-divider')) divider.remove();
    });
  }
  if (save) {
    const prior = novelChapters[m.id];
    novelChapters[m.id] = { sourceURL: m.url, url: chapter.url, title: chapter.title, text: chapter.text,
      fontURL: chapter.fontURL, paragraphs: chapter.paragraphs,
      dialogueIndex: prior?.url === chapter.url && prior.text === chapter.text ? prior.dialogueIndex || 0 : 0 };
    novelSave();
  }
  novelDialogueStatus(m);
}

function novelDialogueStatus(m) {
  const panel = document.querySelector('.novel-browser[data-model-id="' + CSS.escape(m.id) + '"]');
  if (!panel) return;
  const chapter = novelChapters[m.id];
  if (!panel.classList.contains('dialogue-on')) {
    if (chapter?.text) panel.querySelector('.novel-browser-status').textContent = '已连接 · ' +
      (chapter.paragraphs || chapter.text.split('\n\n').length) + ' 段';
    return;
  }
  const paragraphs = chapter?.text?.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean) || [];
  panel.querySelector('.novel-browser-status').textContent = '已连接 · ' + paragraphs.length + ' 段';
}

async function novelDialogueNext(m) {
  const panel = document.querySelector('.novel-browser[data-model-id="' + CSS.escape(m.id) + '"]');
  if (!panel?.classList.contains('dialogue-on') || novelDialogueBusy) return;
  const chapter = novelChapters[m.id];
  if (!chapter?.text || chapter.sourceURL !== m.url) return;
  const paragraphs = chapter.text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const index = chapter.dialogueIndex || 0;
  if (index >= paragraphs.length) { novelDialogueStatus(m); return; }
  novelDialogueBusy = true;
  const generation = novelDialogueGeneration;
  const paragraph = novelDialogueText(paragraphs[index]);
  showTyping(m.name);
  scrollBottom(true);
  await new Promise(resolve => setTimeout(resolve, 800));
  if (generation !== novelDialogueGeneration || state.cur !== 'novel:' + m.id) return;
  hideTyping();
  const ts = Math.floor(Date.now() / 1000);
  const body = novelReply(m, paragraph, ts, chapter.fontURL, true);
  chapter.dialogueIndex = index + 1;
  novelRemember(m, { text: paragraph, ts, fontURL: chapter.fontURL, dialogue: true });
  const row = body.closest('.novel-ai');
  const glyphs = Array.from(state.coverMode ? novelCoverTextFor(row.dataset.msgKey) : paragraph);
  const output = state.coverMode ? row.querySelector('.cover-body') : body;
  if (state.coverMode) row.classList.add('cover-typing');
  output.textContent = '';
  const cursor = document.createElement('span'); cursor.className = 'cursor';
  const typed = document.createTextNode(''); output.append(typed, cursor);
  for (let i = 0; i < glyphs.length; i += 2) {
    if (generation !== novelDialogueGeneration || state.cur !== 'novel:' + m.id) return;
    typed.textContent += glyphs.slice(i, i + 2).join('');
    if (i % 12 === 0) scrollFollow();
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  cursor.remove();
  row.classList.remove('cover-typing');
  novelDialogueBusy = false;
  scrollFollow();
}

function novelFontFamily(raw) {
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'https:' || !/^lf[36]-awef\.bytetos\.com$/.test(u.hostname) ||
      !u.pathname.endsWith('.woff2')) return '';
  if (!novelFontCache.has(u.href)) {
    const family = 'cngp-novel-' + novelFontCache.size;
    const style = document.createElement('style');
    style.textContent = '@font-face{font-family:"' + family + '";src:url("' + u.href + '") format("woff2");font-weight:400}';
    document.head.appendChild(style);
    novelFontCache.set(u.href, family);
  }
  return novelFontCache.get(u.href);
}

function novelReply(m, text, ts, fontURL = '', dialogueTyping = false) {
  text = novelDialogueText(text);
  if (ts) ensureDivider(ts);
  const { row, realWrap } = appendAIRow(m.name);
  row.classList.add('msg-real', 'novel-ai');
  row.dataset.modelId = m.id;
  row.dataset.lastTs = String(ts || 0);
  row.dataset.msgKey = msgKeyOf(null, m.name, text);
  row.dataset.nickname = m.name;
  if (ts) {
    const time = document.createElement('div'); time.className = 'msg-ai-time';
    time.textContent = fmtDividerLabel(ts); time.title = fullStamp(ts); realWrap.appendChild(time);
  }
  const body = document.createElement('div'); body.className = 'ai-body';
  body.textContent = text;
  if (fontURL) body.style.fontFamily = novelFontFamily(fontURL);
  realWrap.appendChild(body);
  row.appendChild(makeCoverLayer());
  coverTextInto(row);
  if (state.coverMode) { row.classList.add('covered'); bindFlashlight(row); }
  if (dialogueTyping) row.classList.add('novel-dialogue-message');
  const actions = document.createElement('div'); actions.className = 'novel-actions';
  const copy = document.createElement('button'); copy.type = 'button'; copy.title = '复制';
  copy.setAttribute('aria-label', '复制');
  copy.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.8"/></svg>';
  copy.onclick = async () => { try { await navigator.clipboard.writeText(body.textContent); toast('已复制'); } catch { toast('复制失败'); } };
  const previous = document.createElement('button'); previous.type = 'button';
  previous.textContent = '<'; previous.title = '上一章'; previous.setAttribute('aria-label', '上一章');
  previous.disabled = !novelSourceKind(m.url);
  previous.onclick = () => novelReaderControl('previous', m);
  const next = document.createElement('button'); next.type = 'button';
  next.textContent = '>'; next.title = '下一章'; next.setAttribute('aria-label', '下一章');
  next.disabled = !novelSourceKind(m.url);
  next.onclick = () => novelReaderControl('next', m);
  const disguise = document.createElement('button'); disguise.type = 'button';
  disguise.className = 'novel-disguise-toggle';
  disguise.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 9A7 7 0 0 1 18 7l2 2M4 15l2 2a7 7 0 0 0 12.5-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const syncDisguise = () => {
    disguise.title = novelDisguiseActive(row) ? '除去伪装' : '穿上伪装';
    disguise.setAttribute('aria-label', disguise.title);
  };
  syncDisguise();
  disguise.onclick = () => {
    if (novelDisguiseActive(row)) {
      row.classList.remove('novel-force-cover', 'reveal-active', 'flash');
      row.classList.add('novel-force-clear');
    } else {
      row.classList.remove('novel-force-clear');
      row.classList.add('novel-force-cover', 'covered');
      coverTextInto(row);
      bindFlashlight(row);
    }
    syncDisguise();
  };
  actions.append(copy, previous, next, disguise);
  addMessageVotes(actions);
  row.appendChild(actions);
  return body;
}

function novelRemember(m, item) {
  const entries = novelHistory[m.id] || [];
  const entry = { ...item, localID: item.localID || crypto.randomUUID(), sourceURL: m.url || '' };
  entries.push(entry);
  if (entries.length > 80) entries.splice(0, entries.length - 80);
  novelHistory[m.id] = entries;
  novelSave();
  return entry;
}

function novelUpdateOwnEntry(localID, recall, content) {
  const id = state.cur.startsWith('novel:') ? state.cur.slice(6) : '';
  const item = (novelHistory[id] || []).find(entry => entry.own && entry.localID === localID);
  if (!item) throw new Error('消息已不存在');
  if (item.text === '消息已撤回' && !item.imageID) throw new Error('消息已撤回');
  item.text = recall ? '消息已撤回' : content;
  if (recall) item.imageID = '';
  novelSave();
  return { content: item.text, image_id: item.imageID };
}

async function novelSend(text, imageID = '') {
  const m = novelModels.find(x => x.id === state.target.id);
  if (!m) return;
  novelDialogueGeneration++;
  novelDialogueBusy = false;
  hideTyping();
  if (state.cur !== 'novel:' + m.id) novelSelect(m);
  input.value = ''; autoGrow(); btnSend.disabled = true;
  const ts = Math.floor(Date.now() / 1000);
  const entry = novelRemember(m, { own: true, text, ts, imageID });
  appendOwn(text, ts, null, imageID, entry.localID);
  scrollFollow();
  if (!text) return;
  if (m.url) {
    if (novelSourceKind(m.url)) {
      const op = /^(上一章|上章)$/.test(text) ? 'previous' : /^(下一章|下章)$/.test(text) ? 'next' : 'attach';
      await novelReaderControl(op, m);
    } else {
      const reply = '请在来源网站打开这个链接。';
      const replyTS = Math.floor(Date.now() / 1000);
      novelReply(m, reply, replyTS); novelRemember(m, { text: reply, ts: replyTS });
    }
    return;
  }
  try {
    const d = await api('/api/custom-models/' + m.id + '/next', { method: 'POST', body: {} });
    const replyTS = Math.floor(Date.now() / 1000);
    novelReply(m, d.content || '已读完', replyTS);
    novelRemember(m, { text: d.content || '已读完', ts: replyTS });
  } catch (e) { toast(e.message); }
}

function novelAddFanqieControls(box, m) {
  const hint = document.createElement('div'); hint.className = 'novel-hint';
  hint.textContent = '你正在和 ' + m.name + ' 智能 Agent 对话';
  box.appendChild(hint);
}

async function novelUploadTXT(m) {
  const file = document.createElement('input'); file.type = 'file'; file.accept = '.txt,text/plain'; file.hidden = true;
  document.body.appendChild(file);
  file.onchange = async () => {
    try {
      const selected = file.files[0]; if (!selected) return;
      if (selected.size > 2 * 1024 * 1024) throw new Error('TXT 文件不能超过 2 MB');
      const text = await selected.text();
      await api('/api/custom-models/' + m.id + '/text', { method: 'PUT', body: { text } });
      toast('TXT 已上传，发送“继续”阅读');
    } catch (e) { toast(e.message); }
    finally { file.remove(); }
  };
  file.click();
}

function novelAddToMenu(menu) {
  for (const m of novelModels) {
    const row = document.createElement('div'); row.className = 'model-entry';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'model-item';
    const title = document.createElement('div'); title.className = 'm-name'; title.textContent = m.name;
    const desc = document.createElement('div'); desc.className = 'm-desc';
    desc.textContent = '智能 Agent';
    b.append(title, desc); b.onclick = () => { novelSelect(m); closeModelMenu(); };
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'model-edit';
    edit.textContent = '编辑链接'; edit.title = '编辑 ' + m.name + ' 的模型链接';
    edit.onclick = () => { closeModelMenu(); novelEditURLModal(m); };
    row.append(b, edit); menu.appendChild(row);
  }
  const add = document.createElement('button'); add.type = 'button'; add.className = 'model-item';
  add.textContent = '＋ 添加自定义模型'; add.onclick = () => { closeModelMenu(); novelCreateModal(); };
  menu.appendChild(add);
}

function novelEditURLModal(m) {
  const root = $('#modalRoot'); root.innerHTML = '';
  const overlay = document.createElement('div'); overlay.className = 'overlay';
  const form = document.createElement('form'); form.className = 'modal';
  const title = document.createElement('h3'); title.textContent = '编辑 ' + m.name + ' 的模型链接';
  const hint = document.createElement('p'); hint.className = 'modal-sub';
  hint.textContent = '保存后，点击“连接 / 刷新”读取新链接。';
  const url = document.createElement('input'); url.type = 'url'; url.placeholder = '模型链接（可选）';
  url.setAttribute('aria-label', '模型链接'); url.value = m.url || '';
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
  cancel.onclick = () => { root.innerHTML = ''; };
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn-primary'; save.textContent = '保存';
  actions.append(cancel, save); form.append(title, hint, url, actions); overlay.appendChild(form); root.appendChild(overlay);
  overlay.onclick = event => { if (event.target === overlay) root.innerHTML = ''; };
  form.onsubmit = async event => {
    event.preventDefault();
    const nextURL = url.value.trim();
    if (nextURL === (m.url || '')) { root.innerHTML = ''; return; }
    save.disabled = true;
    try {
      await api('/api/custom-models/' + encodeURIComponent(m.id) + '/url', {
        method: 'PUT', body: { url: nextURL },
      });
      m.url = nextURL;
      delete novelChapters[m.id];
      delete novelHistory[m.id];
      novelHistorySources[m.id] = nextURL;
      novelSave();
      root.innerHTML = '';
      if (state.cur === 'novel:' + m.id) novelSelect(m);
      toast('模型链接已更新，点击“连接 / 刷新”读取新内容');
    } catch (err) { toast(err.message); save.disabled = false; }
  };
  url.focus();
}

function novelCreateModal() {
  const root = $('#modalRoot'); root.innerHTML = '';
  const overlay = document.createElement('div'); overlay.className = 'overlay';
  const form = document.createElement('form'); form.className = 'modal';
  const h = document.createElement('h3'); h.textContent = '添加自定义模型';
  const sub = document.createElement('p'); sub.className = 'modal-sub';
  sub.textContent = '填写模型名称 Key 和模型链接；链接可稍后补充。';
  const name = document.createElement('input'); name.placeholder = '模型名称 Key'; name.setAttribute('aria-label', '模型名称 Key'); name.maxLength = 40; name.required = true;
  const url = document.createElement('input'); url.placeholder = '模型链接（可选）'; url.setAttribute('aria-label', '模型链接'); url.type = 'url';
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
  cancel.onclick = () => { root.innerHTML = ''; };
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn-primary'; save.textContent = '添加';
  actions.append(cancel, save); form.append(h, sub, name, url, actions); overlay.appendChild(form); root.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) root.innerHTML = ''; };
  form.onsubmit = async e => {
    e.preventDefault(); save.disabled = true;
    try {
      const d = await api('/api/custom-models', { body: { name: name.value.trim(), url: url.value.trim() } });
      root.innerHTML = ''; await novelLoad();
      novelSelect(novelModels.find(m => m.id === d.model.id) || d.model);
    } catch (err) { toast(err.message); save.disabled = false; }
  };
  name.focus();
}
