'use strict';

if (location.port === '8080') {
  document.documentElement.dataset.cngpReaderBridge = 'ready';
  window.postMessage({ channel: 'cngp-reader-ready' }, location.origin);
}

window.addEventListener('message', event => {
  if (location.port !== '8080' || event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.channel !== 'cngp-reader-request' ||
      typeof data.id !== 'string' || !['attach', 'refresh', 'next', 'previous'].includes(data.op)) return;
  chrome.runtime.sendMessage({ type: 'reader-request', op: data.op, url: data.url }, response => {
    window.postMessage({ channel: 'cngp-reader-response', id: data.id,
      response: response || { error: chrome.runtime.lastError?.message || '扩展没有响应' } }, location.origin);
  });
});
