(function () {
  if (window.__guessNumberLoaded) return;
  window.__guessNumberLoaded = true;
  const API = '/api/plugins/guess-number';
  const state = { conv: '', game: null, timer: null, panel: false };
  CNGP.roomMode({ id: 'guess-number', label: '猜数字' });
  const context = () => CNGP.context();
  const current = () => context().conv;

  async function refresh() {
    const conv = current();
    if (!conv || conv.kind !== 1 || conv.id !== state.conv) return;
    try {
      const result = await CNGP.api(API + '?conv_id=' + encodeURIComponent(conv.id));
      if (!current() || current().id !== conv.id) return;
      const changed = JSON.stringify(state.game) !== JSON.stringify(result.game);
      state.game = result.game;
      if (state.game) {
        if (!state.panel) { state.panel = true; CNGP.drawer.setPanel({ title: '猜数字', render }); }
        else if (changed) CNGP.drawer.refresh();
      }
    } catch (_) { /* Other groups do not need a game panel. */ }
  }
  CNGP.on('conv-opened', detail => {
    clearInterval(state.timer);
    state.conv = detail && detail.id || '';
    state.game = null; state.panel = false;
    if (!current() || current().kind !== 1) return;
    refresh();
    state.timer = setInterval(refresh, 3000);
  });
  CNGP.on('room-created', async detail => {
    if (!detail || detail.mode !== 'guess-number' || !detail.conv) return;
    try {
      const d = await CNGP.api(API, { body: { conv_id: detail.conv.id, action: 'create' } });
      if (current() && current().id === detail.conv.id) {
        state.conv = detail.conv.id; state.game = d.game; state.panel = true;
        CNGP.drawer.setPanel({ title: '猜数字', render });
      }
    } catch (e) { CNGP.toast('创建猜数字游戏失败：' + e.message); }
  });
  async function act(action, number) {
    const conv = current(); if (!conv) return;
    try {
      const d = await CNGP.api(API, { body: { conv_id: conv.id, action, number } });
      if (!current() || current().id !== conv.id) return;
      state.game = d.game; CNGP.drawer.refresh();
    } catch (e) { CNGP.toast(e.message); }
  }
  function render(el) {
    el.replaceChildren();
    const g = state.game; if (!g) return;
    const wrap = document.createElement('div'); wrap.className = 'uc-panel';
    const title = document.createElement('div'); title.className = 'dx-tag'; title.textContent = '💣 猜数字'; wrap.appendChild(title);
    const line = document.createElement('div'); line.className = 'dx-clue'; line.textContent = g.last; wrap.appendChild(line);
    const hint = document.createElement('div'); hint.className = 'dx-hint';
    const me = context().me && context().me.id;
    const setter = g.players.find(p => p.id === g.setter);
    const turn = g.players[g.turn];
    if (g.phase === 'setup') hint.textContent = '出题人：' + (setter ? setter.nickname : '未知') + '。秘密数字仅出题人可见。';
    else if (g.phase === 'guess') hint.textContent = '当前范围：' + g.low + '～' + g.high + '。轮到 ' + (turn ? turn.nickname : '未知') + ' 猜。';
    else hint.textContent = '本局结束，秘密数字：' + g.secret;
    wrap.appendChild(hint);
    const canSet = g.phase === 'setup' && g.setter === me;
    const canGuess = g.phase === 'guess' && turn && turn.id === me;
    if (canSet || canGuess) {
      const form = document.createElement('form');
      const input = document.createElement('input'); input.type = canSet ? 'password' : 'number'; input.inputMode = 'numeric'; input.required = true;
      input.placeholder = canSet ? '秘密数字（1～100）' : '输入你猜的数字'; input.setAttribute('aria-label', input.placeholder);
      const button = document.createElement('button'); button.type = 'submit'; button.className = 'dx-btn primary'; button.textContent = canSet ? '设定数字' : '提交猜测';
      form.append(input, button); form.onsubmit = e => { e.preventDefault(); const value = input.value.trim(); if (!/^\d+$/.test(value)) { CNGP.toast('请输入整数'); return; } button.disabled = true; act(canSet ? 'set' : 'guess', Number(value)).finally(() => { button.disabled = false; }); }; wrap.appendChild(form);
    }
    if (g.phase === 'result') { const again = document.createElement('button'); again.type = 'button'; again.className = 'dx-btn primary'; again.textContent = '再来一局'; again.onclick = () => act('reset'); wrap.appendChild(again); }
    el.appendChild(wrap);
  }
})();
