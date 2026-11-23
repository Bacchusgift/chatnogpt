(function () {
  if (window.__murderMysteryLoaded) return;
  window.__murderMysteryLoaded = true;

  const mode = 'murder-mystery';
  CNGP.roomMode({ id: mode, label: '剧本杀组局' });

  CNGP.on('room-created', detail => {
    if (!detail || detail.mode !== mode || !detail.conv || !detail.conv.id) return;
    const announcement = '剧本杀组局已发起，大家可以在群里商量剧本、角色和开场时间。';
    const current = CNGP.context().conv;
    if (current && current.id === detail.conv.id) {
      CNGP.send(announcement);
      return;
    }
    const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() :
      Date.now() + '-' + Math.random().toString(36).slice(2);
    CNGP.api('/api/conversations/' + encodeURIComponent(detail.conv.id) + '/send', {
      body: { content: announcement, client_msg_id: id },
    }).catch(error => CNGP.toast('组局消息发送失败：' + error.message));
  });
})();
