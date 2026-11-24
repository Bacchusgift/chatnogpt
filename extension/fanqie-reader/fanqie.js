'use strict';

(() => {
let runtime;
try { runtime = chrome.runtime; } catch { return; }
if (!runtime?.onMessage || globalThis.__cngpFanqieReaderInstalled) return;

function extractChapter() {
  const root = document.querySelector('.muye-reader-content');
  if (!root) return { error: '当前页面没有章节正文；请先打开章节并登录番茄' };
  const paragraphs = [...root.querySelectorAll('p')].map(p => p.textContent.trim()).filter(Boolean);
  const text = paragraphs.join('\n\n');
  const count = document.body.innerText.match(/本章字数[：:]\s*(\d+)/);
  const expected = count ? Number(count[1]) : 0;
  if (text.length < 100 || (expected && text.length < expected * .7)) {
    return { error: '当前页面仅显示试读内容，请在番茄登录并确认能看到整章' };
  }
  const family = getComputedStyle(root.querySelector('p')).fontFamily.split(',')[0].replace(/["']/g, '').trim();
  const css = [...document.querySelectorAll('style')].map(style => style.textContent).join('\n');
  const at = css.indexOf('font-family:' + family);
  const fontMatch = at < 0 ? null : css.slice(at, at + 900).match(/url\((https:\/\/[^)]+\.woff2)\)/);
  if (!fontMatch && /[\uE000-\uF8FF]/.test(text)) return { error: '无法识别番茄的章节字体' };
  const title = [...document.querySelectorAll('h1')].map(x => x.textContent.trim()).find(x => /第.{1,12}章/.test(x)) || document.title;
  return { url: location.href, title, text, fontURL: fontMatch?.[1] || '', paragraphs: paragraphs.length };
}

async function chapterCatalog() {
  const collect = doc => {
    const seen = new Set(); const entries = [];
    for (const a of doc.querySelectorAll('a[href]')) {
      let u; try { u = new URL(a.getAttribute('href'), location.origin); } catch { continue; }
      if (u.origin !== 'https://fanqienovel.com' || !/^\/reader\/\d+$/.test(u.pathname)) continue;
      const title = (a.textContent || '').trim().replace(/\s+/g, ' ');
      if (!title || seen.has(u.pathname)) continue;
      seen.add(u.pathname); entries.push({ title, url: u.href });
    }
    return entries;
  };
  const openedHere = !document.querySelector('.catalog-content [data-item-id]');
  if (openedHere) {
    const trigger = [...document.querySelectorAll('.reader-toolbar-item')].find(el => el.textContent.trim() === '目录');
    if (trigger) {
      trigger.click();
      const start = Date.now();
      while (!document.querySelector('.catalog-content [data-item-id]') && Date.now() - start < 8000)
        await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  const items = [...document.querySelectorAll('.catalog-content [data-item-id]')].map(el => {
    const id = el.getAttribute('data-item-id');
    const title = (el.querySelector('.chapter-text')?.textContent || el.textContent || '').trim().replace(/\s+/g, ' ');
    return /^\d+$/.test(id || '') && title ? { title, url: 'https://fanqienovel.com/reader/' + id } : null;
  }).filter(Boolean);
  if (openedHere && items.length) {
    const trigger = [...document.querySelectorAll('.reader-toolbar-item')].find(el => el.textContent.trim() === '目录');
    trigger?.click();
  }
  if (items.length) return { chapters: items };
  let chapters = collect(document);
  if (chapters.length < 2) {
    const link = [...document.querySelectorAll('a[href]')].find(a => {
      try { const u = new URL(a.getAttribute('href'), location.origin); return u.origin === 'https://fanqienovel.com' && /^\/page\/\d+$/.test(u.pathname); } catch { return false; }
    });
    if (!link) return { error: '来源页面没有提供书籍目录链接，请打开对应书籍的目录页后重试。' };
    try {
      const response = await fetch(new URL(link.getAttribute('href'), location.origin).href, { credentials: 'include' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      chapters = collect(new DOMParser().parseFromString(await response.text(), 'text/html'));
    } catch { return { error: '无法读取番茄目录，请确认来源网站已登录且目录可访问。' }; }
  }
  return chapters.length ? { chapters } : { error: '番茄页面没有提供可识别的章节目录，请在来源网站确认目录可见。' };
}

async function changeChapter(op) {
  const label = op === 'next' ? '下一章' : '上一章';
  const button = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === label);
  if (!button || button.disabled) return { error: `当前页面无法进入${label}` };
  const beforeText = document.querySelector('.muye-reader-content')?.textContent;
  button.click();
  const changed = await new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (document.querySelector('.muye-reader-content')?.textContent !== beforeText &&
          document.querySelector('.muye-reader-content')?.textContent?.length > 100) {
        clearInterval(timer); resolve(true);
      } else if (Date.now() - started > 15000) {
        clearInterval(timer); resolve(false);
      }
    }, 250);
  });
  if (!changed) return { error: `${label}没有加载完成；请到番茄标签页检查` };
  return extractChapter();
}

try { runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== 'reader-control') return;
  const action = Promise.resolve().then(() => message.op === 'catalog' ? chapterCatalog() : message.op === 'next' || message.op === 'previous'
    ? changeChapter(message.op) : extractChapter());
  action.then(respond, error => respond({ error: error.message || '读取章节失败' }));
  return true;
});
globalThis.__cngpFanqieReaderInstalled = true;
} catch (error) {
  if (!/context invalidated/i.test(error?.message || '')) throw error;
}
})();
