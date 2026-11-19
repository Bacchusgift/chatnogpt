'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const directory = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const chapterURL = 'https://fanqienovel.com/reader/7681682756987781656?enter_from=reader';

test('重新加载时恢复已打开页面的脚本，不刷新其他页面', async () => {
  let installed;
  const injections = [];
  const tabs = [
    { id: 1, url: 'http://127.0.0.1:8080/' },
    { id: 2, url: 'https://chatnogpt.autowired.cn/' },
    { id: 3, url: chapterURL },
    { id: 4, url: 'https://www.jjwxc.net/onebook.php?novelid=1&chapterid=2' },
    { id: 5, url: 'http://127.0.0.1:9999/' },
  ];
  const chrome = { runtime: { onInstalled: { addListener(fn) { installed = fn; } },
    onMessage: { addListener() {} } }, tabs: { query: async () => tabs },
    scripting: { executeScript: async request => { injections.push([request.target.tabId, request.files[0]]); } } };
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'background.js'), 'utf8'),
    { chrome, URL, Map, Promise, setTimeout, clearTimeout, console });
  installed();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(injections.map(([id, file]) => `${id}:${file}`).sort(),
    ['1:chat.js', '2:chat.js', '3:fanqie.js', '4:jinjiang.js']);
});

test('扩展重载后失效的旧聊天监听不抢先返回错误', async () => {
  const listeners = [];
  const messages = [];
  const window = { addEventListener(_type, listener) { listeners.push(listener); },
    postMessage(message) { messages.push(message); } };
  const location = { origin: 'http://127.0.0.1:8080', hostname: '127.0.0.1', protocol: 'http:', port: '8080' };
  const oldRuntime = { id: 'old', sendMessage() { throw new Error('old listener should be silent'); } };
  const source = fs.readFileSync(path.join(directory, 'chat.js'), 'utf8');
  const document = { documentElement: { dataset: {} } };
  vm.runInNewContext(source, { chrome: { runtime: oldRuntime }, document, location, window, setTimeout, clearTimeout });
  oldRuntime.id = undefined;
  const newRuntime = { id: 'new', sendMessage(_message, callback) { callback({ text: '新章节' }); } };
  vm.runInNewContext(source, { chrome: { runtime: newRuntime }, document, location, window, setTimeout, clearTimeout });
  for (const listener of listeners) listener({ source: window, origin: location.origin,
    data: { channel: 'cngp-reader-request', id: 'reload-test', op: 'attach', url: chapterURL } });
  const responses = messages.filter(message => message.channel === 'cngp-reader-response');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].response.text, '新章节');
});

test('番茄脚本在上下文失效时不抛错，重复注入只注册一次', () => {
  const source = fs.readFileSync(path.join(directory, 'fanqie.js'), 'utf8');
  assert.doesNotThrow(() => vm.runInNewContext(source, { chrome: {} }));
  assert.doesNotThrow(() => vm.runInNewContext(source, { chrome: {
    runtime: { onMessage: { addListener() { throw new Error('Extension context invalidated.'); } } },
  } }));
  let registrations = 0;
  const context = vm.createContext({ chrome: { runtime: { onMessage: { addListener() { registrations++; } } } } });
  vm.runInContext(source, context);
  vm.runInContext(source, context);
  assert.equal(registrations, 1);
});

for (const origin of ['https://chatnogpt.autowired.cn', 'http://127.0.0.1:8080']) {
  test(`${origin} can request a chapter through the extension`, async () => {
    assert(manifest.host_permissions.some(pattern => (origin + '/').startsWith(pattern.slice(0, -2))));
    assert(manifest.content_scripts.some(script => script.js.includes('chat.js') &&
      script.matches.some(pattern => (origin + '/').startsWith(pattern.slice(0, -2)))));

    let backgroundListener;
    const chapter = { url: chapterURL, title: '第217章', text: '正文'.repeat(100), paragraphs: 1 };
    const backgroundChrome = {
      runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { backgroundListener = fn; } } },
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
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
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
