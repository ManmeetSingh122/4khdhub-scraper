/**
 * Netwatch Player — Direct Link Player
 * Plays any direct video URL (MP4, MKV, WebM, AVI, etc.) without downloading.
 * Features: native audio tracks, subtitles (VTT/SRT), continue watching,
 *           keyboard shortcuts, PiP, double-tap seek, buffering stats.
 */

import { SubtitleParser }  from './subtitle-parser.js';
import { StreamCache }      from './stream-cache.js';
import { ContinueWatching } from './continue-watching.js';
import { EpisodeManager }   from './episode-manager.js';

// ─── DOM refs ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const video           = $('video');
const playerShell     = $('player-shell');
const loadingScreen   = $('loading-screen');
const sourcePanel     = $('source-panel');
const topBar          = $('top-bar');
const bottomControls  = $('bottom-controls');
const toastContainer  = $('toast-container');

// Controls
const playBtn         = $('play-btn');
const playIcon        = $('play-icon');
const pauseIcon       = $('pause-icon');
const skipBackBtn     = $('skip-back-btn');
const skipFwdBtn      = $('skip-fwd-btn');
const prevEpBtn       = $('prev-ep-btn');
const nextEpBtn       = $('next-ep-btn');
const muteBtn         = $('mute-btn');
const volSlider       = $('vol-slider');
const volIconHigh     = $('vol-icon-high');
const volIconLow      = $('vol-icon-low');
const volIconMute     = $('vol-icon-mute');
const timeCurrent     = $('time-current');
const timeTotal       = $('time-total');
const fullscreenBtn   = $('fullscreen-btn');
const fsEnterIcon     = $('fs-enter-icon');
const fsExitIcon      = $('fs-exit-icon');
const pipBtn          = $('pip-btn');
const settingsBtn     = $('settings-btn');
const settingsPanel   = $('settings-panel');
const settingsCloseBtn= $('settings-close-btn');
const subtitleBtn     = $('subtitle-btn');
const audioBtn        = $('audio-btn');
const speedBtn        = $('speed-btn');
const speedLabel      = $('speed-label');
const backBtn         = $('back-btn');
const playerTitle     = $('player-title');
const playerSubLabel  = $('player-subtitle-label');
const bufferSpinner   = $('buffer-spinner');
const subtitleOverlay = $('subtitle-overlay');
const subtitleText    = $('subtitle-text');
const seekContainer   = $('seek-container');
const seekFill        = $('seek-fill');
const seekBuffer      = $('seek-buffer');
const seekThumb       = $('seek-thumb');
const seekTooltip     = $('seek-tooltip');
const seekTooltipTime = $('seek-tooltip-time');
const audioList       = $('audio-list');
const subtitleList    = $('subtitle-list');
const speedList       = $('speed-list');
const customSubInput  = $('custom-sub-input');
const loadSubBtn      = $('load-sub-btn');
const skipRippleLeft  = $('skip-ripple-left');
const skipRippleRight = $('skip-ripple-right');
const autonextOverlay = $('autonext-overlay');
const autonextTitle   = $('autonext-title');
const autonextCountdown=$('autonext-countdown');
const autonextRingFill= $('autonext-ring-fill');
const autonextPlayBtn = $('autonext-play-btn');
const autonextCancelBtn=$('autonext-cancel-btn');
const cacheBufVal     = $('cache-buffer-val');
const cacheResVal     = $('cache-res-val');
const cacheDropVal    = $('cache-drop-val');
const cacheFmtVal     = $('cache-fmt-val');
const cacheBarFill    = $('cache-bar-fill');

// Source panel
const streamUrlInput   = $('stream-url-input');
const streamTitleInput = $('stream-title-input');
const streamTypeSelect = $('stream-type-select');
const streamYearInput  = $('stream-year-input');
const streamSeasonInput= $('stream-season-input');
const streamEpisodeInput=$('stream-episode-input');
const subtitleUrlInput = $('subtitle-url-input');
const posterUrlInput   = $('poster-url-input');
const launchBtn        = $('launch-btn');
const episodeFields    = $('episode-fields');

// ─── State ───────────────────────────────────────────────────────────────────
let controlsTimer        = null;
let seekDragging         = false;
let lastTapTime          = 0;
let statsInterval        = null;
let autonextTimer        = null;
let autonextSecs         = 5;
let currentSrc           = null;
let currentMeta          = {};
let subtitleParser       = null;
let streamCache          = null;
let continueWatchingMgr  = null;
let episodeMgr           = null;
let activeSubTrack       = 'off';
let progressSaveTimer    = null;
let videoOutputWarningShown = false;
let hls                  = null;
let currentPlaybackUrl   = null;
let hlsFragStats         = { loaded: 0, buffered: 0 };

// HLS sliding window state
let hlsTotalDuration     = 0;    // known total duration from backend (seconds)
let hlsAvailableStart    = 0;    // earliest seekable second
let hlsAvailableEnd      = 0;    // latest seekable second
let positionReportTimer  = null; // interval that reports position to backend

// Stream source list (for server switching)
const streamSourceSection = $('stream-source-section');
const streamSourceList    = $('stream-source-list');

const SKIP_SECONDS          = 10;
const AUTONEXT_DELAY        = 5;
const PROGRESS_SAVE_INTERVAL= 5000;
const CONTROLS_HIDE_DELAY   = 3500;
const NETWATCH_PROXY_ORIGIN = 'http://127.0.0.1:9999';
const PLAYER_BACKEND_ORIGIN = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') && window.location.port === '5000'
    ? ''
    : 'http://127.0.0.1:5000';

function playerBackendUrl(path) {
    const base = window.NETWATCH_BACKEND || PLAYER_BACKEND_ORIGIN;
    return `${base}${path}`;
}

function absoluteBackendUrl(pathOrUrl) {
    try {
        if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
        const base = window.NETWATCH_BACKEND || PLAYER_BACKEND_ORIGIN || window.location.origin;
        return new URL(pathOrUrl, base || window.location.origin).toString();
    } catch {
        return pathOrUrl;
    }
}

function stopCurrentHlsJob() {
    const jobId = currentMeta?.hlsJob;
    if (!jobId) return;
    const url = playerBackendUrl(`/api/hls/stop/${encodeURIComponent(jobId)}`);
    try {
        if (navigator.sendBeacon) {
            navigator.sendBeacon(url, new Blob([], { type: 'application/json' }));
            return;
        }
    } catch {}
    fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
}

