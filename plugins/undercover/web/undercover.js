// 谁是卧底插件前端：右侧抽屉面板（暗词/玩家/投票）。
(function () {
  if (window.__ucLoaded) return;
  window.__ucLoaded = true;
  const API = '/api/plugins/undercover';
  const gs = { conv: null, view: null, timer: null };

  CNGP.roomMode({ id: 'undercover', label: '谁是卧底' });

  const ctx = () => CNGP.context();
  const curConv = () => { const c = ctx().conv; return c ? c.id : null; };
  function isGroup() { const c = ctx().conv; return c && c.kind === 1; }

  CNGP.on('conv-opened', detail => {
    clearInterval(gs.timer); gs.timer = null;
    gs.conv = detail && detail.id; gs.view = null;
    CNGP.drawer.setPanel(null);
    if (!isGroup() || curConv() !== gs.conv) return;
    tsRefresh();
    gs.timer = setInterval(() => {
      if (isGroup() && curConv() === gs.conv) tsRefresh();
      else { clearInterval(gs.timer); gs.timer = null; }
    }, 15000);
  });
  CNGP.on('room-created', detail => {
    if (detail && detail.mode === 'undercover' && detail.conv) {
      CNGP.api(API + '/rooms', { body: { conv_id: detail.conv.id } })
        .then(() => tsRefresh()).catch(() => {});
    }
  });

  async function tsRefresh() {
    if (!isGroup() || !curConv()) return;
    let d = null;
    try { d = await CNGP.api(API + '/games?conv_id=' + encodeURIComponent(curConv())); }
    catch (e) { return; }
    if (!d.uc) return;
    gs.view = d.game;
    CNGP.drawer.setPanel({ title: '谁是卧底', render: el => ucRenderInto(el) });
  }

  function ucRenderInto(el) {
    el.replaceChildren();
    const wrap = document.createElement('div');
    wrap.id = 'ucPanel';
    wrap.className = 'uc-panel';
    const v = gs.view;
    if (!v) { wrap.textContent = '加载中…'; el.appendChild(wrap); return; }
    const g = v.game;
    const tag = document.createElement('span');
    tag.className = 'dx-tag';
    tag.textContent = '🕵 谁是卧底 · 第 ' + g.round + ' 轮 · ' + (g.phase === 'describe' ? '描述阶段' : g.phase === 'vote' ? '投票阶段' : '已结束');
    wrap.appendChild(tag);

    // 我的词（仅本人可见）
    const word = document.createElement('div');
    word.className = 'uc-word' + (g.winner ? ' over' : '');
    word.textContent = g.me || '（观战中，无词语）';
    wrap.appendChild(word);
    const wordLbl = document.createElement('div');
    wordLbl.className = 'dx-hint';
    wordLbl.textContent = g.me ? '↑ 你的词语（只有你能看到）' : '';
    if (wordLbl.textContent) wrap.appendChild(wordLbl);

    // 事件说明
    if (g.last_event) {
      const ev = document.createElement('div'); ev.className = 'dx-clue';
      ev.textContent = g.last_event;
      wrap.appendChild(ev);
    }

    // 玩家列表（存活/出局/已描述/投票按钮）
    const list = document.createElement('div'); list.className = 'uc-players';
    for (const p of g.players) {
      const row = document.createElement('div');
      row.className = 'uc-player' + (p.alive ? '' : ' dead');
      const nm = document.createElement('span'); nm.className = 'uc-name';
      nm.textContent = p.nickname + (p.alive ? '' : '（出局）');
      row.appendChild(nm);
      if (g.phase === 'describe' && p.alive && p.id === ctx().me.id && !p.described) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'dx-btn primary';
        b.textContent = '我说完了';
        b.onclick = () => apiAction('/games/' + encodeURIComponent(curConv()) + '/described', {});
        row.appendChild(b);
      }
      if (g.phase === 'vote' && p.alive && p.id !== ctx().me.id && !g.voted) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'dx-btn';
        b.textContent = '投他';
        b.onclick = () => apiAction('/games/' + encodeURIComponent(curConv()) + '/vote', { target: p.id });
        row.appendChild(b);
      }
      if (p.described && g.phase === 'describe') {
        const d = document.createElement('span'); d.className = 'uc-desc'; d.textContent = ' 已描述';
        row.appendChild(d);
      }
      list.appendChild(row);
    }
    wrap.appendChild(list);

    // 阶段提示
    const h = document.createElement('div'); h.className = 'dx-hint';
    if (g.winner === 'civ') h.textContent = '🎉 平民胜利！';
    else if (g.winner === 'under') h.textContent = '🕵 卧底胜利！';
    else if (g.phase === 'describe') h.textContent = '在聊天里描述你的词（描述进度 ' + g.described + '/' + g.alive + '），别让卧底猜到词，也别描述得太含糊。';
    else if (g.phase === 'vote') h.textContent = '投票放逐疑似卧底（' + Object.keys(g.votes || {}).length + ' 票）…';
    wrap.appendChild(h);

    // 重开
    if (g.winner && ctx().me) {
      const rs = document.createElement('button'); rs.type = 'button'; rs.className = 'dx-btn primary';
      rs.textContent = '再来一局';
      rs.onclick = () => startGame();
      wrap.appendChild(rs);
    }
    el.appendChild(wrap);
  }

  function startGame() {
    const players = (ctx().conv && ctx().conv.members || []).map(m => ({ id: m.id, nickname: m.nickname }));
    CNGP.api(API + '/games', { body: { conv_id: curConv(), players } })
      .then(d => { gs.view = d.game; CNGP.drawer.refresh(); CNGP.toast('谁是卧底开局！'); })
      .catch(e => CNGP.toast(e.message));
  }

  async function apiAction(path, body) {
    try {
      const d = await CNGP.api(API + path, { body });
      gs.view = d;
      CNGP.drawer.refresh();
      return d;
    } catch (e) { CNGP.toast(e.message); return null; }
  }
})();
