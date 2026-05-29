"""
4KHDHub Scraper
Extracts stream URLs and download links from 4khdhub.link movie/series pages.
"""

import re
import sys
import json
import time
import argparse
import requests
from bs4 import BeautifulSoup
from urllib.parse import quote, quote_plus, urljoin, urlparse

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://4khdhub.link/",
}

BASE_URL = "https://4khdhub.link/"
SEARCH_SKIP_PATH_PARTS = (
    "/category/",
    "/tag/",
    "/genre/",
    "/page/",
    "/wp-",
    "/feed",
    "/contact",
    "/privacy",
    "/dmca",
    "/request",
)
SEARCH_STOPWORDS = {
    "and", "or", "the", "a", "an", "in", "on", "of", "to", "for",
    "movie", "movies", "film", "full", "download", "watch", "online",
}

STREAM_SOURCES = {
    "VidSrc":       "https://vidsrc.to/embed/movie/{tmdb_id}",
    "VidSrc Pro":   "https://vidsrc.pro/embed/movie/{tmdb_id}",
    "2Embed":       "https://www.2embed.cc/embed/{tmdb_id}",
    "Autoembed":    "https://player.autoembed.cc/embed/movie/{tmdb_id}",
    "Videasy":      "https://player.videasy.net/movie/{tmdb_id}",
}

SERIES_STREAM_SOURCES = {
    "VidSrc":       "https://vidsrc.to/embed/tv/{tmdb_id}/{season}/{episode}",
    "VidSrc Pro":   "https://vidsrc.pro/embed/tv/{tmdb_id}/{season}/{episode}",
    "2Embed":       "https://www.2embed.cc/embedtv/{tmdb_id}&s={season}&e={episode}",
    "Autoembed":    "https://player.autoembed.cc/embed/tv/{tmdb_id}/{season}/{episode}",
    "Videasy":      "https://player.videasy.net/tv/{tmdb_id}/{season}/{episode}",
}


def fetch_page(url, retries=3):
    """Fetch a page with retry logic to handle Cloudflare redirects."""
    session = requests.Session()
    for attempt in range(retries):
        try:
            resp = session.get(url, headers=HEADERS, timeout=15, allow_redirects=True)
            resp.raise_for_status()
            return BeautifulSoup(resp.text, "html.parser")
        except requests.RequestException as e:
            print(f"  [!] Attempt {attempt + 1} failed: {e}", file=sys.stderr)
            if attempt < retries - 1:
                time.sleep(2)
    return None


def _search_text(value):
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def _search_tokens(value):
    return [
        token for token in _search_text(value).split()
        if token and len(token) > 1 and token not in SEARCH_STOPWORDS
    ]


def _extract_year(value):
    match = re.search(r"\b(19|20)\d{2}\b", value or "")
    return match.group(0) if match else ""


def _looks_like_post_url(url):
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    if "4khdhub" not in host:
        return False
    if not path.strip("/"):
        return False
    if any(part in path for part in SEARCH_SKIP_PATH_PARTS):
        return False
    return True


def _score_search_candidate(query, title, href, year=""):
    if not _looks_like_post_url(href):
        return 0

    query_tokens = _search_tokens(query)
    if not query_tokens:
        return 0

    haystack = _search_text(f"{title} {href}")
    if not haystack:
        return 0

    matched = [token for token in query_tokens if token in haystack]
    if not matched:
        return 0

    score = int((len(matched) / max(1, len(query_tokens))) * 100)
    if all(token in haystack for token in query_tokens):
        score += 80
    if year and year in haystack:
        score += 40
    if "/search/" in href or "?s=" in href:
        score -= 50
    if re.search(r"(movie|web-dl|bluray|2160p|1080p|720p)", haystack):
        score += 15
    return max(score, 0)


def _extract_search_candidates(soup, query, year=""):
    candidates = {}
    for a in soup.find_all("a", href=True):
        href = urljoin(BASE_URL, a["href"])
        title = a.get_text(" ", strip=True)
        score = _score_search_candidate(query, title, href, year)
        if score <= 0:
            continue

        parsed = urlparse(href)
        clean_href = parsed._replace(query="", fragment="").geturl()
        existing = candidates.get(clean_href)
        if not existing or score > existing["score"]:
            candidates[clean_href] = {
                "title": title,
                "url": clean_href,
                "score": score,
            }

    return sorted(candidates.values(), key=lambda item: item["score"], reverse=True)


