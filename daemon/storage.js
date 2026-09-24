/**
 * File-backed storage for Engine 2 — what `chrome.storage` and IndexedDB are
 * to the extension, `platform-cdp` gets from here (ARCHITECTURE §3.2, §9).
 *
 * ## StorageArea: chrome.storage semantics, exactly
 *
 * The tool modules were written against `chrome.storage.{local,session}`, so
 * every quirk they rely on is reproduced rather than "improved":
 *   get(null|undefined) → everything; get('k') → {k} or {}; get(['a','b']) →
 *   only the keys that exist; get({k: fallback}) → stored value or fallback;
 *   set({k: undefined}) stores nothing for k; values are JSON (a stored object
 *   is a copy, never a live reference — mutating what get() returned must not
 *   change the store, just as in the browser).
 *
 * ## Durability
 *
 * `storage.local` holds recordings and issues — a QA's work. Every set/remove
 * resolves only after the data is on disk, written to a temp file and renamed
 * over the old one, so a crash mid-write leaves the previous version, never a
 * truncated file. Writes are coalesced: while one flush runs, further changes
 * wait for the next, so a burst of 50 sets costs two file writes, not 50.
 * `storage.session` is in memory only: it is cleared when the daemon exits,
 * which is what "session" means in the browser too.
 *
 * ## Blobs
 *
 * `platform.blobs` replaces IndexedDB (attachments, screencast frames):
 * `store/blobs/<store>/<id>.bin` + `<id>.json`. Ids are file-name-encoded
 * because the extension's frame ids contain ':' — legal in IndexedDB, illegal
 * in a Windows file name.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './paths.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * Own keys only. `key in data` also sees Object.prototype, so get('toString')
 * returned a function (and then threw cloning it) and set({__proto__: …})
 * replaced the store's prototype instead of storing a key. chrome.storage has
 * neither quirk; the data objects are prototype-free and every lookup is own.
 */
const has = (data, key) => Object.prototype.hasOwnProperty.call(data, key);

/** Define an own data property — plain assignment of "__proto__" would set the prototype. */
const put = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });

/** A prototype-free copy of plain stored data: "__proto__" is then just a key. */
function bare(data) {
  const out = Object.create(null);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of Object.keys(data)) out[key] = data[key];
  }
  return out;
}

/** Apply chrome.storage `get` key semantics to a plain object of stored data. */
export function selectKeys(data, keys) {
  if (keys === null || keys === undefined) return clone({ ...data });
  if (typeof keys === 'string') return has(data, keys) ? put({}, keys, clone(data[keys])) : {};
  if (Array.isArray(keys)) {
    const out = {};
    for (const key of keys) if (typeof key === 'string' && has(data, key)) put(out, key, clone(data[key]));
    return out;
  }
  if (typeof keys === 'object') {
    const out = {};
    for (const [key, fallback] of Object.entries(keys)) put(out, key, has(data, key) ? clone(data[key]) : clone(fallback));
    return out;
  }
  throw new TypeError('storage.get: keys must be null, a string, an array of strings, or an object of defaults.');
}

function keyList(keys) {
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys.filter((k) => typeof k === 'string');
  throw new TypeError('storage.remove: keys must be a string or an array of strings.');
}

/** In-memory StorageArea — `storage.session`, and the base of the file-backed one. */
export class MemoryStorageArea {
  constructor(initial = {}) {
    this.data = bare(clone(initial));
    this.listeners = new Set();
  }

  async get(keys) {
    return selectKeys(this.data, keys);
  }

  async getKeys() {
    return Object.keys(this.data);
  }

