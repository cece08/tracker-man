/*
 * Garde-fou de démarrage (chargé avant Angular).
 * Si l'appli ne s'est pas affichée après quelques secondes (écran noir : cache du service worker
 * corrompu, JS d'une ancienne version introuvable, erreur au lancement…), propose un bouton
 * qui vide le cache hors-ligne et recharge l'appli. Fichier externe car la CSP interdit les scripts inline.
 */
(function () {
  var BOOT_TIMEOUT_MS = 10000;
  var shown = false;

  function stillBooting() {
    return !!document.getElementById('boot-splash');
  }

  function repairAndReload() {
    var tasks = [];
    try {
      if ('serviceWorker' in navigator) {
        tasks.push(
          navigator.serviceWorker.getRegistrations().then(function (regs) {
            return Promise.all(regs.map(function (r) { return r.unregister(); }));
          })
        );
      }
      if (window.caches && caches.keys) {
        tasks.push(
          caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (k) { return caches.delete(k); }));
          })
        );
      }
    } catch (e) { /* ignore */ }
    Promise.all(tasks).catch(function () {}).then(function () {
      location.replace(location.pathname + '?r=' + Date.now());
    });
  }

  function showRepair() {
    if (shown || !stillBooting()) return;
    shown = true;
    var box = document.getElementById('boot-repair');
    if (box) box.style.display = 'block';
    var btn = document.getElementById('boot-repair-btn');
    if (btn) btn.addEventListener('click', repairAndReload);
  }

  window.addEventListener('error', function () {
    if (stillBooting()) setTimeout(showRepair, 1500);
  });
  window.addEventListener('unhandledrejection', function () {
    if (stillBooting()) setTimeout(showRepair, 1500);
  });
  setTimeout(showRepair, BOOT_TIMEOUT_MS);
})();
