"""
Raw Stream Extractor
Extracts direct .m3u8 stream URLs using a headless browser.

Key insight: Videasy fires window.open() on first click as an ad gate.
Brave browser blocks window.open() and the player works immediately.
We do the same — override window.open to null so one click starts the player.
"""

import time
import json
import argparse
import sys
from typing import Optional
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
from playwright_stealth import Stealth

_stealth = Stealth()

SOURCES = [
    {
        "name": "videasy",
        "movie": "https://player.videasy.net/movie/{tmdb_id}",
        "tv":    "https://player.videasy.net/tv/{tmdb_id}/{season}/{episode}",
    },
    {
        "name": "vidsrc.to",
        "movie": "https://vidsrc.to/embed/movie/{tmdb_id}",
        "tv":    "https://vidsrc.to/embed/tv/{tmdb_id}/{season}/{episode}",
    },
    {
        "name": "2embed",
        "movie": "https://www.2embed.cc/embed/{tmdb_id}",
        "tv":    "https://www.2embed.cc/embedtv/{tmdb_id}&s={season}&e={episode}",
    },
]

IGNORE_KEYWORDS = [
    "google", "doubleclick", "googlesyndication", "googletagmanager",
    "facebook", "twitter", "histats", "cloudflareinsights", "llvpn",
    "disable-devtool", "unpkg.com", "cdnjs.cloudflare", "fonts.gstatic",
    "fonts.googleapis", "beacon.min.js", "tag.min.js",
    "dtscout", "dtscdn", "crwdcntrl", "adsrvr", "onaudience",
    "scorecardresearch", "mrktmtrcs", "rtmark", "mysmartprice",
    "fiasco.exsects", "vortexirked", "theknownfacts", "guarriancha",
    "nexusesenkraal", "lamda.burrospupilarcrumply",
]


def _is_noise(url: str) -> bool:
    return any(k in url.lower() for k in IGNORE_KEYWORDS)


def _is_m3u8(url: str) -> bool:
    return ".m3u8" in url.lower() and not _is_noise(url)


# JS injected before any page script runs.
# Blocks window.open (ad popup) so player starts on first click — same as Brave.
# Also hooks HLS.js, fetch, XHR, video.src to capture the m3u8.
_HOOK_JS = """
(function() {
    if (window.__stream_hooked__) return;
    window.__stream_hooked__ = true;

    // Bypass Videasy's popup gate by pre-setting the localStorage flag.
    // ab.js checks: !localStorage.getItem('shown_at') || now - shown_at > 3600000
    // Setting it to now means the condition is false → no popup → player starts on first click.
    // This is exactly what happens in Brave (popup blocked → player works immediately).
    try { localStorage.setItem('shown_at', String(Date.now())); } catch(e) {}

    // Also block window.open as a second layer
    window.open = function() { return null; };

    const _store = (url) => {
        if (!url || !url.includes('.m3u8')) return;
        window.__m3u8_all__ = window.__m3u8_all__ || [];
        if (!window.__m3u8_all__.includes(url)) window.__m3u8_all__.push(url);
        if (!window.__m3u8_url__) window.__m3u8_url__ = url;
    };

    const _origFetch = window.fetch.bind(window);
    window.fetch = function(...args) {
        const url = typeof args[0] === 'string' ? args[0]
                  : (args[0] && args[0].url) ? args[0].url : '';
        _store(url);
        return _origFetch(...args);
    };

    const _origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        if (typeof url === 'string') _store(url);
        return _origOpen.apply(this, [method, url, ...rest]);
    };

    const _desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (_desc && _desc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
            set: function(v) { _store(v); _desc.set.call(this, v); },
            get: _desc.get, configurable: true,
        });
    }

    const _patch = () => {
        if (window.Hls && window.Hls.prototype && !window.__hls_patched__) {
            window.__hls_patched__ = true;
            const _orig = window.Hls.prototype.loadSource;
            if (_orig) {
                window.Hls.prototype.loadSource = function(url) {
                    _store(url);
                    return _orig.call(this, url);
                };
            }
        }
    };
    const _iv = setInterval(() => { _patch(); if (window.__hls_patched__) clearInterval(_iv); }, 50);
    setTimeout(() => clearInterval(_iv), 30000);
})();
"""


