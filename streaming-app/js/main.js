import { fetchTMDB, endpoints, IMAGE_BASE_URL, SMALL_IMAGE_URL, getGenreNames } from './api.js?v=9006';

const FALLBACK_IMAGE = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"%3E%3Cdefs%3E%3ClinearGradient id="g" x1="0" x2="1" y1="0" y2="1"%3E%3Cstop stop-color="%2317171a"/%3E%3Cstop offset="1" stop-color="%23030304"/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect fill="url(%23g)" width="1200" height="675"/%3E%3Cpath d="M520 248h160v180H520z" fill="%23ffffff" fill-opacity=".08"/%3E%3Cpath d="M558 292l90 46-90 46z" fill="%23ffffff" fill-opacity=".38"/%3E%3C/svg%3E';

function safeGetLocal(key) {
    try {
        const item = localStorage.getItem(key);
        const parsed = item ? JSON.parse(item) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function safeSetLocal(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        showToast('Storage unavailable', 'Your browser blocked saving this item locally.');
    }
}

function $(id) {
    return document.getElementById(id);
}

function safeGetString(key, fallback) {
    try {
        return localStorage.getItem(key) || fallback;
    } catch (error) {
        return fallback;
    }
}

function safeSetString(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (error) {
        showToast('Storage unavailable', 'Your browser blocked saving this setting locally.');
    }
}

const MAIN_PROFILE_NAME_KEY = 'netwatch_main_profile_name';

const profileConfig = {
    main: {
        key: 'main',
        name: safeGetString(MAIN_PROFILE_NAME_KEY, 'You'),
        initial: 'Y',
        listKey: 'netwatch_watchlist_main',
        continueKey: 'netwatch_continue_main',
        avatarClass: 'profile-avatar-primary'
    },
    kids: {
        key: 'kids',
        name: 'Kids',
        initial: 'K',
        listKey: 'netwatch_watchlist_kids',
        continueKey: 'netwatch_continue_kids',
        avatarClass: 'profile-avatar-kids'
    }
};

// State
let activeProfile = profileConfig[safeGetString('netwatch_active_profile', 'main')] ? safeGetString('netwatch_active_profile', 'main') : 'main';
let myWatchlist = safeGetLocal(profileConfig[activeProfile].listKey);
let continueWatching = safeGetLocal(profileConfig[activeProfile].continueKey);
let bannerInterval;
let trendingItems = [];
let currentBannerIndex = 0;
let currentBannerItem = null;
let currentDetailItem = null;
let activeBannerEl = 1;
let searchDebounceTimer;
let appInitialized = false;
const LOCAL_BACKEND = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') && window.location.port === '5000'
    ? ''
    : 'http://127.0.0.1:5000';

// DOM Elements
const navbar = $('navbar');
const banner = $('banner');
const bannerKicker = $('banner_kicker');
const bannerTitle = $('banner_title');
const bannerDesc = $('banner_description');
const bannerButtons = $('banner_buttons');
const bannerMeta = $('banner_meta');
const bannerColorOverlay = $('banner-color-overlay');
const rowsContainer = $('movie-rows');
const bodyBg = $('body-bg');
const toastContainer = $('toast-container');

const searchOverlay = $('search-overlay');
const searchInput = $('search-input');
const searchResults = $('search-results');
const searchStatus = $('search-status');
const profileButton = $('profile-btn');
const profileMenu = $('profile-menu');
const profileScreenTitle = $('profile-screen-title');
const profileManagePanel = $('profile-manage-panel');
const profileNameInput = $('profile-name-input');
const continueWatchingContainer = $('continue-watching-container');
const continueWatchingRow = $('continue-watching-row');

const detailsSheet = $('details-sheet');
const detailsContent = $('details-content');

// --- Utilities ---
function titleOf(item) {
    return item?.title || item?.name || 'Untitled';
}

function currentProfile() {
    return profileConfig[activeProfile] || profileConfig.main;
}

function yearOf(item) {
    return (item?.release_date || item?.first_air_date || '').substring(0, 4) || 'New';
}

function truncateText(str, maxLength) {
    if (!str) return 'No description available yet.';
    return str.length > maxLength ? `${str.substring(0, maxLength - 1)}...` : str;
}

function mediaImage(item, preferred = 'backdrop', large = false) {
    const path = preferred === 'poster'
        ? (item?.poster_path || item?.backdrop_path)
        : (item?.backdrop_path || item?.poster_path);

    if (!path) return FALLBACK_IMAGE;
    const base = large ? IMAGE_BASE_URL : SMALL_IMAGE_URL;
    return `${base}${path}`;
}

function syncBodyLock() {
    const searchOpen = searchOverlay && !searchOverlay.classList.contains('hidden');
    const detailsOpen = detailsSheet && !detailsSheet.classList.contains('hidden');
    document.body.style.overflow = searchOpen || detailsOpen ? 'hidden' : '';
}

function isProfileMenuOpen() {
    return profileMenu && !profileMenu.classList.contains('hidden');
}

function showToast(title, message = '') {
    if (!toastContainer) return;

    const toast = document.createElement('div');
    toast.className = 'toast';

    const titleEl = document.createElement('div');
    titleEl.className = 'toast-title';
    titleEl.textContent = title;
    toast.appendChild(titleEl);

    if (message) {
        const messageEl = document.createElement('div');
        messageEl.className = 'toast-message';
        messageEl.textContent = message;
        toast.appendChild(messageEl);
    }

    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-8px)';
        setTimeout(() => toast.remove(), 220);
    }, 3200);
}

function backendUrl(path) {
    return `${LOCAL_BACKEND}${path}`;
}

function mediaTypeOf(item) {
    return item?.media_type || (item?.first_air_date ? 'tv' : 'movie');
}