function shouldProxyStream(url, meta = {}) {
    if (meta.proxy === false || meta.noProxy) return false;
    try {
        const parsed = new URL(url, window.location.href);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        if (parsed.hostname === '127.0.0.1' && parsed.port === '9999' && parsed.pathname === '/proxy') return false;
        if (['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.port !== '9999') return false;
        return true;
    } catch {
        return false;
    }
}

function buildPlaybackUrl(url, meta = {}) {
    if (!shouldProxyStream(url, meta)) return url;
    const proxied = new URL('/proxy', NETWATCH_PROXY_ORIGIN);
    proxied.searchParams.set('url', url);
    if (meta.referer) proxied.searchParams.set('referer', meta.referer);
    return proxied.toString();
}

function looksLikeBrowserHardCodec(url = '', meta = {}) {
    const haystack = `${url} ${meta.title || ''}`.toLowerCase();
    return haystack.includes('hevc')
        || haystack.includes('h.265')
        || haystack.includes('h265')
        || haystack.includes('.mkv');
}

function isHlsUrl(url = '') {
    try {
        return new URL(url, window.location.href).pathname.toLowerCase().endsWith('.m3u8');
    } catch {
        return String(url).toLowerCase().includes('.m3u8');
    }
}

function parseTrackListParam(raw) {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.map(normalizeTrackItem).filter(item => item.url)
            : [];
    } catch {
        return raw.split('|').map((part, index) => {
            const pieces = part.split(',');
            if (pieces.length >= 2) {
                return normalizeTrackItem({ label: pieces[0], url: pieces.slice(1).join(',') });
            }
            return normalizeTrackItem({ label: `Subtitle ${index + 1}`, url: part });
        }).filter(item => item.url);
    }
}

function normalizeTrackItem(item) {
    if (typeof item === 'string') return { label: 'Subtitle', url: item.trim(), lang: '' };
    return {
        label: String(item.label || item.name || item.lang || item.language || 'Subtitle').trim(),
        url: String(item.url || item.src || item.href || '').trim(),
        lang: String(item.lang || item.language || '').trim(),
    };
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
    streamCache         = new StreamCache();
    continueWatchingMgr = new ContinueWatching();
    episodeMgr          = new EpisodeManager();
    subtitleParser      = new SubtitleParser(video, subtitleText, subtitleOverlay);

    bindSourcePanel();
    bindControls();
    bindKeyboard();
    bindTouch();
    bindVideoEvents();

    episodeMgr.loadFromURLParam();

    const params   = new URLSearchParams(window.location.search);
    const srcParam = params.get('src') || params.get('url');
    const playbackJob = params.get('playback_job');

    if (srcParam || playbackJob) {
        const meta = {
            title:   params.get('title')   || 'Untitled',
            type:    params.get('type')    || 'movie',
            year:    params.get('year')    || '',
            season:  parseInt(params.get('season')  || '0'),
            episode: parseInt(params.get('episode') || '0'),
            subUrl:  params.get('sub')     || '',
            subtitles: parseTrackListParam(params.get('subs') || params.get('subtitles')),
            poster:  params.get('poster')  || '',
            referer: params.get('referer') || '',
            proxy:   params.get('proxy') !== '0',
            hlsJob:  params.get('hls_job') || '',
            raw:     params.get('raw') === '1' || params.get('mode') === 'direct',
            id:      params.get('id')      || srcParam,
            streams: (() => { try { return JSON.parse(params.get('streams') || '{}'); } catch { return {}; } })(),
        };
        if (playbackJob) await waitForPlaybackJob(playbackJob, meta);
        else await launchPlayer(srcParam, meta);
    } else {
        loadingScreen.classList.add('hidden');
        sourcePanel.classList.remove('hidden');
        sourcePanel.classList.add('flex');
        renderRecentStreams();
    }
}

// ─── Source Panel ─────────────────────────────────────────────────────────────
function bindSourcePanel() {
    streamTypeSelect?.addEventListener('change', () => {
        const isTV = streamTypeSelect.value === 'tv';
        if (episodeFields) episodeFields.style.display = isTV ? 'block' : 'none';
    });

    launchBtn?.addEventListener('click', async () => {
        const url = streamUrlInput?.value.trim();
        if (!url) { showToast('No URL', 'Please enter a video URL.'); return; }

        const isTV = streamTypeSelect?.value === 'tv';
        const meta = {
            title:   streamTitleInput?.value.trim()   || 'Untitled',
            type:    streamTypeSelect?.value           || 'movie',
            year:    streamYearInput?.value.trim()     || '',
            season:  isTV ? parseInt(streamSeasonInput?.value  || '1') : 0,
            episode: isTV ? parseInt(streamEpisodeInput?.value || '1') : 0,
            subUrl:  subtitleUrlInput?.value.trim()   || '',
            subtitles: [],
            poster:  posterUrlInput?.value.trim()     || '',
            referer: '',
            proxy:   true,
            id:      url,
        };
        await launchPlayer(url, meta);
    });

    streamUrlInput?.addEventListener('keydown', e => {
        if (e.key === 'Enter') launchBtn?.click();
    });
}

// ─── Launch Player ────────────────────────────────────────────────────────────
async function waitForPlaybackJob(jobId, meta = {}) {
    currentMeta = { ...meta, playbackJob: jobId };
    sourcePanel.classList.add('hidden');
    sourcePanel.classList.remove('flex');
    playerShell.classList.remove('hidden');
    loadingScreen.classList.remove('hidden');
    playerTitle.textContent = meta.title || 'Preparing stream';
    if (cacheFmtVal) cacheFmtVal.textContent = 'Playback preparing';
    if (cacheBufVal) cacheBufVal.textContent = '0 seg';

    let lastStatus = '';
    for (let attempt = 0; attempt < 240; attempt += 1) {
        const res = await fetch(playerBackendUrl(`/api/playback/status/${encodeURIComponent(jobId)}`));
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Playback job failed');

        if (data.status !== lastStatus) {
            lastStatus = data.status;
            if (data.message) showToast('Playback', data.message);
        }
        updateHlsPreparationUI(data);

        if (data.status === 'ready' && data.player_url) {
            const playerUrl = new URL(absoluteBackendUrl(data.player_url), window.location.href);
            const src = playerUrl.searchParams.get('src') || data.stream_url;
            if (!src) throw new Error('Playback job did not return a stream URL');

            await launchPlayer(src, {
                ...meta,
                title: playerUrl.searchParams.get('title') || data.title || meta.title,
                type: playerUrl.searchParams.get('type') || meta.type || 'movie',
                id: playerUrl.searchParams.get('id') || meta.id || src,
                proxy: playerUrl.searchParams.get('proxy') !== '0',
                hlsJob: playerUrl.searchParams.get('hls_job') || data.hls_job || '',
                raw: playerUrl.searchParams.get('raw') === '1' || playerUrl.searchParams.get('mode') === 'direct',
                referer: playerUrl.searchParams.get('referer') || meta.referer || '',
                streams: data.streams || (() => { try { return JSON.parse(playerUrl.searchParams.get('streams') || '{}'); } catch { return meta.streams || {}; } })(),
                servers: data.servers || meta.servers || {},
            });
            return;
        }

        if (data.status === 'error') {
            throw new Error(data.error || 'Playback job failed');
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error('Playback job timed out before the stream was ready');
}

async function ensureHlsPlayback(url, meta = {}) {
    if (isHlsUrl(url)) {
        return {
            playbackUrl: absoluteBackendUrl(url),
            sourceUrl: url,
            mode: 'hls',
            hlsJob: meta.hlsJob || '',
        };
    }

    if (meta.raw === true || meta.direct === true) {
        const playbackUrl = buildPlaybackUrl(url, meta);
        return { playbackUrl, sourceUrl: url, mode: 'direct', hlsJob: '' };
    }

    showToast('Preparing stream', 'Converting direct file into HLS.');
    if (cacheFmtVal) cacheFmtVal.textContent = 'HLS preparing';

    const startRes = await fetch(playerBackendUrl('/api/hls/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url,
            referer: meta.referer || '',
            title: meta.title || '',
        }),
    });
    const startData = await startRes.json();
    if (!startRes.ok || startData.error) {
        throw new Error(startData.error || 'Could not start HLS worker');
    }

    if (startData.status === 'ready' && startData.playlist) {
        return {
            playbackUrl: absoluteBackendUrl(startData.playlist),
            sourceUrl: url,
            mode: 'hls',
            hlsJob: startData.job_id || '',
        };
    }

    const hlsJob = startData.job_id;
    if (!hlsJob) throw new Error('HLS worker did not return a job id');
    return await pollHlsJob(hlsJob, url);
}

async function pollHlsJob(jobId, sourceUrl) {
    let lastStatus = '';
    for (let attempt = 0; attempt < 180; attempt += 1) {
        const res = await fetch(playerBackendUrl(`/api/hls/status/${jobId}`));
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'HLS worker failed');

        if (data.status !== lastStatus) {
            lastStatus = data.status;
            if (data.message) showToast('HLS', data.message);
        }
        updateHlsPreparationUI(data);

        if ((data.status === 'ready' || data.status === 'complete') && data.playlist) {
            return {
                playbackUrl: absoluteBackendUrl(data.playlist),
                sourceUrl,
                mode: 'hls',
                hlsJob: jobId,
                audioTracks: data.audio_tracks || [],
                subtitleTracks: data.subtitle_tracks || [],
            };
        }
        if (data.status === 'error') {
            throw new Error(data.error || 'HLS worker failed');
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('HLS worker timed out before the master playlist was ready');
}

function updateHlsPreparationUI(data = {}) {
    const segments = data.segments || {};
    const totalSegments = Object.values(segments).reduce((sum, value) => sum + Number(value || 0), 0);
    if (cacheFmtVal) cacheFmtVal.textContent = `HLS ${data.status || 'preparing'}`;
    if (cacheBufVal) cacheBufVal.textContent = `${totalSegments} seg`;
    if (cacheBarFill) cacheBarFill.style.width = `${Math.min(100, totalSegments * 4)}%`;
}

async function launchPlayer(url, meta) {
    if (currentMeta?.hlsJob && currentMeta.hlsJob !== meta?.hlsJob) {
        stopCurrentHlsJob();
    }
    currentSrc  = url;
    currentMeta = meta;

    sourcePanel.classList.add('hidden');
    sourcePanel.classList.remove('flex');
    loadingScreen.classList.remove('hidden');
    playerShell.classList.remove('hidden');

    playerTitle.textContent = meta.title || 'Untitled';
    if (meta.type === 'tv' && meta.season && meta.episode) {
        playerSubLabel.textContent = `S${meta.season} · E${meta.episode}`;
        playerSubLabel.classList.remove('hidden');
    } else {
        playerSubLabel.classList.add('hidden');
    }

    // Reset player state
    resetPlayer();

    let prepared;
    try {
        prepared = await ensureHlsPlayback(url, meta);
    } catch (error) {
        loadingScreen.classList.add('hidden');
        showToast('Playback failed', error.message);
        showPlayerError(error.message, 'The backend HLS worker could not prepare this stream.');
        return;
    }

    currentPlaybackUrl = prepared.playbackUrl;
    currentMeta = {
        ...meta,
        playbackMode: prepared.mode,
        hlsJob: prepared.hlsJob || meta.hlsJob || '',
    };
    addExternalSubtitleOptions(meta.subtitles || []);

    if (cacheFmtVal) {
        cacheFmtVal.textContent = prepared.mode === 'hls'
            ? `HLS${prepared.hlsJob ? ` job ${prepared.hlsJob.slice(0, 8)}` : ''}`
            : 'Direct fallback';
    }

    // Load the video directly — browser streams it without downloading
    loadPlaybackSource(prepared.playbackUrl, prepared.sourceUrl, prepared.mode);

    // Safety timeout
    const safetyTimer = setTimeout(() => {
        if (!loadingScreen.classList.contains('hidden')) {
            loadingScreen.classList.add('hidden');
            showToast('Slow to load', 'Video is buffering — it will play when ready.');
        }
    }, 12000);

    video.addEventListener('loadedmetadata', () => clearTimeout(safetyTimer), { once: true });

    // Resume saved position
    const savedPos = continueWatchingMgr.getProgress(meta.id);
    if (savedPos > 5) {
        const doSeek = () => {
            video.currentTime = savedPos;
            showToast('Resuming', `Continuing from ${formatTime(savedPos)}`);
        };
        if (video.readyState >= 1) doSeek();
        else video.addEventListener('loadedmetadata', doSeek, { once: true });
    }

    // Load external subtitle if provided
    if (meta.subUrl) {
        video.addEventListener('loadedmetadata', async () => {
            await loadExternalSubtitle(meta.subUrl, 'External');
        }, { once: true });
    }

    // Cache for history
    streamCache.set({
        id:      meta.id,
        src:     url,
        title:   meta.title,
        type:    meta.type,
        season:  meta.season,
        episode: meta.episode,
        poster:  meta.poster,
        subUrl:  meta.subUrl || '',
        subtitles: meta.subtitles || [],
        referer: meta.referer || '',
    });

    updateEpisodeButtons();
    startProgressSave();
    startStatsPolling();
    buildStreamSourceList(meta);

    // Fetch initial HLS status to get total_duration and available range
    const jobId = currentMeta?.hlsJob;
    if (jobId) {
        fetch(playerBackendUrl(`/api/hls/status/${encodeURIComponent(jobId)}`))
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data) return;
                if (data.total_duration > 0) {
                    hlsTotalDuration = data.total_duration;
                    if (timeTotal) timeTotal.textContent = formatTime(hlsTotalDuration);
                }
            })
            .catch(() => {});
        startPositionReporter();
    }
}