def _extract_videasy(
    tmdb_id: str,
    media_type: str = "movie",
    season: int = 1,
    episode: int = 1,
    timeout_sec: int = 20,
    headless: bool = True,
) -> Optional[dict]:

    key = "movie" if media_type == "movie" else "tv"
    embed_url = SOURCES[0][key].format(tmdb_id=tmdb_id, season=season, episode=episode)
    found = {"url": None, "referer": embed_url, "all": []}

    print(f"  [browser] videasy → {embed_url}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=headless,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--autoplay-policy=no-user-gesture-required",
                # Don't allow popups at browser level either
                "--disable-popup-blocking=false",
            ],
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 720},
            bypass_csp=True,
            ignore_https_errors=True,
        )

        context.add_init_script(_HOOK_JS)

        def on_request(req):
            url = req.url
            if not _is_m3u8(url):
                return
            if url not in found["all"]:
                found["all"].append(url)
                print(f"  [net m3u8] {url[:70]}...")
            if not found["url"]:
                found["url"] = url
                found["referer"] = req.headers.get("referer", embed_url)

        context.on("request", on_request)

        page = context.new_page()
        _stealth.apply_stealth_sync(page)

        try:
            page.goto(embed_url, wait_until="domcontentloaded",
                      timeout=timeout_sec * 1000)
        except PWTimeout:
            pass
        except Exception as e:
            print(f"  [!] nav error: {e}")
            context.close(); browser.close()
            return None

        start = time.time()
        # Click positions to try — play button isn't always at dead center
        CLICK_POSITIONS = [(640, 360), (512, 288), (640, 360), (512, 288)]
        click_idx = 0
        last_click_time = 0
        deadline = start + timeout_sec

        while time.time() < deadline:
            if found["url"]:
                break

            elapsed = time.time() - start
            now = time.time()

            # Click every 2s at alternating positions until stream fires
            if elapsed > 3 and click_idx < len(CLICK_POSITIONS) and (now - last_click_time) >= 2:
                x, y = CLICK_POSITIONS[click_idx]
                try:
                    page.mouse.click(x, y)
                    last_click_time = now
                    click_idx += 1
                    print(f"  [browser] click {click_idx} ({x},{y}) at {elapsed:.1f}s")
                except Exception:
                    pass

            # Poll JS hook in all frames
            if not found["url"]:
                try:
                    for frame in page.frames:
                        try:
                            val = frame.evaluate("window.__m3u8_url__ || null")
                            if val and _is_m3u8(val):
                                found["url"] = val
                                print(f"  [✓] JS hook: {val[:80]}...")
                                break
                        except: pass
                except: pass

            time.sleep(0.25)

        # ── Collect all language streams by clicking server buttons ──────────
        all_streams = {}
        if found["url"]:
            all_streams["default"] = found["url"]
            try:
                # Open the Servers tab
                page.evaluate("""() => {
                    const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
                    const t = tabs.find(b => b.textContent.trim() === 'Servers');
                    if (t) { t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); t.dispatchEvent(new MouseEvent('click',{bubbles:true})); }
                }""")
                time.sleep(1.5)

                # Get server names from the active panel
                servers = page.evaluate("""() => {
                    const panel = document.querySelector('[role="tabpanel"][data-state="active"]');
                    if (!panel) return [];
                    return Array.from(panel.querySelectorAll('button')).map(b => b.innerText.trim()).filter(t => t.length > 0 && t.length < 80);
                }""")

                if servers:
                    print(f"  [servers] found {len(servers)}: {[s.split(chr(10))[0] for s in servers]}")
                    for server_name in servers:
                        prev_count = len(found["all"])
                        page.evaluate("""(name) => {
                            const panel = document.querySelector('[role="tabpanel"][data-state="active"]');
                            if (!panel) return;
                            const btn = Array.from(panel.querySelectorAll('button')).find(b => b.innerText.trim() === name);
                            if (btn) { btn.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); btn.dispatchEvent(new MouseEvent('click',{bubbles:true})); }
                        }""", server_name)
                        time.sleep(2)
                        if len(found["all"]) > prev_count:
                            new_url = found["all"][-1]
                            # Use first line of server name as key
                            key = server_name.split('\n')[0].strip()
                            all_streams[key] = new_url
                            print(f"  [server] {key} → {new_url[:60]}...")
            except Exception as e:
                print(f"  [servers] error: {e}")

        context.close()
        browser.close()

    if found["url"]:
        return {
            "m3u8": found["url"],
            "source": "videasy",
            "embed_url": embed_url,
            "referer": found["referer"],
            "all_streams": all_streams,  # {server_name: m3u8_url}
        }
    print("  [✗] no stream from videasy")
    return None


