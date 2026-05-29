"""
HDHub4u Scraper — requests-only, no Playwright.
Scrapes movie/series pages from hdhub4u (new1.hdhub4u.limo).
Search uses the Typesense API at search.hdhub4u.glass (fast, no browser).
"""

import re
import requests
from bs4 import BeautifulSoup
from typing import Optional
from urllib.parse import urlparse
from datetime import date as _date

HDHUB4U_BASE_URL = "https://new1.hdhub4u.limo"
HDHUB4U_SEARCH_API = "https://search.hdhub4u.glass/collections/post/documents/search"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://new1.hdhub4u.limo/",
}


def _is_hdhub4u_url(url: str) -> bool:
    return any(d in url for d in ["hdhub4u", "hdhub4u.limo", "hdhub4u.glass", "hdhub4u.tv"])


def _fetch_page(url: str) -> Optional[BeautifulSoup]:
    """Fetch a page with requests. HDHub4u movie pages are static HTML."""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15, allow_redirects=True)
        resp.raise_for_status()
        text = resp.text
        if len(text) < 500:
            return None
        return BeautifulSoup(text, "html.parser")
    except Exception as e:
        print(f"  [hdhub4u] fetch failed for {url}: {e}")
        return None


def extract_title(soup: BeautifulSoup) -> str:
    h1 = soup.find("h1")
    if h1:
        t = h1.get_text(strip=True)
        t = re.sub(r'^[\W\s]+', '', t)
        t = re.sub(r'\s*[–-]\s*HDHub4u.*$', '', t, flags=re.IGNORECASE)
        t = re.sub(r'\s*\|\s*Full Movie.*$', '', t, flags=re.IGNORECASE)
        return t.strip()
    title_tag = soup.find("title")
    if title_tag:
        t = title_tag.get_text(strip=True)
        t = re.sub(r'\s*[–-]\s*HDHub4u.*$', '', t, flags=re.IGNORECASE)
        return t.strip()
    return "Unknown Title"


def extract_metadata(soup: BeautifulSoup) -> dict:
    meta = {}
    content = soup.find("div", class_=re.compile(r"entry|content|post", re.I)) or soup
    text = ""
    for elem in content.find_all(["p", "li", "div", "span"]):
        t = elem.get_text(" ", strip=True)
        if any(x in t.lower() for x in ["reply", "days ago", "hours ago", "comment"]):
            break
        text += " " + t

    patterns = {
        "IMDb":     r'iMDB Rating[:\s]+([0-9.]+/10)',
        "Genre":    r'Genre[:\s]+([A-Za-z\s|]+?)(?:\s*Stars|\s*Director|\s*Language|\s*Quality|$)',
        "Stars":    r'Stars[:\s]+([^|]+?)(?:\s*Director|\s*Language|\s*Quality|$)',
        "Director": r'Director[:\s]+([^|]+?)(?:\s*Language|\s*Quality|$)',
        "Language": r'Language[:\s]+([^|]+?)(?:\s*Quality|$)',
        "Quality":  r'Quality[:\s]+([^\n|]+?)(?:\s*Raw|\s*\(|$)',
    }
    for key, pattern in patterns.items():
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            meta[key] = re.sub(r'\s+', ' ', m.group(1).strip())[:100]
    return meta


def extract_stream_links(soup: BeautifulSoup) -> dict:
    streams = {}
    for a in soup.find_all("a", href=True):
        href = a.get("href", "")
        text = a.get_text(strip=True).upper()
        if "hdstream4u.com" in href:
            streams["Server 1 (HDStream)"] = href
        elif "hubstream.art" in href:
            streams["Server 2 (HubStream)"] = href
        elif text in ("WATCH", "WATCH ONLINE") and href.startswith("http"):
            streams["Server 1 (HDStream)"] = href
        elif "PLAYER" in text and "2" in text and href.startswith("http"):
            streams["Server 2 (HubStream)"] = href
    return streams


def extract_content_type(title: str, soup: BeautifulSoup) -> str:
    # Only look at main post content — nav menus contain "web series" as category links
    content = soup.find("div", class_=re.compile(r"entry|post-content|article|single", re.I))
    if not content:
        for tag in soup.find_all(["nav", "header", "footer", "aside"]):
            tag.decompose()
        content = soup

    haystack = " ".join([title or "", content.get_text(" ", strip=True)[:3000]]).lower()
    title_lower = (title or "").lower()

    if any(token in title_lower for token in ["season", "all episodes", "full series", "complete series"]):
        return "tv"
    if re.search(r'\bep[-\s]?\d+\b|\bepisode\s+\d+\b|\bs\d{1,2}e\d{1,2}\b', haystack):
        return "tv"
    return "movie"