def search_4khdhub(query, year="", limit=8):
    """Search 4khdhub for likely movie/series page URLs."""
    query = (query or "").strip()
    year = (year or _extract_year(query)).strip()
    if not query:
        return []

    searches = []
    if year and year not in query:
        searches.append(f"{query} {year}")
    searches.append(query)

    found = {}
    for term in searches:
        search_urls = [
            f"{BASE_URL}?s={quote_plus(term)}",
            f"{BASE_URL}search/{quote(term.replace(' ', '-'))}/",
        ]
        for search_url in search_urls:
            soup = fetch_page(search_url, retries=2)
            if not soup:
                continue
            for candidate in _extract_search_candidates(soup, term, year):
                current = found.get(candidate["url"])
                if not current or candidate["score"] > current["score"]:
                    found[candidate["url"]] = candidate

    return sorted(found.values(), key=lambda item: item["score"], reverse=True)[:limit]


def extract_tmdb_id(soup):
    """Extract TMDB ID from the inline JS on the page."""
    scripts = soup.find_all("script")
    for script in scripts:
        if script.string and "defaultVideoId" in script.string:
            match = re.search(r"defaultVideoId\s*=\s*['\"](\d+)['\"]", script.string)
            if match:
                return match.group(1)
    # Fallback: look for videasy/autoembed src in iframes
    iframe = soup.find("iframe", id="videoPlayer")
    if iframe and iframe.get("src"):
        match = re.search(r"/(?:movie|tv)/(\d+)", iframe["src"])
        if match:
            return match.group(1)
    return None


def extract_content_type(soup):
    """Detect if this is a movie or TV series page."""
    scripts = soup.find_all("script")
    for script in scripts:
        if script.string:
            if "/tv/" in script.string and "videoSources" in script.string:
                return "tv"
    iframe = soup.find("iframe", id="videoPlayer")
    if iframe and iframe.get("src"):
        if "/tv/" in iframe["src"]:
            return "tv"
    # If the page has a Single EP's tab or season structure, it's a series
    if soup.find("div", id="episodes") or soup.find(attrs={"data-tab": "episodes"}):
        return "tv"
    return "movie"


def extract_title(soup):
    """Extract the movie/series title."""
    h1 = soup.find("h1", class_="page-title")
    if h1:
        return h1.get_text(strip=True)
    title_tag = soup.find("title")
    if title_tag:
        return title_tag.get_text(strip=True).split(" - ")[0].strip()
    return "Unknown Title"


def extract_metadata(soup):
    """Extract metadata like director, stars, release date, etc."""
    meta = {}
    for item in soup.find_all("div", class_="metadata-item"):
        label_el = item.find("span", class_="metadata-label")
        value_el = item.find("span", class_="metadata-value")
        if label_el and value_el:
            key = label_el.get_text(strip=True).rstrip(":")
            meta[key] = value_el.get_text(strip=True)
    tagline = soup.find("p", class_="movie-tagline")
    if tagline:
        meta["Tagline"] = tagline.get_text(strip=True)
    return meta


def extract_download_links(soup):
    """Extract all download link groups from the page.

    For series pages, prefers Single EP's tab (individual episode links)
    over Zip/Pack tab (whole season zips). Falls back to Zip/Pack if no
    individual episodes are found.
    """
    downloads = []

    # ── Try Single EP's tab first (episode-download-item elements) ──────────
    episodes_div = soup.find("div", id="episodes")
    if episodes_div:
        # Each episode-header groups a quality tier (e.g. S02 AVC 1080p)
        for ep_header in episodes_div.find_all("div", class_="episode-header"):
            ep_id = ep_header.get("data-episode-id", "")
            title_el = ep_header.find("h3", class_="episode-title")
            quality_label = title_el.get_text(strip=True) if title_el else "Unknown"
            badges = [b.get_text(strip=True) for b in ep_header.find_all("span", class_="badge")]

            # The content div is a sibling with id="content-{ep_id}"
            content_div = soup.find("div", id=f"content-{ep_id}") if ep_id else None
            if not content_div:
                # Try finding it as the next sibling
                content_div = ep_header.find_next_sibling("div", class_="episode-content")

            if not content_div:
                continue

            # Each episode-download-item is one episode file
            for item in content_div.find_all("div", class_="episode-download-item"):
                file_title_el = item.find("div", class_="episode-file-title")
                file_name = file_title_el.get_text(strip=True) if file_title_el else ""

                # Episode number badge
                ep_num_el = item.find("span", class_="badge-psa")
                ep_num = ep_num_el.get_text(strip=True) if ep_num_el else ""

                size_el = item.find("span", class_="badge-size")
                size = size_el.get_text(strip=True) if size_el else ""

                links = []
                for a in item.find_all("a", href=True):
                    href = a["href"]
                    text = a.get_text(" ", strip=True)
                    if href.startswith("http") and any(x in href for x in ["hubcloud", "hubdrive", "drive"]):
                        links.append({"label": text, "url": href})

                if links:
                    ep_quality = f"{quality_label} {ep_num}".strip()
                    downloads.append({
                        "quality": ep_quality,
                        "file_name": file_name,
                        "tags": badges + ([size] if size else []),
                        "links": links,
                        "episode": ep_num,
                    })

        if downloads:
            return downloads

    # ── Fall back to Zip/Pack tab (download-item elements) ──────────────────
    for item in soup.find_all("div", class_="download-item"):
        header = item.find("div", class_="download-header")
        if not header:
            continue

        label_div = header.find("div", class_="flex-1")
        quality = label_div.get_text(" ", strip=True) if label_div else "Unknown"
        quality = re.sub(r"\s+", " ", quality).strip()

        file_title_el = item.find("div", class_="file-title")
        file_name = file_title_el.get_text(strip=True) if file_title_el else ""

        badges = [b.get_text(strip=True) for b in item.find_all("span", class_="badge")]

        links = []
        for a in item.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(" ", strip=True)
            if href.startswith("http") and ("hubcloud" in href or "hubdrive" in href or "drive" in href):
                links.append({"label": text, "url": href})

        if links:
            downloads.append({
                "quality": quality,
                "file_name": file_name,
                "tags": badges,
                "links": links,
            })

    return downloads



