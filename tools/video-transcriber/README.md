# Optional local video transcription service for doremy.float.phone

This optional bridge is the self-hosted transcription fallback, not the built-in playback resolver. “Watch Together” can send a video URL to a computer/server you control, then import timestamped JSON script segments. The main app's built-in video resolver handles supported playback URLs separately; successful playback does not mean transcription or full video understanding is available. It now tries platform-provided/manual/automatic captions first; when usable captions exist, it converts them into timestamped JSON and skips audio download and Whisper inference. Only when captions are unavailable does it download audio, run FFmpeg conversion and faster-whisper locally. The app does not send links to a third-party parsing API.

Upstream CLI: https://github.com/quanji081/video-transcriber. The original CLI and MIT license are retained in this folder. Its stated platform support remains subject to authentication, network restrictions, anti-bot measures and upstream platform changes.

## Install with Python

Requirements: Python 3.10+, FFmpeg, and enough RAM for the selected Whisper model.

From the repository root:

~~~bash
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -r tools/video-transcriber/requirements.txt
~~~

Set a random bearer token and start the service:

~~~bash
# Linux/macOS
export VIDEO_TRANSCRIBER_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export VIDEO_TRANSCRIBER_ALLOWED_ORIGINS="https://your-web-app.example"
python tools/video-transcriber/server.py --host 127.0.0.1 --port 8766
~~~

Windows PowerShell:

~~~powershell
$env:VIDEO_TRANSCRIBER_TOKEN = (python -c "import secrets; print(secrets.token_urlsafe(32))")
$env:VIDEO_TRANSCRIBER_ALLOWED_ORIGINS = "https://your-web-app.example"
python tools/video-transcriber/server.py --host 127.0.0.1 --port 8766
~~~

The first transcription may download the model. Later runs reuse the local model cache. Optional environment variables:

- VIDEO_TRANSCRIBER_DEVICE=auto, cpu or cuda (default auto).
- VIDEO_TRANSCRIBER_TIMEOUT_SECONDS=3600 (max 7200 seconds).
- VIDEO_TRANSCRIBER_COOKIES=/secure/path/cookies.txt: optional Netscape cookie file on the service host. Cookies are never passed through the web UI; do not commit them to Git.
- VIDEO_TRANSCRIBER_ALLOWED_ORIGINS: comma-separated exact browser Origin allowlist.

## Docker

From the repository root:

~~~bash
docker build -f tools/video-transcriber/Dockerfile -t doremy-video-transcriber .
docker run --rm -p 8766:8766 \
  -e VIDEO_TRANSCRIBER_TOKEN="replace-with-a-long-random-token" \
  -e VIDEO_TRANSCRIBER_ALLOWED_ORIGINS="https://your-web-app.example" \
  -e VIDEO_TRANSCRIBER_HOST=0.0.0.0 \
  -v video-transcriber-models:/models \
  doremy-video-transcriber
~~~

Model cache persists in the /models volume. The first setup still needs internet access to download packages/model data.

## Use it from the app

Open “Watch Together → Timestamp script · local transcription service”, fill the service URL and token, paste a video URL, then press “Parse link and generate script”. The service returns JSON segments compatible with the app’s existing SRT/VTT/JSON parser. When playback advances, the character prompt uses only script text near the current time; it does not attach screenshots.

- A browser on an HTTPS page normally blocks a plain HTTP service on a LAN. For phone use, expose the service through a trusted HTTPS reverse proxy/VPN, then add the exact web-app Origin to the allowlist.
- The service binds to 127.0.0.1 by default. Do not expose an unauthenticated or plain-HTTP service to the public internet. When binding to 0.0.0.0, use the token, firewall, TLS reverse proxy/VPN and strict Origin allowlist.
- Localhost, private IP addresses, and .local-style targets are rejected to reduce SSRF risk. Only process videos you own or are authorized to access. The bridge does not bypass region, membership or login restrictions.
- Subtitle-first behavior depends on the platform exposing captions through yt-dlp. If no suitable captions are available, the service falls back to audio download and local Whisper; this still requires the service machine to be online and running.
- Some platforms require cookies or may return anti-bot errors. If the script fails, you can still import .srt, .vtt, .txt or .json manually in the app.
- This bridge is the optional self-hosted fallback, not a Cloudflare-hosted service. It does not make the user's computer unnecessary; a Cloudflare Workers AI/container deployment is a separate deployment step and is not automatically created by this repository.

See the upstream project README for detailed platform notes.