function selectedEpisodeFor(item) {
    if (mediaTypeOf(item) !== 'tv') return { season: 1, episode: 1 };
    const seasonSelect = $('sheet-season-input');
    const episodeSelect = $('sheet-episode-input');
    const useSheetValues = currentDetailItem && item && String(currentDetailItem.id) === String(item.id);
    const season = useSheetValues ? parseInt(seasonSelect?.value || '1', 10) : parseInt(item?.season || item?.season_number || '1', 10);
    const episode = useSheetValues ? parseInt(episodeSelect?.value || '1', 10) : parseInt(item?.episode || item?.episode_number || '1', 10);
    return {
        season: Math.max(1, Number.isFinite(season) ? season : 1),
        episode: Math.max(1, Number.isFinite(episode) ? episode : 1),
    };
}

function setImageFallback(img) {
    img.onerror = () => {
        img.onerror = null;
        img.src = FALLBACK_IMAGE;
    };
}

function renderEmptyState(title, message) {
    if (!rowsContainer) return;
    rowsContainer.innerHTML = `
        <div class="empty-state">
            <h2 class="text-white text-xl font-semibold">${title}</h2>
            <p class="mt-3 text-sm leading-relaxed">${message}</p>
        </div>
    `;
}

function setNavbarState() {
    if (!navbar) return;
    navbar.classList.toggle('nav-scrolled', window.scrollY > 18);
}

function scrollToTop() {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

function enhanceHorizontalScroller(scroller) {
    if (!scroller || scroller.dataset.dragScrollBound === '1') return;
    scroller.dataset.dragScrollBound = '1';
    scroller.classList.add('drag-scroll-row');

    let isDragging = false;
    let startX = 0;
    let startScrollLeft = 0;
    let hasMoved = false;
    let suppressClick = false;
    let activePointerId = null;

    scroller.addEventListener('wheel', (event) => {
        const maxScroll = scroller.scrollWidth - scroller.clientWidth;
        if (maxScroll <= 0) return;

        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        if ((delta < 0 && scroller.scrollLeft <= 0) || (delta > 0 && scroller.scrollLeft >= maxScroll)) return;

        event.preventDefault();
        scroller.scrollLeft += delta;
    }, { passive: false });

    scroller.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        isDragging = true;
        hasMoved = false;
        activePointerId = event.pointerId;
        startX = event.clientX;
        startScrollLeft = scroller.scrollLeft;
    });

    scroller.addEventListener('pointermove', (event) => {
        if (!isDragging || event.pointerId !== activePointerId) return;
        const diff = event.clientX - startX;
        if (Math.abs(diff) > 10) {
            hasMoved = true;
            scroller.classList.add('is-dragging');
        }
        if (!hasMoved) return;
        scroller.scrollLeft = startScrollLeft - diff;
        event.preventDefault();
    });

    const endDrag = (event) => {
        if (!isDragging || event.pointerId !== activePointerId) return;
        isDragging = false;
        activePointerId = null;
        scroller.classList.remove('is-dragging');
        if (hasMoved) {
            suppressClick = true;
            setTimeout(() => { suppressClick = false; }, 140);
        }
    };

    scroller.addEventListener('pointerup', endDrag);
    scroller.addEventListener('pointercancel', endDrag);
    scroller.addEventListener('pointerleave', () => {
        isDragging = false;
        activePointerId = null;
        scroller.classList.remove('is-dragging');
    });

    scroller.addEventListener('click', (event) => {
        if (!suppressClick) return;
        event.preventDefault();
        event.stopPropagation();
    }, true);
}

function reloadProfileCollections() {
    myWatchlist = safeGetLocal(currentProfile().listKey);
    continueWatching = safeGetLocal(currentProfile().continueKey);
}

function isKidsProfile() {
    return activeProfile === 'kids';
}

function isKidsAllowed(item) {
    if (!item) return false;
    const genres = item.genre_ids || [];
    return genres.some(id => [16, 10751, 10762].includes(id));
}

// --- Event Binding ---
window.addEventListener('startApp', () => {
    if (!appInitialized) {
        appInitialized = true;
        reloadProfileCollections();
        syncProfileUI();
        initApp();
    }
});

window.addEventListener('profileSelected', (event) => {
    setActiveProfile(event.detail?.profile || 'main', { fromPicker: true });
});

window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace('#', '') || 'all';
    updateActiveNav(hash);
    if (hash === 'mylist') showMyList();
    else loadContent(hash);
    scrollToTop();
});

window.addEventListener('scroll', setNavbarState, { passive: true });

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (isProfileMenuOpen()) closeProfileMenu();
    else if (searchOverlay && !searchOverlay.classList.contains('hidden')) closeSearch();
    else if (detailsSheet && !detailsSheet.classList.contains('hidden')) closeDetailsSheet();
});

document.addEventListener('click', (event) => {
    if (!isProfileMenuOpen()) return;
    if (profileMenu.contains(event.target) || profileButton?.contains(event.target)) return;
    closeProfileMenu();
});

document.querySelectorAll('.category-chip').forEach(chip => {
    chip.addEventListener('click', (event) => {
        window.location.hash = event.currentTarget.getAttribute('data-category');
    });
});

$('main_play_btn')?.addEventListener('click', () => {
    if (!currentBannerItem) return;
    // For TV shows, open details sheet so user can pick season/episode
    if (mediaTypeOf(currentBannerItem) === 'tv') {
        openDetailsSheet(currentBannerItem);
    } else {
        requestPlayback(currentBannerItem);
    }
});
$('banner_info_btn')?.addEventListener('click', () => {
    if (currentBannerItem) openDetailsSheet(currentBannerItem);
});

