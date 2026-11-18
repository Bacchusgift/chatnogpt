'use strict';

const chatPageAllowed = location.origin === 'https://chatnogpt.autowired.cn' ||
  ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') &&
    location.protocol === 'http:' && location.port === '8080');

if (chatPageAllowed) {
  document.documentElement.dataset.cngpReaderBridge = 'ready';
  window.postMessage({ channel: 'cngp-reader-ready' }, location.origin);
}

window.addEventListener('message', event => {
  if (!chatPageAllowed || event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.channel !== 'cngp-reader-request' ||
      typeof data.id !== 'string' || !['attach', 'refresh', 'next', 'previous'].includes(data.op)) return;
  chrome.runtime.sendMessage({ type: 'reader-request', op: data.op, url: data.url }, response => {
    window.postMessage({ channel: 'cngp-reader-response', id: data.id,
      response: response || { error: chrome.runtime.lastError?.message || '扩展没有响应' } }, location.origin);
  });
});
