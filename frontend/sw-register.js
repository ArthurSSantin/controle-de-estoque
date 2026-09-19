// Registra o Service Worker do PWA (permite instalar o app e funcionar
// offline). Roda só em produção (https) ou localhost; navegadores exigem
// conexão segura pra Service Worker funcionar.
// Extraído de index.html pra sair de <script> inline e permitir uma CSP
// sem 'unsafe-inline' em script-src.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Falha ao registrar o Service Worker:', err);
    });
  });
}
