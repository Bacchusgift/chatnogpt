'use strict';

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

async function changeChapter(op) {
  const label = op === 'next' ? '下一章' : '上一章';
  const button = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === label);
  if (!button || button.disabled) return { error: `当前页面无法进入${label}` };
  const beforeURL = location.href;
  const beforeText = document.querySelector('.muye-reader-content')?.textContent;
  button.click();
  const changed = await new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (location.href !== beforeURL ||
          (document.querySelector('.muye-reader-content')?.textContent !== beforeText &&
           document.querySelector('.muye-reader-content')?.textContent?.length > 100)) {
        clearInterval(timer); resolve(true);
      } else if (Date.now() - started > 15000) {
        clearInterval(timer); resolve(false);
      }
    }, 250);
  });
  if (!changed) return { error: `${label}没有加载完成；请到番茄标签页检查` };
  return extractChapter();
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== 'reader-control') return;
  const action = message.op === 'next' || message.op === 'previous'
    ? changeChapter(message.op) : Promise.resolve(extractChapter());
  action.then(respond, error => respond({ error: error.message || '读取章节失败' }));
  return true;
});
