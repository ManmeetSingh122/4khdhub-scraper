"""
Direct-link resolver — pure HTTP, no browser, no Playwright.

Supported chains:
  HubCloud  -> gamerxyt -> direct CDN URL          (~2 requests)
  HubDrive  -> HubCloud -> gamerxyt -> direct URL  (~3 requests)
  GadgetsWeb -> greenmountmotors -> hblinks -> HubCloud -> direct URL (~4 requests)
  hblinks   -> HubCloud/HubDrive -> direct URL     (~3 requests)
"""

import json
import os
import re
from typing import Optional
from urllib.parse import parse_qs, urlparse

import requests as _requests

_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

MEDIA_HOST_HINTS = (
    "video-download",
    "video-downloads.googleusercontent.com",
    "storage.googleapis.com",
    "blob.core.windows.net",
    "r2.dev",
    "pub-",
)


def _looks_like_media_url(url: str) -> bool:
    if not url or not url.startswith("http"):
        return False
    low = url.lower()
    video_exts = (".mp4", ".m4v", ".mkv", ".webm", ".avi", ".mov", ".ts", ".m3u8")
    path = urlparse(url).path.lower()
    if path.endswith(video_exts) or any(ext + "?" in low for ext in video_exts):
        return True
    host = urlparse(url).netloc.lower()
    return any(hint in low or hint in host for hint in MEDIA_HOST_HINTS)


# ── HubCloud ──────────────────────────────────────────────────────────────────

def _fast_resolve_hubcloud(start_url: str) -> Optional[dict]:
    """
    hubcloud.foo/drive/{id} -> gamerxyt.com/hubcloud.php -> direct CDN URL
    Two plain HTTP requests, ~1-2 seconds.
    """
    try:
        resp1 = _requests.get(start_url, headers=_HTTP_HEADERS, timeout=15, allow_redirects=True)
        resp1.raise_for_status()
        html1 = resp1.text

        gamerxyt_url = None
        for pattern in [
            r"var url\s*=\s*['\"]([^'\"]+gamerxyt\.com/hubcloud\.php[^'\"]+)['\"]",
            r'href=["\']([^"\']+gamerxyt\.com/hubcloud\.php[^"\']+)["\']',
        ]:
            m = re.search(pattern, html1)
            if m:
                gamerxyt_url = m.group(1).replace("&amp;", "&")
                break

        if not gamerxyt_url:
            print("  [fast-hubcloud] could not find gamerxyt URL")
            return None

        print(f"  [fast-hubcloud] gamerxyt: {gamerxyt_url[:80]}...")

        resp2 = _requests.get(
            gamerxyt_url,
            headers={**_HTTP_HEADERS, "Referer": start_url},
            timeout=15,
            allow_redirects=True,
        )
        resp2.raise_for_status()
        html2 = resp2.text

        # Collect all hrefs, skip known-bad ones
        all_hrefs = re.findall(r'href=["\']([^"\']{20,})["\']', html2)
        candidate_urls = []
        for href in all_hrefs:
            href = href.replace("&amp;", "&")
            if any(skip in href for skip in [
                "fontawesome", "jsdelivr", "googleapis.com/css", "fonts.gstatic",
                "unpkg.com", "tinyurl", "t.me/", "google.com/search",
                "hubcloud.foo/drive/admin", "HDhub4u", "one.one.one.one",
                "bonuscaf", "winexch", "tutorial",
            ]):
                continue
            candidate_urls.append(href)

        # Priority: workers.dev > r2.dev > mandalorian/homelander > google > hubcloud.cx > pixel
        priority_patterns = [
            r'workers\.dev/',
            r'\.r2\.dev/',
            r'mandalorian\.buzz/',
            r'homelander\.buzz/',
            r'\.buzz/',
            r'googleusercontent\.com/',
            r'storage\.googleapis\.com/',
            r'lh3\.google',
            r'hubcloud\.cx/',
            r'pixel\.hubcloud',
        ]

        direct_url = None
        for patt in priority_patterns:
            for href in candidate_urls:
                if re.search(patt, href, re.IGNORECASE):
                    direct_url = href
                    break
            if direct_url:
                break

        # Last resort: any video extension
        if not direct_url:
            for href in candidate_urls:
                if re.search(r'\.(mkv|mp4|avi|webm|mov)([?#]|$)', href, re.IGNORECASE):
                    direct_url = href
                    break

        # Follow pixel.hubcloud (10Gbps intermediate) to get actual URL
        if direct_url and "pixel.hubcloud" in direct_url:
            try:
                print(f"  [fast-hubcloud] following pixel.hubcloud...")
                r3 = _requests.get(
                    direct_url,
                    headers={**_HTTP_HEADERS, "Referer": resp2.url},
                    timeout=15,
                    allow_redirects=True,
                )
                final_url = r3.url
                parsed = urlparse(final_url)
                qs = parse_qs(parsed.query)
                if "link" in qs:
                    direct_url = qs["link"][0]
                    print(f"  [fast-hubcloud] extracted from dl.php: {direct_url[:80]}...")
                elif _looks_like_media_url(final_url):
                    direct_url = final_url
                else:
                    for href in re.findall(r'href=["\']([^"\']{20,})["\']', r3.text):
                        href = href.replace("&amp;", "&")
                        if _looks_like_media_url(href):
                            direct_url = href
                            break
            except Exception as exc:
                print(f"  [fast-hubcloud] pixel follow failed: {exc}")

        if not direct_url:
            print("  [fast-hubcloud] no direct URL found")
            return None

        print(f"  [fast-hubcloud] direct URL: {direct_url[:80]}...")
        return {
            "url": direct_url,
            "m3u8": direct_url,
            "referer": resp2.url,
            "source": "direct",
            "content_type": "",
            "file_name": "",
            "start_url": start_url,
            "last_page": resp2.url,
        }

    except Exception as exc:
        print(f"  [fast-hubcloud] failed: {exc}")
        return None


