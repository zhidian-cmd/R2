/* r2em Service Worker
 *
 * 策略：
 *   - HTML（导航请求）与 bundle.js（全部业务逻辑入口）：网络优先，离线回缓存
 *     ——保证部署后入口页与逻辑代码总是最新（旧缓存最多造成一次刷新延迟）
 *   - 其余同源静态资源（css/svg/png/ico）：SWR（缓存优先立即返回 + 后台拉新写入缓存）
 *     二次打开零网络等待，且最多一次导航延迟后自动拿到新版
 *   - 跨源请求（R2 API、公共链接、预签名直链）：直接放行，绝不缓存用户数据
 */
var CACHE = 'r2em-runtime';

self.addEventListener('install', function (e) {
  // 清掉上一代运行时缓存：部署新版后第一个请求就回源拿新文件（"部署即生效"）
  e.waitUntil(caches.delete(CACHE));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    var names = await caches.keys();
    await Promise.all(names.filter(function (n) { return n !== CACHE; }).map(function (n) { return caches.delete(n); }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // R2 API / 公开链接不缓存

  var accept = req.headers.get('accept') || '';
  var isHTML = req.mode === 'navigate' || accept.indexOf('text/html') !== -1;
  // bundle.js 必须网络优先：它是全部业务逻辑的唯一入口，SWR 先回旧缓存会让
  // 用户在部署新版后的第一次加载仍跑旧代码（实测发生过：修复没生效像"没修"）
  var isBundle = /\/js\/bundle\.js$/.test(url.pathname);
  var isStatic = /\.(?:js|css|svg|png|ico)$/.test(url.pathname);

  if (isHTML || isBundle) {
    e.respondWith((async function () {
      try {
        // cache:'reload'：绕过浏览器 HTTP 缓存强制回源（bundle 的 HTTP 缓存同样会让
        // 旧代码复活）；离线时 reload 失败，落到底部 caches.match 兜底
        var res = await fetch(req, isBundle ? { cache: 'reload' } : undefined);
        var cache = await caches.open(CACHE);
        cache.put(req, res.clone());
        return res;
      } catch (err) {
        var cached = await caches.match(req);
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  if (isStatic) {
    e.respondWith((async function () {
      var cached = await caches.match(req);
      var update = fetch(req).then(function (res) {
        if (res && res.ok) {
          var clone = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, clone); });
        }
        return res;
      }).catch(function () { return null; });
      if (cached) {
        e.waitUntil(update.then(function () {}, function () {})); // 先回缓存，后台静默更新
        return cached;
      }
      var fresh = await update;
      if (!fresh) throw new Error('offline');
      return fresh;
    })());
  }
  // 其余同源请求不拦截
});
