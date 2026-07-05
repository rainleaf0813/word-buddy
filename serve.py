# 本機開發用靜態伺服器：python3 serve.py
import os
import http.server
import socketserver

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

PORT = 8899


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f'Serving {ROOT} at http://127.0.0.1:{PORT}')
    httpd.serve_forever()