# ── HubDrive ──────────────────────────────────────────────────────────────────

def _fast_resolve_hubdrive(hubdrive_url: str) -> Optional[dict]:
    """
    hubdrive.space/file/{id} -> find HubCloud link -> _fast_resolve_hubcloud
    """
    try:
        print(f"  [fast-hubdrive] fetching: {hubdrive_url[:80]}...")
        resp = _requests.get(hubdrive_url, headers=_HTTP_HEADERS, timeout=15, allow_redirects=True)
        resp.raise_for_status()
        html = resp.text

        hubcloud_url = None
        for pattern in [
            r'href=["\']([^"\']*hubcloud\.[^"\']+/drive/[^"\']+)["\']',
            r'href=["\']([^"\']*hubcloud\.[^"\']+)["\']',
        ]:
            m = re.search(pattern, html, re.IGNORECASE)
            if m:
                hubcloud_url = m.group(1).replace("&amp;", "&")
                if hubcloud_url.rstrip('/') in ('https://hubcloud.foo', 'https://hubcloud.art'):
                    hubcloud_url = None
                    continue
                break

        if not hubcloud_url:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, "html.parser")
            for a in soup.find_all("a", href=True):
                text = a.get_text(strip=True).lower()
                href = a.get("href", "")
                if ("hubcloud" in text or "hubcloud" in href) and ("/drive/" in href or "hubcloud" in href):
                    hubcloud_url = href
                    break

        if not hubcloud_url:
            print(f"  [fast-hubdrive] no HubCloud link found")
            return None

        print(f"  [fast-hubdrive] found HubCloud: {hubcloud_url[:80]}...")
        return _fast_resolve_hubcloud(hubcloud_url)

    except Exception as exc:
        print(f"  [fast-hubdrive] failed: {exc}")
        return None


# ── hblinks ───────────────────────────────────────────────────────────────────

def _fast_resolve_hblinks(hblinks_url: str) -> Optional[dict]:
    """
    hblinks.org/archives/N -> find HubCloud/HubDrive link -> resolve further
    """
    try:
        print(f"  [fast-hblinks] fetching: {hblinks_url[:80]}...")
        resp = _requests.get(hblinks_url, headers=_HTTP_HEADERS, timeout=15, allow_redirects=True)
        resp.raise_for_status()
        html = resp.text

        all_hrefs = re.findall(r'href=["\']([^"\']{20,})["\']', html)
        candidate_urls = []
        for href in all_hrefs:
            href = href.replace("&amp;", "&")
            if any(skip in href for skip in ["hblinks.org", "hdhub4u", "font", "css", "javascript", "#"]):
                continue
            candidate_urls.append(href)

        priority_patterns = [
            r'workers\.dev/',
            r'\.r2\.dev/',
            r'mandalorian\.buzz/',
            r'homelander\.buzz/',
            r'\.buzz/',
            r'googleusercontent\.com/',
            r'storage\.googleapis\.com/',
            r'hubcloud\.',
            r'hubdrive\.',
            r'hubcdn\.',
        ]

        direct_url = None
        for patt in priority_patterns:
            for href in candidate_urls:
                if re.search(patt, href, re.IGNORECASE):
                    direct_url = href
                    break
            if direct_url:
                break

        if not direct_url:
            print(f"  [fast-hblinks] no link found")
            return None

        if "hubcloud" in direct_url:
            return _fast_resolve_hubcloud(direct_url)
        if "hubdrive" in direct_url:
            return _fast_resolve_hubdrive(direct_url)

        print(f"  [fast-hblinks] direct URL: {direct_url[:80]}...")
        return {
            "url": direct_url,
            "m3u8": direct_url,
            "referer": hblinks_url,
            "source": "direct",
            "content_type": "",
            "file_name": "",
            "start_url": hblinks_url,
            "last_page": hblinks_url,
        }
    except Exception as exc:
        print(f"  [fast-hblinks] failed: {exc}")
        return None


