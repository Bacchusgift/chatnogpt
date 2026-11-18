'use strict';

const readerTabByChat = new Map();

function readerURL(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && u.hostname === 'fanqienovel.com' &&
        /^\/(reader|page)\/\d+$/.test(u.pathname)) return u.href;
  } catch {}
  return null;
}

async function findReaderTab(url) {
  const tabs = await chrome.tabs.query({ url: 'https://fanqienovel.com/*' });
  return tabs.find(tab => tab.url?.split('?')[0] === url.split('?')[0]) ||
    tabs.find(tab => /^https:\/\/fanqienovel\.com\/reader\/\d+/.test(tab.url || ''));
}

async function readChapter(tabId, op) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'reader-control', op });
  } catch (error) {
    if (/Receiving end does not exist|Could not establish connection/i.test(error.message || '')) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['fanqie.js'] });
      return chrome.tabs.sendMessage(tabId, { type: 'reader-control', op });
    }
    if (op !== 'next' && op !== 'previous') throw error;
    // A chapter button may replace the entire page before its content script can respond.
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        const result = await chrome.tabs.sendMessage(tabId, { type: 'reader-control', op: 'attach' });
        if (result?.text || result?.error) return result;
      } catch {}
    }
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'reader-request' || !sender.tab ||
      !/^http:\/\/(127\.0\.0\.1|localhost):8080\//.test(sender.tab.url || '')) return;
  (async () => {
    const url = readerURL(message.url);
    if (!url) return { error: '请填写番茄小说官网的书籍或章节链接' };
    let tab;
    const attached = readerTabByChat.get(sender.tab.id);
    if (attached?.url === url) {
      try { tab = await chrome.tabs.get(attached.tabId); }
      catch { readerTabByChat.delete(sender.tab.id); }
    }
    if (!tab || !tab.url?.startsWith('https://fanqienovel.com/')) tab = await findReaderTab(url);
    if (!tab) {
      tab = await chrome.tabs.create({ url, active: true });
      readerTabByChat.set(sender.tab.id, { tabId: tab.id, url });
      return { opened: true, message: '已打开番茄页面；登录并确认可读后，返回聊天区点“连接页面”' };
    }
    readerTabByChat.set(sender.tab.id, { tabId: tab.id, url });
    if (message.op === 'attach' && new URL(url).pathname.startsWith('/reader/') &&
        tab.url?.split('?')[0] !== url.split('?')[0] && attached?.url !== url) {
      await chrome.tabs.update(tab.id, { url });
      return { opened: true, message: '已切换到指定章节；确认可读后，返回聊天区点“连接页面”' };
    }
    const result = await readChapter(tab.id, message.op);
    return { ...result, tabId: tab.id };
  })().then(respond, error => respond({ error: /Cannot access contents|Missing host permission/i.test(error.message || '')
    ? '扩展没有番茄页面访问权限；请在扩展详情里允许访问 fanqienovel.com，然后刷新番茄页'
    : error.message || '无法读取番茄标签页' }));
  return true;
});
