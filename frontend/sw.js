// Service Worker do Controle de Estoque de Pneus.
// Faz cache da "casca" do app (HTML/CSS/JS estáticos) pra ele abrir rápido e
// funcionar mesmo com internet instável. Os dados de estoque em si sempre
// vêm da API (Supabase via backend) — isso aqui não guarda dados, só arquivos.

// IMPORTANTE: mude esse número toda vez que publicar uma nova versão do
// frontend, senão os usuários que já instalaram o app podem continuar vendo
// a versão antiga em cache por um tempo.
const CACHE_VERSION = 'v2';
const CACHE_NAME = `estoque-pneus-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './auth.css',
  './app.js',
  './auth.js',
  './config.js',
  './manifest.json',
  './vendor/xlsx.full.min.js',
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Nunca cacheia chamadas de API (dados sempre precisam vir "ao vivo" do
  // backend/Supabase) — só a casca estática do app usa cache.
  if (req.method !== 'GET' || req.url.includes('/api/') || req.url.includes('supabase.co')) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => cached);

      // Cache-first pra abrir rápido; atualiza o cache em segundo plano.
      return cached || network;
    })
  );
});
