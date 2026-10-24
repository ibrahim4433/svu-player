(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const buildMeta = document.querySelector("meta[name=\"build\"]");
  const buildId = buildMeta ? buildMeta.content : "";
  if (byId("buildId")) {
    byId("buildId").textContent = buildId || "local";
  }
  async function reloadLatest() {
    try {
      if ("serviceWorker" in navigator) {
        for (const reg of await navigator.serviceWorker.getRegistrations()) {
          await reg.unregister();
        }
      }
      if (window.caches) {
        for (const name of await caches.keys()) {
          await caches.delete(name);
        }
      }
    } catch (err) {}
    const url = new URL(location.href);
    url.searchParams.set("r", Date.now().toString(36));
    location.replace(url.toString());
  }
  if (byId("reloadLatestBtn")) {
    byId("reloadLatestBtn").addEventListener("click", reloadLatest);
  }
})();
