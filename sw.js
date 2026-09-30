/**
 * 成都都江堰行程 PWA Service Worker
 *
 * 設計理念：永遠不需要手動改版本號
 *
 * 策略分層：
 * 1. HTML / manifest → network-first
 *    每次都先去網路抓最新版本，抓不到或 3 秒沒回應才用快取。只要 git push，
 *    下次打開（有網路時）就自動拿到新版，不需要任何手動操作。
 *
 * 2. 其他資源（CDN、圖片、地圖瓦片）→ stale-while-revalidate
 *    立刻用快取顯示（快），背景去網路抓新版更新快取。
 *    URL 帶版本號的（如 react@18）反正內容不會變。
 *
 * 3. 完全離線時 → 全部 fallback 到快取，依然能用
 *
 * 安裝時先預載 App 本體和 CDN 函式庫，第一次打開後就能離線使用。
 */

const CACHE_NAME = 'chengdu-trip-cache';

// 安裝時預先快取（用 CORS 抓，才能存下 babel、Google Fonts 這類 no-cors 載入的資源）
const PRECACHE_URLS = [
  './',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  'https://unpkg.com/react@18/umd/react.development.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.development.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;500;600;700&display=swap',
];

// 安裝：預載資源（個別失敗不影響安裝），跳過等待，立刻接管
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(PRECACHE_URLS.map(url => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

// 啟動：清掉舊版的 cache（如果以前用過別的 cache 名）
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isHTMLOrManifest(request, url) {
  return request.mode === 'navigate'
      || url.pathname.endsWith('.html')
      || url.pathname.endsWith('/')
      || url.pathname.endsWith('.webmanifest');
}

// network-first：先網路，失敗或逾時才用快取
// 在大陸連 github.io 有時不會失敗、而是一直卡住，所以等 3 秒沒回應就先開快取版本，
// 網路版在背景繼續抓，抓到就存起來，下次打開就是新版
const NETWORK_TIMEOUT_MS = 3000;

async function networkFirst(event) {
  const request = event.request;
  const cachePromise = caches.open(CACHE_NAME);
  const network = fetch(request).then(async fresh => {
    if (fresh && fresh.ok) (await cachePromise).put(request, fresh.clone());
    return fresh;
  });
  event.waitUntil(network.catch(() => {}));

  const cachedCopy = async () => {
    const cache = await cachePromise;
    return await cache.match(request)
      || (request.mode === 'navigate' && await cache.match('./'));
  };

  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const fresh = await Promise.race([network, timeout]);
    if (fresh) return fresh;
    return (await cachedCopy()) || (await network);
  } catch (err) {
    const cached = await cachedCopy();
    if (cached) return cached;
    throw err;
  }
}

// stale-while-revalidate：先回快取，背景抓新版
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then(response => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || (await networkPromise) || Response.error();
}

self.addEventListener('fetch', (event) => {
  // 只處理 GET 請求
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 只處理同源 + 已知第三方 CDN（避免誤攔不該管的）
  const allowedHosts = [
    self.location.host,
    'unpkg.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'tile.openstreetmap.org',
    'server.arcgisonline.com',
    'webrd01.is.autonavi.com',
    'webrd02.is.autonavi.com',
    'webrd03.is.autonavi.com',
    'webrd04.is.autonavi.com',
  ];
  if (!allowedHosts.includes(url.host)) return;

  if (isHTMLOrManifest(event.request, url)) {
    event.respondWith(networkFirst(event));
  } else {
    event.respondWith(staleWhileRevalidate(event.request));
  }
});
