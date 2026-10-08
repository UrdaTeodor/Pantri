import { html, render } from './ui/lib.js';
import { App } from './ui/app.js';
import { showToast, navigate } from './ui/nav.js';
import { initStore } from './store.js';
import { initCloud } from './cloud.js';

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    const offer = () => showToast('A new version of the app is ready.', {
      action: { label: 'Update', fn: () => reg.waiting && reg.waiting.postMessage({ type: 'SKIP_WAITING' }) },
      timeout: 0,
    });
    if (reg.waiting && hadController) offer();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => w.state === 'installed' && navigator.serviceWorker.controller && offer());
    });
    let lastCheck = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck > 3600e3) {
        lastCheck = Date.now();
        reg.update().catch(() => {});
      }
    });
  }).catch(e => console.warn('Service worker not registered', e));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
}

await initStore();
render(html`<${App} />`, document.getElementById('app'));
registerServiceWorker();
// Online backup (only when config.js sets it up): never delays the app, works in the background.
initCloud({
  notify: text => showToast(text, { timeout: 10000 }),
  openAccount: () => navigate('#/account', { replace: true }),
});
