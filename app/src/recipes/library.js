// The user's recipe and workflow library (REQ-GAP-84): kept in IndexedDB with no cap, where the
// settings held only the last 20 imported recipes. Recipes are data: they are validated against
// the operations before they run, and never run on their own. Without IndexedDB (a locked-down
// sandbox) the library is empty and saving says so.

import { txDone } from '../storage/idb.js';

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
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    return await txDone(tx, () => out?.result ?? out);
  } finally {
    db.close();
  }
}

/** Every recipe and workflow in the library, oldest first. */
export const listLibrary = () => idbDo('readonly', (st) => st.getAll()).then((rows) => rows.sort((a, b) => String(a.saved).localeCompare(String(b.saved))).map((x) => x.recipe));
/** Keep a recipe (a validated gw-recipe object) in the library, replacing one with its id. */
export const putLibrary = (recipe) => idbDo('readwrite', (st) => st.put({ id: recipe.id, recipe: JSON.parse(JSON.stringify(recipe)), saved: new Date().toISOString() }));
export const removeFromLibrary = (id) => idbDo('readwrite', (st) => st.delete(id));

/**
 * Copy the recipes the settings kept (the old cap of 20) into the library, once. The settings keep them,
 * so a build from before the library still lists them; the library's copy is the one this build shows.
 */
export async function migrateFromPrefs(prefs) {
  const old = prefs.get('recipes');
  if (prefs.get('recipesInLibrary') || !Array.isArray(old) || !old.length) return 0;
  for (const r of old) if (r?.id) await putLibrary(r);
  prefs.set('recipesInLibrary', true);
  return old.length;
}
