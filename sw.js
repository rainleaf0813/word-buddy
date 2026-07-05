// Service Worker：網路優先、離線時用快取備援（避免更新後還載到舊版）

const CACHE = 'wordbuddy-v1';
const ASSETS = [
  '.',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/dictionary.js',
  'js/grammar.js',
  'js/speech.js',
  'js/storage.js',
  'manifest.json',
  'icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 只處理自己網站的檔案；字典、文法等 API 永遠走網路
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
