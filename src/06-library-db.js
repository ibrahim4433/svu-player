(function (ns) {
  'use strict';

  const BASE_DB_NAME = "lrec-library";
  const STORE_FILES = "files";
  const STORE_TRANSCRIPTS = "transcripts";
  const STORE_ENHANCED = "enhanced";
  let activeProfileId = "default";
  try {
    const savedProf = (window.SVU_PREFS && window.SVU_PREFS.get("svu.activeProfile.v1", "default")) || localStorage.getItem("svu.activeProfile.v1") || "default";
    if (savedProf && typeof savedProf === "string") {
      activeProfileId = savedProf.trim() || "default";
    }
  } catch (e) {}

  function getDbName() {
    if (!activeProfileId || activeProfileId === "default") {
      return BASE_DB_NAME;
    }
    return BASE_DB_NAME + "-" + activeProfileId.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(getDbName(), 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES, {
            keyPath: "id"
          });
        }
        if (!db.objectStoreNames.contains(STORE_TRANSCRIPTS)) {
          db.createObjectStore(STORE_TRANSCRIPTS, {
            keyPath: "id"
          });
        }
        if (!db.objectStoreNames.contains(STORE_ENHANCED)) {
          db.createObjectStore(STORE_ENHANCED, {
            keyPath: "id"
          });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function withStore(mode, fn, store = STORE_FILES) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      Promise.resolve(fn(tx.objectStore(store))).then(value => {
        result = value;
      }, reject);
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    });
  }
  const reqToPromise = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  ns.LibraryDB = {
    available: typeof indexedDB !== "undefined",
    setProfile(profileId) {
      activeProfileId = (profileId && String(profileId).trim()) || "default";
    },
    getProfile() {
      return activeProfileId;
    },
    put: record => withStore("readwrite", store => reqToPromise(store.put(record))),
    get: id => withStore("readonly", store => reqToPromise(store.get(id))),
    updateMeta: (id, patch) => withStore("readwrite", async store => {
      const existing = await reqToPromise(store.get(id));
      if (!existing) return null;
      const updated = Object.assign({}, existing, patch);
      await reqToPromise(store.put(updated));
      const { blob, ...rest } = updated;
      return rest;
    }),
    remove: async id => {
      await withStore("readwrite", store => reqToPromise(store.delete(id)));
      await withStore("readwrite", store => reqToPromise(store.delete(id)), STORE_TRANSCRIPTS);
      await withStore("readwrite", store => reqToPromise(store.delete(id)), STORE_ENHANCED);
    },
    putEnhanced: record => withStore("readwrite", store => reqToPromise(store.put(record)), STORE_ENHANCED),
    getEnhanced: id => withStore("readonly", store => reqToPromise(store.get(id)), STORE_ENHANCED),
    putTranscript: record => withStore("readwrite", store => reqToPromise(store.put(record)), STORE_TRANSCRIPTS),
    getTranscript: id => withStore("readonly", store => reqToPromise(store.get(id)), STORE_TRANSCRIPTS),
    async list() {
      const records = await withStore("readonly", store => reqToPromise(store.getAll()));
      return records.map(({
        blob: blob,
        ...rest
      }) => rest).sort((a, b) => b.savedAt - a.savedAt);
    },
    async usage() {
      try {
        const estimate = await navigator.storage.estimate();
        const usage = {
          used: estimate.usage,
          quota: estimate.quota
        };
        return usage;
      } catch (err) {
        return null;
      }
    },
    persist() {
      try {
        return navigator.storage.persist();
      } catch (err) {
        return Promise.resolve(false);
      }
    }
  };
})(globalThis);
;

;
