// The modules under test are browser code, so give Node the two browser APIs
// they reach for at import time: IndexedDB (db.js opens the database as a
// side effect of being imported) and localStorage (still the home of
// credentials and preferences).
//
// No jsdom: nothing tested here touches the DOM. That's the point of what
// lives in text.js, zip.js and db.js.
import 'fake-indexeddb/auto';

class MemoryStorage {
  #map = new Map();
  getItem(k) {
    return this.#map.has(k) ? this.#map.get(k) : null;
  }
  setItem(k, v) {
    this.#map.set(k, String(v));
  }
  removeItem(k) {
    this.#map.delete(k);
  }
  clear() {
    this.#map.clear();
  }
  key(i) {
    return [...this.#map.keys()][i] ?? null;
  }
  get length() {
    return this.#map.size;
  }
}

globalThis.localStorage = new MemoryStorage();