// ─── Reset Player ─────────────────────────────────────────────────────────────
function loadPlaybackSource(playbackUrl, originalUrl, mode = 'hls') {
    destroyHls();

    const hlsMode = mode === 'hls' || isHlsUrl(originalUrl) || isHlsUrl(playbackUrl);
    video.removeAttribute('crossorigin');

    if (hlsMode) {
        if (window.Hls && window.Hls.isSupported()) {
            hls = new window.Hls({
                enableWorker: true,
                lowLatencyMode: false,
                renderTextTracksNatively: true,
                backBufferLength: 30,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                liveSyncDuration: 18,
                liveMaxLatencyDuration: 54,
            });
            hls.attachMedia(video);
            hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
                hls.loadSource(playbackUrl);
            });
            hls.on(window.Hls.Events.MANIFEST_PARSED, (_, data) => {
                hls.subtitleTrack = -1;
                buildHlsAudioList();
                buildHlsSubtitleList();
                if (cacheFmtVal) cacheFmtVal.textContent = `HLS master (${data?.levels?.length || 1} level)`;
                // Show known total duration immediately if we have it from backend
                if (hlsTotalDuration > 0 && timeTotal) {
                    timeTotal.textContent = formatTime(hlsTotalDuration);
                }
                video.play().catch(() => {});
            });
            hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, buildHlsAudioList);
            hls.on(window.Hls.Events.AUDIO_TRACK_SWITCHED, buildHlsAudioList);
            hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, buildHlsSubtitleList);
            hls.on(window.Hls.Events.SUBTITLE_TRACK_SWITCH, buildHlsSubtitleList);
            hls.on(window.Hls.Events.LEVEL_LOADED, (_, data) => {
                // Only update from HLS if we don't have a backend duration
                if (hlsTotalDuration <= 0 && data?.details?.totalduration && timeTotal) {
                    timeTotal.textContent = formatTime(data.details.totalduration);
                }
            });
            hls.on(window.Hls.Events.FRAG_LOADED, () => {
                hlsFragStats.loaded += 1;
            });
            hls.on(window.Hls.Events.FRAG_BUFFERED, () => {
                hlsFragStats.buffered += 1;
            });
            hls.on(window.Hls.Events.ERROR, (_, data) => {
                if (data?.fatal) {
                    if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
                        showToast('HLS Network', 'Retrying stream load.');
                        hls.startLoad();
                    } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
                        showToast('HLS Media', 'Recovering decoder.');
                        hls.recoverMediaError();
                    } else {
                        showPlayerError('HLS playback failed', data.details || 'The stream could not be recovered.');
                        hls.destroy();
                        hls = null;
                    }
                }
            });
            return;
        }

        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = playbackUrl;
            video.load();
            return;
        }

        showToast('HLS unavailable', 'This browser needs hls.js to play this stream.');
        showPlayerError('HLS unavailable', 'The player could not load hls.js.');
        return;
    }

    video.src = playbackUrl;
    video.load();
}

function destroyHls() {
    if (!hls) return;
    try {
        hls.destroy();
    } catch {
        // HLS cleanup is best-effort during source changes.
    }
    hls = null;
}

function resetPlayer() {
    destroyHls();
    video.src = '';
    video.load();
    videoOutputWarningShown = false;
    currentPlaybackUrl = null;
    hlsFragStats = { loaded: 0, buffered: 0 };

    // Reset HLS sliding window state
    hlsTotalDuration  = 0;
    hlsAvailableStart = 0;
    hlsAvailableEnd   = 0;
    clearInterval(positionReportTimer);
    positionReportTimer = null;

    // Reset audio list
    audioList.innerHTML = '';
    audioList.appendChild(makeSettingsNote('Loading HLS audio tracks...'));

    // Reset subtitle list
    subtitleList.innerHTML = '';
    const offBtn = makeSettingsOption('Off', 'off', true);
    offBtn.dataset.sub = 'off';
    offBtn.addEventListener('click', () => deactivateSubtitles());
    subtitleList.appendChild(offBtn);

    subtitleParser?.reset();
    activeSubTrack = 'off';
    subtitleBtn.classList.remove('active');
    speedLabel.textContent = '1×';

    clearInterval(statsInterval);
    clearInterval(progressSaveTimer);
    cancelAutonext();
    playerShell.querySelector('.player-error-overlay')?.remove();
    playerShell.querySelector('.player-warning-overlay')?.remove();
}

