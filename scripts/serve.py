#!/usr/bin/env python3
"""本地开发服务器：禁缓存（防止浏览器缓存 index.html/js 导致新旧版本混跑）。
用法: python3 scripts/serve.py [端口，默认 8377]"""
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8377


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(
        ("", PORT), NoCacheHandler).serve_forever()