  async set(items) {
    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      throw new TypeError('storage.set needs an object of key/value pairs.');
    }
    const changes = {};
    for (const [key, value] of Object.entries(items)) {
      if (value === undefined) continue;
      const next = clone(value);
      put(changes, key, { oldValue: this.data[key], newValue: next });
      this.data[key] = next;
    }
    this.#notify(changes);
    await this.persist();
  }

  async remove(keys) {
    const changes = {};
    for (const key of keyList(keys)) {
      if (has(this.data, key)) {
        put(changes, key, { oldValue: this.data[key] });
        delete this.data[key];
      }
    }
    this.#notify(changes);
    await this.persist();
  }

  async clear() {
    const changes = {};
    for (const key of Object.keys(this.data)) put(changes, key, { oldValue: this.data[key] });
    this.data = bare({});
    this.#notify(changes);
    await this.persist();
  }

  /** Approximate bytes, as chrome.storage reports them (JSON length of key + value). */
  async getBytesInUse(keys = null) {
    const selected = selectKeys(this.data, keys);
    let total = 0;
    for (const [key, value] of Object.entries(selected)) total += key.length + JSON.stringify(value).length;
    return total;
  }

  onChanged(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #notify(changes) {
    if (!Object.keys(changes).length) return;
    for (const fn of this.listeners) {
      try { fn(changes); } catch { /* a listener must not break a write */ }
    }
  }

  async persist() {}
}

/** File-backed StorageArea — `storage.local` for Engine 2. */
export class FileStorageArea extends MemoryStorageArea {
  constructor(file, { log = () => {} } = {}) {
    super({});
    this.file = file;
    this.log = log;
    this.flushing = null;
    this.dirty = false;
    this.data = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return bare(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the unreadable file for a human; start empty rather than refuse to run.
        const aside = `${this.file}.corrupt-${Date.now()}`;
        try { fs.renameSync(this.file, aside); } catch { /* leave it */ }
        this.log(`[storage] ${this.file} was unreadable (${err.message}); moved aside to ${aside}`);
      }
      return bare({});
    }
  }

  /**
   * Resolve once the CURRENT data is on disk. Coalescing: a caller arriving
   * while a flush runs waits for the flush after it, which includes its change.
   */
  persist() {
    this.dirty = true;
    if (!this.flushing) {
      this.flushing = (async () => {
        try {
          while (this.dirty) {
            this.dirty = false;
            await writeFileAtomic(this.file, JSON.stringify({ ...this.data }));
          }
        } finally {
          this.flushing = null;
        }
      })();
      return this.flushing;
    }
    // A flush is running: it loops while dirty, so our change is written by it.
    return this.flushing;
  }
}

// ------------------------------------------------------------------- blobs

/** File-name-safe encoding of an id: keeps [A-Za-z0-9._-], %XX-escapes the rest. */
export function encodeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, (ch) =>
    [...Buffer.from(ch, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
  );
}

export function decodeId(name) {
  return decodeURIComponent(name);
}

const STORE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * `platform.blobs` on disk. Each store keeps an in-memory index of its records'
 * metadata (everything but the bytes), loaded on first use, so `byIndex` over a
 * few thousand screencast frames is a Map scan, not a directory read.
 */
export class FileBlobs {
  constructor(dir, { log = () => {} } = {}) {
    this.dir = dir;
    this.log = log;
    this.indexes = new Map(); // store → Promise<Map(id → meta)>
    this.chain = Promise.resolve();
  }

