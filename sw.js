'use strict';

/* 오프라인 지원 Service Worker
 * - 설치 시 앱 셸 + assets/ 전체를 프리캐시
 * - cache-first 전략, 네트워크 성공 시 캐시 갱신
 * - CACHE_VERSION을 올리면 이전 캐시가 정리되고 새로 받는다
 */

const CACHE_VERSION = 'v5';
const CACHE_NAME = `glitch-tile-${CACHE_VERSION}`;

const CORE = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'assets/index.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE);
    // 에셋 목록을 읽어 전부 프리캐시 (오프라인에서 에셋 브라우저가 동작하도록)
    try {
      const res = await cache.match('assets/index.json') || await fetch('assets/index.json');
      const index = await res.clone().json();
      const urls = [];
      for (const [folder, files] of Object.entries(index)) {
        for (const f of files) urls.push(`assets/${folder}/${f}`);
      }
      await cache.addAll(urls);
    } catch (_) { /* 에셋 프리캐시 실패는 치명적이지 않음 */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) {
      // 백그라운드 갱신 (온라인일 때만 성공)
      event.waitUntil(
        fetch(req).then(res => {
          if (res && res.ok) return cache.put(req, res.clone());
        }).catch(() => {})
      );
      return cached;
    }
    try {
      const res = await fetch(req);
      if (res && res.ok && new URL(req.url).origin === self.location.origin) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      // 오프라인 내비게이션은 앱 셸로
      if (req.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