$('search-btn')?.addEventListener('click', openSearch);
$('close-search-btn')?.addEventListener('click', closeSearch);
profileButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleProfileMenu();
});
$('profile-main-btn')?.addEventListener('click', () => {
    closeProfileMenu();
    setActiveProfile('main');
});
$('profile-kids-btn')?.addEventListener('click', () => {
    closeProfileMenu();
    setActiveProfile('kids');
});
$('profile-manage-btn')?.addEventListener('click', () => {
    closeProfileMenu();
    showProfileScreen({ manage: true });
});
$('profile-choose-btn')?.addEventListener('click', () => {
    closeProfileMenu();
    showProfileScreen({ manage: false });
});
$('save-profile-name-btn')?.addEventListener('click', saveMainProfileName);
$('done-manage-btn')?.addEventListener('click', () => {
    hideProfileScreen();
});

searchInput?.addEventListener('input', (event) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => handleSearchInput(event), 280);
});

$('sheet-close-btn')?.addEventListener('click', closeDetailsSheet);
detailsSheet?.addEventListener('click', (event) => {
    if (event.target === detailsSheet) closeDetailsSheet();
});

// --- Navigation ---
function updateActiveNav(target) {
    let mappedTarget = target;
    if (['action', 'scifi', 'comedy', 'horror'].includes(target)) mappedTarget = 'categories';

    document.querySelectorAll('.top-nav-item').forEach(item => {
        const isActive = item.getAttribute('data-nav') === mappedTarget;
        item.classList.toggle('text-white', isActive);
        item.classList.toggle('font-bold', isActive);
        item.classList.toggle('text-white/60', !isActive);
        item.setAttribute('aria-current', isActive ? 'page' : 'false');
        item.onclick = () => {
            window.location.hash = item.getAttribute('data-nav');
        };
    });

    document.querySelectorAll('.mobile-nav-item').forEach(item => {
        const indicator = item.querySelector('.nav-indicator');
        const isActive = item.getAttribute('data-nav') === mappedTarget;
        item.classList.toggle('text-white', isActive);
        item.classList.toggle('text-white/50', !isActive);
        item.setAttribute('aria-current', isActive ? 'page' : 'false');
        if (indicator) {
            indicator.classList.toggle('opacity-100', isActive);
            indicator.classList.toggle('opacity-0', !isActive);
        }
        item.onclick = () => {
            window.location.hash = item.getAttribute('data-nav');
        };
    });

    updateActiveCategory(target);
}

function updateActiveCategory(target) {
    document.querySelectorAll('.category-chip').forEach(chip => {
        const isActive = chip.getAttribute('data-category') === target;
        chip.setAttribute('aria-pressed', String(isActive));
    });
}

// --- Search ---
function openSearch() {
    if (!searchOverlay) return;
    searchOverlay.classList.remove('hidden');
    searchOverlay.classList.add('flex');
    renderSearchSuggestions();
    syncBodyLock();
    setTimeout(() => searchInput?.focus(), 100);
}

function closeSearch() {
    if (!searchOverlay) return;
    searchOverlay.classList.add('hidden');
    searchOverlay.classList.remove('flex');
    syncBodyLock();
}

function toggleProfileMenu() {
    if (!profileMenu) return;
    if (isProfileMenuOpen()) closeProfileMenu();
    else openProfileMenu();
}

function openProfileMenu() {
    if (!profileMenu) return;
    if (searchOverlay && !searchOverlay.classList.contains('hidden')) closeSearch();
    profileMenu.classList.remove('hidden');
    profileButton?.setAttribute('aria-expanded', 'true');
}

function closeProfileMenu() {
    if (!profileMenu) return;
    profileMenu.classList.add('hidden');
    profileButton?.setAttribute('aria-expanded', 'false');
}

function showProfileScreen(options = {}) {
    const screen = $('profile-screen');
    if (!screen) return;
    const isManaging = Boolean(options.manage);
    syncProfileUI();
    if (profileScreenTitle) profileScreenTitle.textContent = isManaging ? 'Manage profiles' : 'Choose a profile';
    profileManagePanel?.classList.toggle('hidden', !isManaging);
    if (profileNameInput) profileNameInput.value = profileConfig.main.name;
    screen.classList.remove('hidden');
    screen.style.pointerEvents = 'auto';
    requestAnimationFrame(() => {
        screen.style.opacity = '1';
        if (isManaging) profileNameInput?.focus();
    });
}

function hideProfileScreen() {
    const screen = $('profile-screen');
    if (!screen) return;
    screen.style.opacity = '0';
    screen.style.pointerEvents = 'none';
    setTimeout(() => screen.classList.add('hidden'), 700);
}

function saveMainProfileName() {
    const nextName = (profileNameInput?.value || '').trim() || 'You';
    profileConfig.main.name = nextName;
    safeSetString(MAIN_PROFILE_NAME_KEY, nextName);
    syncProfileUI();
    if (profileNameInput) profileNameInput.value = nextName;
    showToast('Profile renamed', `Your profile is now ${nextName}.`);
}

function setActiveProfile(profileKey, options = {}) {
    if (!profileConfig[profileKey]) return;
    const changed = activeProfile !== profileKey;

    activeProfile = profileKey;
    safeSetString('netwatch_active_profile', profileKey);
    reloadProfileCollections();
    syncProfileUI();

    if (!appInitialized) return;

    if (detailsSheet && !detailsSheet.classList.contains('hidden')) closeDetailsSheet();
    if (searchOverlay && !searchOverlay.classList.contains('hidden')) closeSearch();

    const hash = window.location.hash.replace('#', '') || 'all';
    if (hash === 'mylist') showMyList();
    else loadContent(isKidsProfile() ? 'all' : hash);

    if (!options.fromPicker || changed) {
        showToast(`${currentProfile().name} profile`, isKidsProfile() ? 'Showing kids and family content only.' : 'Showing the full catalog.');
    }
}

