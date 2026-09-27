import http.server, urllib.parse, sys, os

os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        if self.path.startswith('/client-log'):
            query = urllib.parse.urlparse(self.path).query
            print("CLIENT_LOG:", urllib.parse.unquote(query), flush=True)
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b"ok")
            return
        super().do_GET()

    def log_message(self, format, *args):
        print("HTTP:", format % args, flush=True)

http.server.HTTPServer(('0.0.0.0', 8088), Handler).serve_forever()