def extract_download_links(soup: BeautifulSoup) -> list:
    downloads = []
    seen_hrefs = set()

    for a in soup.find_all("a", href=True):
        href = a.get("href", "")
        text = a.get_text(strip=True)

        if not text or len(text) < 3:
            continue
        if any(x in href for x in ["category/", "tag/", "page/", "#", "javascript"]):
            continue
        if _is_hdhub4u_url(href):
            continue
        if href in seen_hrefs:
            continue

        is_download = (
            any(x in href for x in ["hubdrive", "hubcdn", "gadgetsweb", "hubcloud", "drive"]) or
            bool(re.search(r'\d+p|GB|MB|HEVC|x264|x265|WEB-DL|WEBRip|BluRay', text, re.IGNORECASE))
        )

        if is_download and href.startswith("http"):
            seen_hrefs.add(href)
            if "hubdrive" in href:
                label = "HubDrive"
            elif "hubcdn" in href:
                label = "HubCDN"
            elif "hubcloud" in href:
                label = "HubCloud"
            elif "gadgetsweb" in href:
                label = "GadgetsWeb"
            else:
                label = "Download"

            downloads.append({
                "quality": text,
                "file_name": "",
                "tags": [],
                "links": [{"label": label, "url": href}],
            })

    return downloads


def _search_score(query: str, title: str, href: str, year: str = "") -> int:
    def tokens(value):
        return re.findall(r"[a-z0-9]+", (value or "").lower())

    query_tokens = [t for t in tokens(query) if t not in {"movie", "season", "series", "full", "episodes"}]
    haystack = " ".join([title or "", href or ""]).lower()
    hay_tokens = set(tokens(haystack))
    if not query_tokens:
        return 0

    matched = sum(1 for token in query_tokens if token in hay_tokens)
    score = int((matched / len(query_tokens)) * 100)
    if year and year in haystack:
        score += 25
    if "season" in query.lower() and "season" in haystack:
        score += 30
    if any(word in haystack for word in ["category", "tag", "page", "privacy", "contact"]):
        score -= 100
    return score


def search_hdhub4u(query: str, year: str = "", limit: int = 8) -> list:
    """Search HDHub4u using the Typesense API — one HTTP request, ~200ms."""
    query = (query or "").strip()
    if not query:
        return []

    searches = []
    if year and year not in query:
        searches.append(f"{query} {year}")
    searches.append(query)

    found = {}

    for term in searches:
        try:
            params = {
                "q": term,
                "query_by": "post_title,category,stars,director,imdb_id",
                "query_by_weights": "4,2,2,2,4",
                "sort_by": "sort_by_date:desc",
                "limit": limit,
                "highlight_fields": "none",
                "use_cache": "true",
                "page": 1,
                "analytics_tag": str(_date.today()),
            }
            resp = requests.get(HDHUB4U_SEARCH_API, params=params, headers=HEADERS, timeout=10)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"  [hdhub4u search] failed for '{term}': {e}")
            continue

        for hit in data.get("hits", []):
            doc = hit.get("document", {})
            title = doc.get("post_title", "")
            permalink = doc.get("permalink", "")

            if not permalink:
                continue
            if not permalink.startswith("http"):
                permalink = HDHUB4U_BASE_URL + "/" + permalink.lstrip("/")

            score = _search_score(term, title, permalink, year)

            # Hard year filter: wrong year gets pushed to bottom
            if year:
                candidate_year = re.search(r'\b(19|20)\d{2}\b', title)
                if candidate_year and candidate_year.group(0) != year:
                    score -= 200

            if score < 20:
                score = 20  # Typesense returned it — it's relevant

            clean_url = permalink.split("?")[0].rstrip("/") + "/"
            current = found.get(clean_url)
            if not current or score > current["score"]:
                found[clean_url] = {
                    "title": re.sub(r"\s+", " ", title).strip(),
                    "url": clean_url,
                    "score": score,
                }

        if found:
            break

    return sorted(found.values(), key=lambda item: item["score"], reverse=True)[:limit]


def scrape_hdhub4u(url: str) -> dict:
    """Scrape an HDHub4u movie/series page. Returns same structure as scraper.py."""
    print(f"[*] HDHub4u fetching: {url}")

    soup = _fetch_page(url)
    if not soup:
        return {"error": f"Failed to fetch {url}"}

    title = extract_title(soup)
    metadata = extract_metadata(soup)
    stream_links = extract_stream_links(soup)
    downloads = extract_download_links(soup)
    content_type = extract_content_type(title, soup)

    tmdb_id = None
    for script in soup.find_all("script"):
        if script.string:
            m = re.search(r'tmdb[_\s]*id["\s:=]+["\']?(\d+)', script.string, re.IGNORECASE)
            if m:
                tmdb_id = m.group(1)
                break

    return {
        "url": url,
        "title": title,
        "tmdb_id": tmdb_id,
        "type": content_type,
        "source": "hdhub4u",
        "metadata": metadata,
        "streams": stream_links,
        "downloads": downloads,
    }


if __name__ == "__main__":
    import json, sys
    url = sys.argv[1] if len(sys.argv) > 1 else "https://new1.hdhub4u.limo/dhurandhar-2025-hindi-webrip-full-movie/"
    result = scrape_hdhub4u(url)
    print(json.dumps(result, indent=2, ensure_ascii=False))
