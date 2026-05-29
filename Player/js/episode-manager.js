/**
 * EpisodeManager — Manages TV series episode playlist
 * Supports: auto-next, prev/next navigation, playlist injection via URL params or API
 */
export class EpisodeManager {
    constructor() {
        this.playlist    = [];  // Array of { id, title, src, subUrl, poster, season, episode, type }
        this.currentIdx  = -1;
    }

    /**
     * Load a playlist of episodes
     * @param {Array} episodes
     * @param {number} startIndex
     */
    load(episodes, startIndex = 0) {
        this.playlist   = episodes || [];
        this.currentIdx = startIndex;
    }

    /**
     * Set current episode by matching src URL
     */
    setCurrentBySrc(src) {
        const idx = this.playlist.findIndex(e => e.src === src);
        if (idx !== -1) this.currentIdx = idx;
    }

    /**
     * Set current episode by season/episode number
     */
    setCurrentByEpisode(season, episode) {
        const idx = this.playlist.findIndex(e => e.season === season && e.episode === episode);
        if (idx !== -1) this.currentIdx = idx;
    }

    /**
     * Add a single episode to the playlist
     */
    addEpisode(ep) {
        this.playlist.push(ep);
    }

    /**
     * Build a simple playlist from current meta + next episode info
     * Used when no full playlist is available
     */
    buildFromMeta(currentMeta, nextMeta) {
        this.playlist = [];
        if (currentMeta) {
            this.playlist.push({ ...currentMeta, src: currentMeta.src || '' });
            this.currentIdx = 0;
        }
        if (nextMeta) {
            this.playlist.push({ ...nextMeta, src: nextMeta.src || '' });
        }
    }

    hasPrev() {
        return this.currentIdx > 0;
    }

    hasNext() {
        return this.currentIdx < this.playlist.length - 1;
    }

    getCurrent() {
        return this.playlist[this.currentIdx] || null;
    }

    getNext() {
        if (!this.hasNext()) return null;
        return this.playlist[this.currentIdx + 1];
    }

    getPrev() {
        if (!this.hasPrev()) return null;
        return this.playlist[this.currentIdx - 1];
    }

    /**
     * Play next episode
     * @param {Function} launchFn - async function(src, meta)
     */
    async playNext(launchFn) {
        if (!this.hasNext()) return;
        this.currentIdx++;
        const ep = this.playlist[this.currentIdx];
        if (ep?.src) {
            await launchFn(ep.src, ep);
        }
    }

    /**
     * Play previous episode
     * @param {Function} launchFn - async function(src, meta)
     */
    async playPrev(launchFn) {
        if (!this.hasPrev()) return;
        this.currentIdx--;
        const ep = this.playlist[this.currentIdx];
        if (ep?.src) {
            await launchFn(ep.src, ep);
        }
    }

    /**
     * Parse episode playlist from URL query param
     * Format: ?playlist=[{src,title,season,episode,...},...]
     */
    loadFromURLParam() {
        try {
            const params = new URLSearchParams(window.location.search);
            const raw    = params.get('playlist');
            if (!raw) return false;
            const list   = JSON.parse(decodeURIComponent(raw));
            if (Array.isArray(list) && list.length) {
                const startSrc = params.get('src');
                const startIdx = startSrc ? list.findIndex(e => e.src === startSrc) : 0;
                this.load(list, Math.max(0, startIdx));
                return true;
            }
        } catch { /* ignore */ }
        return false;
    }

    get length() { return this.playlist.length; }
}