def _extract_generic(
    source: dict,
    tmdb_id: str,
    media_type: str = "movie",
    season: int = 1,
    episode: int = 1,
    timeout_sec: int = 35,
    headless: bool = True,
) -> Optional[dict]:

    key = "movie" if media_type == "movie" else "tv"
    embed_url = source[key].format(tmdb_id=tmdb_id, season=season, episode=episode)
    found = {"url": None, "referer": embed_url}

    print(f"  [browser] {source['name']} → {embed_url}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=headless,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-web-security",
                "--disable-features=IsolateOrigins,site-per-process",
                "--autoplay-policy=no-user-gesture-required",
                "--disable-popup-blocking",
            ],
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 720},
            bypass_csp=True,
            ignore_https_errors=True,
        )

        def on_request(req):
            if not found["url"] and _is_m3u8(req.url):
                found["url"] = req.url
                found["referer"] = req.headers.get("referer", embed_url)
                print(f"  [✓] {req.url[:90]}...")

        context.on("request", on_request)

        page = context.new_page()
        _stealth.apply_stealth_sync(page)

        try:
            page.goto(embed_url, wait_until="domcontentloaded",
                      timeout=timeout_sec * 1000)
        except PWTimeout:
            pass
        except Exception as e:
            print(f"  [!] nav error: {e}")
            context.close(); browser.close()
            return None

        start = time.time()
        click_times = [4, 9, 15, 22]
        next_click = 0
        deadline = start + timeout_sec

        while time.time() < deadline:
            if found["url"]:
                break
            elapsed = time.time() - start
            if next_click < len(click_times) and elapsed >= click_times[next_click]:
                try:
                    page.mouse.click(640, 360)
                    print(f"  [browser] click at {elapsed:.1f}s")
                except: pass
                next_click += 1
            time.sleep(0.25)

        context.close()
        browser.close()

    if found["url"]:
        return {"m3u8": found["url"], "source": source["name"],
                "embed_url": embed_url, "referer": found["referer"]}
    print(f"  [✗] no stream from {source['name']}")
    return None


def extract_stream(
    tmdb_id: str,
    media_type: str = "movie",
    season: int = 1,
    episode: int = 1,
    sources: list = None,
    headless: bool = True,
    timeout_sec: int = 20,
) -> Optional[dict]:
    """Try each source in order, return first working m3u8."""
    for src in (sources or SOURCES):
        if src["name"] == "videasy":
            result = _extract_videasy(tmdb_id, media_type, season, episode,
                                      timeout_sec=timeout_sec, headless=headless)
        else:
            result = _extract_generic(src, tmdb_id, media_type, season, episode,
                                      timeout_sec=timeout_sec, headless=headless)
        if result:
            return result
    return None


