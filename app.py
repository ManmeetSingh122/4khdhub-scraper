"""
4KHDHub Automation - Web UI
Run: python app.py
Then open http://localhost:5000
"""

import json
import os
import hashlib
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlencode, urlparse, urlunparse, parse_qsl
from flask import Flask, render_template, request, jsonify, send_file, send_from_directory
from scraper import scrape, export_json, search_4khdhub
from scraper_hdhub4u import scrape_hdhub4u, search_hdhub4u, _is_hdhub4u_url

PLAYER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), 'Player'))
STREAMING_APP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), 'streaming-app'))
TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "").strip()
TMDB_BASE_URL = "https://api.themoviedb.org/3"

app = Flask(__name__)

DB_FILE = "library.json"
db_lock = threading.Lock()
# Cache extracted streams so we don't re-run the browser every time
stream_cache = {}   # tmdb_id -> {m3u8, source, referer, expires}
direct_cache = {}   # source download url -> resolved direct media result
playback_jobs = {}
playback_lock = threading.Lock()


# ── Shutdown hook ─────────────────────────────────────────────────────────────
import atexit
@atexit.register
def _shutdown_resolver_pool():
    try:
        from direct_resolver import shutdown_pool
        shutdown_pool()
    except Exception:
        pass


# ── Thread-isolated resolver ──────────────────────────────────────────────────
# Playwright sync API crashes if called inside an asyncio event loop.
# Running it in a dedicated ThreadPoolExecutor thread guarantees a clean
# non-async context regardless of what Flask or other libs are doing.
import concurrent.futures as _futures
_resolver_executor = _futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="resolver")


def _run_resolver(url, timeout_sec=90, headless=True):
    """
    Resolve a download page URL to a direct media URL.
    All resolvers are pure HTTP — no browser, no Playwright.
    """
    from direct_resolver import (
        resolve_direct_link,
        _fast_resolve_hubcloud,
        _fast_resolve_hubdrive,
        _fast_resolve_hblinks,
        _fast_resolve_gadgetsweb,
    )

    if "hubcloud" in url:
        result = _fast_resolve_hubcloud(url)
        if result and result.get("url"):
            return result

    if "hubdrive" in url:
        result = _fast_resolve_hubdrive(url)
        if result and result.get("url"):
            return result

    if "hblinks" in url:
        result = _fast_resolve_hblinks(url)
        if result and result.get("url"):
            return result

    if "gadgetsweb" in url:
        result = _fast_resolve_gadgetsweb(url)
        if result and result.get("url"):
            return result

    return {"error": f"No resolver available for: {url[:80]}"}