function syncProfileUI() {
    const profile = currentProfile();
    document.body.classList.toggle('kids-profile', isKidsProfile());

    const avatarTargets = [
        profileButton,
        document.querySelector('.profile-menu-header .profile-avatar-small')
    ].filter(Boolean);

    avatarTargets.forEach(target => {
        target.classList.remove('profile-avatar-primary', 'profile-avatar-kids');
        target.classList.add(profile.avatarClass);
        const label = target.querySelector('span') || target;
        label.textContent = profile.initial;
    });

    const profileName = document.querySelector('.profile-menu-name');
    if (profileName) profileName.textContent = profile.name;

    document.querySelectorAll('.profile-card-name, .profile-main-row-name').forEach(label => {
        label.textContent = profileConfig.main.name;
    });
    const mainProfileCardAvatar = document.querySelector('#profile-card-main .profile-avatar span');
    if (mainProfileCardAvatar) mainProfileCardAvatar.textContent = profileConfig.main.initial;
    const mainProfileRowAvatar = document.querySelector('#profile-main-btn .profile-avatar-tiny');
    if (mainProfileRowAvatar) mainProfileRowAvatar.textContent = profileConfig.main.initial;

    document.querySelectorAll('.profile-menu-row').forEach(row => {
        row.querySelector('.profile-row-state')?.remove();
    });

    const activeRow = activeProfile === 'kids' ? $('profile-kids-btn') : $('profile-main-btn');
    if (activeRow) {
        const state = document.createElement('span');
        state.className = 'profile-row-state';
        state.textContent = 'Active';
        activeRow.appendChild(state);
    }
}

function setSearchStatus(text) {
    if (searchStatus) searchStatus.textContent = text;
}

function renderSearchSuggestions() {
    if (!searchResults) return;
    const items = [...trendingItems, ...myWatchlist, ...continueWatching]
        .filter(item => !isKidsProfile() || isKidsAllowed(item))
        .filter((item, index, list) => item && list.findIndex(candidate => candidate.id === item.id) === index)
        .slice(0, 12);

    searchResults.innerHTML = '';
    setSearchStatus(items.length ? 'Suggested Searches' : 'Start typing to search');
    items.forEach(item => searchResults.appendChild(createSearchCard(item)));
}

async function handleSearchInput(event) {
    const query = event.target.value.trim();
    if (query.length < 2) {
        renderSearchSuggestions();
        return;
    }

    setSearchStatus(`Searching "${query}"`);
    if (searchResults) {
        searchResults.innerHTML = '<div class="col-span-full text-white/50 text-sm">Looking through the catalog...</div>';
    }

    const endpoint = isKidsProfile()
        ? `${endpoints.search + encodeURIComponent(query)}&with_genres=16,10751`
        : endpoints.search + encodeURIComponent(query);
    const data = await fetchTMDB(endpoint);
    if (!searchResults) return;

    const results = (data.results || [])
        .filter(item => ['movie', 'tv'].includes(item.media_type || '') || item.poster_path || item.backdrop_path)
        .filter(item => item.poster_path || item.backdrop_path)
        .filter(item => !isKidsProfile() || isKidsAllowed(item))
        .slice(0, 18);

    searchResults.innerHTML = '';
    setSearchStatus(results.length ? 'Results' : 'No results found');

    if (!results.length) {
        searchResults.innerHTML = `<div class="col-span-full empty-state mt-2">${isKidsProfile() ? 'Try a family, animation, or kids title.' : 'Try a different title, actor, or genre.'}</div>`;
        return;
    }

    results.forEach(item => searchResults.appendChild(createSearchCard(item)));
}

function createSearchCard(item) {
    const card = document.createElement('button');
    card.className = 'search-card group';
    card.setAttribute('aria-label', `View details for ${titleOf(item)}`);

    const media = document.createElement('div');
    media.className = 'search-card-media skeleton-bg';

    const img = document.createElement('img');
    img.src = mediaImage(item, 'poster');
    img.alt = titleOf(item);
    img.loading = 'lazy';
    img.decoding = 'async';
    setImageFallback(img);
    img.onload = () => media.classList.remove('skeleton-bg');

    const title = document.createElement('div');
    title.className = 'search-card-title';
    title.textContent = titleOf(item);

    media.appendChild(img);
    card.appendChild(media);
    card.appendChild(title);
    card.addEventListener('click', () => {
        closeSearch();
        openDetailsSheet(item);
    });

    return card;
}

// --- Season / Episode dropdown population ---
async function populateSeasonEpisodeSelects(item, seasonSelect, episodeSelect) {
    const tmdbId = item.id;
    const currentSeason = Math.max(1, parseInt(item?.season || item?.season_number || '1', 10) || 1);
    const currentEpisode = Math.max(1, parseInt(item?.episode || item?.episode_number || '1', 10) || 1);

    // Populate season dropdown from item.seasons or TMDB
    let seasons = item.seasons || [];

    if (!seasons.length) {
        try {
            const data = await fetchTMDB(`/tv/${tmdbId}?language=en-US`);
            seasons = (data.seasons || []).filter(s => s.season_number > 0);
        } catch { /* use fallback */ }
    }

    // Build season options
    seasonSelect.innerHTML = '';
    if (seasons.length) {
        seasons.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.season_number;
            opt.textContent = `Season ${s.season_number}${s.name && s.name !== `Season ${s.season_number}` ? ` â€” ${s.name}` : ''}`;
            if (s.season_number === currentSeason) opt.selected = true;
            seasonSelect.appendChild(opt);
        });
    } else {
        // Fallback: just show season 1
        const opt = document.createElement('option');
        opt.value = 1;
        opt.textContent = 'Season 1';
        seasonSelect.appendChild(opt);
    }

    // Populate episodes for the selected season
    await populateEpisodeSelect(tmdbId, parseInt(seasonSelect.value), episodeSelect, currentEpisode);

    // When season changes, reload episodes
    seasonSelect.onchange = async () => {
        await populateEpisodeSelect(tmdbId, parseInt(seasonSelect.value), episodeSelect, 1);
    };
}