  #storeDir(store) {
    if (!STORE_NAME.test(String(store))) throw new Error(`Invalid blob store name "${store}".`);
    return path.join(this.dir, store);
  }

  /**
   * The store's index, loaded once. The PROMISE is cached, not the map: two
   * first uses racing (a frame put while a viewer lists frames) used to read
   * the directory twice and install two maps, and the loser's later puts
   * vanished from the one that won — frames on disk that byIndex never saw.
   */
  #index(store) {
    let loading = this.indexes.get(store);
    if (!loading) {
      loading = this.#loadIndex(store);
      this.indexes.set(store, loading);
      loading.catch(() => this.indexes.delete(store));
    }
    return loading;
  }

  async #loadIndex(store) {
    const index = new Map();
    const dir = this.#storeDir(store);
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
        if (meta && meta.id != null) index.set(String(meta.id), meta);
      } catch {
        /* a half-written sidecar is skipped; its .bin is orphaned, not fatal */
      }
    }
    return index;
  }

  /** Serialise mutations: two puts of one id must not interleave their two files. */
  #exclusive(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async put(store, record) {
    if (!record || typeof record !== 'object') throw new TypeError('blobs.put needs a record object.');
    return this.#exclusive(async () => {
      const id = record.id != null ? String(record.id) : `b_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const { blob, ...fields } = record;
      const meta = { ...clone(fields), id };
      const base = path.join(this.#storeDir(store), encodeId(id));
      if (blob != null) {
        const bytes = await toBytes(blob);
        meta.__blob = { size: bytes.length, type: blob.type || fields.mime || '' };
        await writeFileAtomic(`${base}.bin`, bytes);
      } else {
        await fsp.rm(`${base}.bin`, { force: true });
      }
      await writeFileAtomic(`${base}.json`, JSON.stringify(meta));
      (await this.#index(store)).set(id, meta);
    });
  }

  async get(store, id) {
    const index = await this.#index(store);
    const meta = index.get(String(id));
    if (!meta) return null;
    return this.#materialise(store, meta);
  }

  async delete(store, id) {
    return this.#exclusive(async () => {
      const index = await this.#index(store);
      const key = String(id);
      const base = path.join(this.#storeDir(store), encodeId(key));
      await fsp.rm(`${base}.json`, { force: true });
      await fsp.rm(`${base}.bin`, { force: true });
      index.delete(key);
    });
  }

  async byIndex(store, field, value) {
    const index = await this.#index(store);
    const out = [];
    for (const meta of index.values()) {
      if (meta[field] === value) out.push(await this.#materialise(store, meta));
    }
    return out;
  }

  async deleteByIndex(store, field, value) {
    const index = await this.#index(store);
    const ids = [...index.values()].filter((m) => m[field] === value).map((m) => m.id);
    for (const id of ids) await this.delete(store, id);
    return ids.length;
  }

  /**
   * `{ count, bytes }` of a store from its in-memory index — the optional
   * `platform.blobs.stats` extension/lib/store.js usage() asks for. Without it
   * the launched-engine store fell back to listing every owner's attachments
   * on each issue-list refresh. `bytes` sums the records' own `size` field, as
   * the extension's IndexedDB cursor does, so both engines report alike.
   */
  async stats(store) {
    const index = await this.#index(store);
    let bytes = 0;
    for (const meta of index.values()) bytes += Number(meta.size) || 0;
    return { count: index.size, bytes };
  }

  async #materialise(store, meta) {
    const { __blob, ...fields } = meta;
    const record = clone(fields);
    if (__blob) {
      try {
        const bytes = await fsp.readFile(path.join(this.#storeDir(store), `${encodeId(meta.id)}.bin`));
        record.blob = new Blob([bytes], { type: __blob.type || '' });
      } catch {
        record.blob = null; // the bytes are gone; say so rather than inventing an empty blob
      }
    }
    return record;
  }
}

/** In-memory `platform.blobs` with the same semantics — for tests. */
export class MemoryBlobs {
  constructor() {
    this.stores = new Map();
  }
  #store(name) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return this.stores.get(name);
  }
  async put(store, record) {
    const { blob, ...fields } = record;
    const id = String(record.id);
    const entry = { ...clone(fields), id };
    if (blob != null) {
      const bytes = await toBytes(blob);
      entry.__bytes = bytes;
      entry.__type = blob.type || fields.mime || '';
    }
    this.#store(store).set(id, entry);
  }
  async get(store, id) {
    const entry = this.#store(store).get(String(id));
    return entry ? materialiseMemory(entry) : null;
  }
  async delete(store, id) {
    this.#store(store).delete(String(id));
  }
  async byIndex(store, field, value) {
    return [...this.#store(store).values()].filter((e) => e[field] === value).map(materialiseMemory);
  }
  async deleteByIndex(store, field, value) {
    const s = this.#store(store);
    let n = 0;
    for (const [id, e] of s) if (e[field] === value) { s.delete(id); n += 1; }
    return n;
  }
  async stats(store) {
    let bytes = 0;
    for (const e of this.#store(store).values()) bytes += Number(e.size) || 0;
    return { count: this.#store(store).size, bytes };
  }
}

function materialiseMemory(entry) {
  const { __bytes, __type, ...fields } = entry;
  const record = clone(fields);
  if (__bytes) record.blob = new Blob([__bytes], { type: __type });
  return record;
}

async function toBytes(blob) {
  if (blob instanceof Uint8Array) return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (blob instanceof ArrayBuffer) return Buffer.from(blob);
  if (typeof blob?.arrayBuffer === 'function') return Buffer.from(await blob.arrayBuffer());
  if (typeof blob === 'string') return Buffer.from(blob, 'utf8');
  throw new TypeError('A blob must be a Blob, Uint8Array, ArrayBuffer or string.');
}
