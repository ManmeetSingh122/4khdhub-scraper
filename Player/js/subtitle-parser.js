/**
 * SubtitleParser — Parses VTT and SRT subtitle files
 * Renders cues as styled overlay on the video
 */
export class SubtitleParser {
    constructor(videoEl, textEl, overlayEl) {
        this.video    = videoEl;
        this.textEl   = textEl;
        this.overlayEl= overlayEl;
        this.cues     = [];
        this.enabled  = false;
        this.currentCue = null;
    }

    async load(url) {
        try {
            const res  = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            this.cues  = url.toLowerCase().includes('.srt') || this._looksLikeSRT(text)
                ? this._parseSRT(text)
                : this._parseVTT(text);
            this.enabled = true;
            this.textEl.classList.remove('hidden');
        } catch (err) {
            console.error('Subtitle load failed:', err);
        }
    }

    enable()  { this.enabled = true; }
    disable() {
        this.enabled = false;
        this.textEl.classList.add('hidden');
        this.textEl.textContent = '';
        this.currentCue = null;
    }

    reset() {
        this.cues = [];
        this.disable();
    }

    tick(currentTime) {
        if (!this.enabled || !this.cues.length) return;

        const cue = this.cues.find(c => currentTime >= c.start && currentTime <= c.end);

        if (cue !== this.currentCue) {
            this.currentCue = cue;
            if (cue) {
                this.textEl.innerHTML = cue.html || this._escapeHtml(cue.text);
                this.textEl.classList.remove('hidden');
            } else {
                this.textEl.classList.add('hidden');
                this.textEl.textContent = '';
            }
        }
    }

    _looksLikeSRT(text) {
        return /^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3}/.test(text.trim());
    }

    _parseVTT(text) {
        const cues = [];
        // Remove BOM and WEBVTT header
        const body = text.replace(/^\uFEFF/, '').replace(/^WEBVTT[^\n]*\n/, '');
        const blocks = body.split(/\n\n+/);

        for (const block of blocks) {
            const lines = block.trim().split('\n');
            if (!lines.length) continue;

            // Find timestamp line
            let tsIdx = lines.findIndex(l => l.includes('-->'));
            if (tsIdx === -1) continue;

            const ts = lines[tsIdx].match(
                /(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{3})/
            );
            if (!ts) continue;

            const start = this._vttTime(ts[1], ts[2], ts[3], ts[4]);
            const end   = this._vttTime(ts[5], ts[6], ts[7], ts[8]);
            const text  = lines.slice(tsIdx + 1).join('\n').trim();
            if (!text) continue;

            cues.push({ start, end, text, html: this._vttHtmlToHtml(text) });
        }
        return cues;
    }

    _vttTime(h, m, s, ms) {
        return (parseInt(h || 0) * 3600) + (parseInt(m) * 60) + parseInt(s) + (parseInt(ms) / 1000);
    }

    _parseSRT(text) {
        const cues = [];
        const blocks = text.replace(/^\uFEFF/, '').split(/\n\n+/);

        for (const block of blocks) {
            const lines = block.trim().split('\n');
            if (lines.length < 3) continue;

            const ts = lines[1]?.match(
                /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/
            );
            if (!ts) continue;

            const start = parseInt(ts[1])*3600 + parseInt(ts[2])*60 + parseInt(ts[3]) + parseInt(ts[4])/1000;
            const end   = parseInt(ts[5])*3600 + parseInt(ts[6])*60 + parseInt(ts[7]) + parseInt(ts[8])/1000;
            const text  = lines.slice(2).join('\n').trim();
            if (!text) continue;

            cues.push({ start, end, text, html: this._srtHtmlToHtml(text) });
        }
        return cues;
    }

    _vttHtmlToHtml(text) {
        return text
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/<b>(.*?)<\/b>/gi, '<strong>$1</strong>')
            .replace(/<i>(.*?)<\/i>/gi, '<em>$1</em>')
            .replace(/<u>(.*?)<\/u>/gi, '<u>$1</u>')
            .replace(/<[^>]+>/g, '')  // strip unknown tags
            .replace(/\n/g, '<br>');
    }

    _srtHtmlToHtml(text) {
        return text
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/<b>(.*?)<\/b>/gi, '<strong>$1</strong>')
            .replace(/<i>(.*?)<\/i>/gi, '<em>$1</em>')
            .replace(/<u>(.*?)<\/u>/gi, '<u>$1</u>')
            .replace(/<font[^>]*>(.*?)<\/font>/gi, '$1')
            .replace(/<[^>]+>/g, '')
            .replace(/\n/g, '<br>');
    }

    _escapeHtml(text) {
        return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
    }
}
