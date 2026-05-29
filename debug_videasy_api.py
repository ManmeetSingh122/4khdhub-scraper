"""Find the master playlist URL from Videasy."""
import time, json
from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth

EMBED_URL = "https://player.videasy.net/movie/1380291"
_stealth = Stealth()

all_m3u8 = []

HOOK = """
(function() {
    if (window.__hooked__) return;
    window.__hooked__ = true;
    const _f = window.fetch.bind(window);
    window.fetch = function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]&&args[0].url)||'';
        if (url.includes('.m3u8') || url.includes('master') || url.includes('playlist')) {
            window.__all_m3u8__ = window.__all_m3u8__ || [];
            window.__all_m3u8__.push(url);
        }
        return _f(...args);
    };
    const _xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, url, ...r) {
        if (typeof url === 'string' && (url.includes('.m3u8') || url.includes('master'))) {
            window.__all_m3u8__ = window.__all_m3u8__ || [];
            window.__all_m3u8__.push(url);
        }
        return _xo.apply(this, [m, url, ...r]);
    };
    const iv = setInterval(() => {
        if (window.Hls && window.Hls.prototype && !window.__hlsp__) {
            window.__hlsp__ = true;
            const orig = window.Hls.prototype.loadSource;
            if (orig) {
                window.Hls.prototype.loadSource = function(url) {
                    window.__all_m3u8__ = window.__all_m3u8__ || [];
                    window.__all_m3u8__.push('HLS.loadSource: ' + url);
                    return orig.call(this, url);
                };
            }
        }
    }, 50);
    setTimeout(() => clearInterval(iv), 60000);
})();
"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox","--autoplay-policy=no-user-gesture-required","--disable-popup-blocking"])
    ctx = browser.new_context(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36", viewport={"width":1280,"height":720}, bypass_csp=True, ignore_https_errors=True)
    ctx.add_init_script(HOOK)

    def on_req(req):
        url = req.url
        if ".m3u8" in url.lower() and not any(x in url for x in ["google","cloudflare"]):
            all_m3u8.append(("NET", url))
            print(f"  [NET] {url[:100]}")

    ctx.on("request", on_req)
    popups = []
    popup_close = {}

    def on_page(pg):
        pg.on("request", on_req)
        popups.append(pg)

    page = ctx.new_page()
    _stealth.apply_stealth_sync(page)
    ctx.on("page", on_page)

    page.goto(EMBED_URL, wait_until="domcontentloaded", timeout=30000)
    print("Page loaded\n")

    start = time.time()
    clicked = False
    second_click = False
    deadline = start + 30

    while time.time() < deadline:
        elapsed = time.time() - start
        for pg in list(popups):
            if pg not in popup_close:
                popup_close[pg] = time.time() + 2.0
        for pg, close_at in list(popup_close.items()):
            if time.time() >= close_at:
                try: pg.close()
                except: pass
                del popup_close[pg]
                if pg in popups: popups.remove(pg)
                if not second_click:
                    second_click = True
                    time.sleep(0.5)
                    try:
                        page.mouse.click(640, 360)
                        print(f"  [click 2 at {elapsed:.1f}s]")
                    except: pass
        if not clicked and elapsed > 3:
            try:
                page.mouse.click(640, 360)
                clicked = True
                print(f"  [click 1 at {elapsed:.1f}s]")
            except: pass
        if len(all_m3u8) >= 2:
            break
        time.sleep(0.3)

    # Check JS
    try:
        js_urls = page.evaluate("JSON.stringify(window.__all_m3u8__ || [])")
        js_list = json.loads(js_urls)
        print(f"\n[JS hook] {len(js_list)} URLs:")
        for u in js_list:
            print(f"  {u[:120]}")
    except Exception as e:
        print(f"JS check error: {e}")

    print(f"\n[Network] {len(all_m3u8)} m3u8 URLs:")
    for src, url in all_m3u8:
        print(f"  [{src}] {url[:120]}")

    ctx.close()
    browser.close()