// ─── Native Audio Tracks ──────────────────────────────────────────────────────
// Reads audio tracks from the video element (works for MKV, MP4 with multiple audio)
function buildHlsAudioList() {
    if (!hls || !Array.isArray(hls.audioTracks)) return;
    removeSettingsNotes(audioList);
    audioList.innerHTML = '';
    if (!hls.audioTracks.length) {
        audioList.appendChild(makeSettingsNote('Waiting for HLS audio tracks...'));
        return;
    }
    hls.audioTracks.forEach((track, index) => {
        const label = track.name || track.lang || `Audio ${index + 1}`;
        const active = index === hls.audioTrack || (hls.audioTrack < 0 && index === 0);
        const btn = makeSettingsOption(label, String(index), active);
        if (track.default) btn.querySelector('span').insertAdjacentHTML('afterend', '<span class="settings-option-badge">Default</span>');
        btn.addEventListener('click', () => {
            hls.audioTrack = index;
            setActiveOption(audioList, String(index));
            showToast('Audio', label);
        });
        audioList.appendChild(btn);
    });
}

function buildNativeAudioList() {
    if (hls) {
        buildHlsAudioList();
        return;
    }
    const tracks = video.audioTracks;
    if (!tracks || tracks.length <= 1) {
        if (!audioList.querySelector('.settings-note')) {
            audioList.appendChild(makeSettingsNote(
                'Only the browser-decoded audio track is available here. Embedded MKV tracks may not be exposed by this browser.'
            ));
        }
        return;
    }

    audioList.innerHTML = '';
    for (let i = 0; i < tracks.length; i++) {
        const t     = tracks[i];
        const label = t.label || t.language || `Track ${i + 1}`;
        const btn   = makeSettingsOption(label, String(i), i === 0);
        const idx   = i; // capture
        btn.addEventListener('click', () => selectAudioTrack(idx));
        audioList.appendChild(btn);
    }
}

function selectAudioTrack(index) {
    const tracks = video.audioTracks;
    if (!tracks) return;
    for (let i = 0; i < tracks.length; i++) {
        tracks[i].enabled = (i === index);
    }
    setActiveOption(audioList, String(index));
    const label = tracks[index]?.label || tracks[index]?.language || `Track ${index + 1}`;
    showToast('Audio', label);
}

// ─── Native Text Tracks (subtitles embedded in MKV/MP4) ──────────────────────
function buildHlsSubtitleList() {
    if (!hls || !Array.isArray(hls.subtitleTracks)) return;
    subtitleList.innerHTML = '';
    const offBtn = makeSettingsOption('Off', 'off', activeSubTrack === 'off');
    offBtn.dataset.sub = 'off';
    offBtn.addEventListener('click', () => deactivateSubtitles());
    subtitleList.appendChild(offBtn);
    if (!hls.subtitleTracks.length) {
        subtitleList.appendChild(makeSettingsNote('No HLS subtitle tracks were found for this stream.'));
        return;
    }
    hls.subtitleTracks.forEach((track, index) => {
        const label = track.name || track.lang || `Subtitle ${index + 1}`;
        const value = `hls:${index}`;
        const active = hls.subtitleTrack === index;
        const btn = makeSettingsOption(label, value, active);
        btn.dataset.sub = value;
        btn.addEventListener('click', () => {
            hls.subtitleTrack = index;
            activeSubTrack = value;
            subtitleBtn.classList.add('active');
            setActiveOption(subtitleList, value);
            showToast('Subtitles', label);
        });
        subtitleList.appendChild(btn);
    });
}

function buildNativeSubtitleList() {
    if (hls) {
        buildHlsSubtitleList();
        return;
    }
    const tracks = video.textTracks;
    if (!tracks || !tracks.length) {
        if (!subtitleList.querySelector('.settings-note') && subtitleList.querySelectorAll('.settings-option').length <= 1) {
            subtitleList.appendChild(makeSettingsNote(
                'No embedded subtitles were exposed by this browser. Load an external SRT or VTT file if needed.'
            ));
        }
        return;
    }

    let added = 0;
    for (let i = 0; i < tracks.length; i++) {
        const t     = tracks[i];
        if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
        const label = t.label || t.language || `Sub ${i + 1}`;
        const value = `native:${i}`;
        if (subtitleList.querySelector(`[data-value="${value}"]`)) continue;
        const btn = makeSettingsOption(label, value, false);
        btn.dataset.sub = value;
        btn.addEventListener('click', () => activateNativeSubtitle(i, value));
        subtitleList.appendChild(btn);
        added += 1;
    }
    if (!added && !subtitleList.querySelector('.settings-note') && subtitleList.querySelectorAll('.settings-option').length <= 1) {
        subtitleList.appendChild(makeSettingsNote(
            'No embedded subtitles were exposed by this browser. Load an external SRT or VTT file if needed.'
        ));
    }
}

function activateNativeSubtitle(index, value) {
    if (hls) hls.subtitleTrack = -1;
    // Disable all tracks first
    const tracks = video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
        tracks[i].mode = 'disabled';
    }
    // Disable custom subtitle parser
    subtitleParser?.disable();

    if (value !== 'off') {
        tracks[index].mode = 'showing';
        activeSubTrack = value;
        subtitleBtn.classList.add('active');
        setActiveOption(subtitleList, value);
        showToast('Subtitles', tracks[index].label || tracks[index].language || `Track ${index + 1}`);
    } else {
        deactivateSubtitles();
    }
}

function deactivateSubtitles() {
    if (hls) hls.subtitleTrack = -1;
    // Disable all native tracks
    const tracks = video.textTracks;
    if (tracks) {
        for (let i = 0; i < tracks.length; i++) tracks[i].mode = 'disabled';
    }
    subtitleParser?.disable();
    activeSubTrack = 'off';
    subtitleBtn.classList.remove('active');
    setActiveOption(subtitleList, 'off');
    showToast('Subtitles', 'Off');
}

// ─── External Subtitle Loader (VTT / SRT via fetch) ──────────────────────────
async function loadExternalSubtitle(url, label = 'External') {
    try {
        await subtitleParser.load(url);
        const value = url;
        if (!subtitleList.querySelector(`[data-value="${value}"]`)) {
            const btn = makeSettingsOption(label, value, false);
            btn.dataset.sub = value;
            btn.addEventListener('click', () => activateExternalSubtitle(url, value));
            subtitleList.appendChild(btn);
        }
        // Auto-activate
        activateExternalSubtitle(url, value);
    } catch (err) {
        console.warn('[Subtitles] Failed to load:', err.message);
        showToast('Subtitle Error', 'Could not load subtitle file.');
    }
}

function addExternalSubtitleOptions(subtitles = []) {
    subtitles.forEach((track, index) => {
        const item = normalizeTrackItem(track);
        if (!item.url || subtitleList.querySelector(`[data-value="${item.url}"]`)) return;
        removeSettingsNotes(subtitleList);
        const label = item.label || item.lang || `Subtitle ${index + 1}`;
        const btn = makeSettingsOption(label, item.url, false);
        btn.dataset.sub = item.url;
        btn.addEventListener('click', () => loadExternalSubtitle(item.url, label));
        subtitleList.appendChild(btn);
    });
}

