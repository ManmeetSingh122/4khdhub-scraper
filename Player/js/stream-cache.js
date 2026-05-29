/**
 * StreamCache — Manages stream URL caching and metadata
 * Stores recently played streams with their metadata for quick re-access
 */
export class StreamCache {
    constructor() {
        this.KEY     = 'netwatch_stream_cache';
        this.MAX     = 20;
        this._cache  = this._load();
    }

    _load() {
        try {
            const raw = localStorage.getItem(this.KEY);
            return raw ? JSON.parse(raw) : [];
        } catch { return []; }
    }

    _save() {
        try { localStorage.setItem(this.KEY, JSON.stringify(this._cache)); }
        catch { console.warn('StreamCache: localStorage write failed'); }
    }

    /**
     * Store a stream entry
     * @param {object} entry - { id, src, title, type, poster, subUrl, ... }
     */
    set(entry) {
        if (!entry?.id) return;
        this._cache = this._cache.filter(e => e.id !== entry.id);
        this._cache.unshift({ ...entry, cachedAt: Date.now() });
        if (this._cache.length > this.MAX) this._cache.length = this.MAX;
        this._save();
    }

    /**
     * Get a cached stream by id
     */
    get(id) {
        return this._cache.find(e => e.id === id) || null;
    }

    /**
     * Get all cached streams
     */
    getAll() {
        return [...this._cache];
    }

    /**
     * Remove a stream from cache
     */
    remove(id) {
        this._cache = this._cache.filter(e => e.id !== id);
        this._save();
    }

    /**
     * Clear all cached streams
     */
    clear() {
        this._cache = [];
        this._save();
    }

    /**
     * Get cache size
     */
    get size() { return this._cache.length; }
}
