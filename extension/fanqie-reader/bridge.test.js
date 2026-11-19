'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const directory = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const chapterURL = 'https://fanqienovel.com/reader/7681682756987781656?enter_from=reader';

for (const origin of ['https://chatnogpt.autowired.cn', 'http://127.0.0.1:8080']) {
  test(`${origin} can request a chapter through the extension`, async () => {
    assert(manifest.host_permissions.some(pattern => (origin + '/').startsWith(pattern.slice(0, -2))));
    assert(manifest.content_scripts.some(script => script.js.includes('chat.js') &&
      script.matches.some(pattern => (origin + '/').startsWith(pattern.slice(0, -2)))));

    let backgroundListener;
    const chapter = { url: chapterURL, title: '第217章', text: '正文'.repeat(100), paragraphs: 1 };
    const backgroundChrome = {
      runtime: { onMessage: { addListener(fn) { backgroundListener = fn; } } },
      tabs: {
        query: async () => [{ id: 7, url: chapterURL }],
        sendMessage: async () => chapter,
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(directory, 'background.js'), 'utf8'),
      { chrome: backgroundChrome, URL, Map, Promise, setTimeout, clearTimeout });

    const messages = [];
    const window = {
      postMessage(data) { messages.push(data); },
      addEventListener(_type, fn) { this.listener = fn; },
    };
    const chrome = {
      runtime: {
        id: 'test-extension',
        sendMessage(request, callback) {
          backgroundListener(request, { tab: { id: 3, url: origin + '/' } }, callback);
        },
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(directory, 'chat.js'), 'utf8'),
      { chrome, document: { documentElement: { dataset: {} } }, location: { origin, hostname: new URL(origin).hostname,
        protocol: new URL(origin).protocol, port: new URL(origin).port }, window, setTimeout, clearTimeout });
    window.listener({ source: window, origin, data: {
      channel: 'cngp-reader-request', id: 'test-request', op: 'attach', url: chapterURL,
    } });
    await new Promise(resolve => setImmediate(resolve));
    const response = messages.find(message => message.channel === 'cngp-reader-response');
    assert.equal(response?.response?.text, chapter.text);
  });
}

test('连续翻章使用当前来源标签页并能返回上一章', async () => {
  let listener;
  const chapters = [217, 218, 219].map(n => ({
    url: `https://fanqienovel.com/reader/${n}`, title: `第${n}章`, text: `章节${n}`.repeat(80),
  }));
  let position = 0;
  const calls = [];
  const tab = { id: 7, url: chapters[0].url };
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    tabs: {
      query: async () => [{ ...tab }],
      get: async () => ({ ...tab }),
      sendMessage: async (id, message) => {
        calls.push([id, message.op, position]);
        if (message.op === 'next') position++;
        if (message.op === 'previous') position--;
        tab.url = chapters[position].url;
        return { ...chapters[position] };
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'background.js'), 'utf8'),
    { chrome, URL, Map, Promise, setTimeout, clearTimeout });
  const request = (op, chapter) => new Promise(resolve => listener({ type: 'reader-request', op,
    url: chapter.url, before: { url: chapter.url, text: chapter.text } },
  { tab: { id: 3, url: 'http://127.0.0.1:8080/' } }, resolve));
  let result = await request('attach', chapters[0]);
  assert.equal(result.title, '第217章');
  result = await request('next', result);
  assert.equal(result.title, '第218章');
  result = await request('next', result);
  assert.equal(result.title, '第219章');
  result = await request('previous', result);
  assert.equal(result.title, '第218章');
  assert.deepEqual(calls.map(call => call[1]), ['attach', 'next', 'next', 'previous']);
});