async function populateEpisodeSelect(tmdbId, season, episodeSelect, selectedEpisode = 1) {
    episodeSelect.innerHTML = '<option value="1">Loading...</option>';
    try {
        const data = await fetchTMDB(`/tv/${tmdbId}/season/${season}?language=en-US`);
        const episodes = data.episodes || [];
        episodeSelect.innerHTML = '';
        if (episodes.length) {
            episodes.forEach(ep => {
                const opt = document.createElement('option');
                opt.value = ep.episode_number;
                opt.textContent = `E${ep.episode_number}${ep.name ? ` â€” ${ep.name}` : ''}`;
                if (ep.episode_number === selectedEpisode) opt.selected = true;
                episodeSelect.appendChild(opt);
            });
        } else {
            const opt = document.createElement('option');
            opt.value = 1;
            opt.textContent = 'Episode 1';
            episodeSelect.appendChild(opt);
        }
    } catch {
        episodeSelect.innerHTML = `<option value="${selectedEpisode}">Episode ${selectedEpisode}</option>`;
    }
}

// --- Details and Lists ---
function openDetailsSheet(item) {
    if (!detailsSheet || !item) return;
    currentDetailItem = item;

    $('sheet-title').textContent = titleOf(item);
    $('sheet-overview').textContent = item.overview || 'No description available yet.';
    const sheetBackdrop = $('sheet-backdrop');
    if (sheetBackdrop) {
        setImageFallback(sheetBackdrop);
        sheetBackdrop.src = mediaImage(item, 'backdrop', true);
    }
    $('sheet-year').textContent = yearOf(item);
    $('sheet-genres-list').textContent = getGenreNames(item.genre_ids);
    $('sheet-match').textContent = item.vote_average ? `${Math.round(item.vote_average * 10)}% Match` : 'New';

    const episodeControls = $('sheet-episode-controls');
    const seasonSelect = $('sheet-season-input');
    const episodeSelect = $('sheet-episode-input');
    const isTV = mediaTypeOf(item) === 'tv';
    if (episodeControls) {
        episodeControls.classList.toggle('hidden', !isTV);
        episodeControls.classList.toggle('grid', isTV);
    }
    if (isTV && seasonSelect && episodeSelect) {
        // Populate from TMDB season data
        populateSeasonEpisodeSelects(item, seasonSelect, episodeSelect);
    }

    const addBtn = $('sheet-add-list');
    setAddButtonState(addBtn, item);
    if (addBtn) addBtn.onclick = () => toggleWatchlist(item, addBtn);

    const playBtn = $('sheet-play-btn');
    if (playBtn) playBtn.onclick = () => requestPlayback(item);

    detailsSheet.classList.remove('hidden');
    void detailsSheet.offsetWidth;
    detailsSheet.classList.remove('opacity-0');
    detailsContent?.classList.remove('translate-y-full');
    syncBodyLock();
}

function closeDetailsSheet() {
    if (!detailsSheet) return;
    detailsSheet.classList.add('opacity-0');
    detailsContent?.classList.add('translate-y-full');
    setTimeout(() => {
        detailsSheet.classList.add('hidden');
        syncBodyLock();
    }, 360);
}

function setAddButtonState(button, item) {
    if (!button) return;
    const isInList = myWatchlist.some(entry => entry.id === item.id);
    button.setAttribute('aria-label', isInList ? 'Remove from My List' : 'Add to My List');
    button.innerHTML = isInList
        ? '<svg class="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>'
        : '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>';
}

function toggleWatchlist(item, button) {
    const index = myWatchlist.findIndex(entry => entry.id === item.id);
    const itemTitle = titleOf(item);

    if (index > -1) {
        myWatchlist.splice(index, 1);
        showToast('Removed from My List', itemTitle);
    } else {
        myWatchlist.unshift(item);
        showToast('Added to My List', itemTitle);
    }

    safeSetLocal(currentProfile().listKey, myWatchlist);
    setAddButtonState(button, item);

    if (window.location.hash.includes('mylist')) showMyList();
}

function showMyList() {
    if (!rowsContainer) return;
    document.body.classList.add('library-view');
    rowsContainer.innerHTML = '';
    rowsContainer.style.opacity = '1';
    renderContinueWatching();
    scrollToTop();

    if (myWatchlist.length === 0) {
        renderEmptyState('Your list is empty', isKidsProfile() ? 'Add kids movies or shows from the details sheet and they will appear here.' : 'Add movies or shows from the details sheet and they will appear here.');
        return;
    }

    createLocalRow(isKidsProfile() ? 'Kids List' : 'My List', myWatchlist.filter(item => !isKidsProfile() || isKidsAllowed(item)), true);
}

