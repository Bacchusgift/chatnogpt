// 只言片语（Dixit）插件前端：右侧抽屉面板（手牌/桌面/投票/计分）。
// 卡牌插画：程序化生成艺术 SVG（原创，按牌号确定性渲染）。
(function () {
  if (window.__dixitLoaded) return;
  window.__dixitLoaded = true;
  const API = '/api/plugins/dixit';
  const gs = { conv: null, view: null, timer: null };

  CNGP.roomMode({ id: 'dixit', label: '只言片语' });

  // ---- 程序化卡牌艺术：seeded 生成 SVG ----
  const PALETTES = [
    ['#0f2027', '#2c5364', '#e96f43', '#f9d423'],
    ['#3a1c71', '#d76d77', '#ffaf7b', '#ffe3d8'],
    ['#0b8793', '#360033', '#f8b195', '#f67280'],
    ['#1a2a6c', '#b21f1f', '#fdbb2d', '#fefcea'],
    ['#134e5e', '#e8ca8d', '#71b280', '#eae8c8'],
    ['#41295a', '#2f0743', '#f64f59', '#ffc3a0'],
    ['#0d3b66', '#faf0ca', '#f4d35e', '#ee964b'],
    ['#283048', '#85a7b2', '#f6f0ea', '#e2b6a3'],
    ['#1d976c', '#f2c94c', '#fdf3d8', '#2f7351'],
    ['#2b5876', '#4e4376', '#f9c5c8', '#fdeff9'],
    ['#16222a', '#3a6073', '#f0c27b', '#fcf3cf'],
    ['#5f2c82', '#49a09d', '#f8e9a1', '#ffffff'],
    ['#3e1e68', '#f39c6b', '#99d5cf', '#2b3a67'],
    ['#ff9966', '#ff5e62', '#fff2e1', '#704e2e'],
    ['#0f0c29', '#302b63', '#f64f59', '#f2c94c'],
    ['#232526', '#c8a27a', '#efe6d5', '#7a5c3e']
  ];
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  window.dixitCardArt = function (id, w) {
    w = w || 120;
    const h = Math.round(w * 1.45);
    const rnd = mulberry32((id * 2654435761) >>> 0);
    const pal = PALETTES[id % PALETTES.length];
    const bg = pal[id % 2 === 0 ? 0 : 1];
    const c1 = pal[2], c2 = pal[3];
    let shapes = '';
    const blobs = 2 + Math.floor(rnd() * 3);
    for (let b = 0; b < blobs; b++) {
      const cx = 20 + rnd() * (w - 40), cy = 20 + rnd() * (h - 40);
      const rr = 12 + rnd() * (w * 0.22);
      let p = 'M' + cx.toFixed(1) + ' ' + cy.toFixed(1);
      let a0 = rnd() * 6.28;
      for (let k = 0; k < 3; k++) {
        const a = a0 + (k * 6.28) / 3 + (rnd() - 0.5);
        const mx = cx + Math.cos(a) * rr * 1.6, my = cy + Math.sin(a) * rr * 1.6;
        p += ' Q' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + (cx + Math.cos(a + 2.1) * rr).toFixed(1) + ' ' + (cy + Math.sin(a + 2.1) * rr).toFixed(1);
      }
      p += ' Z';
      shapes += '<path d="' + p + '" fill="' + (b % 2 ? c2 : c1) + '" opacity="' + (0.35 + rnd() * 0.4).toFixed(2) + '"/>';
    }
    const dots = 4 + Math.floor(rnd() * 5);
    for (let d = 0; d < dots; d++) {
      const x = (rnd() * w).toFixed(1), y = (rnd() * h).toFixed(1), rr2 = (1.5 + rnd() * 4).toFixed(1);
      shapes += rnd() < 0.5
        ? '<circle cx="' + x + '" cy="' + y + '" r="' + rr2 + '" fill="' + c1 + '" opacity="' + (0.5 + rnd() * 0.4).toFixed(2) + '"/>'
        : '<circle cx="' + x + '" cy="' + y + '" r="' + rr2 + '" fill="none" stroke="' + c2 + '" stroke-width="1.4" opacity="0.8"/>';
    }
    if (rnd() < 0.6) {
      const y0 = (h * (0.3 + rnd() * 0.4)).toFixed(1);
      shapes += '<path d="M0 ' + y0 + ' Q ' + (w * 0.25).toFixed(1) + ' ' + (h * rnd() * 0.6).toFixed(1) + ' ' + (w * 0.5).toFixed(1) + ' ' + y0 + ' T ' + w + ' ' + y0 + '" fill="none" stroke="' + c2 + '" stroke-width="1.2" opacity="0.55"/>';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">' +
      '<rect width="' + w + '" height="' + h + '" fill="' + bg + '"/>' + shapes +
      '<text x="6" y="' + (h - 6) + '" font-size="' + Math.max(9, w * 0.09) + '" fill="' + c2 + '" opacity="0.85">' + id + '</text></svg>';
  };

  const ctx = () => CNGP.context();
  const curConv = () => { const c = ctx().conv; return c ? c.id : null; };
  function isGroup() { const c = ctx().conv; return c && c.kind === 1; }

  // ---- 基座 hook ----
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
    if (detail && detail.mode === 'dixit' && detail.conv) {
      CNGP.api(API + '/rooms', { body: { conv_id: detail.conv.id } })
        .then(() => tsRefresh()).catch(() => {});
    }
  });

  async function tsRefresh() {
    if (!isGroup() || !curConv()) return;
    let d = null;
    try { d = await CNGP.api(API + '?conv=' + encodeURIComponent(curConv())); }
    catch (e) { return; }
    if (!d.dixit) { CNGP.drawer.setPanel(null); return; }
    gs.view = d.game;
    CNGP.drawer.setPanel({ title: '只言片语', render: el => dixitRenderInto(el) });
  }

  function phaseLabel(g) {
    return { story: '讲者出牌', pick: '成员选牌', vote: '投票中', reveal: '结算' }[g.phase] || g.phase;
  }
  function phaseText(g) {
    if (!g.me) return '观战中';
    if (g.me.is_story) {
      if (g.phase === 'story') return '你是讲者：出一张牌，在聊天里描述它（别太直白，也别无人猜中）。';
      if (g.phase === 'pick') return '等其他人从手牌里选出最像的牌…';
      if (g.phase === 'vote') return '等大家投票猜哪张是你的牌…';
      return '本回合结束。';
    }
    if (g.phase === 'story') return '等待讲者出牌…';
    if (g.phase === 'pick') return '从下面的手牌里点选一张最贴合描述的牌打出。';
    if (g.phase === 'vote') return '猜猜哪一张是讲者的牌，点击桌面卡片投票。';
    return '回合结束。';
  }

  // ---- 抽屉面板渲染 ----
  function dixitRenderInto(el) {
    el.replaceChildren();
    const wrap = document.createElement('div');
    wrap.id = 'dixitPanel';
    wrap.className = 'dx-panel';
    const v = gs.view;
    if (!v) {
      wrap.textContent = '加载中…';
      el.appendChild(wrap);
      el.appendChild(makeActionsBar());
      return;
    }
    const g = v.game;
    const tag = document.createElement('span');
    tag.className = 'dx-tag';
    tag.textContent = '🎴 只言片语 · 第 ' + g.round + ' 轮 · ' + phaseLabel(g);
    wrap.appendChild(tag);
    const info = document.createElement('div');
    info.className = 'dx-riddle';
    info.textContent = phaseText(g);
    wrap.appendChild(info);

    if (g.phase !== 'story' && g.clue) {
      const clue = document.createElement('div');
      clue.className = 'dx-clue';
      clue.textContent = '描述：「' + g.clue + '」';
      wrap.appendChild(clue);
    }

    if (g.table && g.table.length) {
      const tbl = document.createElement('div');
      tbl.className = 'dx-table';
      for (const t of g.table) {
        const cell = document.createElement('div');
        cell.className = 'dx-cell';
        cell.innerHTML = window.dixitCardArt(t.card, 74);
        if (g.phase === 'reveal' && t.nickname) {
          const who = document.createElement('div');
          who.className = 'dx-who'; who.textContent = t.nickname;
          cell.appendChild(who);
        } else if (g.phase === 'vote' && g.me && !g.me.is_story && !g.me.voted) {
          cell.classList.add('votable');
          cell.title = '投票：第 ' + t.pos + ' 张';
          cell.onclick = () => voteFor(t.pos);
        }
        tbl.appendChild(cell);
      }
      wrap.appendChild(tbl);
      if (g.phase === 'vote') {
        const h = document.createElement('div'); h.className = 'dx-hint';
        h.textContent = '点击桌面卡片投票：哪一张是讲者出的？';
        wrap.appendChild(h);
      }
    }

    const act = makeActionsBar();
    wrap.appendChild(act);

    if (g.players && g.players.length) {
      const sc = document.createElement('div'); sc.className = 'dx-score';
      for (const p of g.players) {
        const row = document.createElement('div'); row.className = 'dx-score-row';
        row.textContent = p.nickname + ' · ' + p.score + ' 分' + (g.phase !== 'story' && p.is_story ? ' · 讲者' : '');
        sc.appendChild(row);
      }
      wrap.appendChild(sc);
    }
    el.appendChild(wrap);
  }

  function makeActionsBar() {
    const act = document.createElement('div');
    act.className = 'dx-actions';
    const g = gs.view && gs.view.game;
    if (!g || !g.me) return act;
    if (g.phase === 'story' && g.me.is_story) {
      const h = document.createElement('div'); h.className = 'dx-hint';
      h.textContent = '你是讲者：点选手牌打出，然后在聊天里用一句话描述。';
      act.appendChild(h);
      for (const card of g.me.hand) {
        const c = document.createElement('div');
        c.className = 'dx-hand-card';
        c.innerHTML = window.dixitCardArt(card, 92);
        c.title = '打出这张牌';
        c.onclick = () => storyPlay(card);
        act.appendChild(c);
      }
    } else if (g.phase === 'pick' && g.me.played) {
      const h = document.createElement('div'); h.className = 'dx-hint';
      h.textContent = '你已出牌，等待其他成员出牌…';
      act.appendChild(h);
    } else if (g.phase === 'pick' && g.me.is_story) {
      const h = document.createElement('div'); h.className = 'dx-hint';
      h.textContent = '等待成员出牌…';
      act.appendChild(h);
    } else if (g.phase === 'vote' && g.me.is_story) {
      const h = document.createElement('div'); h.className = 'dx-hint';
      h.textContent = '等待成员投票（' + g.vote_progress + '）…';
      act.appendChild(h);
    } else if (g.phase === 'vote' && g.me.voted) {
      const h = document.createElement('div'); h.className = 'dx-hint';
      h.textContent = '你已投票（' + g.vote_progress + '）…';
      act.appendChild(h);
    }
    if (g.phase === 'reveal') {
      const nx = document.createElement('button');
      nx.type = 'button'; nx.className = 'dx-btn primary'; nx.textContent = '下一轮';
      nx.onclick = () => apiAction('/games/' + encodeURIComponent(curConv()) + '/next', {});
      act.appendChild(nx);
    }
    return act;
  }

  async function apiAction(path, body) {
    try {
      const d = await CNGP.api(API + path, { body });
      gs.view = d;
      CNGP.drawer.refresh();
      return d;
    } catch (e) { CNGP.toast(e.message); return null; }
  }
  function storyPlay(card) {
    const clue = window.prompt('用一句话描述这张牌（描述会作为聊天消息发出）：');
    if (clue === null) return;
    const c = (clue || '').trim();
    if (!c) { CNGP.toast('描述不能为空'); return; }
    apiAction('/games/' + encodeURIComponent(curConv()) + '/story', { card }).then(d => {
      if (!d) return;
      CNGP.api(API + '/games/' + encodeURIComponent(curConv()) + '/clue', { body: { clue: c } }).then(() => {
        CNGP.send('🎴 我出了一张牌，描述是：「' + c + '」');
        CNGP.drawer.refresh();
      }).catch(() => {});
    });
  }
  function voteFor(pos) {
    apiAction('/games/' + encodeURIComponent(curConv()) + '/vote', { pos }).then(d => {
      if (d) CNGP.send('🗳 我投给了第 ' + pos + ' 张牌');
    });
  }
})();
