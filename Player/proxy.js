/**
 * Netwatch Stream Proxy
 *
 * Local HTTP proxy for the player. It adds browser-safe CORS headers,
 * forwards Referer/Origin, preserves Range requests for seeking, and follows
 * short redirect chains before piping the media response back to the browser.
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = Number(process.env.NETWATCH_PROXY_PORT || 9999);
const MAX_REDIRECTS = 5;

const ALLOWED_ORIGINS = [
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'http://127.0.0.1:8080',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://127.0.0.1:5000',
    'http://localhost:5000',
    'null',
];

function corsOriginFor(req) {
    const origin = req.headers.origin || '';
    return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function applyCors(res, corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');
}

function proxiedUrlFor(mediaUrl, referer) {
    const proxied = new URL('/proxy', `http://127.0.0.1:${PORT}`);
    proxied.searchParams.set('url', mediaUrl);
    if (referer) proxied.searchParams.set('referer', referer);
    return proxied.toString();
}

function rewriteM3u8(body, currentTarget, referer) {
    const baseUrl = new URL('.', currentTarget).toString();
    return body.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const absolute = trimmed.startsWith('http://') || trimmed.startsWith('https://')
            ? trimmed
            : new URL(trimmed, baseUrl).toString();
        return proxiedUrlFor(absolute, referer);
    }).join('\n');
}

function responseHeadersFor(proxyRes, corsOrigin) {
    const passHeaders = {};
    [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'cache-control',
        'last-modified',
        'etag',
    ].forEach(header => {
        if (proxyRes.headers[header]) passHeaders[header] = proxyRes.headers[header];
    });

    if (proxyRes.headers['content-range'] && !passHeaders['accept-ranges']) {
        passHeaders['accept-ranges'] = 'bytes';
    }

    passHeaders['Access-Control-Allow-Origin'] = corsOrigin;
    passHeaders['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Content-Type, Accept-Ranges';
    return passHeaders;
}

const server = http.createServer((req, res) => {
    const corsOrigin = corsOriginFor(req);
    applyCors(res, corsOrigin);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method !== 'GET') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
    }

    const parsed = url.parse(req.url, true);

    if (parsed.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '2.0' }));
        return;
    }

    if (parsed.pathname !== '/proxy') {
        res.writeHead(404);
        res.end('Not found. Use /proxy?url=...&referer=...');
        return;
    }

    const targetUrl = parsed.query.url;
    const referer = parsed.query.referer || '';

    if (!targetUrl) {
        res.writeHead(400);
        res.end('Missing ?url= parameter');
        return;
    }

    let target;
    try {
        target = new URL(targetUrl);
        if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Bad protocol');
    } catch (err) {
        res.writeHead(400);
        res.end('Invalid URL');
        return;
    }

    const forwardHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
    };

    if (referer) {
        forwardHeaders.Referer = referer;
        try {
            forwardHeaders.Origin = new URL(referer).origin;
        } catch (err) {
            // Some callers may send a non-standard referer. It is still safe to continue.
        }
    }

    if (req.headers.range) {
        forwardHeaders.Range = req.headers.range;
    }

    function requestTarget(currentTarget, redirectCount = 0) {
        const lib = currentTarget.protocol === 'https:' ? https : http;
        const proxyReq = lib.request(
            {
                hostname: currentTarget.hostname,
                port: currentTarget.port || (currentTarget.protocol === 'https:' ? 443 : 80),
                path: currentTarget.pathname + currentTarget.search,
                method: 'GET',
                headers: forwardHeaders,
            },
            proxyRes => {
                const location = proxyRes.headers.location;
                if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && location && redirectCount < MAX_REDIRECTS) {
                    proxyRes.resume();
                    try {
                        requestTarget(new URL(location, currentTarget), redirectCount + 1);
                    } catch (err) {
                        if (!res.headersSent) {
                            res.writeHead(502);
                            res.end(`Bad redirect URL: ${err.message}`);
                        }
                    }
                    return;
                }

                const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
                const isM3u8 = contentType.includes('mpegurl')
                    || contentType.includes('m3u8')
                    || currentTarget.pathname.toLowerCase().endsWith('.m3u8');
                const passHeaders = responseHeadersFor(proxyRes, corsOrigin);

                if (isM3u8) {
                    let body = '';
                    proxyRes.setEncoding('utf8');
                    proxyRes.on('data', chunk => { body += chunk; });
                    proxyRes.on('end', () => {
                        delete passHeaders['content-length'];
                        passHeaders['content-type'] = 'application/vnd.apple.mpegurl';
                        res.writeHead(proxyRes.statusCode, passHeaders);
                        res.end(rewriteM3u8(body, currentTarget, referer));
                    });
                    return;
                }

                res.writeHead(proxyRes.statusCode, passHeaders);
                proxyRes.pipe(res);
            },
        );

        proxyReq.on('error', err => {
            console.error(`[Proxy] Error fetching ${currentTarget.toString()}:`, err.message);
            if (!res.headersSent) {
                res.writeHead(502);
                res.end(`Proxy error: ${err.message}`);
            }
        });

        req.on('close', () => proxyReq.destroy());
        proxyReq.end();
    }

    requestTarget(target);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Netwatch Stream Proxy running at http://127.0.0.1:${PORT}`);
    console.log(`Use http://127.0.0.1:${PORT}/proxy?url=<stream_url>&referer=<referer_url>`);
});

server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Kill the existing process or change NETWATCH_PROXY_PORT.`);
    } else {
        console.error('Server error:', err);
    }
    process.exit(1);
});
