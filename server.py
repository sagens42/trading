#!/usr/bin/env python3
"""Serve the BTC option odds page and proxy Bybit's public market API.

Use this when the browser can't call api.bybit.com directly (CORS or network).
    python3 server.py            # then open http://localhost:8000
    python3 server.py --port 9000
Only GET /bybit/v5/market/... is forwarded; no API keys are involved.
"""
import argparse
import http.server
import os
import re
import urllib.parse
import urllib.request

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
ALLOWED_HOSTS = {"api.bybit.com", "api.bytick.com", "api.bybit.nl", "api.bybit.eu", "api.bybit-tr.com", "api.bybitglobal.com"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def do_GET(self):
        if not self.path.startswith("/bybit/"):
            return super().do_GET()
        url = urllib.parse.urlsplit(self.path[len("/bybit"):])
        if not re.fullmatch(r"/v5/market/[a-z-]+", url.path):
            return self.send_error(404)
        query = urllib.parse.parse_qsl(url.query)
        host = next((v for k, v in query if k == "host"), "api.bybit.com")
        if host not in ALLOWED_HOSTS:
            return self.send_error(400, "host not allowed")
        qs = urllib.parse.urlencode([(k, v) for k, v in query if k != "host"])
        req = urllib.request.Request(f"https://{host}{url.path}?{qs}", headers={"User-Agent": "btc-option-odds/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                body, status = r.read(), r.status
        except urllib.error.HTTPError as e:
            body, status = e.read(), e.code
        except Exception as e:  # network failure
            return self.send_error(502, str(e))
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    print(f"Serving on http://{args.host}:{args.port}  (demo: http://{args.host}:{args.port}/?demo=1)")
    http.server.ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