# ── GadgetsWeb ────────────────────────────────────────────────────────────────

def _decode_gadgetsweb_o_value(o_val: str) -> Optional[str]:
    """
    Decode the 'o' value from the GadgetsWeb redirect page to get the hblinks URL.

    Encoding chain (JS applies):
      hblinks_url -> b64 -> embed in JSON{"o":...} -> b64 -> rot13 -> b64 -> b64

    Decoding chain (we apply):
      o_val -> b64 -> b64 -> rot13 -> b64 -> JSON["o"] -> b64 -> hblinks_url
    """
    import base64 as _b64

    def rot13(s):
        r = []
        for c in s:
            if 'a' <= c <= 'z':
                r.append(chr((ord(c) - 97 + 13) % 26 + 97))
            elif 'A' <= c <= 'Z':
                r.append(chr((ord(c) - 65 + 13) % 26 + 65))
            else:
                r.append(c)
        return ''.join(r)

    try:
        step1 = _b64.b64decode(o_val + '==').decode('ascii')
        step2 = _b64.b64decode(step1 + '==').decode('ascii')
        step3 = rot13(step2)
        step4 = _b64.b64decode(step3 + '==').decode('utf-8')
        data = json.loads(step4)
        o_encoded = data.get('o', '')
        if not o_encoded:
            return None
        return _b64.b64decode(o_encoded + '==').decode('utf-8').strip()
    except Exception as exc:
        print(f"  [gadgetsweb-decode] failed: {exc}")
        return None


def _fast_resolve_gadgetsweb(gadgetsweb_url: str) -> Optional[dict]:
    """
    gadgetsweb.xyz/?id=... -> decode 'o' value -> hblinks URL -> resolve
    Pure HTTP, ~3-4 requests, no browser.
    """
    try:
        print(f"  [fast-gadgetsweb] fetching: {gadgetsweb_url[:80]}...")
        resp = _requests.get(gadgetsweb_url, headers=_HTTP_HEADERS, timeout=15, allow_redirects=True)
        resp.raise_for_status()

        o_match = re.search(r"s\('o'\s*,\s*'([^']+)'", resp.text)
        if not o_match:
            print(f"  [fast-gadgetsweb] no 'o' value found")
            return None

        hblinks_url = _decode_gadgetsweb_o_value(o_match.group(1))
        if not hblinks_url:
            print(f"  [fast-gadgetsweb] could not decode 'o' value")
            return None

        print(f"  [fast-gadgetsweb] hblinks URL: {hblinks_url}")
        return _fast_resolve_hblinks(hblinks_url)

    except Exception as exc:
        print(f"  [fast-gadgetsweb] failed: {exc}")
        return None


# ── Public entry point ────────────────────────────────────────────────────────

def resolve_direct_link(url: str, **kwargs) -> Optional[dict]:
    """
    Resolve any supported download page URL to a direct media URL.
    Tries fast HTTP resolvers in order. Returns None if unsupported.
    """
    if not url:
        return None

    if "hubcloud" in url:
        return _fast_resolve_hubcloud(url)
    if "hubdrive" in url:
        return _fast_resolve_hubdrive(url)
    if "gadgetsweb" in url:
        return _fast_resolve_gadgetsweb(url)
    if "hblinks" in url:
        return _fast_resolve_hblinks(url)

    print(f"  [resolver] unsupported URL type: {url[:80]}")
    return {"error": f"No resolver available for: {url[:80]}"}


def shutdown_pool():
    """No-op — kept for compatibility with app.py atexit hook."""
    pass


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    import argparse

    parser = argparse.ArgumentParser(description="Resolve a download page to a direct media URL")
    parser.add_argument("url", help="HubCloud / HubDrive / GadgetsWeb / hblinks URL")
    parser.add_argument("--fast-only", action="store_true", help="(ignored, kept for compatibility)")
    args = parser.parse_args()

    result = resolve_direct_link(args.url)
    if result and result.get("url"):
        print(json.dumps(result, indent=2))
    else:
        print("No direct media URL found.")
        if result and result.get("error"):
            print("Error:", result["error"])
        sys.exit(1)