function activateExternalSubtitle(url, value) {
    if (hls) hls.subtitleTrack = -1;
    // Disable native tracks
    const tracks = video.textTracks;
    if (tracks) {
        for (let i = 0; i < tracks.length; i++) tracks[i].mode = 'disabled';
    }
    subtitleParser.enable();
    activeSubTrack = value;
    subtitleBtn.classList.add('active');
    setActiveOption(subtitleList, value);
    showToast('Subtitles', 'On');
}

// ─── Settings Helpers ─────────────────────────────────────────────────────────
function makeSettingsOption(label, value, isActive) {
    const btn = document.createElement('button');
    btn.className = 'settings-option' + (isActive ? ' active' : '');
    btn.dataset.value = value;
    btn.innerHTML = `<span>${label}</span>`;
    return btn;
}

function makeSettingsNote(text) {
    const note = document.createElement('div');
    note.className = 'settings-note';
    note.textContent = text;
    return note;
}

function removeSettingsNotes(container) {
    container.querySelectorAll('.settings-note').forEach(note => note.remove());
}

function setActiveOption(container, value) {
    container.querySelectorAll('.settings-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === String(value));
    });
}

function setSpeed(speed) {
    video.playbackRate = speed;
    const label = speed === 1 ? '1×' : `${speed}×`;
    speedLabel.textContent = label;
    setActiveOption(speedList, String(speed));
    showToast('Speed', label);
}

// ─── Video Events ─────────────────────────────────────────────────────────────
function bindVideoEvents() {
    video.addEventListener('loadedmetadata', onMetadataLoaded);
    video.addEventListener('timeupdate',     onTimeUpdate);
    video.addEventListener('progress',       onProgress);
    video.addEventListener('waiting',        () => bufferSpinner.classList.remove('hidden'));
    video.addEventListener('playing',        () => { bufferSpinner.classList.add('hidden'); loadingScreen.classList.add('hidden'); });
    video.addEventListener('canplay',        () => { bufferSpinner.classList.add('hidden'); loadingScreen.classList.add('hidden'); });
    video.addEventListener('play',           () => { updatePlayPauseUI(); if (hls) hls.startLoad(); });
    video.addEventListener('pause',          () => { updatePlayPauseUI(); if (hls) hls.stopLoad(); });
    video.addEventListener('ended',          onVideoEnded);
    video.addEventListener('volumechange',   updateVolumeUI);
    video.addEventListener('error',          onVideoError);
    video.addEventListener('ratechange',     () => {
        speedLabel.textContent = video.playbackRate === 1 ? '1×' : `${video.playbackRate}×`;
    });

    document.addEventListener('fullscreenchange',       updateFullscreenUI);
    document.addEventListener('webkitfullscreenchange', updateFullscreenUI);
    document.addEventListener('pictureInPictureChange', updatePiPUI);
}

function onMetadataLoaded() {
    // Use backend total duration if available, otherwise fall back to video.duration
    const displayDuration = hlsTotalDuration > 0 ? hlsTotalDuration : video.duration;
    timeTotal.textContent = formatTime(displayDuration);
    loadingScreen.classList.add('hidden');

    // Build native audio/subtitle track lists from the video file
    buildNativeAudioList();
    buildNativeSubtitleList();

    // Update resolution in stats
    if (cacheResVal && video.videoWidth) {
        cacheResVal.textContent = `${video.videoWidth}×${video.videoHeight}`;
    }

    video.play().catch(() => {});
    showControls();

    if (!sessionStorage.getItem('nw_hint_shown')) {
        sessionStorage.setItem('nw_hint_shown', '1');
        const hint = document.createElement('div');
        hint.className = 'shortcut-hint';
        hint.textContent = 'Space = Play/Pause  ·  F = Fullscreen  ·  C = Subtitles  ·  A = Audio  ·  ← → = Seek';
        playerShell.appendChild(hint);
        setTimeout(() => hint.remove(), 4000);
    }
}

function onTimeUpdate() {
    if (seekDragging) return;
    // Use backend total duration for seek bar if available
    const totalDur = hlsTotalDuration > 0 ? hlsTotalDuration : video.duration;
    const pct = totalDur ? (video.currentTime / totalDur) * 100 : 0;
    seekFill.style.width = `${pct}%`;
    seekThumb.style.left = `${pct}%`;
    seekContainer.setAttribute('aria-valuenow', Math.round(pct));
    timeCurrent.textContent = formatTime(video.currentTime);
    subtitleParser?.tick(video.currentTime);

    if (totalDur && !autonextTimer && currentMeta.type === 'tv') {
        const remaining = totalDur - video.currentTime;
        if (remaining > 0 && remaining <= 30) triggerAutonext();
    }

    checkVideoOutput();
}

function onProgress() {
    const totalDur = hlsTotalDuration > 0 ? hlsTotalDuration : video.duration;
    if (!totalDur) return;
    let buffered = 0;
    for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime) {
            buffered = Math.max(buffered, video.buffered.end(i));
        }
    }
    seekBuffer.style.width = `${(buffered / totalDur) * 100}%`;
}

function onVideoEnded() {
    updatePlayPauseUI();
    continueWatchingMgr.remove(currentMeta.id);
    if (currentMeta.type !== 'tv') return;
    if (!autonextTimer) triggerAutonext();
}

