#!/usr/bin/env python3
"""Doremy 本地视频解析服务 —— 纯标准库实现（Android / DSH 环境可用）。

与上游 tools/video-resolver/app.py 的 HTTP 契约保持一致：
  GET    /health                 健康检查
  POST   /api/resolve            解析并下载视频
  GET    /api/videos/{id}        取回本地缓存视频（支持 Range）
  DELETE /api/videos/{id}        删除缓存

上游用 fastapi + pydantic（需要 Rust/C 编译，Android 装不上），
这里用 http.server + yt-dlp 复刻同一套接口与字段。
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlparse
from urllib.request import Request, urlopen

import yt_dlp

ROOT = Path(os.environ.get("VIDEO_RESOLVER_CACHE", Path.home() / ".doremy-video-cache")).expanduser().resolve()
ROOT.mkdir(parents=True, exist_ok=True)
MAX_BYTES = max(50, int(os.environ.get("VIDEO_RESOLVER_MAX_MB", "2048"))) * 1024 * 1024
API_TOKEN = os.environ.get("VIDEO_RESOLVER_TOKEN", "").strip()
HOST = os.environ.get("VIDEO_RESOLVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("VIDEO_RESOLVER_PORT", "8765"))
VERSION = "1.3.0"

INDEX_FILE = ROOT / "index.json"
JOBS: dict[str, dict] = {}
LOCK = threading.Lock()

SHORT_LINK_HOSTS = ("xhslink.cn", "xhslink.com", "b23.tv", "v.douyin.com")
PARSE_FIRST_HOSTS = (
    "douyin.com", "iesdouyin.com", "kuaishou.com", "gifshow.com",
    "xiaohongshu.com", "xhslink.com", "xhslink.cn", "pipix.com", "huoshan.com",
    "ixigua.com", "weishi.qq.com", "zuiyou.com",
)
UA_MOBILE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
             "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
UA_DESKTOP = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126 Safari/537.36")


class HttpError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def validate_url(value: str) -> str:
    parsed = urlparse((value or "").strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HttpError(400, "只支持 http/https 视频链接")
    host = parsed.hostname.lower().rstrip(".")
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
        raise HttpError(400, "不允许访问本机或局域网地址")
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80),
                                   type=socket.SOCK_STREAM)
        for info in infos:
            addr = ipaddress.ip_address(info[4][0])
            # 本机代理的 Fake-IP 模式会把域名解析到 198.18.0.0/15（RFC2544 基准网段），
            # 这类地址实际映射的是公网域名，不能当成内网拒绝。
            if addr.is_global or addr in ipaddress.ip_network("198.18.0.0/15"):
                continue
            raise HttpError(400, "不允许解析内网或保留地址")
    except HttpError:
        raise
    except OSError:
        raise HttpError(400, "无法解析链接域名")
    return value.strip()


def expand_short_url(url: str) -> str:
    """短链先展开成正式地址，顺带保留 xsec_token 等分享参数。网络抖动时重试一次。"""
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    if host not in SHORT_LINK_HOSTS:
        return url
    last: Exception | None = None
    for _attempt in range(2):
        try:
            current = url
            for _hop in range(5):
                req = Request(current, headers={"User-Agent": UA_MOBILE})
                with urlopen(req, timeout=15) as resp:  # noqa: S310 - 已在 validate_url 中限制
                    status = resp.status
                    location = resp.headers.get("Location")
                if status in (301, 302, 303, 307, 308) and location:
                    current = urljoin(current, location)
                    continue
                break
            return validate_url(current) if current != url else url
        except HttpError:
            raise
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise HttpError(504, f"短链展开失败（{type(last).__name__}: {str(last)[:80]}）。网络抖动时常见，请重试一次；仍然失败就换成不经过短链的完整链接。")
def ydl_options(outtmpl: str, quality: str, cookiefile: str | None = None) -> dict:
    height = {"1080": 1080, "720": 720, "480": 480, "360": 360}.get(quality)
    # 手机端优先 H.264：B 站默认给 AV1，部分机型/WebView 硬解不了，会表现为“点了没反应/黑屏”。
    h = f"[height<={height}]" if height else ""
    if shutil.which("ffmpeg"):
        fmt = (
            f"bestvideo{h}[vcodec^=avc1]+bestaudio[acodec^=mp4a]/"
            f"bestvideo{h}[vcodec^=avc1]+bestaudio/"
            f"bestvideo{h}+bestaudio/"
            f"best{h}/best"
        )
    else:
        fmt = (
            f"best{h}[vcodec^=avc1]/best{h}/best"
        )
    return {
        "format": fmt,
        "outtmpl": outtmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 25,
        "max_filesize": MAX_BYTES,
        "merge_output_format": "mp4",
        "cookiefile": cookiefile,
        "http_headers": {"User-Agent": UA_DESKTOP},
    }


def _load_index() -> dict[str, dict]:
    try:
        data = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _save_index(index: dict[str, dict]) -> None:
    try:
        tmp = INDEX_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
        tmp.replace(INDEX_FILE)
    except OSError:
        pass


def cache_key(url: str, quality: str) -> str:
    return hashlib.sha1((url + "\n" + quality).encode("utf-8")).hexdigest()[:20]


def cleanup_old() -> None:
    # 本地缓存长期保留；只按总容量淘汰最久未访问的文件，不再 24 小时后无条件删除。
    cutoff = 0
    total = 0
    try:
        paths = sorted(ROOT.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0)
    except OSError:
        return
    for path in paths:
        if not path.is_file():
            continue
        try:
            if path.stat().st_mtime < cutoff or total > MAX_BYTES:
                path.unlink(missing_ok=True)
            else:
                total += path.stat().st_size
        except OSError:
            pass
    try:
        index = _load_index()
        stale = [key for key, item in index.items() if not (ROOT / str(item.get("file", ""))).is_file()]
        if stale:
            for key in stale:
                index.pop(key, None)
            _save_index(index)
    except Exception:  # noqa: BLE001
        pass


XHS_HOSTS = ("xiaohongshu.com", "xhslink.com", "xhslink.cn")


def _xhs_cookie_header(cookies_text: str | None) -> str:
    """把 Netscape 格式 cookies 里属于小红书的部分转成 Cookie 请求头。"""
    if not cookies_text:
        return ""
    pairs = []
    for line in cookies_text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, _flag, _path, _secure, _expiry, name, value = parts[:7]
        if "xiaohongshu" not in domain:
            continue
        pairs.append(f"{name}={value}")
    return "; ".join(pairs)


def _xhs_page(url: str, cookie_header: str) -> str:
    headers = {"User-Agent": UA_MOBILE, "Accept-Language": "zh-CN,zh;q=0.9"}
    if cookie_header:
        headers["Cookie"] = cookie_header
    with urlopen(Request(url, headers=headers), timeout=25) as resp:  # noqa: S310
        final = resp.geturl()
        html = resp.read().decode("utf-8", "replace")
    if "/login" in final:
        raise HttpError(422, "小红书要求登录：请在「一起看 → 设置 → 平台 Cookies」粘贴小红书 cookies 后重试")
    # 注意：不能直接匹配 "sec_"，正常链接里的 xsec_token 也会命中。
    if "/404/" in final or "/sec_" in final or "你访问的页面不见了" in html or "页面不见了" in html:
        raise HttpError(422, "小红书笔记打不开：链接可能已失效或缺 xsec_token。请用 App 里「分享 → 复制链接」得到的完整链接（xhslink 短链会自动展开）")
    return html


def _xhs_master_url(html: str) -> tuple[str, str]:
    match = re.search(r'"masterUrl"\s*:\s*"((?:[^"\\]|\\.)*)"', html)
    if not match:
        if '"imageList"' in html or '"noteType":"normal"' in html or '"type":"normal"' in html:
            raise HttpError(422, "这是小红书的图文笔记，没有视频可下载")
        raise HttpError(422, "没能从小红书页面里找到视频直链（可能需要登录，或平台改了页面结构）")
    try:
        direct = json.loads('"' + match.group(1) + '"')
    except Exception:  # noqa: BLE001
        raise HttpError(422, "小红书视频直链解析失败")
    if not direct.startswith(("http://", "https://")):
        raise HttpError(422, "小红书返回的视频直链不合法")
    title_match = (re.search(r'<meta[^>]+name="og:title"[^>]+content="([^"]*)"', html)
                   or re.search(r"<title[^>]*>([^<]*)</title>", html))
    title = (title_match.group(1) if title_match else "").replace("_小红书", "").strip(" -")
    return direct, title


def _download_xhs(url: str, target_dir: Path, cookie_header: str) -> str:
    """小红书：页面里直接提取 masterUrl 再下载，绕开 yt-dlp（它没有小红书 extractor）。"""
    html = _xhs_page(url, cookie_header)
    direct, title = _xhs_master_url(html)
    headers = {"User-Agent": UA_MOBILE, "Referer": "https://www.xiaohongshu.com/"}
    if cookie_header:
        headers["Cookie"] = cookie_header
    dest = target_dir / "video.mp4"
    written = 0
    with urlopen(Request(direct, headers=headers), timeout=180) as resp, open(dest, "wb") as fh:  # noqa: S310
        while True:
            chunk = resp.read(1 << 18)
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_BYTES:
                raise HttpError(422, "视频超过本地缓存大小限制")
            fh.write(chunk)
    if written < 1024:
        raise HttpError(422, "小红书视频下载内容异常（过小）")
    return title


def _netscape_cookie_count(text: str | None) -> int:
    """数一下用户到底贴了几条有效 cookie（Netscape 格式每行 7 列）。"""
    if not text:
        return 0
    return sum(1 for line in text.splitlines() if not line.startswith("#") and len(line.split("\t")) >= 7)


def _download(url: str, options: dict) -> None:
    with yt_dlp.YoutubeDL(options) as ydl:
        ydl.download([url])


def resolve_video(body: dict) -> dict:
    url = validate_url(str(body.get("url") or ""))
    quality = str(body.get("quality") or "best")
    if quality not in ("best", "1080", "720", "480", "360"):
        raise HttpError(422, "quality 只能是 best/1080/720/480/360")
    url = expand_short_url(url)
    job_id = cache_key(url, quality)
    index = _load_index()
    existing = index.get(job_id)
    if existing:
        cached_path = ROOT / str(existing.get("file", ""))
        try:
            if cached_path.is_file() and cached_path.stat().st_size > 1024:
                with LOCK:
                    JOBS[job_id] = {
                        "state": "ready", "file": cached_path.name,
                        "title": existing.get("title", cached_path.stem),
                        "size": cached_path.stat().st_size,
                        "engine": existing.get("engine", "cache"),
                        "created": existing.get("created", time.time()),
                    }
                return {
                    "ok": True, "id": job_id, "title": existing.get("title", cached_path.stem),
                    "size": cached_path.stat().st_size,
                    "mime": "video/mp4" if cached_path.suffix.lower() in (".mp4", ".m4v") else "video/" + cached_path.suffix.lower()[1:],
                    "engine": existing.get("engine", "cache"),
                    "cacheHit": True,
                    "downloadUrl": f"/api/videos/{job_id}",
                }
        except OSError:
            pass
        index.pop(job_id, None)
    with LOCK:
        JOBS[job_id] = {"state": "downloading", "message": "正在获取视频并保存到本地", "created": time.time()}

    import tempfile
    tempdir = Path(tempfile.mkdtemp(prefix="doremy-", dir=ROOT))
    cookie_path = None
    try:
        cookies = body.get("cookies")
        if isinstance(cookies, str) and cookies.strip():
            cookie_path = tempdir / "cookies.txt"
            cookie_path.write_text(cookies, encoding="utf-8")
        output = str(tempdir / "video.%(ext)s")
        opts = ydl_options(output, quality, str(cookie_path) if cookie_path else None)
        failures: list[str] = []
        engine_used = "yt-dlp"
        video_title = ""
        host = (urlparse(url).hostname or "").lower().removeprefix("www.")
        cookies_text = cookies if isinstance(cookies, str) else None
        if any(host == suffix or host.endswith("." + suffix) for suffix in XHS_HOSTS):
            engine_used = "xiaohongshu"
            video_title = _download_xhs(url, tempdir, _xhs_cookie_header(cookies_text))
        else:
            try:
                _download(url, opts)
            except Exception as exc:  # noqa: BLE001
                message = str(exc)
                low = message.lower()
                if ("douyin" in host or "iesdouyin" in host) and ("cookie" in low or "uifid" in low or "argus" in low):
                    # 实测（2026-10）：抖音 web 接口要 a_bogus 请求签名，由浏览器 JS 现场计算，
                    # yt-dlp 没有实现；带不带 cookies 都会被 Argus 拦，所以直接给出可用替代方案。
                    cookie_count = _netscape_cookie_count(cookies_text)
                    prefix = f"已收到 {cookie_count} 条 cookies，但" if cookie_count else ""
                    raise HttpError(422, prefix + "抖音拒绝了这次请求：它现在要求 a_bogus 请求签名（浏览器 JS 现场计算），yt-dlp 无法生成，粘贴 cookies 也基本无效。最稳的做法是在抖音 App 里把视频保存到相册，再用一起看的「选择本地视频」播放。")
                failures.append("yt-dlp: " + message[:180])

        media = next((p for p in tempdir.iterdir()
                      if p.is_file() and p.name != "cookies.txt" and p.stat().st_size > 1024), None)
        if media is None:
            raise RuntimeError("解析引擎没有返回可播放的视频文件。 " + "；".join(failures))
        if media.stat().st_size > MAX_BYTES:
            raise RuntimeError("视频超过本地缓存大小限制")
        suffix = media.suffix.lower()
        if suffix not in (".mp4", ".webm", ".mkv", ".mov", ".m4v"):
            raise RuntimeError(f"暂不支持该平台输出格式：{suffix or '未知'}")
        if suffix in (".mp4", ".m4v", ".mov") and shutil.which("ffmpeg"):
            # moov atom 在文件尾部时，Android 播放器拖进度会先卡住等元数据。
            # 统一再 remux 一次 faststart（不重编码），让 Range 跳转稳定。
            faststart = tempdir / ("faststart" + suffix)
            try:
                result = subprocess.run(
                    ["ffmpeg", "-y", "-loglevel", "error", "-i", str(media),
                     "-c", "copy", "-movflags", "+faststart", str(faststart)],
                    capture_output=True, timeout=180,
                )
                if result.returncode == 0 and faststart.is_file() and faststart.stat().st_size > 1024:
                    media.unlink(missing_ok=True)
                    media = faststart
            except Exception:
                faststart.unlink(missing_ok=True)
        final = ROOT / f"{job_id}{suffix}"
        media.replace(final)
        title = video_title or final.stem
        with LOCK:
            JOBS[job_id] = {"state": "ready", "file": final.name, "title": title,
                            "size": final.stat().st_size, "engine": engine_used, "created": time.time()}
        index[job_id] = {
            "id": job_id, "url": url, "title": title, "file": final.name,
            "size": final.stat().st_size, "engine": engine_used, "created": time.time(),
        }
        _save_index(index)
        cleanup_old()
        return {
            "ok": True,
            "id": job_id,
            "title": title,
            "size": final.stat().st_size,
            "mime": "video/mp4" if suffix in (".mp4", ".m4v") else "video/" + suffix[1:],
            "engine": engine_used,
            "cacheHit": False,
            "downloadUrl": f"/api/videos/{job_id}",
        }
    except HttpError as exc:
        with LOCK:
            JOBS[job_id] = {"state": "failed", "message": exc.detail, "created": time.time()}
        raise
    except Exception as exc:  # noqa: BLE001
        with LOCK:
            JOBS[job_id] = {"state": "failed", "message": str(exc)[:500], "created": time.time()}
        raise HttpError(422, f"解析或下载失败：{str(exc)[:300]}")
    finally:
        shutil.rmtree(tempdir, ignore_errors=True)


def health_payload() -> dict:
    try:
        yt_version = getattr(yt_dlp.version, "__version__", "installed")
    except Exception:  # noqa: BLE001
        yt_version = None
    cache = 0
    try:
        cache = sum(p.stat().st_size for p in ROOT.iterdir() if p.is_file())
    except OSError:
        pass
    return {
        "ok": bool(yt_version),
        "service": "doremy-video-resolver",
        "version": VERSION,
        "engines": {"parse-video-py": False, "yt-dlp": bool(yt_version), "xiaohongshu": True},
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "ffmpeg_required_for_separate_audio": True,
        "cache_mb": round(cache / 1048576, 1),
        "runtime": f"python {__import__('sys').version.split()[0]} (dsh)",
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "DoremyResolver/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 安静一点，日志走 stdout 重定向
        print("[%s] %s" % (time.strftime("%H:%M:%S"), fmt % args), flush=True)

    # ---------- 基础工具 ----------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Resolver-Token")

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _authorize(self):
        if API_TOKEN:
            token = self.headers.get("X-Resolver-Token") or ""
            if not secrets.compare_digest(token, API_TOKEN):
                raise HttpError(401, "本地视频解析服务令牌不正确")

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > 512 * 1024:
            raise HttpError(413, "请求体过大")
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except json.JSONDecodeError:
            raise HttpError(422, "请求体不是合法 JSON")
        if not isinstance(data, dict):
            raise HttpError(422, "请求体必须是 JSON 对象")
        return data

    def _dispatch(self, method: str):
        try:
            path = urlparse(self.path).path
            if method == "OPTIONS":
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self._cors()
                self.end_headers()
                return
            if path == "/health" and method in ("GET", "HEAD"):
                return self._json(200, health_payload())
            if path == "/api/resolve" and method == "POST":
                self._authorize()
                return self._json(200, resolve_video(self._body()))
            m = re.fullmatch(r"/api/videos/([A-Za-z0-9_\-]{4,64})", path)
            if m:
                job_id = m.group(1)
                if method in ("GET", "HEAD"):
                    return self._video(job_id, head_only=(method == "HEAD"))
                if method == "DELETE":
                    self._authorize()
                    record = JOBS.pop(job_id, None)
                    if record and record.get("file"):
                        (ROOT / record["file"]).unlink(missing_ok=True)
                    index = _load_index()
                    had_index = job_id in index
                    index.pop(job_id, None)
                    _save_index(index)
                    return self._json(200, {"ok": True, "deleted": bool(record) or had_index})
            if path == "/" and method == "GET":
                return self._json(200, {"ok": True, "service": "doremy-video-resolver",
                                        "hint": "POST /api/resolve 解析视频；GET /health 查看状态"})
            raise HttpError(404, "接口不存在")
        except HttpError as exc:
            self._json(exc.status, {"detail": exc.detail})
        except (BrokenPipeError, ConnectionResetError):
            # 播放器拖动进度或关页时会主动断开，这不是服务端错误，不该回 500。
            self.close_connection = True
        except Exception as exc:  # noqa: BLE001
            self._json(500, {"detail": f"服务内部错误：{str(exc)[:200]}"})

    # ---------- 视频文件（支持 Range，便于 <video> 拖动进度） ----------
    def _video(self, job_id: str, head_only: bool = False):
        record = JOBS.get(job_id)
        if not record or record.get("state") != "ready":
            indexed = _load_index().get(job_id)
            if indexed:
                record = {"state": "ready", "file": indexed.get("file"), "title": indexed.get("title", ""), "size": indexed.get("size", 0)}
                JOBS[job_id] = record
        if not record or record.get("state") != "ready":
            raise HttpError(404, "本地缓存不存在或已清理")
        path = (ROOT / record["file"]).resolve()
        if path.parent != ROOT or not path.is_file():
            raise HttpError(404, "本地视频已删除")
        size = path.stat().st_size
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix.lower() in (".mp4", ".m4v"):
            ctype = "video/mp4"
        start, end = 0, size - 1
        status = 200
        rng = self.headers.get("Range")
        if rng:
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                elif m.group(2):
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self._cors()
                    self.end_headers()
                    return
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{quote(path.name)}")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self._cors()
        self.end_headers()
        if head_only:
            return
        try:
            with path.open("rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_OPTIONS(self):
        self._dispatch("OPTIONS")

    def do_HEAD(self):
        self._dispatch("HEAD")


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"doremy-video-resolver {VERSION} listening on http://{HOST}:{PORT}", flush=True)
    print(f"cache: {ROOT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
