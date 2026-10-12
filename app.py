"""Local server for Flight Vector 2."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import webbrowser


ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8766


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    url = f"http://{HOST}:{PORT}"
    print(f"Flight Vector 2: {url}")
    webbrowser.open(url)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
