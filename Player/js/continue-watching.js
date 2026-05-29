/**
 * ContinueWatching — Syncs with streaming-app's localStorage format
 * Keys: netwatch_continue_main / netwatch_continue_kids
 * Shape: TMDB item + { progress: 0-100, position: seconds, src, subUrl, savedAt }
 */
export class ContinueWatching {
    constructor() {
        this.PROFILE_KEY = 'netwatch_active_profile';
        this.MAX         = 10;
    }

    _getKey() {
        try {
            const profile = localStorage.getItem(this.PROFILE_KEY) || 'main';
            return `netwatch_continue_${profile}`;
        } catch { return 'netwatch_continue_main'; }
    }

    _load() {
        try {
            const raw = localStorage.getItem(this._getKey());
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch { return []; }
    }

    _write(arr) {
        try { localStorage.setItem(this._getKey(), JSON.stringify(arr)); }
        catch { console.warn('ContinueWatching: write failed'); }
    }

    /**
     * Save / update a continue-watching entry
     * @param {object} item - must have id, title, progress (0-100), position (seconds)
     */
    save(item) {
        if (!item?.id) return;
        let arr = this._load().filter(e => e.id !== item.id);
        arr.unshift(item);
        if (arr.length > this.MAX) arr.length = this.MAX;
        this._write(arr);
    }

    /**
     * Get saved playback position in seconds for a given id
     */
    getProgress(id) {
        if (!id) return 0;
        const entry = this._load().find(e => e.id === id);
        return entry?.position || 0;
    }

    /**
     * Get full entry for a given id
     */
    getEntry(id) {
        return this._load().find(e => e.id === id) || null;
    }

    /**
     * Get all continue-watching entries
     */
    getAll() {
        return this._load();
    }

    /**
     * Remove an entry (e.g. when finished)
     */
    remove(id) {
        const arr = this._load().filter(e => e.id !== id);
        this._write(arr);
    }

    /**
     * Clear all entries for current profile
     */
    clear() {
        this._write([]);
    }
}
