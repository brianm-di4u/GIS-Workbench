// The user's recipe and workflow library (REQ-GAP-84): kept in IndexedDB with no cap, where the
// settings held only the last 20 imported recipes. Recipes are data: they are validated against
// the operations before they run, and never run on their own. Without IndexedDB (a locked-down
// sandbox) the library is empty and saving says so.

const DB = 'gw-workflows';
const STORE = 'workflows';

function idb() {
  return new Promise((res, rej) => {
    if (!globalThis.indexedDB) return rej(new Error('IndexedDB is not available'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('IndexedDB is blocked by another tab'));
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(out?.result ?? out);
      tx.onerror = () => rej(tx.error);
      // A commit can fail with no request error (a full disk): the transaction aborts.
      tx.onabort = () => rej(tx.error ?? new Error('the library transaction was aborted'));
    });
  } finally {
    db.close();
  }
}

/** Every recipe and workflow in the library, oldest first. */
export const listLibrary = () => idbDo('readonly', (st) => st.getAll()).then((rows) => rows.sort((a, b) => String(a.saved).localeCompare(String(b.saved))).map((x) => x.recipe));
/** Keep a recipe (a validated gw-recipe object) in the library, replacing one with its id. */
export const putLibrary = (recipe) => idbDo('readwrite', (st) => st.put({ id: recipe.id, recipe: JSON.parse(JSON.stringify(recipe)), saved: new Date().toISOString() }));
export const removeFromLibrary = (id) => idbDo('readwrite', (st) => st.delete(id));

/** Move the recipes the settings kept (the old cap of 20) into the library, once. */
export async function migrateFromPrefs(prefs) {
  const old = prefs.get('recipes');
  if (!Array.isArray(old) || !old.length) return 0;
  for (const r of old) if (r?.id) await putLibrary(r);
  prefs.set('recipes', []);
  return old.length;
}
