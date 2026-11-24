'use strict';

(() => {
if (globalThis.__cngpChatBridgeInstalled) return;

const chatPageAllowed = location.origin === 'https://chatnogpt.autowired.cn' ||
  ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') &&
    location.protocol === 'http:' && location.port === '8080');

function readerExtensionReady() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

if (chatPageAllowed && readerExtensionReady()) {
  document.documentElement.dataset.cngpReaderBridge = 'ready';
  document.documentElement.dataset.cngpReaderBridgeVersion = '0.3.8';
  window.postMessage({ channel: 'cngp-reader-ready', version: '0.3.8' }, location.origin);
}

window.addEventListener('message', event => {
  if (!chatPageAllowed || event.source !== window || event.origin !== location.origin) return;
  // After an extension reload the old listener must not race the newly injected one.
  if (!readerExtensionReady()) return;
  const data = event.data;
  if (!data || data.channel !== 'cngp-reader-request' ||
      typeof data.id !== 'string' || !['attach', 'refresh', 'next', 'previous', 'catalog', 'jump'].includes(data.op)) return;
  let answered = false;
  const reply = response => {
    if (answered) return;
    answered = true;
    clearTimeout(watchdog);
    window.postMessage({ channel: 'cngp-reader-response', id: data.id, response }, location.origin);
  };
  const watchdog = setTimeout(() => {
    if (readerExtensionReady()) reply({ error: '扩展后台未返回请求结果（桥接版本 0.3.8）' });
  }, 42000);
  try {
    chrome.runtime.sendMessage({ type: 'reader-request', op: data.op, url: data.url, before: data.before, target: data.target }, response => {
      if (!readerExtensionReady()) { clearTimeout(watchdog); return; }
      let error = '';
      try { error = chrome.runtime?.lastError?.message || ''; } catch { error = 'Extension context invalidated'; }
      reply(response || { error: /context invalidated/i.test(error)
        ? '阅读扩展已重新加载，请刷新聊天页和来源章节页后重试。'
        : error || '扩展没有响应' });
    });
  } catch (error) {
    if (!readerExtensionReady()) { clearTimeout(watchdog); return; }
    reply({ error: /context invalidated/i.test(error.message || '')
      ? '阅读扩展已重新加载，请刷新聊天页和来源章节页后重试。'
      : error.message || '扩展没有响应' });
  }
});
globalThis.__cngpChatBridgeInstalled = true;
})();