async function requestPlayback(item) {
    if (!item) {
        showToast('Nothing selected', 'Choose a title first.');
        return;
    }

    const mediaType = mediaTypeOf(item);
    const episodeInfo = selectedEpisodeFor(item);
    const continueItem = mediaType === 'tv'
        ? { ...item, season: episodeInfo.season, episode: episodeInfo.episode, progress: item.progress || 6 }
        : { ...item, progress: item.progress || 6 };

    if (detailsSheet && !detailsSheet.classList.contains('hidden')) closeDetailsSheet();
    addToContinueWatching(continueItem);
    const episodeLabel = mediaType === 'tv' ? ` S${String(episodeInfo.season).padStart(2, '0')}E${String(episodeInfo.episode).padStart(2, '0')}` : '';
    showToast('Preparing playback', `Selecting x264 source for ${titleOf(item)}${episodeLabel}.`);

    try {
        const startRes = await fetch(backendUrl('/api/playback/start'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tmdb_id: item.id,
                title: titleOf(item),
                year: yearOf(item),
                release_date: item.release_date || '',
                first_air_date: item.first_air_date || '',
                type: mediaType,
                season: episodeInfo.season,
                episode: episodeInfo.episode,
            }),
        });
        const startData = await startRes.json();
        if (!startRes.ok || startData.error) {
            throw new Error(startData.error || 'Could not start playback job');
        }

        const params = new URLSearchParams({
            playback_job: startData.job_id,
            title: titleOf(item),
            type: mediaType,
            id: item.id || startData.job_id,
            year: yearOf(item),
            season: mediaType === 'tv' ? episodeInfo.season : '',
            episode: mediaType === 'tv' ? episodeInfo.episode : '',
        });
        const playerUrl = backendUrl(`/player/?${params.toString()}`);
        showToast('Opening player', 'Preparing stream in the player.');
        window.location.assign(playerUrl);
    } catch (error) {
        showToast('Playback failed', error.message);
    }
}