function showPlayerError(title, detail = '') {
    loadingScreen.classList.add('hidden');
    playerShell.querySelector('.player-error-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'player-error-overlay';
    overlay.innerHTML = `
        <div class="player-error-icon">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
        </div>
        <p class="text-white font-semibold text-base">${title}</p>
        <p class="text-white/45 text-sm max-w-xs text-center">${detail}</p>
        <div class="flex gap-3 mt-2">
            <button class="primary-btn text-sm py-2.5 px-5" id="err-retry-btn">Retry</button>
            <button class="secondary-btn text-sm py-2.5 px-5" id="err-back-btn">Go Back</button>
        </div>
    `;
    playerShell.appendChild(overlay);
    overlay.querySelector('#err-retry-btn')?.addEventListener('click', () => {
        overlay.remove();
        if (currentSrc) launchPlayer(currentSrc, currentMeta);
    });
    overlay.querySelector('#err-back-btn')?.addEventListener('click', () => {
        overlay.remove();
        resetPlayer();
        showSourcePanel();
    });
}

function onVideoError() {
    const err  = video.error;
    const msgs = {
        1: 'Playback aborted',
        2: 'Network error — check your connection or the URL',
        3: 'Decode error — format may be unsupported by this browser',
        4: 'Source not supported — try a different format or browser'
    };
    const msg = msgs[err?.code] || 'Unknown playback error';
    loadingScreen.classList.add('hidden');
    playerShell.querySelector('.player-error-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'player-error-overlay';
    overlay.innerHTML = `
        <div class="player-error-icon">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
        </div>
        <p class="text-white font-semibold text-base">${msg}</p>
        <p class="text-white/45 text-sm max-w-xs text-center">Paste the URL into VLC to verify it works, then try again here.</p>
        <div class="flex gap-3 mt-2">
            <button class="primary-btn text-sm py-2.5 px-5" id="err-retry-btn">Retry</button>
            <button class="secondary-btn text-sm py-2.5 px-5" id="err-back-btn">Go Back</button>
        </div>
    `;
    playerShell.appendChild(overlay);
    overlay.querySelector('#err-retry-btn')?.addEventListener('click', () => {
        overlay.remove();
        if (currentSrc) launchPlayer(currentSrc, currentMeta);
    });
    overlay.querySelector('#err-back-btn')?.addEventListener('click', () => {
        overlay.remove();
        resetPlayer();
        showSourcePanel();
    });
}

function checkVideoOutput(force = false) {
    if (hls || currentMeta.playbackMode === 'hls') return;
    if (videoOutputWarningShown || video.videoWidth > 0) return;
    if (!force && (video.paused || video.currentTime < 4)) return;
    if (!force && !looksLikeBrowserHardCodec(currentSrc, currentMeta)) return;
    // Don't show warning if video is actually progressing — it may just be
    // a slow decoder or the dimensions haven't been reported yet.
    // Only warn if currentTime has been stuck (no progress) for a while.
    if (video.currentTime > 0 && !video.paused) return;
    showVideoOutputWarning();
}

function showVideoOutputWarning() {
    videoOutputWarningShown = true;
    loadingScreen.classList.add('hidden');
    playerShell.querySelector('.player-warning-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'player-warning-overlay player-error-overlay';
    overlay.innerHTML = `
        <div class="player-warning-icon">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.55-2.27A1 1 0 0121 8.62v6.76a1 1 0 01-1.45.89L15 14M4 6h9a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2z"/></svg>
        </div>
        <p class="text-white font-semibold text-base">Audio is playing, but the browser cannot render this video track.</p>
        <p class="text-white/45 text-sm max-w-md text-center">This usually happens with HEVC/H.265 or MKV files. VLC can decode it; the browser player needs an H.264/MP4 source or a transcoded stream.</p>
        <div class="flex gap-3 mt-2 flex-wrap justify-center">
            <button class="primary-btn text-sm py-2.5 px-5" id="warn-vlc-btn">Open VLC</button>
            <button class="secondary-btn text-sm py-2.5 px-5" id="warn-copy-btn">Copy URL</button>
            <button class="secondary-btn text-sm py-2.5 px-5" id="warn-audio-btn">Keep Audio</button>
        </div>
    `;
    playerShell.appendChild(overlay);
    overlay.querySelector('#warn-vlc-btn')?.addEventListener('click', openCurrentInVlc);
    overlay.querySelector('#warn-copy-btn')?.addEventListener('click', copyCurrentSource);
    overlay.querySelector('#warn-audio-btn')?.addEventListener('click', () => overlay.remove());
}

function openCurrentInVlc() {
    const source = currentPlaybackUrl || currentSrc;
    if (!source) return;
    fetch('/api/open_vlc', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({m3u8: source, referer: currentMeta.referer || ''})
    })
    .then(r => r.json())
    .then(data => {
        if (data.ok) showToast('VLC', 'Launched');
        else {
            copyCurrentSource();
            showToast('VLC', (data.error || 'Could not launch VLC') + ' URL copied.');
        }
    })
    .catch(() => {
        copyCurrentSource();
        showToast('VLC', 'URL copied for manual open.');
    });
}

function copyCurrentSource() {
    const source = currentPlaybackUrl || currentSrc;
    if (!source) return;
    const copied = navigator.clipboard?.writeText(source);
    if (!copied) {
        showToast('Copy failed', 'Clipboard is not available in this browser.');
        return;
    }
    copied.then(
        () => showToast('Copied', 'Direct URL copied.'),
        () => showToast('Copy failed', 'Select and copy the URL from the previous page.')
    );
}

// ─── Controls Binding ─────────────────────────────────────────────────────────
function bindControls() {
    playBtn.addEventListener('click', togglePlayPause);
    skipBackBtn.addEventListener('click', () => skip(-SKIP_SECONDS));
    skipFwdBtn.addEventListener('click',  () => skip(SKIP_SECONDS));
    prevEpBtn.addEventListener('click', () => episodeMgr.playPrev(launchPlayer));
    nextEpBtn.addEventListener('click', () => episodeMgr.playNext(launchPlayer));

    muteBtn.addEventListener('click', toggleMute);
    volSlider.addEventListener('input', () => {
        video.volume = parseFloat(volSlider.value);
        video.muted  = false;
        volSlider.style.setProperty('--vol-pct', `${volSlider.value * 100}%`);
    });

    fullscreenBtn.addEventListener('click', toggleFullscreen);
    pipBtn.addEventListener('click', togglePiP);
    settingsBtn.addEventListener('click', toggleSettings);
    settingsCloseBtn.addEventListener('click', closeSettings);

    // Subtitle quick toggle
    subtitleBtn.addEventListener('click', () => {
        if (activeSubTrack === 'off') {
            const firstSub = subtitleList.querySelector('[data-sub]:not([data-sub="off"])');
            if (firstSub) firstSub.click();
            else openSettings();
        } else {
            deactivateSubtitles();
        }
    });

    // Audio button — open settings
    audioBtn?.addEventListener('click', openSettings);

    // Speed button — open settings
    speedBtn.addEventListener('click', openSettings);

    // Speed options
    speedList.querySelectorAll('.speed-opt').forEach(btn => {
        btn.addEventListener('click', () => setSpeed(parseFloat(btn.dataset.speed)));
    });

    // Custom subtitle load
    loadSubBtn.addEventListener('click', async () => {
        const url = customSubInput.value.trim();
        if (!url) return;
        await loadExternalSubtitle(url, 'Custom');
        customSubInput.value = '';
    });
    customSubInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') loadSubBtn.click();
    });

    // Back button
    backBtn.addEventListener('click', () => {
        saveProgress();
        if (window.history.length > 1) window.history.back();
        else if (document.referrer) window.location.href = document.referrer;
        else { resetPlayer(); showSourcePanel(); }
    });

    bindSeekBar();

    // Click on video = toggle controls / play
    playerShell.addEventListener('click', e => {
        if (e.target === video || e.target === playerShell) {
            if (playerShell.classList.contains('controls-hidden')) showControls();
            else togglePlayPause();
        }
    });

    playerShell.addEventListener('mousemove', showControls);
    playerShell.addEventListener('mouseleave', scheduleHideControls);

    autonextPlayBtn.addEventListener('click',   () => { cancelAutonext(); episodeMgr.playNext(launchPlayer); });
    autonextCancelBtn.addEventListener('click', cancelAutonext);

    document.addEventListener('click', e => {
        if (!settingsPanel.classList.contains('hidden') &&
            !settingsPanel.contains(e.target) &&
            e.target !== settingsBtn) {
            closeSettings();
        }
    });
}

function showSourcePanel() {
    playerShell.classList.add('hidden');
    sourcePanel.classList.remove('hidden');
    sourcePanel.classList.add('flex');
    renderRecentStreams();
}