@app.after_request
def add_local_api_cors(response):
    if request.path.startswith("/api/"):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Range"
        response.headers["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges"
    return response


# ── Serve Player files ───────────────────────────────────────────────────────

@app.route("/player")
@app.route("/player/")
def player_index():
    return send_from_directory(PLAYER_DIR, "index.html")

@app.route("/player/<path:filename>")
def player_static(filename):
    return send_from_directory(PLAYER_DIR, filename)


@app.route("/app/")
def streaming_app_index():
    return send_from_directory(STREAMING_APP_DIR, "index.html")


@app.route("/app/<path:filename>")
def streaming_app_static(filename):
    return send_from_directory(STREAMING_APP_DIR, filename)


# ── Library helpers ──────────────────────────────────────────────────────────

def load_library():
    if os.path.exists(DB_FILE):
        with open(DB_FILE, encoding="utf-8") as f:
            return json.load(f)
    return []


def save_library(data):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def library_add(entry):
    """Add or update an entry in the library (keyed by URL)."""
    with db_lock:
        lib = load_library()
        existing = next((i for i, e in enumerate(lib) if e["url"] == entry["url"]), None)
        if existing is not None:
            lib[existing] = entry
        else:
            lib.append(entry)
        save_library(lib)


def library_remove(url):
    with db_lock:
        lib = load_library()
        lib = [e for e in lib if e["url"] != url]
        save_library(lib)


# ── Routes ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/library", methods=["GET"])
def api_library():
    return jsonify(load_library())


@app.route("/api/add", methods=["POST"])
def api_add():
    """Scrape a URL and add it to the library. Auto-detects 4khdhub vs hdhub4u."""
    body = request.get_json(force=True)
    url = (body.get("url") or "").strip()
    season = int(body.get("season") or 1)
    episode = int(body.get("episode") or 1)

    if not url:
        return jsonify({"error": "No URL provided"}), 400

    def do_scrape():
        if _is_hdhub4u_url(url):
            data = scrape_hdhub4u(url)
        else:
            data = scrape(url, season=season, episode=episode)
        if "error" not in data:
            library_add(data)

    t = threading.Thread(target=do_scrape, daemon=True)
    t.start()
    t.join(timeout=30)

    with db_lock:
        lib = load_library()
        entry = next((e for e in lib if e["url"] == url), None)

    if entry:
        return jsonify(entry)
    return jsonify({"error": "Scrape failed or timed out"}), 500


@app.route("/api/add_bulk", methods=["POST"])
def api_add_bulk():
    """Scrape multiple URLs (newline-separated) in background."""
    body = request.get_json(force=True)
    raw = (body.get("urls") or "").strip()
    urls = [u.strip() for u in raw.splitlines() if u.strip() and not u.startswith("#")]

    if not urls:
        return jsonify({"error": "No URLs provided"}), 400

    results = {"queued": len(urls), "done": 0, "errors": []}

    def worker():
        for i, url in enumerate(urls):
            if i > 0:
                time.sleep(1.5)
            # Auto-detect site
            if _is_hdhub4u_url(url):
                data = scrape_hdhub4u(url)
            else:
                data = scrape(url)
            if "error" in data:
                results["errors"].append(url)
            else:
                library_add(data)
            results["done"] += 1

    t = threading.Thread(target=worker, daemon=True)
    t.start()

    return jsonify({"message": f"Queued {len(urls)} URLs for scraping", "job_id": id(t)})


@app.route("/api/remove", methods=["POST"])
def api_remove():
    body = request.get_json(force=True)
    url = (body.get("url") or "").strip()
    if not url:
        return jsonify({"error": "No URL"}), 400
    library_remove(url)
    return jsonify({"ok": True})


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    """Re-scrape an existing entry."""
    body = request.get_json(force=True)
    url = (body.get("url") or "").strip()
    if not url:
        return jsonify({"error": "No URL"}), 400
    if _is_hdhub4u_url(url):
        data = scrape_hdhub4u(url)
    else:
        data = scrape(url)
    if "error" in data:
        return jsonify(data), 500
    library_add(data)
    return jsonify(data)


@app.route("/api/export/m3u")
def api_export_m3u():
    """Download the full library as an M3U playlist."""
    lib = load_library()
    path = "export.m3u"
    export_m3u(lib, path)
    return send_file(path, as_attachment=True, download_name="4khdhub_streams.m3u")


@app.route("/api/export/json")
def api_export_json():
    """Download the full library as JSON."""
    lib = load_library()
    path = "export.json"
    export_json(lib, path)
    return send_file(path, as_attachment=True, download_name="4khdhub_library.json")


@app.route("/api/status")
def api_status():
    lib = load_library()
    return jsonify({
        "total": len(lib),
        "movies": sum(1 for e in lib if e.get("type") == "movie"),
        "series": sum(1 for e in lib if e.get("type") == "tv"),
    })


@app.route("/api/tmdb")
def api_tmdb():
    """
    Backend TMDB proxy. The browser sends only the API path; this server adds
    the API key so it is not exposed in frontend JavaScript.
    """
    if not TMDB_API_KEY:
        return jsonify({"error": "TMDB_API_KEY is not configured on the backend", "results": []}), 503

    endpoint = (request.args.get("endpoint") or "").strip()
    if not endpoint:
        return jsonify({"error": "endpoint required", "results": []}), 400
    if "://" in endpoint or endpoint.startswith("//"):
        return jsonify({"error": "absolute TMDB URLs are not allowed", "results": []}), 400

    endpoint = "/" + endpoint.lstrip("/")
    parsed = urlparse(endpoint)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["api_key"] = TMDB_API_KEY
    if "language" not in query:
        query["language"] = "en-US"
    tmdb_path = urlunparse(("", "", parsed.path, "", urlencode(query), ""))
    tmdb_url = f"{TMDB_BASE_URL}{tmdb_path}"

    try:
        req = urllib.request.Request(
            tmdb_url,
            headers={
                "Accept": "application/json",
                "User-Agent": "Netwatch/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
            return jsonify(payload), resp.status
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8", errors="replace") or "{}")
        except Exception:
            payload = {"error": str(exc), "results": []}
        return jsonify(payload), exc.code
    except Exception as exc:
        return jsonify({"error": str(exc), "results": []}), 502


@app.route("/api/fetch_stream")
def api_fetch_stream():
    """
    CORS proxy endpoint — fetches the m3u8 or .ts segment from the CDN
    and returns it with CORS headers so the browser player can load it.
    This solves the cross-origin restriction on easy.speedsterwave.app
    """
    import urllib.request, urllib.parse, re as _re

    target_url = request.args.get("url", "").strip()
    referer    = request.args.get("referer", "").strip()

    if not target_url:
        return "Missing url param", 400

    # Only allow fetching from known stream CDNs
    allowed = ["speedsterwave.app", "cloudnestra.com", "vsembed.ru",
               "easy.", "stream.", "cdn.", "hls.", "media.",
               "tylerfisher55.workers.dev", "midwesteagle.com",
               "workers.dev", "yoru.", "broad.", "mute.",
               "cloudflare", "r2.dev", "pages.dev",
               "hdstream4u.com", "hubstream.art"]
    if not any(a in target_url for a in allowed):
        return "Forbidden", 403

    try:
        req = urllib.request.Request(target_url)
        req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        if referer:
            req.add_header("Referer", referer)
            try:
                req.add_header("Origin", urllib.parse.urlparse(referer).scheme + "://" + urllib.parse.urlparse(referer).netloc)
            except Exception:
                pass

        with urllib.request.urlopen(req, timeout=15) as resp:
            content_type = resp.headers.get("Content-Type", "application/octet-stream")
            data = resp.read()

            # If m3u8, rewrite relative segment URLs to absolute
            if "mpegurl" in content_type or "m3u8" in content_type or target_url.endswith(".m3u8"):
                base = target_url.rsplit("/", 1)[0] + "/"
                text = data.decode("utf-8", errors="replace")
                lines = []
                for line in text.splitlines():
                    stripped = line.strip()
                    if stripped and not stripped.startswith("#"):
                        if not stripped.startswith("http"):
                            # Make absolute — handle both relative and root-relative paths
                            if stripped.startswith("/"):
                                parsed_base = urllib.parse.urlparse(target_url)
                                abs_url = f"{parsed_base.scheme}://{parsed_base.netloc}{stripped}"
                            else:
                                abs_url = base + stripped
                        else:
                            abs_url = stripped
                        # Route segment through this same proxy endpoint
                        proxied = "/api/fetch_stream?url=" + urllib.parse.quote(abs_url, safe="")
                        if referer:
                            proxied += "&referer=" + urllib.parse.quote(referer, safe="")
                        lines.append(proxied)
                    else:
                        lines.append(line)
                data = "\n".join(lines).encode("utf-8")
                content_type = "application/vnd.apple.mpegurl"

            from flask import Response
            r = Response(data, status=200, content_type=content_type)
            # Force video content-type for disguised segments (.html/.css/.js that are actually .ts)
            if not any(x in content_type for x in ["mpegurl", "m3u8", "video", "octet"]):
                if target_url.endswith((".html", ".css", ".js", ".htm")):
                    r = Response(data, status=200, content_type="video/MP2T")
            r.headers["Access-Control-Allow-Origin"] = "*"
            r.headers["Access-Control-Allow-Headers"] = "Range, Content-Type"
            r.headers["Access-Control-Expose-Headers"] = "Content-Length, Content-Range"
            return r

    except Exception as e:
        return str(e), 502


@app.route("/api/open_vlc", methods=["POST"])
def api_open_vlc():
    """Launch VLC directly on the server machine with the m3u8 URL."""
    import subprocess, shutil
    body = request.get_json(force=True)
    m3u8    = (body.get("m3u8") or "").strip()
    referer = (body.get("referer") or "").strip()

    if not m3u8:
        return jsonify({"error": "m3u8 required"}), 400

    vlc_paths = [
        r"C:\Program Files\VideoLAN\VLC\vlc.exe",
        r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
        shutil.which("vlc") or "",
    ]
    vlc_exe = next((p for p in vlc_paths if p and os.path.exists(p)), None)

    if not vlc_exe:
        return jsonify({"error": "VLC not found. Use 'Copy URL only' and open via Media → Open Network Stream."}), 404

    cmd = [vlc_exe, m3u8, "--play-and-exit", "--started-from-file"]
    if referer:
        cmd += ["--http-referrer", referer]

    try:
        subprocess.Popen(cmd)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _safe_job_id(value):
    return hashlib.sha1(value.encode("utf-8", errors="ignore")).hexdigest()[:18]


def _set_playback_job(job_id, **updates):
    with playback_lock:
        job = playback_jobs.setdefault(job_id, {})
        job.update(updates)
        job["updated_at"] = time.time()
        return job.copy()


LOOKUP_STOPWORDS = {
    "and", "or", "the", "a", "an", "in", "on", "of", "to", "for",
    "movie", "movies", "film", "full", "download", "watch", "online",
}


def _lookup_text(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def _lookup_tokens(value):
    return [
        token for token in _lookup_text(value).split()
        if token and token not in LOOKUP_STOPWORDS
    ]


def _lookup_year(*values):
    text = " ".join(str(value or "") for value in values)
    match = re.search(r"\b(19|20)\d{2}\b", text)
    return match.group(0) if match else ""


def _title_match_score(target, candidate, year=""):
    target_norm = _lookup_text(target)
    candidate_norm = _lookup_text(candidate)
    if not target_norm or not candidate_norm:
        return 0

    score = 0
    if target_norm == candidate_norm:
        score += 140
    elif target_norm in candidate_norm or candidate_norm in target_norm:
        score += 95

    target_tokens = _lookup_tokens(target)
    candidate_tokens = set(_lookup_tokens(candidate))
    if target_tokens and candidate_tokens:
        matched = [token for token in target_tokens if token in candidate_tokens]
        score += int((len(matched) / max(1, len(target_tokens))) * 100)
        if len(matched) == len(target_tokens):
            score += 35

        # Penalise extra *title* words in the candidate that aren't in the target.
        # Only look at the candidate's title portion — strip everything after the
        # first year or quality marker so we don't penalise "1080p", "WEB-DL" etc.
        # e.g. "Dhurandhar: The Revenge (2026) WEB-DL" -> title part = "Dhurandhar The Revenge"
        candidate_title_part = re.split(
            r'\b(19|20)\d{2}\b|\b(1080p|720p|480p|4k|2160p|web|dl|bluray|webrip|hevc|x264|x265|avc|hdr|remux|hindi|english|tamil|telugu|punjabi|dual|multi)\b',
            candidate, flags=re.IGNORECASE
        )[0]
        candidate_title_tokens = set(_lookup_tokens(candidate_title_part))
        extra_title_tokens = [
            t for t in candidate_title_tokens
            if t not in set(target_tokens)
            and len(t) > 2
            and not t.isdigit()
        ]
        if extra_title_tokens:
            score -= len(extra_title_tokens) * 25

    if year and year in candidate_norm:
        score += 25

    return score


def _entry_match_score(entry, title="", year=""):
    text_parts = [
        entry.get("title", ""),
        entry.get("url", ""),
        json.dumps(entry.get("metadata") or {}, ensure_ascii=False),
    ]
    return _title_match_score(title, " ".join(text_parts), year)


def _season_matches_text(text, season=None):
    if not season:
        return True
    text = (text or "").lower()
    wanted = int(season)
    season_numbers = set()
    for pattern in (r"season\s*0*(\d+)", r"\bs0*(\d+)\b"):
        for match in re.finditer(pattern, text, re.IGNORECASE):
            try:
                season_numbers.add(int(match.group(1)))
            except ValueError:
                pass
    return not season_numbers or wanted in season_numbers


def _entry_matches_season(entry, season=None):
    if not season:
        return True
    text = " ".join([
        entry.get("title", ""),
        entry.get("url", ""),
        json.dumps(entry.get("metadata") or {}, ensure_ascii=False),
    ])
    return _season_matches_text(text, season)


def _find_library_entry(tmdb_id="", title="", year="", media_type="movie", season=None):
    lib = load_library()
    if tmdb_id:
        matches = [entry for entry in lib if str(entry.get("tmdb_id", "")) == str(tmdb_id)]
        if media_type:
            typed = [entry for entry in matches if not entry.get("type") or entry.get("type") == media_type]
            matches = typed or matches
        if media_type == "tv":
            seasoned = [entry for entry in matches if _entry_matches_season(entry, season)]
            matches = seasoned or matches
        if matches:
            return matches[0]
    if title:
        year = year or _lookup_year(title)
        scored = []
        for entry in lib:
            if media_type and entry.get("type") and entry.get("type") != media_type:
                continue
            if media_type == "tv" and not _entry_matches_season(entry, season):
                continue
            # Year hard filter: if we know the year and the entry has a different
            # year, skip it — prevents "Dhurandhar: The Revenge (2026)" matching
            # a search for "Dhurandhar (2025)".
            if year and media_type != "tv":
                entry_year = _lookup_year(
                    entry.get("title", ""),
                    entry.get("url", ""),
                )
                if entry_year and entry_year != year:
                    continue
            scored.append((_entry_match_score(entry, title, year), entry))
        scored.sort(key=lambda item: item[0], reverse=True)
        if scored and scored[0][0] >= 125:
            return scored[0][1]
    return None


def _source_search_queries(title, year="", media_type="movie", season=None):
    title = (title or "").strip()
    if not title:
        return []

    variants = [
        title,
        title.replace(":", " "),
        re.sub(r"\s*\([^)]*\)", "", title).strip(),
    ]
    if ":" in title:
        variants.append(title.split(":", 1)[0].strip())
    if media_type == "tv" and season:
        variants.insert(0, f"{title} Season {int(season)}")

    queries = []
    seen = set()
    for variant in variants:
        variant = re.sub(r"\s+", " ", variant).strip()
        if not variant:
            continue
        if year and media_type != "tv" and year not in variant:
            variant = f"{variant} {year}"
        key = _lookup_text(variant)
        if key and key not in seen:
            seen.add(key)
            queries.append(variant)
    return queries


def _scraped_entry_matches(entry, tmdb_id="", title="", year="", media_type="movie", season=None):
    if tmdb_id and str(entry.get("tmdb_id") or "") == str(tmdb_id):
        return media_type != "tv" or _entry_matches_season(entry, season)

    entry_year = _lookup_year(
        entry.get("title", ""),
        entry.get("url", ""),
        json.dumps(entry.get("metadata") or {}, ensure_ascii=False),
    )
    if media_type != "tv" and year and entry_year and year != entry_year:
        return False
    if media_type == "tv" and not _entry_matches_season(entry, season):
        return False

    score = _entry_match_score(entry, title, year)
    # HDHub4u titles include quality/language suffixes so the match score is
    # naturally lower — use a relaxed threshold for hdhub4u entries.
    threshold = 90 if entry.get("source") == "hdhub4u" else 125
    return score >= threshold


def _find_or_import_source_entry(tmdb_id="", title="", year="", media_type="movie", season=None, episode=None):
    year = (year or _lookup_year(title)).strip()
    errors = []
    seen_urls = set()

    sources = [
        ("4KHDHub", search_4khdhub, lambda url: scrape(url, season=season or 1, episode=episode or 1)),
        ("HDHub4u", search_hdhub4u, scrape_hdhub4u),
    ]

    for source_name, search_fn, scrape_fn in sources:
        source_found = False
        for query in _source_search_queries(title, year, media_type, season):
            try:
                candidates = search_fn(query, year=year if media_type != "tv" else "", limit=5)
            except Exception as exc:
                errors.append(f"{source_name} search failed for {query}: {exc}")
                continue

            # Only scrape candidates with a strong enough title match score.
            # This prevents wasting time fetching unrelated pages (e.g. WWE pages
            # when searching for an Indian film that 4KHDHub doesn't have).
            MIN_CANDIDATE_SCORE = 70
            good_candidates = [c for c in candidates if c.get("score", 0) >= MIN_CANDIDATE_SCORE]

            if not good_candidates:
                # No strong matches from this source for this query — skip scraping
                errors.append(f"{source_name}: no strong candidates for '{query}' (best score: {candidates[0].get('score', 0) if candidates else 0})")
                continue

            for candidate in good_candidates:
                url = candidate.get("url")
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)

                try:
                    data = scrape_fn(url)
                except Exception as exc:
                    errors.append(f"{source_name} scrape failed for {url}: {exc}")
                    continue

                if "error" in data:
                    errors.append(data["error"])
                    continue
                if media_type and data.get("type") and data.get("type") != media_type:
                    continue
                if not _scraped_entry_matches(data, tmdb_id, title, year, media_type, season):
                    continue
                # Accept any entry that has at least one resolvable download link
                has_any_download = any(_download_has_resolvable_link(d) for d in data.get("downloads") or [])
                if not has_any_download:
                    errors.append(f"{source_name} had no resolvable links for {url}")
                    continue

                if tmdb_id and not data.get("tmdb_id"):
                    data["tmdb_id"] = str(tmdb_id)
                library_add(data)
                return data

            if source_found:
                break

    if errors:
        print("[playback source search] " + " | ".join(errors[-5:]))
    return None


def _download_score(download):
    haystack = " ".join([
        download.get("quality", ""),
        download.get("file_name", ""),
        " ".join(download.get("tags", [])),
    ]).lower()

    if any(bad in haystack for bad in ("hevc", "h.265", "h265", "x265", "av1")):
        return -10000

    score = 0
    if any(good in haystack for good in ("x264", "h.264", "h264", "avc")):
        score += 1000
    if "1080p" in haystack:
        score += 300
    if "remux" in haystack:
        score += 140
    if "bluray" in haystack:
        score += 80
    if "web-dl" in haystack:
        score += 30
    return score


def _download_text(download):
    return " ".join([
        download.get("quality", ""),
        download.get("file_name", ""),
        " ".join(download.get("tags", [])),
        str(download.get("episode") or ""),
    ])


def _download_has_episode_marker(download):
    return bool(re.search(r"\b(?:ep|episode|e)\s*[-_.]?\s*\d{1,3}\b", _download_text(download), re.IGNORECASE))


def _download_matches_episode(download, season=None, episode=None):
    if not episode:
        return True
    text = _download_text(download)
    wanted = int(episode)
    episode_numbers = set()
    for pattern in (r"\bep\s*[-_.]?\s*0*(\d{1,3})\b", r"\bepisode\s*0*(\d{1,3})\b", r"\be0*(\d{1,3})\b"):
        for match in re.finditer(pattern, text, re.IGNORECASE):
            try:
                episode_numbers.add(int(match.group(1)))
            except ValueError:
                pass
    if episode_numbers and wanted not in episode_numbers:
        return False
    return _season_matches_text(text, season)


def _download_has_resolvable_link(download):
    for link in download.get("links") or []:
        url = link.get("url", "")
        if url and not _is_hdhub4u_url(url):
            return True
    return False


def _is_resolvable_url(url):
    """Return True if this URL can be resolved to a direct media URL."""
    if not url:
        return False
    if _is_hdhub4u_url(url):
        return False
    # Accept hubcloud, hubdrive, gadgetsweb, hblinks, and any direct media URL
    return True


def _select_browser_download(entry, season=None, episode=None):
    downloads = [download for download in entry.get("downloads") or [] if _download_has_resolvable_link(download)]
    if not downloads:
        return None
    if entry.get("type") == "tv" and episode:
        matching = [download for download in downloads if _download_matches_episode(download, season, episode)]
        if matching:
            downloads = matching
        elif any(_download_has_episode_marker(download) for download in downloads):
            return None
    downloads.sort(key=_download_score, reverse=True)
    # Prefer x264/AVC — but if nothing scores > 0, fall back to best available
    # (e.g. only HEVC exists). The player will still try to play it.
    best = downloads[0]
    if _download_score(best) > 0:
        return best
    # Fallback: pick the highest quality available even if HEVC
    # Prefer 1080p over 720p over 480p
    def fallback_score(d):
        text = _download_text(d).lower()
        s = 0
        if "1080p" in text: s += 30
        if "720p" in text: s += 20
        if "480p" in text: s += 10
        if "web-dl" in text: s += 5
        if "webrip" in text: s += 3
        return s
    downloads.sort(key=fallback_score, reverse=True)
    return downloads[0]


def _select_download_link(download):
    links = [link for link in download.get("links") or [] if not _is_hdhub4u_url(link.get("url", ""))]
    if not links:
        return None
    # Priority: hubcloud > hubdrive > gadgetsweb > hblinks > anything else
    for keyword in ("hubcloud", "hubdrive", "gadgetsweb", "hblinks"):
        match = next(
            (link for link in links if keyword in (link.get("label", "") + link.get("url", "")).lower()),
            None
        )
        if match:
            return match
    return links[0]



@app.route("/api/playback/start", methods=["POST", "OPTIONS"])
def api_playback_start():
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(force=True)
    tmdb_id = str(body.get("tmdb_id") or body.get("id") or "").strip()
    title = (body.get("title") or "").strip()
    year = _lookup_year(body.get("year"), body.get("release_date"), body.get("first_air_date"), title)
    media_type = body.get("type") or body.get("media_type") or "movie"
    season = int(body.get("season") or 1)
    episode = int(body.get("episode") or 1)
    job_id = _safe_job_id(f"{tmdb_id}:{title}:{season}:{episode}:{time.time()}")
    _set_playback_job(job_id, status="queued", title=title, tmdb_id=tmdb_id, year=year, season=season, episode=episode)

    thread = threading.Thread(
        target=_run_playback_job,
        args=(job_id, tmdb_id, title, year, media_type, season, episode),
        daemon=True,
    )
    thread.start()
    return jsonify({"job_id": job_id, "status": "queued"})


@app.route("/api/playback/status/<job_id>")
def api_playback_status(job_id):
    with playback_lock:
        job = playback_jobs.get(job_id)
    if not job:
        return jsonify({"error": "playback job not found"}), 404
    return jsonify(job)


def _run_playback_job(job_id, tmdb_id, title, year, media_type, season=1, episode=1):
    try:
        _set_playback_job(job_id, status="selecting_source", message="Selecting browser-compatible x264 source")
        entry = _find_library_entry(tmdb_id, title, year, media_type, season)
        download = _select_browser_download(entry, season=season, episode=episode) if entry else None
        if not entry or not download:
            _set_playback_job(
                job_id,
                status="importing_source",
                message=f"Searching source sites for {title}{f' S{season:02d}E{episode:02d}' if media_type == 'tv' else (f' ({year})' if year else '')}",
            )
            entry = _find_or_import_source_entry(tmdb_id, title, year, media_type, season, episode)
            download = _select_browser_download(entry, season=season, episode=episode) if entry else None
        if not entry:
            raise RuntimeError("No matching source page found on 4KHDHub or HDHub4u.")

        if not download:
            raise RuntimeError("No matching x264/AVC browser-compatible download found")

        link = _select_download_link(download)
        if not link:
            raise RuntimeError("No download link found")

        _set_playback_job(
            job_id,
            status="resolving",
            message=f"Resolving {download.get('quality') or download.get('file_name')}",
            selected_quality=download.get("quality"),
            selected_file=download.get("file_name"),
            source_url=link.get("url"),
        )

        future = _resolver_executor.submit(_run_resolver, link.get("url"), 90, True)
        resolved = future.result(timeout=100)
        if not resolved or not resolved.get("url"):
            raise RuntimeError((resolved or {}).get("error") or "Could not resolve direct media URL")

        direct_url = resolved["url"]
        referer = resolved.get("referer") or ""
        source_site = entry.get("source", "4khdhub")

        # Build server list: Server 1 = primary resolved URL
        servers = {
            f"Server 1 ({source_site.upper()})": {
                "url": direct_url,
                "referer": referer,
            }
        }

        # Try to find Server 2 from the OTHER source site
        try:
            alt_source_name = "hdhub4u" if "4khdhub" in source_site.lower() else "4khdhub"
            alt_search_fn = search_hdhub4u if alt_source_name == "hdhub4u" else search_4khdhub
            alt_scrape_fn = scrape_hdhub4u if alt_source_name == "hdhub4u" else (lambda u: scrape(u, season=season or 1, episode=episode or 1))

            # First check library for an entry from the other source
            with db_lock:
                lib = load_library()
            alt_entry = next(
                (e for e in lib
                 if e.get("source", "") == alt_source_name
                 and (str(e.get("tmdb_id", "")) == str(tmdb_id) if tmdb_id else False)),
                None
            )

            # If not in library, do a quick search (limit=3 to keep it fast)
            if not alt_entry:
                for query in _source_search_queries(title, year, media_type, season)[:2]:
                    try:
                        candidates = alt_search_fn(query, year=year if media_type != "tv" else "", limit=3)
                        for candidate in candidates:
                            alt_url = candidate.get("url")
                            if not alt_url:
                                continue
                            try:
                                alt_data = alt_scrape_fn(alt_url)
                            except Exception:
                                continue
                            if "error" in alt_data:
                                continue
                            if not _scraped_entry_matches(alt_data, tmdb_id, title, year, media_type, season):
                                continue
                            if any(_download_has_resolvable_link(d) for d in alt_data.get("downloads") or []):
                                alt_entry = alt_data
                                break
                    except Exception:
                        pass
                    if alt_entry:
                        break

            if alt_entry:
                alt_download = _select_browser_download(alt_entry, season=season, episode=episode)
                if alt_download:
                    alt_link = _select_download_link(alt_download)
                    if alt_link and alt_link.get("url") and alt_link.get("url") != link.get("url"):
                        alt_future = _resolver_executor.submit(_run_resolver, alt_link.get("url"), 45, True)
                        try:
                            alt_resolved = alt_future.result(timeout=50)
                            if alt_resolved and alt_resolved.get("url"):
                                servers[f"Server 2 ({alt_source_name.upper()})"] = {
                                    "url": alt_resolved["url"],
                                    "referer": alt_resolved.get("referer") or "",
                                }
                        except Exception:
                            pass
        except Exception:
            pass

        player_params = urlencode({
            "src": direct_url,
            "title": entry.get("title") or title,
            "type": media_type,
            "id": tmdb_id or direct_url,
            "season": season if media_type == "tv" else "",
            "episode": episode if media_type == "tv" else "",
            "referer": referer,
            "proxy": "1",
            "mode": "direct",
            "raw": "1",
        })
        _set_playback_job(
            job_id,
            status="ready",
            message="Stream ready",
            player_url=f"/player/?{player_params}",
            stream_url=direct_url,
            direct_url=direct_url,
            referer=referer,
            mode="direct",
            servers=servers,  # {server_name: {url, referer}}
        )
        return

    except Exception as exc:
        _set_playback_job(job_id, status="error", error=str(exc))


@app.route("/api/direct/resolve", methods=["POST"])
def api_direct_resolve():
    """
    Resolve an authorized download page into a final direct media URL.

    The browser automation cancels the actual download after capturing its URL,
    so this endpoint returns a playable link without saving the video file.
    """
    body = request.get_json(force=True)
    url = (body.get("url") or "").strip()
    force = bool(body.get("force_refresh"))
    timeout_sec = min(int(body.get("timeout_sec") or 75), 120)

    if not url:
        return jsonify({"error": "url required"}), 400

    now = time.time()
    cached = direct_cache.get(url)
    if cached and not force and cached.get("expires", 0) > now:
        result = cached["result"].copy()
        result["cached"] = True
        return jsonify(result)

    try:
        future = _resolver_executor.submit(_run_resolver, url, timeout_sec, True)
        result = future.result(timeout=timeout_sec + 10)
    except Exception as e:
        msg = str(e)
        if "Network access denied" in msg:
            return jsonify({
                "error": (
                    "Resolver network access denied for this host. "
                    "Run the app process with full network permission or allow Python/Playwright in firewall."
                )
            }), 502
        return jsonify({"error": str(e)}), 500

    if not result or not result.get("url"):
        payload = result.copy() if isinstance(result, dict) else {}
        payload.setdefault("error", "Could not find a direct media URL")
        payload["cached"] = False
        return jsonify(payload), 404

    direct_cache[url] = {
        "result": result,
        "expires": now + 7200,
    }
    result = result.copy()
    result["cached"] = False
    return jsonify(result)




if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
