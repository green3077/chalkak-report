import http.server
import socket
import sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8794

GITHUB_PAGES_URL = "https://green3077.github.io/chalkak-report/"


def get_lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


lan_ip = get_lan_ip()
print(f"내부망(같은 Wi-Fi, 휴대폰 테스트용): http://{lan_ip}:{port}")
print(f"외부(GitHub Pages, 별도 배포본):     {GITHUB_PAGES_URL}")
print()

http.server.test(HandlerClass=NoCacheHandler, port=port, bind="0.0.0.0")