// ─── Seek Bar ─────────────────────────────────────────────────────────────────
function bindSeekBar() {
    function getSeekPct(e) {
        const rect = seekContainer.getBoundingClientRect();
        const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
        return Math.max(0, Math.min(1, x / rect.width));
    }

    function applySeek(pct) {
        const totalDur = hlsTotalDuration > 0 ? hlsTotalDuration : video.duration;
        if (!totalDur) return;
        let t = pct * totalDur;

        // Clamp to available segment range for sliding window HLS
        if (hlsAvailableEnd > 0) {
            if (t < hlsAvailableStart) {
                showToast('Seek', 'This part is no longer available.');
                t = hlsAvailableStart;
            } else if (t > hlsAvailableEnd) {
                showToast('Seek', 'This part hasn\'t loaded yet.');
                t = Math.min(t, hlsAvailableEnd - 1);
            }
        }

        const clampedPct = t / totalDur;
        seekFill.style.width = `${clampedPct * 100}%`;
        seekThumb.style.left = `${clampedPct * 100}%`;
        video.currentTime = t;
        timeCurrent.textContent = formatTime(t);
    }

    seekContainer.addEventListener('mousedown', e => {
        seekDragging = true;
        seekContainer.classList.add('dragging');
        applySeek(getSeekPct(e));
    });

    seekContainer.addEventListener('mousemove', e => {
        const pct = getSeekPct(e);
        seekTooltip.classList.remove('hidden');
        seekTooltip.style.left = `${pct * 100}%`;
        seekTooltipTime.textContent = formatTime(pct * (video.duration || 0));
        if (seekDragging) applySeek(pct);
    });

    seekContainer.addEventListener('mouseleave', () => {
        seekTooltip.classList.add('hidden');
        if (seekDragging) { seekDragging = false; seekContainer.classList.remove('dragging'); }
    });

    document.addEventListener('mouseup', () => {
        if (seekDragging) { seekDragging = false; seekContainer.classList.remove('dragging'); }
    });

    seekContainer.addEventListener('touchstart', e => {
        seekDragging = true;
        seekContainer.classList.add('dragging');
        applySeek(getSeekPct(e));
        e.preventDefault();
    }, { passive: false });

    seekContainer.addEventListener('touchmove', e => {
        if (seekDragging) applySeek(getSeekPct(e));
        e.preventDefault();
    }, { passive: false });

    seekContainer.addEventListener('touchend', () => {
        seekDragging = false;
        seekContainer.classList.remove('dragging');
    });

    seekContainer.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight') skip(5);
        if (e.key === 'ArrowLeft')  skip(-5);
    });
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────
function bindKeyboard() {
    document.addEventListener('keydown', e => {
        if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
        if (!playerShell || playerShell.classList.contains('hidden')) return;
        showControls();

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault(); togglePlayPause(); break;
            case 'ArrowRight':
                e.preventDefault(); skip(e.shiftKey ? 30 : SKIP_SECONDS); break;
            case 'ArrowLeft':
                e.preventDefault(); skip(e.shiftKey ? -30 : -SKIP_SECONDS); break;
            case 'ArrowUp':
                e.preventDefault(); adjustVolume(0.1); break;
            case 'ArrowDown':
                e.preventDefault(); adjustVolume(-0.1); break;
            case 'm': case 'M': toggleMute(); break;
            case 'f': case 'F': toggleFullscreen(); break;
            case 'c': case 'C': subtitleBtn.click(); break;
            case 'a': case 'A': openSettings(); break;
            case 's': case 'S': openSettings(); break;
            case 'p': case 'P': togglePiP(); break;
            case 'Escape':
                if (!settingsPanel.classList.contains('hidden')) closeSettings();
                else if (document.fullscreenElement) document.exitFullscreen();
                break;
            case 'n': case 'N':
                if (currentMeta.type === 'tv') episodeMgr.playNext(launchPlayer); break;
            case 'b': case 'B':
                if (currentMeta.type === 'tv') episodeMgr.playPrev(launchPlayer); break;
            case '0': case '1': case '2': case '3': case '4':
            case '5': case '6': case '7': case '8': case '9':
                if (video.duration || hlsTotalDuration > 0) {
                    const totalDur = hlsTotalDuration > 0 ? hlsTotalDuration : video.duration;
                    let target = (parseInt(e.key) / 10) * totalDur;
                    if (hlsAvailableEnd > 0) {
                        target = Math.max(hlsAvailableStart, Math.min(hlsAvailableEnd - 1, target));
                    }
                    video.currentTime = target;
                }
                break;
        }
    });
}

// ─── Touch Gestures ───────────────────────────────────────────────────────────
function bindTouch() {
    let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
    let touchStartVol = 0, touchStartPos = 0;
    let isSeeking = false, isVolume = false;

    video.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        touchStartX    = e.touches[0].clientX;
        touchStartY    = e.touches[0].clientY;
        touchStartTime = Date.now();
        touchStartVol  = video.volume;
        touchStartPos  = video.currentTime;
        isSeeking = false; isVolume = false;
    }, { passive: true });

    video.addEventListener('touchmove', e => {
        if (e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - touchStartX;
        const dy = e.touches[0].clientY - touchStartY;
        if (!isSeeking && !isVolume) {
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 12) isSeeking = true;
            else if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) isVolume = true;
        }
        if (isSeeking && video.duration) {
            const totalDur = hlsTotalDuration > 0 ? hlsTotalDuration : video.duration;
            const seekDelta = (dx / window.innerWidth) * Math.min(totalDur, 120);
            let target = Math.max(0, Math.min(totalDur, touchStartPos + seekDelta));
            if (hlsAvailableEnd > 0) {
                target = Math.max(hlsAvailableStart, Math.min(hlsAvailableEnd - 1, target));
            }
            video.currentTime = target;
            showControls();
        }
        if (isVolume) {
            video.volume = Math.max(0, Math.min(1, touchStartVol - (dy / window.innerHeight) * 1.5));
        }
    }, { passive: true });

    video.addEventListener('touchend', e => {
        const elapsed = Date.now() - touchStartTime;
        const dx = Math.abs(e.changedTouches[0].clientX - touchStartX);
        const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
        if (!isSeeking && !isVolume && elapsed < 300 && dx < 12 && dy < 12) {
            const now  = Date.now();
            const tapX = e.changedTouches[0].clientX;
            if (now - lastTapTime < 300) {
                const isLeft = tapX < window.innerWidth / 2;
                skip(isLeft ? -SKIP_SECONDS : SKIP_SECONDS);
                showRipple(isLeft ? 'left' : 'right');
                lastTapTime = 0;
            } else {
                lastTapTime = now;
                if (playerShell.classList.contains('controls-hidden')) showControls();
                else scheduleHideControls();
            }
        }
    }, { passive: true });
}

function showRipple(side) {
    const el = side === 'left' ? skipRippleLeft : skipRippleRight;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 600);
}

// ─── Controls Visibility ──────────────────────────────────────────────────────
function showControls() {
    playerShell.classList.remove('controls-hidden');
    clearTimeout(controlsTimer);
    if (!video.paused) scheduleHideControls();
}

function scheduleHideControls() {
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => {
        if (!video.paused && settingsPanel.classList.contains('hidden') && !seekDragging) {
            playerShell.classList.add('controls-hidden');
        }
    }, CONTROLS_HIDE_DELAY);
}

// ─── Playback Helpers ─────────────────────────────────────────────────────────
function togglePlayPause() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
}

function skip(seconds) {
    const totalDur = hlsTotalDuration > 0 ? hlsTotalDuration : video.duration;
    if (!totalDur) return;
    let target = Math.max(0, Math.min(totalDur, video.currentTime + seconds));
    // Clamp to available range
    if (hlsAvailableEnd > 0) {
        if (target < hlsAvailableStart) target = hlsAvailableStart;
        if (target > hlsAvailableEnd - 1) {
            showToast('Seek', 'This part hasn\'t loaded yet.');
            target = Math.min(target, hlsAvailableEnd - 1);
        }
    }
    video.currentTime = target;
    showControls();
}

function adjustVolume(delta) {
    video.volume = Math.max(0, Math.min(1, video.volume + delta));
    video.muted  = false;
}

function toggleMute() { video.muted = !video.muted; }

function updatePlayPauseUI() {
    const paused = video.paused || video.ended;
    playIcon.classList.toggle('hidden',  !paused);
    pauseIcon.classList.toggle('hidden', paused);
    if (!paused) scheduleHideControls();
    else showControls();
}

function updateVolumeUI() {
    const vol = video.muted ? 0 : video.volume;
    volSlider.value = vol;
    volSlider.style.setProperty('--vol-pct', `${vol * 100}%`);
    volIconHigh.classList.toggle('hidden', vol < 0.5 || video.muted);
    volIconLow.classList.toggle('hidden',  !(vol > 0 && vol < 0.5) || video.muted);
    volIconMute.classList.toggle('hidden', vol > 0 && !video.muted);
}

async function toggleFullscreen() {
    if (!document.fullscreenElement) {
        await (playerShell.requestFullscreen?.() || playerShell.webkitRequestFullscreen?.());
    } else {
        await (document.exitFullscreen?.() || document.webkitExitFullscreen?.());
    }
}

function updateFullscreenUI() {
    const isFS = !!document.fullscreenElement || !!document.webkitFullscreenElement;
    fsEnterIcon.classList.toggle('hidden', isFS);
    fsExitIcon.classList.toggle('hidden',  !isFS);
}

async function togglePiP() {
    if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled) {
        await video.requestPictureInPicture();
    } else {
        showToast('PiP', 'Picture-in-Picture not supported in this browser.');
    }
}

