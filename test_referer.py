import requests

# Test the master.m3u8 first to get a fresh sub-playlist URL
master = "https://hdstream4u.com/stream/0KQuToJExHJixJcftG4IAg/hjkrhuihghfvu/1779856286/41248487/master.m3u8"
h = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"}
r = requests.get(master, headers=h, timeout=10)
print(f"master.m3u8: {r.status_code}")
if r.status_code == 200:
    print(r.text[:300])

# Test sub-playlist with browser-like headers
sub = "https://hdstream4u.com/stream/0KQuToJExHJixJcftG4IAg/hjkrhuihghfvu/1779856286/41248487/index-f1-v1-a1.m3u8"
browser_headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://hdstream4u.com",
    "Referer": "https://hdstream4u.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}
r2 = requests.get(sub, headers=browser_headers, timeout=10)
print(f"\nsub with full browser headers: {r2.status_code}")
if r2.status_code == 200:
    print(r2.text[:200])
else:
    print(r2.text[:200])

# Check CORS headers on master
print(f"\nCORS headers on master: {dict(r.headers)}")