def extract_stream_from_url(player_url: str, headless: bool = True, timeout_sec: int = 20) -> Optional[dict]:
    """
    Extract m3u8 directly from a player URL (e.g. hdstream4u.com, hubstream.art).
    Used for HDHub4u streams which provide direct player URLs.
    """
    print(f"  [browser] direct player → {player_url}")

    found = {"url": None, "referer": player_url, "all": []}

    AD_DOMAINS = [
        "googlesyndication", "doubleclick", "googletagmanager",
        "facebook", "twitter", "histats", "cloudflareinsights",
        "scorecardresearch", "dtscout", "crwdcntrl", "adsrvr",
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=headless,
            args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required",
                  "--disable-popup-blocking=false"],
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 720},
            bypass_csp=True, ignore_https_errors=True,
        )
        context.add_init_script(_HOOK_JS)

        # Block ads
        context.route("**/*", lambda route: route.abort()
            if any(x in route.request.url for x in AD_DOMAINS)
            else route.continue_()
        )

        def on_request(req):
            url = req.url
            if not _is_m3u8(url):
                return
            if url not in found["all"]:
                found["all"].append(url)
                print(f"  [net m3u8] {url[:70]}...")
            if not found["url"]:
                found["url"] = url
                found["referer"] = req.headers.get("referer", player_url)

        context.on("request", on_request)
        page = context.new_page()
        _stealth.apply_stealth_sync(page)

        try:
            page.goto(player_url, wait_until="domcontentloaded", timeout=timeout_sec * 1000)
        except Exception as e:
            print(f"  [!] nav error: {e}")
            context.close(); browser.close()
            return None

        # Wait up to timeout for m3u8 (hdstream4u fires immediately on load)
        start = time.time()
        CLICK_POSITIONS = [(640, 360), (512, 288)]
        click_idx = 0
        last_click = 0
        deadline = start + timeout_sec

        while time.time() < deadline:
            if found["url"]:
                break
            elapsed = time.time() - start
            now = time.time()

            # Click after 2s if no m3u8 yet
            if elapsed > 2 and click_idx < len(CLICK_POSITIONS) and (now - last_click) >= 2:
                x, y = CLICK_POSITIONS[click_idx]
                try: page.mouse.click(x, y)
                except: pass
                last_click = now
                click_idx += 1

            # Poll JS hook
            if not found["url"]:
                try:
                    val = page.evaluate("window.__m3u8_url__ || null")
                    if val and _is_m3u8(val):
                        # Make absolute if relative
                        if val.startswith("/"):
                            from urllib.parse import urlparse
                            parsed = urlparse(player_url)
                            val = f"{parsed.scheme}://{parsed.netloc}{val}"
                        found["url"] = val
                        found["referer"] = player_url
                        print(f"  [✓] JS: {val[:80]}...")
                except: pass

            time.sleep(0.25)

        context.close()
        browser.close()

    if found["url"]:
        return {
            "m3u8": found["url"],
            "source": "hdstream4u",
            "embed_url": player_url,
            "referer": player_url,
        }
    print(f"  [✗] no stream from {player_url}")
    return None


def _extract_videasy_default(
    tmdb_id: str,
    media_type: str = "movie",
    season: int = 1,
    episode: int = 1,
) -> Optional[dict]:
    """
    Fast extraction — returns only the default stream (~6s).
    Used for Phase 1 of lazy loading.
    """
    return _extract_videasy(tmdb_id, media_type, season, episode,
                            timeout_sec=20, headless=True)


