# Netwatch Player

Advanced stream player built to match the Netwatch streaming-app design system.

## Files

```
Player/
├── index.html          — Main player page
├── history.html        — Continue Watching history page
├── css/
│   └── player.css      — Full design system (mirrors streaming-app tokens)
└── js/
    ├── player.js           — Core player engine
    ├── subtitle-parser.js  — VTT + SRT parser with styled overlay
    ├── stream-cache.js     — Stream URL + metadata cache (localStorage)
    ├── continue-watching.js— Resume progress (syncs with streaming-app)
    └── episode-manager.js  — TV series playlist + auto-next
```

## Features

| Feature | Details |
|---|---|
| **HLS** | hls.js with adaptive bitrate, error recovery, buffer config |
| **DASH** | Shaka Player with ABR, retry logic |
| **MP4 / Direct** | Native HTML5 video |
| **Multi-Quality** | Auto + manual level selection per stream |
| **Audio Language** | Track selector for HLS audio groups / DASH languages |
| **Subtitles** | VTT + SRT parser, custom URL loader, styled overlay |
| **Stream Cache** | Stores last 20 streams with metadata in localStorage |
| **Continue Watching** | Saves position every 5s, syncs with streaming-app's localStorage keys |
| **Auto-Next Episode** | Triggers 30s before end, 5s countdown ring, cancel option |
| **Episode Playlist** | Prev/Next buttons, playlist via `?playlist=[...]` URL param |
| **Keyboard Shortcuts** | See table below |
| **Touch Gestures** | Swipe horizontal = seek, swipe vertical = volume, double-tap = ±10s |
| **PiP** | Picture-in-Picture via browser API |
| **Fullscreen** | Native fullscreen API |
| **Stats Panel** | Buffer health, bandwidth, dropped frames, resolution |
| **Controls Auto-hide** | Hides after 3.5s of inactivity |

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `→` / `←` | Skip ±10s |
| `Shift+→` / `Shift+←` | Skip ±30s |
| `↑` / `↓` | Volume ±10% |
| `M` | Mute toggle |
| `F` | Fullscreen |
| `C` | Subtitle toggle |
| `Q` | Open quality settings |
| `S` | Open speed settings |
| `P` | Picture-in-Picture |
| `N` | Next episode (TV) |
| `B` | Previous episode (TV) |
| `0–9` | Jump to 0%–90% of video |
| `Esc` | Close settings / exit fullscreen |

## URL Parameters

Launch the player directly with a stream:

```
index.html?src=https://...stream.m3u8&title=Movie+Name&type=movie&year=2024
index.html?src=https://...stream.m3u8&title=Show&type=tv&season=1&episode=3&sub=https://...subs.vtt
```

| Param | Description |
|---|---|
| `src` | Stream URL (HLS/DASH/MP4) |
| `title` | Display title |
| `type` | `movie` or `tv` |
| `year` | Release year |
| `season` | Season number (TV) |
| `episode` | Episode number (TV) |
| `sub` | Subtitle URL (VTT or SRT) |
| `poster` | Poster/thumbnail image URL |
| `id` | Unique ID for continue-watching (defaults to src) |
| `playlist` | JSON-encoded episode array for TV series |

## Continue Watching Sync

The player reads and writes to the same localStorage keys as the streaming-app:
- `netwatch_continue_main`
- `netwatch_continue_kids`
- `netwatch_active_profile`

So progress saved in the player appears in the streaming-app's Continue Watching row automatically.

## Episode Playlist Format

```json
[
  { "src": "https://.../s01e01.m3u8", "title": "Show S1E1", "type": "tv", "season": 1, "episode": 1 },
  { "src": "https://.../s01e02.m3u8", "title": "Show S1E2", "type": "tv", "season": 1, "episode": 2 }
]
```

Pass as: `?playlist=<URL-encoded JSON>&src=<current episode src>`
