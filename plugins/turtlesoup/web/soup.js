// 海龟汤插件前端：群聊内嵌游戏面板 + 主持人快捷回复。
// 伪装约定：谜底只出现在主持人本机的面板里；快捷按钮只对主持人渲染；
// 开局/揭晓走普通消息通道（与普通聊天相同的密文/圆孔/通知伪装）。
(function () {
  if (window.__tsLoaded) return;
  window.__tsLoaded = true;
  const API = '/api/plugins/turtle-soup';
  const gs = { conv: null, game: null, timer: null };

  // 注册群聊创建模式（新建对话时可选：普通对话 / 海龟汤对话）
  CNGP.roomMode({ id: 'turtle-soup', label: '海龟汤' });

  // ---- 样式 ----
  const style = document.createElement('style');
  style.textContent = `
.ts-panel { margin: 14px auto 6px; max-width: 720px; width: calc(100% - 32px); background: #262626;
  border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 14px 16px; font-size: 14px; }
.ts-panel .ts-tag { display: inline-block; font-size: 12px; color: #ffb86b; background: rgba(255,184,107,.12);
  border-radius: 999px; padding: 2px 10px; margin-bottom: 8px; }
.ts-panel .ts-riddle { color: #e6e6e6; line-height: 1.7; white-space: pre-wrap; }
.ts-panel .ts-answer { margin-top: 10px; padding: 10px 12px; border-radius: 10px; background: rgba(255,184,107,.08);
  color: #d8c9a8; line-height: 1.7; white-space: pre-wrap; }
.ts-panel .ts-hint { margin-top: 8px; font-size: 12.5px; color: #9b9b9b; }
.ts-panel .ts-row { margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap; }
.ts-btn { padding: 7px 16px; border-radius: 9px; font-size: 13.5px; border: 1px solid rgba(255,255,255,.14); color: #e6e6e6; }
.ts-btn.primary { background: #fff; color: #0d0d0d; border-color: #fff; font-weight: 600; }
.ts-btn.primary:hover { background: #e3e3e3; }
.ts-btn:hover { background: rgba(255,255,255,.07); }
.ts-list { display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto; margin: 10px 0; }
.ts-story { text-align: left; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,.09); background: #232323; }
.ts-story .r { color: #ddd; font-size: 13.5px; line-height: 1.6; }
.ts-story .m { margin-top: 6px; font-size: 12px; color: #9b9b9b; display: flex; gap: 8px; align-items: center; }
.ts-story .m .pick { margin-left: auto; }
.ts-upform { border-top: 1px solid rgba(255,255,255,.08); margin-top: 12px; padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.ts-upform textarea { width: 100%; min-height: 64px; resize: vertical; background: #1e1e1e; color: #e6e6e6;
  border: 1px solid rgba(255,255,255,.12); border-radius: 9px; padding: 8px 10px; }
.ts-upform .lbl { font-size: 12.5px; color: #9b9b9b; }
`;
  document.head.appendChild(style);

  // ---- 工具 ----
  const ctx = () => CNGP.context();
  const curConv = () => { const c = ctx().conv; return c ? c.id : null; };
  function isSoupCandidate() { const c = ctx().conv; return c && c.kind === 1; }
  function amHost() { const c = ctx().conv; return c && c.creator_id === ctx().me.id; }
  function sendText(t, replyTo) { CNGP.send(t, { replyTo: replyTo || '' }); }

  // ---- 基座 hook：cngp:conv-opened（契约见 plugins/README.md） ----
  CNGP.on('conv-opened', detail => {
    clearInterval(gs.timer); gs.timer = null;
    tsOnConv(detail && detail.id);
  });

  function tsOnConv(id) {
    gs.conv = id; gs.game = null;
    CNGP.drawer.setPanel(null);
    if (!isSoupCandidate() || curConv() !== id) return;
    tsRefresh();
    gs.timer = setInterval(() => {
      if (isSoupCandidate() && curConv() === gs.conv) tsRefresh();
      else { clearInterval(gs.timer); gs.timer = null; }
    }, 15000);
  }

  async function tsRefresh() {
    if (!isSoupCandidate() || !curConv()) return;
    let soup = false, g = null;
    try {
      const d = await CNGP.api(API + '/games?conv_id=' + encodeURIComponent(curConv()));
      soup = !!d.soup;
      g = d.game || null;
    } catch (e) { return; }
    gs.game = g;
    if (soup) {
      CNGP.drawer.setPanel({ title: '海龟汤', render: el => tsRenderInto(el) });
    } else {
      CNGP.drawer.setPanel(null);
    }
    tsRescanActions();
    tsRescanActions();
  }

  // ---- 游戏面板 ----

  function tsRenderInto(el) {
    el.replaceChildren();
    const p = document.createElement('div');
    p.id = 'tsPanel';
    p.className = 'ts-panel';
    el.appendChild(p);
    const tag = document.createElement('span'); tag.className = 'ts-tag';
    const riddleEl = document.createElement('div'); riddleEl.className = 'ts-riddle';
    const row = document.createElement('div'); row.className = 'ts-row';

    if (!gs.game) {
      tag.textContent = '🍲 海龟汤 · 未开始';
      riddleEl.textContent = amHost()
        ? '选一个故事本开始游戏：系统会把谜面发到群里，只有你能看到谜底。'
        : '等待主持人选故事本开始游戏。';
      if (amHost()) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'ts-btn primary'; b.textContent = '选择故事本';
        b.onclick = () => tsOpenStoryPicker(curConv());
        row.appendChild(b);
      }
      p.append(tag, riddleEl, row);
      return;
    }
    tag.textContent = gs.game.phase === 2 ? '🍲 海龟汤 · 已揭晓' : '🍲 海龟汤 · 进行中';
    riddleEl.textContent = '谜面：' + gs.game.riddle;
    p.append(tag, riddleEl);
    if (gs.game.answer) {
      // 谜底伪装：CNGP.secureBlock 覆盖行（密文 + 悬停透视），跟随思考伪装开关
      p.appendChild(CNGP.secureBlock('谜底：' + gs.game.answer, {
        tag: '谜底', key: 'ts-ans-' + gs.game.story_id, className: 'ts-answer-row',
      }));
    } else {
      const h = document.createElement('div'); h.className = 'ts-hint';
      h.textContent = gs.game.is_host
        ? '对成员的消息点快捷按钮即可回复「是 / 不是 / 是也不是 / 无关」。'
        : '直接在下方提问，主持人会回复「是 / 不是 / 是也不是 / 无关」。';
      p.appendChild(h);
    }
    if (gs.game.is_host && gs.game.phase === 1) {
      const end = document.createElement('button'); end.type = 'button'; end.className = 'ts-btn'; end.textContent = '结束游戏并揭晓';
      end.onclick = async () => {
        end.disabled = true;
        try {
          const d = await CNGP.api(API + '/games/' + encodeURIComponent(curConv()) + '/end', { method: 'POST' });
          gs.game = d.game;
          sendText('谜底揭晓：' + gs.game.answer);
          CNGP.drawer.refresh();
        } catch (e) { CNGP.toast(e.message); end.disabled = false; }
      };
      row.appendChild(end);
    }
    p.appendChild(row);
  }

  // ---- 故事本选择 + 上传（主持人开局） ----
  function tsOpenStoryPicker(convID) {
    const { panel, close } = openPicker('选择海龟汤故事本');
    const list = document.createElement('div'); list.className = 'ts-list';
    const upload = document.createElement('div'); upload.className = 'ts-upform';
    const lbl1 = document.createElement('span'); lbl1.className = 'ts-upform lbl'; lbl1.textContent = '上传自己的故事本（谜底只有你能看到，别人可以拿它玩）';
    const riddle = document.createElement('textarea'); riddle.placeholder = '谜面（5–2000 字）';
    const answer = document.createElement('textarea'); answer.placeholder = '谜底（2–2000 字，仅保存，不公开）';
    const upBtn = document.createElement('button'); upBtn.type = 'button'; upBtn.className = 'ts-btn primary'; upBtn.textContent = '上传故事本';
    const status = document.createElement('span'); status.className = 'ts-upform lbl';

    upBtn.onclick = async () => {
      upBtn.disabled = true; status.textContent = '';
      try {
        await CNGP.api(API + '/stories', { body: { riddle: riddle.value.trim(), answer: answer.value.trim() } });
        CNGP.toast('故事本已上传');
        riddle.value = ''; answer.value = '';
        await fillList();
      } catch (e) { status.textContent = e.message; }
      upBtn.disabled = false;
    };

    async function fillList() {
      list.replaceChildren();
      const loading = document.createElement('div'); loading.className = 'ts-story'; loading.textContent = '加载中…';
      list.appendChild(loading);
      let stories = [];
      try { stories = (await CNGP.api(API + '/stories')).stories || []; }
      catch (e) { loading.textContent = '加载失败：' + e.message; return; }
      list.replaceChildren();
      if (!stories.length) { list.textContent = '暂无故事本'; return; }
      for (const s of stories) {
        const item = document.createElement('div'); item.className = 'ts-story';
        const r = document.createElement('div'); r.className = 'r'; r.textContent = s.riddle;
        const meta = document.createElement('div'); meta.className = 'm';
        const tag = document.createElement('span'); tag.textContent = s.system ? '内置' : (s.mine ? '我上传的' : '他人上传');
        const del = document.createElement('button'); del.type = 'button'; del.className = 'ts-btn'; del.textContent = '删除';
        del.onclick = async () => {
          try { await CNGP.api(API + '/stories/' + encodeURIComponent(s.id), { method: 'DELETE' }); await fillList(); }
          catch (e) { CNGP.toast(e.message); }
        };
        const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'ts-btn primary pick'; pick.textContent = '用它开局';
        pick.onclick = async () => {
          pick.disabled = true;
          try {
            const d = await CNGP.api(API + '/games', { body: { conv_id: convID || curConv(), story_id: s.id } });
            gs.game = d.game;
            close();
            sendText('🍲 海龟汤开锅！谜面：\n' + d.game.riddle + '\n（主持人已拿到谜底，大家开始提问吧）');
            CNGP.drawer.refresh();
          } catch (e) { CNGP.toast(e.message); pick.disabled = false; }
        };
        meta.append(tag);
        if (s.mine) meta.append(del);
        meta.append(pick);
        item.append(r, meta);
        list.appendChild(item);
      }
    }
    fillList();
    upload.append(lbl1, riddle, answer, upBtn, status);
    panel.append(list, upload);
  }
  window.tsOpenStoryPicker = tsOpenStoryPicker;

  // 新建房间时选择了海龟汤模式：进入房间自动打开选本
  CNGP.on('room-created', detail => {
    if (detail && detail.mode === 'turtle-soup' && detail.conv) {
      CNGP.api(API + '/rooms', { body: { conv_id: detail.conv.id } })
        .then(() => { tsOnConv(detail.conv.id); })
        .catch(() => {});
      if (ctx().me && detail.conv.creator_id === ctx().me.id) tsOpenStoryPicker(detail.conv.id);
    }
  });

  // ---- 主持人快捷回复：在他人消息的操作条上注入 是/不是/是也不是/无关 ----
  // 快捷回复：沿用点赞/点踩的图标按钮形态，功能变为发出对应裁决
  const tsThumbIcon = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><path d="M7 10v10H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h3Zm0 0 4-7a2 2 0 0 1 2-1c1.1 0 2 .9 2 2v5h4a3 3 0 0 1 2.9 3.8l-1.7 6A3 3 0 0 1 17.3 21H7" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const tsBothIcon = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6"/><path d="M12 3.5v17" stroke="currentColor" stroke-width="1.6"/></svg>';
  const tsIrrelevantIcon = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6"/><path d="M5.8 5.8l12.4 12.4" stroke="currentColor" stroke-width="1.6"/></svg>';
  const TS_QUICKS = [
    { label: '是', icon: tsThumbIcon },
    { label: '不是', icon: tsThumbIcon, down: true },
    { label: '是也不是', icon: tsBothIcon },
    { label: '无关', icon: tsIrrelevantIcon },
  ];
  function tsAugmentActions(row) {
    if (!isSoupCandidate() || !gs.game || gs.game.phase !== 1 || !gs.game.is_host) return;
    const actions = row.querySelector('.msg-actions');
    if (!actions || actions.querySelector('.ts-quick')) return;
    // 摘掉原点赞/点踩（位置与形态保留，语义变为快捷裁决），保留复制/刷新
    actions.querySelectorAll('button[aria-pressed]').forEach(b => b.remove());
    const replyTo = row.dataset.mid || '';
    for (const q of TS_QUICKS) {
      const b = document.createElement('button');
      b.type = 'button'; b.title = q.label; b.setAttribute('aria-label', q.label); b.innerHTML = q.icon;
      b.className = 'ts-quick' + (q.down ? ' thumb-down' : '');
      b.onclick = () => sendText(q.label, replyTo);
      actions.appendChild(b);
    }
  }
  function tsRescanActions() {
    document.querySelectorAll('#messages .msg-actions').forEach(a => {
      const row = a.closest('.msg-real, .msg-ai');
      if (row) tsAugmentActions(row);
    });
  }
  // ---- 基座 hook：cngp:message-actions（消息操作条渲染完成） ----
  CNGP.on('message-actions', detail => {
    try { tsAugmentActions(detail.row); } catch (err) { }
  });
  // 兜底：消息行可能在面板状态加载完成之后才流入（异步渲染），DOM 观察器补挂快捷按钮
  new MutationObserver(muts => {
    if (!isSoupCandidate() || !gs.game || gs.game.phase !== 1 || !gs.game.is_host) return;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.querySelector && n.querySelector('.msg-actions')) tsAugmentActions(n);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
