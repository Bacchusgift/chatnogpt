'use strict';

const readerTabByChat = new Map();

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}

function readerSource(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && u.hostname === 'fanqienovel.com' &&
        /^\/(reader|page)\/\d+$/.test(u.pathname)) return { url: u.href, kind: 'fanqie' };
    if (u.protocol === 'https:' && (u.hostname === 'www.jjwxc.net' || u.hostname === 'jjwxc.net') &&
        u.pathname === '/onebook.php' && /^\d+$/.test(u.searchParams.get('novelid') || '') &&
        (!u.searchParams.has('chapterid') || /^\d+$/.test(u.searchParams.get('chapterid') || '')))
      return { url: u.href, kind: 'jinjiang' };
  } catch {}
  return null;
}

function sameReaderPage(left, right, kind) {
  try {
    const a = new URL(left), b = new URL(right);
    if (kind === 'fanqie') return a.origin === b.origin && a.pathname === b.pathname;
    return a.hostname === b.hostname && a.pathname === b.pathname &&
      a.searchParams.get('novelid') === b.searchParams.get('novelid') &&
      a.searchParams.get('chapterid') === b.searchParams.get('chapterid');
  } catch { return false; }
}

async function findReaderTab(source) {
  const pattern = source.kind === 'fanqie' ? 'https://fanqienovel.com/*' :
    ['https://www.jjwxc.net/*', 'https://jjwxc.net/*'];
  const tabs = await chrome.tabs.query({ url: pattern });
  const exact = tabs.find(tab => sameReaderPage(tab.url, source.url, source.kind));
  if (exact) return exact;
  if (source.kind === 'jinjiang' && !new URL(source.url).searchParams.has('chapterid')) {
    const novelID = new URL(source.url).searchParams.get('novelid');
    return tabs.find(tab => {
      const page = readerSource(tab.url);
      return page?.kind === 'jinjiang' && new URL(tab.url).searchParams.get('novelid') === novelID &&
        new URL(tab.url).searchParams.has('chapterid');
    });
  }
  return null;
}

async function readChapter(tabId, op, kind, injected = false) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'reader-control', op });
    if (result?.navigate && kind === 'jinjiang') {
      if (readerSource(result.navigate)?.kind !== 'jinjiang') return { error: '章节链接不属于晋江阅读页' };
      await chrome.tabs.update(tabId, { url: result.navigate });
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const tab = await chrome.tabs.get(tabId);
        if (tab.status !== 'complete') continue;
        try { return await readChapter(tabId, 'attach', kind); } catch {}
      }
      return { error: '新章节尚未加载完成，请返回聊天区点“连接 / 刷新”' };
    }
    return result;
  } catch (error) {
    if (!injected && /Receiving end does not exist|Could not establish connection/i.test(error.message || '')) {
      await chrome.scripting.executeScript({ target: { tabId }, files: [kind === 'jinjiang' ? 'jinjiang.js' : 'fanqie.js'] });
      return readChapter(tabId, op, kind, true);
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

async function changeFanqieChapter(tabId, op, cachedBefore) {
  const before = cachedBefore?.text && readerSource(cachedBefore.url)?.kind === 'fanqie'
    ? cachedBefore : await withTimeout(readChapter(tabId, 'attach', 'fanqie'), 24000, '当前章节读取超时');
  if (before?.error || !before?.text) return before || { error: '当前番茄章节无法读取' };
  const label = op === 'next' ? '下一章' : '上一章';
  let first;
  try {
    first = await withTimeout(readChapter(tabId, op, 'fanqie'), 18000, `${label}读取超时`);
  } catch { /* 跳转会销毁旧页面的消息通道，继续读取新页面。 */ }
  if (first?.text && first.text !== before.text) return first;
  if (first?.error && /无法进入|找不到/.test(first.error)) return first;
  const started = Date.now();
  while (Date.now() - started < 12000) {
    await new Promise(resolve => setTimeout(resolve, 400));
    try {
      const result = await withTimeout(readChapter(tabId, 'attach', 'fanqie'), 3000, '新章节读取超时');
      if (result?.text && result.text !== before.text) return result;
    } catch {}
  }
  return { error: `${label}后尚未读到完整的新章节；当前章节已保留，请检查来源阅读框后重试。` };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'reader-request') return;
  let chatURL;
  try { chatURL = new URL(sender.url || sender.tab?.url || ''); }
  catch { respond({ error: '扩展后台没有收到聊天页地址' }); return true; }
  const allowedChatPage = chatURL.origin === 'https://chatnogpt.autowired.cn' ||
    (chatURL.protocol === 'http:' && chatURL.port === '8080' &&
      (chatURL.hostname === '127.0.0.1' || chatURL.hostname === 'localhost'));
  if (!allowedChatPage || !sender.tab?.id) {
    respond({ error: '扩展后台未能确认聊天页身份' });
    return true;
  }
  let stage = '查找来源标签页';
  const work = (async () => {
    const source = readerSource(message.url);
    if (!source) return { error: '请填写支持的书籍或章节链接' };
    const { url, kind } = source;
    let tab;
    const attached = readerTabByChat.get(sender.tab.id);
    if (attached?.url === url) {
      try { tab = await withTimeout(chrome.tabs.get(attached.tabId), 6000, '已连接的来源标签页查询超时'); }
      catch { readerTabByChat.delete(sender.tab.id); }
    }
    if (!tab || readerSource(tab.url)?.kind !== kind)
      tab = await withTimeout(findReaderTab(source), 6000, '来源标签页查询超时');
    if (!tab) {
      stage = '打开来源标签页';
      tab = await withTimeout(chrome.tabs.create({ url, active: true }), 6000, '打开来源标签页超时');
      readerTabByChat.set(sender.tab.id, { tabId: tab.id, url });
      return { opened: true, message: '已打开来源页面；登录并确认章节可读后，返回聊天区点“连接 / 刷新”' };
    }
    readerTabByChat.set(sender.tab.id, { tabId: tab.id, url });
    if (message.op === 'attach' && !sameReaderPage(tab.url, url, kind) &&
        !(kind === 'jinjiang' && !new URL(url).searchParams.has('chapterid'))) {
      stage = '切换来源章节';
      await withTimeout(chrome.tabs.update(tab.id, { url }), 6000, '切换来源章节超时');
      return { opened: true, message: '已切换到指定章节；确认可读后，返回聊天区点“连接 / 刷新”' };
    }
    stage = '来源页正文读取';
    const result = kind === 'fanqie'
      ? (message.op === 'next' || message.op === 'previous'
        ? await changeFanqieChapter(tab.id, message.op, message.before)
        : await withTimeout(readChapter(tab.id, 'attach', kind), 18000, '来源页正文脚本未响应'))
      : await withTimeout(readChapter(tab.id, message.op, kind), 25000, '来源页正文脚本未响应');
    if (result?.text && readerSource(result.url)?.kind === kind)
      readerTabByChat.set(sender.tab.id, { tabId: tab.id, url: result.url });
    return { ...result, tabId: tab.id };
  })();
  const fail = error => respond({ error: /Cannot access contents|Missing host permission/i.test(error.message || '')
    ? '扩展没有来源页面访问权限；请在扩展详情里允许访问该网站，然后刷新来源页'
    : error.message || '无法读取来源标签页' });
  let timer;
  Promise.race([work, new Promise(resolve => {
    timer = setTimeout(() => resolve({ error: stage + '超时；当前章节已保留。' }),
      message.op === 'next' || message.op === 'previous' ? 34000 : 28000);
  })]).then(result => { clearTimeout(timer); respond(result); }, error => { clearTimeout(timer); fail(error); });
  return true;
});
