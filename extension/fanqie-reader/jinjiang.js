'use strict';

(() => {
let runtime;
try { runtime = chrome.runtime; } catch { return; }
if (!runtime?.onMessage || globalThis.__cngpJinjiangReaderInstalled) return;

function jinjiangChapter() {
  const page = new URL(location.href);
  if (!page.searchParams.has('chapterid'))
    return { error: '请在晋江页面打开具体章节，再返回聊天区点“连接 / 刷新”' };
  const root = document.querySelector('.noveltext #paragraph_comment_content');
  if (!root) return { error: '当前晋江章节没有可显示的正文；请确认已登录且有阅读权限' };
  // Jinjiang wraps each paragraph and appends comment-count bubbles after it.
  // Read only the text wrapper so numbers such as “999” never enter the chapter.
  const anchors = [...root.querySelectorAll('.onebook_paragraph_comment_anchor')];
  const raw = anchors.length
    ? anchors.map(anchor => anchor.querySelector('.onebook_paragraph_comment_text')?.textContent || '').join('\n')
    : root.innerText;
  const text = raw.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n')
    .split(/\n+/).map(part => part.trim()).filter(Boolean).join('\n\n');
  if (text.length < 100) return { error: '当前晋江页面未显示完整正文；请在来源网站确认章节可阅读' };
  const title = document.querySelector('.noveltext h2')?.textContent.trim() || document.title;
  return { url: location.href, title, text, fontURL: '', paragraphs: text.split('\n\n').length };
}

function jinjiangChangeChapter(op) {
  const label = op === 'next' ? '下一章' : '上一章';
  const link = op === 'next' ? document.querySelector('#chapter_next_link') :
    [...document.querySelectorAll('.noveltitle a')].find(a => a.textContent.includes(label));
  if (!link?.href) return { error: `当前页面无法进入${label}` };
  return { navigate: link.href };
}

try { runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== 'reader-control') return;
  respond(message.op === 'next' || message.op === 'previous'
    ? jinjiangChangeChapter(message.op) : jinjiangChapter());
  return true;
});
globalThis.__cngpJinjiangReaderInstalled = true;
} catch (error) {
  if (!/context invalidated/i.test(error?.message || '')) throw error;
}
})();
