// Service Worker：只負責快取「靜態外殼」（HTML/CSS/JS/圖示），
// 讓瀏覽器願意把這個網站當成可安裝的 App，並支援「偵測到新版本時跳出更新按鈕」。
// Socket.io 即時連線跟 /api/ 資料一律不快取，永遠走網路，不然遊戲資料會是舊的。
const CACHE_NAME = 'snake-online-shell-v3';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/style.css',
  '/auth.js',
  '/leaderboard.js',
  '/shop.js',
  '/game.js',
  '/firebase-config.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => {})
  );
  // 注意：這裡故意不呼叫 self.skipWaiting()。
  // 新版本先進入「等待中」狀態，等使用者在畫面上按下「立即更新」才會真正切換過去，
  // 不然舊分頁畫面用到一半，程式碼卻突然被換掉，反而容易出怪問題。
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 收到畫面上「立即更新」按鈕送來的訊息，才真正啟用新版本
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 即時連線與 API 資料一定要走網路，不能用快取
  if (url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
