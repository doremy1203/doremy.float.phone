#!/usr/bin/env python3
"""Authenticated local HTTP bridge for video-transcriber."""
from __future__ import annotations

import hmac
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "vendor" / "transcribe_video.py"
TOKEN = os.environ.get("VIDEO_TRANSCRIBER_TOKEN", "")
ALLOWED_MODELS = {"tiny", "base", "small", "medium", "large-v3", "turbo"}
ALLOWED_DEVICES = {"auto", "cpu", "cuda"}
MAX_BODY = 16 * 1024
TRANSCRIBE_LOCK = threading.Lock()
DEFAULT_LOCAL_ORIGINS = {
    "http://localhost:3000", "http://127.0.0.1:3000",
    "http://localhost:5173", "http://127.0.0.1:5173",
}


def allowed_origins() -> set[str]:
    raw = os.environ.get("VIDEO_TRANSCRIBER_ALLOWED_ORIGINS", "")
    configured = {item.strip().rstrip("/") for item in raw.split(",") if item.strip()}
    return configured or DEFAULT_LOCAL_ORIGINS


def is_public_video_url(value: str) -> bool:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        return False
    host = parsed.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain"} or host.endswith((".local", ".internal", ".lan")):
        return False
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return False
    try:
        address = ipaddress.ip_address(host)
        return address.is_global
    except ValueError:
        pass
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)}
    except OSError:
        return False
    return bool(addresses) and all(ipaddress.ip_address(address).is_global for address in addresses)


class Handler(BaseHTTPRequestHandler):
    server_version = "FloatPhoneTranscriptBridge/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        # Avoid logging URLs, cookies, bearer tokens or transcript contents.
        print("transcriber-bridge:", fmt % args)

    def _cors_ok(self) -> bool:
        origin = self.headers.get("Origin", "").rstrip("/")
        return not origin or origin in allowed_origins()

    def _send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "").rstrip("/")
        if origin and origin in allowed_origins():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        if not self._cors_ok():
            self._send_json(403, {"ok": False, "error": "Origin is not allowed."})
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        origin = self.headers.get("Origin", "").rstrip("/")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/health":
            self._send_json(404, {"ok": False, "error": "Not found."})
            return
        if not self._cors_ok():
            self._send_json(403, {"ok": False, "error": "Origin is not allowed."})
            return
        self._send_json(200, {"ok": True, "service": "video-transcriber", "models": sorted(ALLOWED_MODELS)})

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/transcribe":
            self._send_json(404, {"ok": False, "error": "Not found."})
            return
        if not self._cors_ok():
            self._send_json(403, {"ok": False, "error": "Origin is not allowed."})
            return
        if not TOKEN or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN):
            self._send_json(401, {"ok": False, "error": "Missing or invalid service token."})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if size <= 0 or size > MAX_BODY:
            self._send_json(413, {"ok": False, "error": "Request body must be between 1 byte and 16 KB."})
            return
        try:
            body = json.loads(self.rfile.read(size))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"ok": False, "error": "Invalid JSON body."})
            return
        if not isinstance(body, dict):
            self._send_json(400, {"ok": False, "error": "JSON body must be an object."})
            return
        source_url = body.get("url")
        if not isinstance(source_url, str) or len(source_url) > 4096 or not is_public_video_url(source_url):
            self._send_json(400, {"ok": False, "error": "Provide a public http(s) video URL; localhost and private-network targets are blocked."})
            return
        model = body.get("model", "small")
        if model not in ALLOWED_MODELS:
            self._send_json(400, {"ok": False, "error": "Unsupported model."})
            return
        language = body.get("language", "zh")
        if language is not None and (not isinstance(language, str) or not re.fullmatch(r"[A-Za-z-]{2,12}", language)):
            self._send_json(400, {"ok": False, "error": "Invalid language code."})
            return
        device = os.environ.get("VIDEO_TRANSCRIBER_DEVICE", "auto")
        if device not in ALLOWED_DEVICES:
            device = "auto"
        try:
            timeout = max(60, min(7200, int(os.environ.get("VIDEO_TRANSCRIBER_TIMEOUT_SECONDS", "3600"))))
        except ValueError:
            timeout = 3600
        cookies = os.environ.get("VIDEO_TRANSCRIBER_COOKIES", "").strip()

        if not TRANSCRIBE_LOCK.acquire(blocking=False):
            self._send_json(429, {"ok": False, "error": "Another transcription is running; retry when it finishes."})
            return
        try:
            with tempfile.TemporaryDirectory(prefix="floatphone-transcript-") as temp_dir:
                command = [
                    sys.executable, str(SCRIPT), source_url,
                    "--output-dir", temp_dir, "--formats", "json",
                    "--model", model, "--device", device,
                ]
                if language:
                    command.extend(["--language", language])
                if cookies:
                    cookie_path = Path(cookies).expanduser().resolve()
                    if not cookie_path.is_file():
                        self._send_json(500, {"ok": False, "error": "Configured cookie file does not exist on the server."})
                        return
                    command.extend(["--cookies", str(cookie_path)])
                try:
                    process = subprocess.run(command, cwd=temp_dir, capture_output=True, text=True, timeout=timeout, check=False)
                except subprocess.TimeoutExpired:
                    self._send_json(504, {"ok": False, "error": "Transcription timed out; try a smaller model or a shorter public video."})
                    return
                if process.returncode != 0:
                    detail = (process.stderr or process.stdout or "Transcriber process failed.").strip()[-1400:]
                    self._send_json(502, {"ok": False, "error": detail})
                    return
                output_files = sorted(Path(temp_dir).glob("*.json"))
                if not output_files:
                    self._send_json(502, {"ok": False, "error": "Transcriber completed without producing JSON segments."})
                    return
                with output_files[0].open("r", encoding="utf-8") as stream:
                    transcript = json.load(stream)
                parsed = urlsplit(source_url)
                title = Path(parsed.path).name or parsed.hostname or "视频脚本"
                self._send_json(200, {"ok": True, "title": title, "transcript": transcript})
        finally:
            TRANSCRIBE_LOCK.release()


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description="Authenticated local HTTP bridge for video-transcriber")
    parser.add_argument("--host", default=os.environ.get("VIDEO_TRANSCRIBER_HOST", "127.0.0.1"))
    parser.add_argument("--port", default=int(os.environ.get("VIDEO_TRANSCRIBER_PORT", "8766")), type=int)
    args = parser.parse_args()
    if len(TOKEN) < 24:
        parser.error("Set VIDEO_TRANSCRIBER_TOKEN to a random secret with at least 24 characters.")
    if not SCRIPT.is_file():
        parser.error("Missing vendored CLI: " + str(SCRIPT))
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"Video transcriber bridge listening on {args.host}:{args.port}")
    print("Allowed browser origins:", ", ".join(sorted(allowed_origins())))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping transcriber bridge.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