def scrape(url, season=1, episode=1):
    """Main scrape function. Returns structured data for a movie/series page."""
    print(f"[*] Fetching: {url}")
    soup = fetch_page(url)
    if not soup:
        return {"error": f"Failed to fetch {url}"}

    tmdb_id = extract_tmdb_id(soup)
    content_type = extract_content_type(soup)
    title = extract_title(soup)
    metadata = extract_metadata(soup)
    downloads = extract_download_links(soup)

    return {
        "url": url,
        "title": title,
        "tmdb_id": tmdb_id,
        "type": content_type,
        "metadata": metadata,        "downloads": downloads,
    }


def print_result(data, fmt="text"):
    """Pretty-print the scraped result."""
    if fmt == "json":
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    if "error" in data:
        print(f"ERROR: {data['error']}")
        return

    print(f"\n{'='*60}")
    print(f"  {data['title']}")
    print(f"  TMDB ID : {data['tmdb_id']}  |  Type: {data['type']}")
    print(f"{'='*60}")

    if data["metadata"]:
        print("\n[Metadata]")
        for k, v in data["metadata"].items():
            print(f"  {k}: {v}")
    print()



def export_json(results, output_path):
    """Export all results as JSON."""
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"[+] JSON saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Scrape stream/download links from 4khdhub.link",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Single movie
  python scraper.py https://4khdhub.link/stuart-little-2-movie-6945/

  # Multiple URLs from a file (one URL per line)
  python scraper.py --file urls.txt

  # Export as M3U playlist (works in VLC, Jellyfin, Stremio, etc.)
  python scraper.py --file urls.txt --m3u output.m3u

  # Export as JSON
  python scraper.py https://4khdhub.link/some-movie/ --json output.json

  # TV series (specific episode)
  python scraper.py https://4khdhub.link/some-series/ --season 1 --episode 3

  # JSON output in terminal
  python scraper.py https://4khdhub.link/some-movie/ --format json
        """
    )
    parser.add_argument("urls", nargs="*", help="One or more 4khdhub.link URLs")
    parser.add_argument("--file", "-f", help="Text file with one URL per line")
    parser.add_argument("--json", dest="json_out", help="Export all data as JSON to this file")
    parser.add_argument("--format", choices=["text", "json"], default="text",
                        help="Terminal output format (default: text)")
    parser.add_argument("--season", type=int, default=1, help="Season number for TV series")
    parser.add_argument("--episode", type=int, default=1, help="Episode number for TV series")
    parser.add_argument("--delay", type=float, default=1.5,
                        help="Delay in seconds between requests (default: 1.5)")

    args = parser.parse_args()

    # Collect URLs
    urls = list(args.urls)
    if args.file:
        try:
            with open(args.file, encoding="utf-8") as f:
                file_urls = [line.strip() for line in f if line.strip() and not line.startswith("#")]
            urls.extend(file_urls)
        except FileNotFoundError:
            print(f"[!] File not found: {args.file}", file=sys.stderr)
            sys.exit(1)

    if not urls:
        parser.print_help()
        sys.exit(0)

    results = []
    for i, url in enumerate(urls):
        if i > 0:
            time.sleep(args.delay)
        data = scrape(url, season=args.season, episode=args.episode)
        results.append(data)
        print_result(data, fmt=args.format)

    # Exports
    if args.json_out:
        export_json(results, args.json_out)


if __name__ == "__main__":
    main()