function updatePiPUI() {
    pipBtn.classList.toggle('active', !!document.pictureInPictureElement);
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
function toggleSettings() {
    if (settingsPanel.classList.contains('hidden')) openSettings();
    else closeSettings();
}

function openSettings() {
    settingsPanel.classList.remove('hidden');
    settingsBtn.classList.add('active');
    showControls();
}

function closeSettings() {
    settingsPanel.classList.add('hidden');
    settingsBtn.classList.remove('active');
}

// ─── Auto-Next Episode ────────────────────────────────────────────────────────
function triggerAutonext() {
    if (!episodeMgr.hasNext()) return;
    const next = episodeMgr.getNext();
    if (!next) return;

    autonextTitle.textContent = next.title || `Episode ${(currentMeta.episode || 0) + 1}`;
    autonextOverlay.classList.remove('hidden');
    autonextSecs = AUTONEXT_DELAY;
    autonextCountdown.textContent = autonextSecs;

    const circumference = 2 * Math.PI * 18;
    autonextRingFill.style.strokeDasharray  = circumference;
    autonextRingFill.style.strokeDashoffset = 0;

    autonextTimer = setInterval(() => {
        autonextSecs--;
        autonextCountdown.textContent = autonextSecs;
        const progress = (AUTONEXT_DELAY - autonextSecs) / AUTONEXT_DELAY;
        autonextRingFill.style.strokeDashoffset = circumference * (1 - progress);
        if (autonextSecs <= 0) {
            cancelAutonext();
            episodeMgr.playNext(launchPlayer);
        }
    }, 1000);
}

function cancelAutonext() {
    clearInterval(autonextTimer);
    autonextTimer = null;
    autonextOverlay.classList.add('hidden');
}

function updateEpisodeButtons() {
    const isTV = currentMeta.type === 'tv';
    prevEpBtn.classList.toggle('hidden', !isTV || !episodeMgr.hasPrev());
    nextEpBtn.classList.toggle('hidden', !isTV || !episodeMgr.hasNext());
}

// ─── Progress Save ────────────────────────────────────────────────────────────
function startProgressSave() {
    clearInterval(progressSaveTimer);
    progressSaveTimer = setInterval(saveProgress, PROGRESS_SAVE_INTERVAL);
}

// ─── Stream Source Switcher ───────────────────────────────────────────────────
function buildStreamSourceList(meta = {}) {
    if (!streamSourceSection || !streamSourceList) return;

    // servers = { "Server 1 (4KHDHUB)": { url, referer }, "Server 2 (HDHUB4U)": {...} }
    const servers = meta.servers || {};
    const entries = Object.entries(servers).filter(([, s]) => s && s.url);

    if (!entries.length) {
        streamSourceSection.style.display = 'none';
        return;
    }

    streamSourceSection.style.display = '';
    streamSourceList.innerHTML = '';

    entries.forEach(([name, serverInfo], index) => {
        const isActive = serverInfo.url === currentSrc || index === 0;
        const btn = makeSettingsOption(name, String(index), isActive);
        btn.addEventListener('click', async () => {
            if (serverInfo.url === currentSrc) return;
            setActiveOption(streamSourceList, String(index));
            showToast('Switching server', name);
            closeSettings();
            await launchPlayer(serverInfo.url, {
                ...meta,
                referer: serverInfo.referer || meta.referer || '',
                proxy: true,
                raw: true,
                servers,
            });
        });
        streamSourceList.appendChild(btn);
    });
}

// ─── HLS Position Reporter ────────────────────────────────────────────────────
// Reports current playback position to backend every 10s so it can delete
// segments behind the playhead and return the available seek range.
function startPositionReporter() {
    clearInterval(positionReportTimer);
    const jobId = currentMeta?.hlsJob;
    if (!jobId) return;

    positionReportTimer = setInterval(async () => {
        if (!jobId || video.paused) return;
        try {
            const res = await fetch(playerBackendUrl(`/api/hls/position/${encodeURIComponent(jobId)}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ position: Math.floor(video.currentTime) }),
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data.available_start !== undefined) hlsAvailableStart = data.available_start;
            if (data.available_end   !== undefined) hlsAvailableEnd   = data.available_end;
            if (data.total_duration  > 0)           hlsTotalDuration  = data.total_duration;
            // Update total time display if we got a better value
            if (hlsTotalDuration > 0 && timeTotal) {
                timeTotal.textContent = formatTime(hlsTotalDuration);
            }
        } catch { /* non-fatal */ }
    }, 10000);
}

function saveProgress() {
    if (!currentMeta.id) return;
    const totalDur = hlsTotalDuration > 0 ? hlsTotalDuration : video.duration;
    if (!totalDur) return;
    const pct = (video.currentTime / totalDur) * 100;
    if (pct > 95) {
        continueWatchingMgr.remove(currentMeta.id);
    } else if (pct > 2) {
        continueWatchingMgr.save({
            id:       currentMeta.id,
            title:    currentMeta.title,
            type:     currentMeta.type,
            season:   currentMeta.season,
            episode:  currentMeta.episode,
            poster:   currentMeta.poster,
            src:      currentSrc,
            subUrl:   currentMeta.subUrl,
            progress: Math.round(pct),
            position: Math.floor(video.currentTime),
            savedAt:  Date.now(),
        });
    }
}

// ─── Stats Polling ────────────────────────────────────────────────────────────
function startStatsPolling() {
    clearInterval(statsInterval);
    statsInterval = setInterval(updateStats, 2000);
}

function updateStats() {
    // Buffer ahead
    let buffered = 0;
    for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime) {
            buffered = Math.max(buffered, video.buffered.end(i) - video.currentTime);
        }
    }
    const bufSecs = Math.round(buffered);
    if (cacheBufVal) cacheBufVal.textContent = `${bufSecs}s`;
    const bufPct = Math.min(100, (bufSecs / 120) * 100);
    if (cacheBarFill) cacheBarFill.style.width = `${bufPct}%`;

    // Resolution (update in case it changes)
    if (cacheResVal && video.videoWidth) {
        cacheResVal.textContent = `${video.videoWidth}×${video.videoHeight}`;
    }

    // Dropped frames
    if (cacheDropVal && video.getVideoPlaybackQuality) {
        const q = video.getVideoPlaybackQuality();
        cacheDropVal.textContent = q.droppedVideoFrames ?? '—';
    }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(title, message = '') {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<div class="toast-title">${title}</div>${message ? `<div class="toast-msg">${message}</div>` : ''}`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-8px)';
        toast.style.transition = 'opacity 0.22s ease, transform 0.22s ease';
        setTimeout(() => toast.remove(), 240);
    }, 2800);
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function formatTime(seconds) {
    if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
}

// ─── Recent Streams (Source Panel) ───────────────────────────────────────────
function renderRecentStreams() {
    const section = $('recent-streams-section');
    const list    = $('recent-streams-list');
    if (!section || !list || !streamCache) return;

    const items = streamCache.getAll().slice(0, 5);
    if (!items.length) { section.classList.add('hidden'); return; }

    section.classList.remove('hidden');
    list.innerHTML = '';

    items.forEach(item => {
        const progress = continueWatchingMgr.getProgress(item.id);
        const pct      = item.duration ? Math.round((progress / item.duration) * 100) : 0;

        const row = document.createElement('button');
        row.className = 'recent-stream-row';
        const epLabel = item.type === 'tv' && item.season
            ? `<span class="recent-ep-badge">S${item.season}·E${item.episode}</span>` : '';
        const progressBar = progress > 0
            ? `<div class="recent-progress-bar"><div style="width:${pct}%"></div></div>` : '';

        row.innerHTML = `
            <div class="recent-stream-thumb">
                ${item.poster
                    ? `<img src="${item.poster}" alt="" style="width:100%;height:100%;object-fit:cover;">`
                    : `<svg class="w-4 h-4 text-white/30" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`}
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                    <span class="text-white text-sm font-semibold truncate">${item.title || 'Untitled'}</span>
                    ${epLabel}
                </div>
                ${progressBar}
            </div>
        `;
        row.addEventListener('click', () => {
            streamUrlInput.value   = item.src || '';
            streamTitleInput.value = item.title || '';
            streamTypeSelect.value = item.type  || 'movie';
            subtitleUrlInput.value = item.subUrl || '';
            launchBtn.click();
        });
        list.appendChild(row);
    });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('pagehide', stopCurrentHlsJob);
window.addEventListener('beforeunload', stopCurrentHlsJob);
init();
