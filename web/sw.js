// ChatNoGPT Service Worker：只缓存应用外壳与带版本号的静态资源。
// /api/、/ws、/downloads/ 一律直连，聊天数据永不落盘（伪装隐私优先）。
// 版本号与 web/index.html 的资源 ?v= 同步更新。
const VERSION = 'v2.4.3';
const SHELL_CACHE = 'cngp-shell-' + VERSION;
const ASSET_CACHE = 'cngp-asset-' + VERSION;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (!key.endsWith(VERSION)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // 隐私与动态内容：消息、登录态、上传下载、WebSocket 全部直连，绝不缓存
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/downloads/')) return;

  // 带版本号的静态资源（app.js?v= / style.css?v= / 插件脚本）：内容随版本变更，缓存优先
  if (url.search.includes('v=')) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // 页面外壳（含 /s/ 分享落地页）：网络优先，离线回退缓存
  if (url.pathname === '/' || url.pathname.startsWith('/index.html') || url.pathname.startsWith('/s/')) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = (await cache.match(req)) || (await cache.match('/'));
        if (hit) return hit;
        return new Response('离线且暂无缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // 其余同源静态（图标 / manifest / 主题资源）：缓存优先
  event.respondWith((async () => {
    const cache = await caches.open(ASSET_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  })());
});