def _extract_videasy_all_servers(
    tmdb_id: str,
    media_type: str = "movie",
    season: int = 1,
    episode: int = 1,
) -> dict:
    """
    Background extraction — clicks through all Videasy servers and
    returns {server_name: m3u8_url} for each one that yields a stream.
    Used for Phase 2 of lazy loading.
    """
    key = "movie" if media_type == "movie" else "tv"
    embed_url = SOURCES[0][key].format(tmdb_id=tmdb_id, season=season, episode=episode)
    servers_found = {}
    net_m3u8 = []

    print(f"  [bg] extracting all servers for TMDB {tmdb_id}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 720},
            bypass_csp=True, ignore_https_errors=True,
        )
        context.add_init_script(_HOOK_JS)

        def on_req(req):
            if _is_m3u8(req.url) and req.url not in net_m3u8:
                net_m3u8.append(req.url)

        context.on("request", on_req)
        page = context.new_page()
        _stealth.apply_stealth_sync(page)

        try:
            page.goto(embed_url, wait_until="domcontentloaded", timeout=20000)
        except Exception:
            context.close(); browser.close()
            return {}

        # Start player with multi-click
        CLICK_POSITIONS = [(640, 360), (512, 288), (640, 360)]
        click_idx = 0
        last_click = 0
        start = time.time()
        deadline = start + 20

        while time.time() < deadline:
            elapsed = time.time() - start
            now = time.time()
            if elapsed > 3 and click_idx < len(CLICK_POSITIONS) and (now - last_click) >= 2:
                x, y = CLICK_POSITIONS[click_idx]
                try: page.mouse.click(x, y)
                except: pass
                last_click = now
                click_idx += 1
            if net_m3u8: break
            time.sleep(0.3)

        if not net_m3u8:
            context.close(); browser.close()
            return {}

        servers_found["Original audio"] = net_m3u8[-1]
        time.sleep(2)

        # Open Servers tab and click each server
        try:
            page.evaluate("""() => {
                const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
                const t = tabs.find(b => b.textContent.trim() === 'Servers');
                if (t) { t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); t.dispatchEvent(new MouseEvent('click',{bubbles:true})); }
            }""")
            time.sleep(1.5)

            server_names = page.evaluate("""() => {
                const panel = document.querySelector('[role="tabpanel"][data-state="active"]');
                if (!panel) return [];
                return Array.from(panel.querySelectorAll('button')).map(b => b.innerText.trim()).filter(t => t.length > 0 && t.length < 80);
            }""")

            print(f"  [bg] servers: {[s.split(chr(10))[0] for s in server_names]}")

            for server_name in server_names:
                prev = len(net_m3u8)
                page.evaluate("""(name) => {
                    const panel = document.querySelector('[role="tabpanel"][data-state="active"]');
                    if (!panel) return;
                    const btn = Array.from(panel.querySelectorAll('button')).find(b => b.innerText.trim() === name);
                    if (btn) { btn.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); btn.dispatchEvent(new MouseEvent('click',{bubbles:true})); }
                }""", server_name)
                time.sleep(2.5)
                if len(net_m3u8) > prev:
                    # Parse label: use language description if available, else server name
                    # Format: "ServerName\n\nLanguage description" e.g. "Fade\n\nHindi audio"
                    parts = server_name.split('\n')
                    server_short = parts[0].strip()
                    lang_desc = parts[-1].strip() if len(parts) > 1 else ""
                    # Build display label: prefer language description
                    if lang_desc and lang_desc.lower() not in ("", server_short.lower()):
                        label = lang_desc  # e.g. "Hindi audio", "German audio"
                    else:
                        label = server_short  # fallback to server name
                    servers_found[label] = net_m3u8[-1]
                    print(f"  [bg] {label} ({server_short}) → {net_m3u8[-1][:50]}...")

        except Exception as e:
            print(f"  [bg] server extraction error: {e}")

        context.close()
        browser.close()

    print(f"  [bg] done — {len(servers_found)} servers")
    return servers_found


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract raw m3u8 stream URL via headless browser")
    parser.add_argument("tmdb_id")
    parser.add_argument("--type", choices=["movie", "tv"], default="movie", dest="media_type")
    parser.add_argument("--season", type=int, default=1)
    parser.add_argument("--episode", type=int, default=1)
    parser.add_argument("--source", help="videasy | vidsrc.to | 2embed")
    parser.add_argument("--show-browser", action="store_true")
    parser.add_argument("--timeout", type=int, default=20)
    args = parser.parse_args()

    src_filter = None
    if args.source:
        src_filter = [s for s in SOURCES if s["name"] == args.source]
        if not src_filter:
            print(f"Unknown source. Options: {[s['name'] for s in SOURCES]}")
            sys.exit(1)

    print(f"\n[*] Extracting  TMDB={args.tmdb_id}  type={args.media_type}")
    result = extract_stream(
        tmdb_id=args.tmdb_id,
        media_type=args.media_type,
        season=args.season,
        episode=args.episode,
        sources=src_filter,
        headless=not args.show_browser,
        timeout_sec=args.timeout,
    )

    if result:
        print(f"\n{'='*60}")
        print(f"  Source  : {result['source']}")
        print(f"  M3U8    : {result['m3u8']}")
        print(f"  Referer : {result['referer']}")
        print(f"{'='*60}")
        print(f'\nVLC:  vlc "{result["m3u8"]}" --http-referrer="{result["referer"]}"')
        print(f'MPV:  mpv --referrer="{result["referer"]}" "{result["m3u8"]}"')
        print()
        print(json.dumps(result, indent=2))
    else:
        print("\n[!] No stream found.")
        sys.exit(1)