async function pollPlaybackJob(jobId, title) {
    let lastStatus = '';
    for (let attempt = 0; attempt < 180; attempt += 1) {
        try {
            const res = await fetch(backendUrl(`/api/playback/status/${jobId}`));
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'Playback job failed');

            if (data.status !== lastStatus) {
                lastStatus = data.status;
                if (data.message) showToast('Playback', data.message);
            }

            if (data.status === 'ready' && data.player_url) {
                const playerUrl = data.player_url.startsWith('http')
                    ? data.player_url
                    : backendUrl(data.player_url);
                showToast('Opening player', data.mode === 'hls' ? 'Selectable stream ready.' : 'Direct stream ready.');
                window.location.assign(playerUrl);
                return;
            }

            if (data.status === 'error') {
                throw new Error(data.error || 'Playback job failed');
            }
        } catch (error) {
            showToast('Playback failed', error.message);
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    showToast('Still preparing', `${title} is taking longer than expected.`);
}

function addToContinueWatching(item) {
    continueWatching = continueWatching.filter(entry => entry.id !== item.id);
    continueWatching.unshift(item);
    if (continueWatching.length > 10) continueWatching.pop();
    safeSetLocal(currentProfile().continueKey, continueWatching);
    renderContinueWatching();
}

function renderContinueWatching() {
    if (!continueWatchingContainer || !continueWatchingRow) return;
    if (continueWatching.length === 0) {
        continueWatchingContainer.classList.add('hidden');
        return;
    }

    continueWatchingContainer.classList.remove('hidden');
    continueWatchingRow.innerHTML = '';

    continueWatching.filter(item => !isKidsProfile() || isKidsAllowed(item)).forEach(item => {
        const wrapper = document.createElement('button');
        wrapper.className = 'flex-shrink-0 w-56 md:w-72 cursor-pointer group outline-none rounded-lg text-left transition-transform active:scale-95';
        wrapper.setAttribute('aria-label', `Resume ${titleOf(item)}`);
        wrapper.addEventListener('click', () => openDetailsSheet(item));

        const imgWrapper = document.createElement('div');
        imgWrapper.className = 'relative rounded-lg overflow-hidden bg-[#1c1c1e] shadow-lg skeleton-bg';

        const img = document.createElement('img');
        img.src = mediaImage(item, 'backdrop');
        img.alt = titleOf(item);
        img.className = 'w-full h-32 md:h-40 object-cover';
        img.loading = 'lazy';
        img.decoding = 'async';
        setImageFallback(img);
        img.onload = () => imgWrapper.classList.remove('skeleton-bg');

        const progressContainer = document.createElement('div');
        progressContainer.className = 'absolute bottom-0 left-0 w-full h-1 bg-white/20 backdrop-blur-sm';

        const progress = document.createElement('div');
        progress.className = 'h-full bg-white';
        progress.style.width = `${Math.max(4, Math.min(96, item.progress || 6))}%`;
        progressContainer.appendChild(progress);

        const title = document.createElement('h4');
        title.className = 'text-white/90 text-sm font-semibold mt-3 truncate px-1';
        title.textContent = titleOf(item);

        imgWrapper.appendChild(img);
        imgWrapper.appendChild(progressContainer);
        wrapper.appendChild(imgWrapper);
        wrapper.appendChild(title);
        continueWatchingRow.appendChild(wrapper);
    });

    enhanceHorizontalScroller(continueWatchingRow);
}

// --- Hero ---
function extractColorAndTint(imgUrl) {
    if (!window.ColorThief || !bannerColorOverlay || !bodyBg || imgUrl.startsWith('data:')) return;
    const colorThief = new ColorThief();
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.src = imgUrl;

    img.onload = function () {
        try {
            const color = colorThief.getColor(img);
            bannerColorOverlay.style.backgroundColor = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
        } catch (error) {
            bannerColorOverlay.style.backgroundColor = 'transparent';
        }
    };
}

function updateBannerUI(item) {
    if (!item) return;
    currentBannerItem = item;
    const imgUrl = mediaImage(item, 'backdrop', true);

    const bg1 = $('banner-bg-1');
    const bg2 = $('banner-bg-2');

    if (bg1 && bg2) {
        const next = activeBannerEl === 1 ? bg2 : bg1;
        const current = activeBannerEl === 1 ? bg1 : bg2;
        next.src = imgUrl;
        next.alt = '';
        next.classList.replace('opacity-0', 'opacity-100');
        current.classList.replace('opacity-100', 'opacity-0');
        activeBannerEl = activeBannerEl === 1 ? 2 : 1;
    }

    extractColorAndTint(imgUrl);

    if (bannerKicker) {
        bannerKicker.textContent = isKidsProfile()
            ? 'Kids Featured'
            : (mediaTypeOf(item) === 'tv' ? 'Featured Series' : 'Featured Film');
    }
    if (bannerTitle) {
        bannerTitle.textContent = titleOf(item);
        bannerTitle.classList.remove('hidden');
    }

    if (bannerDesc) bannerDesc.textContent = truncateText(item.overview, window.innerWidth < 768 ? 108 : 188);

    const ratingEl = $('banner_rating');
    if (ratingEl) ratingEl.textContent = item.vote_average ? `${Math.round(item.vote_average * 10)}% Match` : 'New';

    const yearEl = $('banner_year');
    if (yearEl) yearEl.textContent = yearOf(item);

    const genresEl = $('banner_genres');
    if (genresEl) genresEl.textContent = getGenreNames(item.genre_ids);

    const elements = [bannerKicker, bannerTitle, bannerDesc, bannerButtons, bannerMeta];
    elements.forEach(el => {
        if (!el) return;
        el.classList.remove('opacity-100', 'translate-y-0');
        el.classList.add('opacity-0', 'translate-y-4');
    });

    setTimeout(() => {
        elements.forEach(el => {
            if (!el) return;
            el.classList.remove('opacity-0', 'translate-y-4');
            el.classList.add('opacity-100', 'translate-y-0');
        });
    }, 100);

    const dots = document.querySelectorAll('.banner-dot');
    dots.forEach((dot, index) => {
        dot.className = index === currentBannerIndex
            ? 'w-6 h-1.5 rounded-full bg-white banner-dot transition-all duration-300'
            : 'w-1.5 h-1.5 rounded-full bg-white/30 banner-dot transition-all duration-300';
    });
}

function startAutoRotation() {
    clearInterval(bannerInterval);
    bannerInterval = setInterval(() => {
        if (!trendingItems.length) return;
        currentBannerIndex = (currentBannerIndex + 1) % Math.min(3, trendingItems.length);
        updateBannerUI(trendingItems[currentBannerIndex]);
    }, 8000);
}

async function setHeroFromEndpoint(endpoint) {
    const data = await fetchTMDB(endpoint);
    const items = (data.results || [])
        .filter(item => item.backdrop_path || item.poster_path)
        .filter(item => !isKidsProfile() || isKidsAllowed(item));

    if (!items.length) return [];

    trendingItems = items.slice(0, 3);
    currentBannerIndex = 0;
    updateBannerUI(trendingItems[0]);
    startAutoRotation();
    renderSearchSuggestions();
    return items;
}

// --- Content Rows ---
async function loadContent(category) {
    if (!rowsContainer) return;
    document.body.classList.remove('library-view');
    if (banner) banner.classList.remove('hidden');
    rowsContainer.style.opacity = '0';
    renderContinueWatching();

    await new Promise(resolve => setTimeout(resolve, 220));
    rowsContainer.innerHTML = '';

    let renderedRows = 0;

    if (isKidsProfile()) {
        await setHeroFromEndpoint(endpoints.kidsMovies);
        renderedRows += await createRow('Kids Top Picks', endpoints.kidsMovies, true, true);
        renderedRows += await createRow('Animated Adventures', endpoints.kidsAnimation);
        renderedRows += await createRow('Family Movie Night', endpoints.kidsFamily);
        renderedRows += await createRow('Kids Shows', endpoints.kidsShows);
    } else if (category === 'all') {
        await setHeroFromEndpoint(endpoints.trendingAll);
        renderedRows += await createRow('Top 10 Today', endpoints.trendingMovies, true, true);
        renderedRows += await createRow('Trending Now', endpoints.trendingAll);
        renderedRows += await createRow('Original Series', endpoints.netwatchOriginals);
        renderedRows += await createRow('Blockbuster Action', endpoints.actionMovies);
        renderedRows += await createRow('Sci-Fi Worlds', endpoints.scifiMovies);
    } else if (category === 'tv') {
        await setHeroFromEndpoint(endpoints.trendingTV);
        renderedRows += await createRow('Must-Watch Series', endpoints.netwatchOriginals, true);
        renderedRows += await createRow('Binge-Worthy Shows', endpoints.trendingTV);
        renderedRows += await createRow('Animated Shows', endpoints.kidsShows);
    } else if (category === 'movies') {
        await setHeroFromEndpoint(endpoints.trendingMovies);
        renderedRows += await createRow('Top Movies Worldwide', endpoints.trendingMovies, true);
        renderedRows += await createRow('Blockbuster Action', endpoints.actionMovies);
        renderedRows += await createRow('Comedy Hits', endpoints.comedyMovies);
        renderedRows += await createRow('Sci-Fi Masterpieces', endpoints.scifiMovies);
    } else if (category === 'categories') {
        await setHeroFromEndpoint(endpoints.actionMovies);
        renderedRows += await createRow('Action', endpoints.actionMovies, true);
        renderedRows += await createRow('Sci-Fi', endpoints.scifiMovies);
        renderedRows += await createRow('Comedy', endpoints.comedyMovies);
        renderedRows += await createRow('Horror', endpoints.horrorMovies);
        renderedRows += await createRow('Animation', endpoints.animationMovies);
        renderedRows += await createRow('Thrillers', endpoints.thrillerMovies);
        renderedRows += await createRow('Romance', endpoints.romanceMovies);
    } else {
        const endpoint = endpoints[`${category}Movies`] || endpoints.trendingMovies;
        await setHeroFromEndpoint(endpoint);
        const title = `${category.charAt(0).toUpperCase() + category.slice(1)} Selection`;
        renderedRows += await createRow(title, endpoint, true);
        renderedRows += await createRow('More Like This', endpoints.trendingAll);
    }

    if (renderedRows === 0) {
        renderEmptyState('Catalog unavailable', 'The layout is ready, but the movie data could not be loaded right now.');
    }

    rowsContainer.style.opacity = '1';
    scrollToTop();
}

async function createRow(title, endpoint, isLargeRow = false, isTop10 = false) {
    const data = await fetchTMDB(endpoint);
    let itemsToRender = data.results || [];
    if (isTop10) itemsToRender = itemsToRender.slice(0, 10);
    itemsToRender = itemsToRender.filter(item => item.poster_path || item.backdrop_path);
    if (isKidsProfile()) itemsToRender = itemsToRender.filter(isKidsAllowed);

    if (!itemsToRender.length) return 0;
    createLocalRow(title, itemsToRender, isLargeRow, isTop10);
    return 1;
}

function createLocalRow(title, items, isLargeRow = false, isTop10 = false) {
    if (!rowsContainer) return;

    const rowDiv = document.createElement('section');
    rowDiv.classList.add('pl-5', 'md:pl-16', 'relative');
    rowDiv.setAttribute('aria-label', title);

    const rowTitle = document.createElement('h2');
    rowTitle.textContent = title;
    rowTitle.classList.add('text-white/90', 'text-lg', 'md:text-xl', 'font-semibold', 'mb-4', 'tracking-wide');
    rowDiv.appendChild(rowTitle);

    const postersContainerWrapper = document.createElement('div');
    postersContainerWrapper.classList.add('mask-image-right');

    const postersContainer = document.createElement('div');
    postersContainer.classList.add('flex', 'overflow-x-scroll', 'overflow-y-hidden', 'no-scrollbar', 'pb-7', 'pr-16', 'space-x-4', 'md:space-x-6');
    enhanceHorizontalScroller(postersContainer);

    items.forEach((item, index) => {
        const imagePath = isLargeRow ? (item.poster_path || item.backdrop_path) : (item.backdrop_path || item.poster_path);
        if (!imagePath) return;

        const imgWrapper = document.createElement('button');
        imgWrapper.classList.add('movie-card-wrapper', 'flex-shrink-0');
        imgWrapper.setAttribute('aria-label', `View details for ${titleOf(item)}`);

        if (isLargeRow) {
            imgWrapper.classList.add('w-36', 'md:w-56', 'h-52', 'md:h-80');
            if (isTop10) imgWrapper.classList.add('ml-4', 'md:ml-6');
        } else {
            imgWrapper.classList.add('w-56', 'md:w-72', 'h-32', 'md:h-40');
        }

        const imgContainer = document.createElement('div');
        imgContainer.className = 'w-full h-full relative skeleton-bg rounded-[inherit] overflow-hidden';

        const img = document.createElement('img');
        img.classList.add('movie-card', 'skeleton-img');
        img.src = isLargeRow ? mediaImage(item, 'poster') : mediaImage(item, 'backdrop');
        img.alt = titleOf(item);
        img.loading = 'lazy';
        img.decoding = 'async';
        setImageFallback(img);
        img.onload = () => {
            img.classList.add('loaded');
            setTimeout(() => imgContainer.classList.remove('skeleton-bg'), 400);
        };

        if (!isLargeRow) {
            const label = document.createElement('div');
            label.className = 'absolute inset-x-0 bottom-0 z-10 p-3 bg-gradient-to-t from-black/80 to-transparent text-left';
            const labelTitle = document.createElement('h3');
            labelTitle.className = 'text-white text-sm font-semibold truncate';
            labelTitle.textContent = titleOf(item);
            const labelYear = document.createElement('p');
            labelYear.className = 'text-white/60 text-xs mt-0.5';
            labelYear.textContent = yearOf(item);
            label.appendChild(labelTitle);
            label.appendChild(labelYear);
            imgContainer.appendChild(label);
        }

        if (isTop10 && index < 10) {
            const num = document.createElement('span');
            num.className = 'top-10-number';
            num.textContent = index + 1;
            imgWrapper.appendChild(num);
        }

        imgWrapper.addEventListener('click', () => openDetailsSheet(item));
        imgContainer.appendChild(img);
        imgWrapper.appendChild(imgContainer);
        postersContainer.appendChild(imgWrapper);
    });

    postersContainerWrapper.appendChild(postersContainer);
    rowDiv.appendChild(postersContainerWrapper);
    rowsContainer.appendChild(rowDiv);
}

// --- Main Init ---
function initApp() {
    setNavbarState();
    syncProfileUI();
    const initialHash = window.location.hash.replace('#', '') || 'all';
    updateActiveNav(initialHash);

    if (initialHash === 'mylist') showMyList();
    else loadContent(initialHash);
    scrollToTop();
}

function bootFromSavedProfile() {
    const savedProfile = safeGetString('netwatch_active_profile', '');
    if (!savedProfile || !profileConfig[savedProfile]) return;
    const screen = $('profile-screen');
    if (screen) {
        screen.style.opacity = '0';
        screen.style.pointerEvents = 'none';
        screen.classList.add('hidden');
    }
    window.dispatchEvent(new Event('startApp'));
}

bootFromSavedProfile();



