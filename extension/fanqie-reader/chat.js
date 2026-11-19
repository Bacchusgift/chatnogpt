'use strict';

const chatPageAllowed = location.origin === 'https://chatnogpt.autowired.cn' ||
  ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') &&
    location.protocol === 'http:' && location.port === '8080');

function readerExtensionReady() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

if (chatPageAllowed && readerExtensionReady()) {
  document.documentElement.dataset.cngpReaderBridge = 'ready';
  document.documentElement.dataset.cngpReaderBridgeVersion = '0.3.4';
  window.postMessage({ channel: 'cngp-reader-ready', version: '0.3.4' }, location.origin);
}

window.addEventListener('message', event => {
  if (!chatPageAllowed || event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.channel !== 'cngp-reader-request' ||
      typeof data.id !== 'string' || !['attach', 'refresh', 'next', 'previous'].includes(data.op)) return;
  let answered = false;
  const reply = response => {
    if (answered) return;
    answered = true;
    clearTimeout(watchdog);
    window.postMessage({ channel: 'cngp-reader-response', id: data.id, response }, location.origin);
  };
  const watchdog = setTimeout(() => reply({ error: '扩展后台未返回请求结果（桥接版本 0.3.4）' }), 42000);
  if (!readerExtensionReady()) {
    reply({ error: '阅读扩展已重新加载，请刷新聊天页和来源章节页后重试。' });
    return;
  }
  try {
    chrome.runtime.sendMessage({ type: 'reader-request', op: data.op, url: data.url, before: data.before }, response => {
      let error = '';
      try { error = chrome.runtime?.lastError?.message || ''; } catch { error = 'Extension context invalidated'; }
      reply(response || { error: /context invalidated/i.test(error)
        ? '阅读扩展已重新加载，请刷新聊天页和来源章节页后重试。'
        : error || '扩展没有响应' });
    });
  } catch (error) {
    reply({ error: /context invalidated/i.test(error.message || '')
      ? '阅读扩展已重新加载，请刷新聊天页和来源章节页后重试。'
      : error.message || '扩展没有响应' });
  }
});
