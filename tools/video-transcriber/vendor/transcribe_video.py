#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
video-transcriber：多平台视频/音频本地转写脚本。

链路：yt-dlp 下载最佳音轨 -> ffmpeg 转 16kHz 单声道 WAV
      -> faster-whisper 本地转写 -> 输出 .txt / .srt / .json

不依赖任何在线解析服务；只转写自己拥有或有授权的视频。
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SUPPORTED_MODELS = {
    "tiny",
    "base",
    "small",
    "medium",
    "large",
    "large-v1",
    "large-v2",
    "large-v3",
    "turbo",
    "tiny.en",
    "base.en",
    "small.en",
    "medium.en",
    "distil-small.en",
    "distil-medium.en",
    "distil-large-v2",
    "distil-large-v3",
}

SUPPORTED_FORMATS = {"txt", "srt", "json"}

SUPPORTED_COMPUTE_TYPES = {"float16", "int8", "int8_float16", "float32"}

DOUYIN_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
DOUYIN_HEADERS = {
    "User-Agent": DOUYIN_UA,
    "Referer": "https://www.douyin.com/",
    "Accept": "*/*",
}
DOUYIN_NUMERIC_RE = re.compile(r"/(?:share/)?video/(\d+)")
DOUYIN_URI_PATTERNS = [
    re.compile(r'"play_addr":\{"uri":"([^"]+)"'),
    re.compile(r'"uri":"(v[0-9a-z]{10,})"'),
]
URL_RE = re.compile(r"https?://[^\s]+")


class TranscribeError(RuntimeError):
    """可向用户展示的清晰错误。"""


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="本地提取视频/音频的口播稿、逐字稿与字幕（yt-dlp + ffmpeg + faster-whisper）"
    )
    parser.add_argument(
        "input",
        nargs="?",
        default=None,
        help="平台分享链接或本地视频/音频文件路径（与 --urls-file 二选一）",
    )
    parser.add_argument(
        "--urls-file",
        default=None,
        help="批量模式：文本文件，每行一个链接或本地文件路径（支持直接粘贴分享文本，# 开头为注释）",
    )
    parser.add_argument(
        "--output-dir",
        default="output",
        help="输出目录（默认 ./output）",
    )
    parser.add_argument(
        "--model",
        default="small",
        help="faster-whisper 模型：tiny/base/small/medium/large-v3/turbo 或 HF 仓库路径（默认 small，支持中文；"
        "体积参考：tiny 75MB/base 145MB/small 0.5GB/medium 1.5GB/large-v3 3GB/turbo 1.6GB）",
    )
    parser.add_argument(
        "--language",
        default=None,
        help="语言代码，如 zh、en；不传则自动检测",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "cuda"],
        help="推理设备（默认 auto：有 NVIDIA GPU 用 cuda，否则 cpu）",
    )
    parser.add_argument(
        "--compute-type",
        default=None,
        help="计算精度：float16/int8/int8_float16/float32（默认 CPU=int8、CUDA=float16）",
    )
    parser.add_argument(
        "--formats",
        default="txt,srt,json",
        help="输出格式，逗号分隔（默认 txt,srt,json）",
    )
    parser.add_argument(
        "--keep-audio",
        action="store_true",
        help="保留转换后的 16kHz WAV 音频文件",
    )
    parser.add_argument(
        "--no-download",
        action="store_true",
        help="跳过网络下载，只处理本地已有媒体（与 URL 同时使用时报错）",
    )
    parser.add_argument(
        "--cookies",
        default=None,
        help="Netscape 格式 cookie 文件路径（平台需要登录时使用）",
    )
    parser.add_argument(
        "--cookies-from-browser",
        default=None,
        help="从浏览器读取 cookie，如 chrome/safari/firefox（可带 profile，如 chrome:Default）",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="输出 yt-dlp/ffmpeg 详细日志",
    )
    return parser.parse_args(argv)


def is_url(value: str) -> bool:
    return value.strip().lower().startswith(("http://", "https://"))


def check_dependencies(need_yt_dlp: bool) -> None:
    missing = []
    hints = {}

    if need_yt_dlp:
        try:
            import yt_dlp  # noqa: F401
        except ImportError:
            missing.append("yt-dlp")
            hints["yt-dlp"] = "pip install yt-dlp"

    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        missing.append("faster-whisper")
        hints["faster-whisper"] = "pip install faster-whisper"

    if shutil.which("ffmpeg") is None:
        missing.append("ffmpeg")
        hints["ffmpeg"] = (
            "macOS: brew install ffmpeg；Ubuntu/Debian: sudo apt install ffmpeg；"
            "Windows: 将 ffmpeg.exe 加入 PATH"
        )

    if missing:
        install_lines = "\n".join(f"  - {name}：{hints[name]}" for name in missing)
        raise TranscribeError(
            "缺少必需依赖：" + "、".join(missing) + "。\n" + install_lines
        )


def validate_model(model: str) -> None:
    if "/" in model:
        return  # 允许 HuggingFace 仓库路径
    if model not in SUPPORTED_MODELS:
        supported = "、".join(sorted(SUPPORTED_MODELS))
        raise TranscribeError(
            f"未知模型：{model}。可选：{supported}，或 HuggingFace 仓库路径（如 Systran/faster-whisper-large-v3）"
        )


def get_cuda_device_count() -> int:
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


def resolve_device(device: str) -> str:
    if device == "cpu":
        return "cpu"
    if device == "cuda":
        if get_cuda_device_count() <= 0:
            raise TranscribeError(
                "指定了 --device cuda，但未检测到可用的 NVIDIA GPU；请改用 --device cpu"
            )
        return "cuda"
    return "cuda" if get_cuda_device_count() > 0 else "cpu"


def validate_compute_type(compute_type: str) -> None:
    if compute_type not in SUPPORTED_COMPUTE_TYPES:
        raise TranscribeError(
            f"未知计算精度：{compute_type}。可选：" + "、".join(sorted(SUPPORTED_COMPUTE_TYPES))
        )


def parse_formats(raw: str) -> list[str]:
    formats = [fmt.strip().lower() for fmt in raw.split(",") if fmt.strip()]
    invalid = [fmt for fmt in formats if fmt not in SUPPORTED_FORMATS]
    if invalid:
        raise TranscribeError(
            f"未知输出格式：{'、'.join(invalid)}。可选：" + "、".join(sorted(SUPPORTED_FORMATS))
        )
    return formats or ["txt", "srt", "json"]


def slugify(text: str | None, max_len: int = 100) -> str:
    if not text:
        return "transcript"
    text = unicodedata.normalize("NFKC", str(text)).strip()
    text = re.sub(r"[^\w\- ]", "_", text, flags=re.UNICODE)
    text = re.sub(r"\s+", "_", text)
    text = text.strip("._")
    return text[:max_len] or "transcript"


def is_douyin_url(url: str) -> bool:
    host = urllib.parse.urlparse(url).netloc.lower()
    return "douyin.com" in host or "v.douyin.com" in host


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _douyin_http_get(url: str, allow_redirects: bool = True, timeout: int = 15):
    request = urllib.request.Request(url, headers=DOUYIN_HEADERS)
    if allow_redirects:
        return urllib.request.urlopen(request, timeout=timeout)
    opener = urllib.request.build_opener(_NoRedirect())
    return opener.open(request, timeout=timeout)


def resolve_douyin_numeric_id(url: str) -> str | None:
    match = DOUYIN_NUMERIC_RE.search(url)
    if match:
        return match.group(1)
    try:
        response = _douyin_http_get(url)
        match = DOUYIN_NUMERIC_RE.search(response.geturl())
        return match.group(1) if match else None
    except Exception:
        return None


def fetch_douyin_video_id(numeric_id: str) -> str | None:
    """从 SSR share 页提取 video_id（页面 HTML 里的 uri 字段）。"""
    share_url = f"https://www.iesdouyin.com/share/video/{numeric_id}/"
    try:
        response = _douyin_http_get(share_url)
        html = response.read().decode("utf-8", errors="ignore")
        for pattern in DOUYIN_URI_PATTERNS:
            match = pattern.search(html)
            if match:
                return match.group(1)
    except Exception:
        pass
    return None


def fetch_douyin_cdn_url(video_id: str) -> str | None:
    """用 video_id 换 CDN 直链（v1/play 返回 302，Location 即直链）。"""
    play_url = (
        f"https://aweme.snssdk.com/aweme/v1/play/"
        f"?video_id={video_id}&ratio=540p&line=0"
    )
    try:
        response = _douyin_http_get(play_url, allow_redirects=False)
        content_type = response.headers.get("Content-Type", "").lower()
        if response.status == 200 and "video" in content_type:
            return play_url
    except urllib.error.HTTPError as exc:
        if exc.code in (301, 302, 303, 307, 308):
            location = exc.headers.get("Location")
            if location:
                return location
    except Exception:
        pass
    return None


def download_douyin_direct(cdn_url: str, out_path: Path) -> None:
    request = urllib.request.Request(cdn_url, headers=DOUYIN_HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response, open(out_path, "wb") as out:
        shutil.copyfileobj(response, out)


def download_douyin_fallback(url: str, tmpdir: Path) -> tuple[Path, dict]:
    """yt-dlp 撞抖音风控时的无登录直连兜底（仅公开视频）。"""
    print("yt-dlp 撞上抖音风控，改用抖音无登录直连接口…")
    numeric_id = resolve_douyin_numeric_id(url)
    if not numeric_id:
        raise TranscribeError("无法解析抖音视频 ID（链接可能已删除或受异地限制）")
    print(f"视频 ID：{numeric_id}")

    video_id = fetch_douyin_video_id(numeric_id)
    if not video_id:
        raise TranscribeError("无法提取 video_id（私密/仅好友可见的视频不支持）")
    print(f"video_id：{video_id}")

    cdn_url = fetch_douyin_cdn_url(video_id)
    if not cdn_url:
        raise TranscribeError("未拿到 CDN 直链（抖音直连接口可能已失效）")

    media_path = tmpdir / f"{numeric_id}.mp4"
    try:
        download_douyin_direct(cdn_url, media_path)
    except Exception as exc:
        raise TranscribeError(f"抖音直连下载失败：{exc}") from exc
    if not media_path.is_file() or media_path.stat().st_size == 0:
        raise TranscribeError("抖音直连下载得到空文件")

    print(f"抖音无登录直连成功：{media_path}")
    info = {"id": numeric_id, "title": f"douyin_{numeric_id}", "duration": None}
    return media_path, info


def find_downloaded_file(tmpdir: Path, info: dict) -> Path:
    requested = info.get("requested_downloads") or []
    for item in requested:
        filepath = item.get("filepath")
        if filepath and Path(filepath).is_file():
            return Path(filepath)
    candidates = sorted(
        (p for p in tmpdir.iterdir() if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise TranscribeError("下载失败：未找到生成的音频文件")
    return candidates[0]


def download_audio(
    url: str,
    tmpdir: Path,
    cookies: str | None,
    cookies_from_browser: str | None,
    verbose: bool,
) -> tuple[Path, dict]:
    from yt_dlp import YoutubeDL

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(tmpdir / "%(id)s.%(ext)s"),
        "paths": {"home": str(tmpdir)},
        "noplaylist": True,
        "quiet": not verbose,
        "no_warnings": not verbose,
        "no_color": True,
    }
    if cookies:
        cookie_path = Path(cookies).expanduser()
        if not cookie_path.is_file():
            raise TranscribeError(f"cookie 文件不存在：{cookie_path}")
        opts["cookiefile"] = str(cookie_path)
    if cookies_from_browser:
        opts["cookiesfrombrowser"] = (cookies_from_browser,)

    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except TranscribeError:
        raise
    except Exception as exc:
        message = str(exc).strip()
        if message.startswith("ERROR:"):
            message = message[len("ERROR:") :].strip()
        if is_douyin_url(url):
            try:
                return download_douyin_fallback(url, tmpdir)
            except TranscribeError as fallback_exc:
                raise TranscribeError(
                    f"下载失败：{message}\n抖音无登录直连也失败：{fallback_exc}"
                ) from exc
        raise TranscribeError(f"下载失败：{message}") from exc

    if info and info.get("entries"):
        info = info["entries"][0]
    if not info:
        raise TranscribeError("下载失败：未获取到视频信息")

    media_path = find_downloaded_file(tmpdir, info)
    return media_path, info


def convert_to_wav(src: Path, dst: Path, verbose: bool) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(dst),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        detail = proc.stderr.strip()[-1200:] if proc.stderr else proc.stdout.strip()[-1200:]
        raise TranscribeError(f"ffmpeg 转换失败：{detail}")
    if verbose:
        sys.stderr.write(proc.stderr)


def vad_available() -> bool:
    try:
        import onnxruntime  # noqa: F401

        return True
    except Exception:
        return False


def transcribe(
    wav_path: Path,
    model: str,
    language: str | None,
    device: str,
    compute_type: str,
) -> tuple[list[dict], object]:
    from faster_whisper import WhisperModel

    validate_model(model)
    print(f"加载模型 {model}（首次使用需联网下载）…")
    try:
        whisper = WhisperModel(model, device=device, compute_type=compute_type)
    except Exception as exc:
        raise TranscribeError(
            f"加载模型 {model} 失败：{exc}\n"
            "首次使用需要联网从 HuggingFace 下载，请检查网络；"
            "模型缓存在 ~/.cache/huggingface 或 ~/.cache/faster-whisper"
        ) from exc

    use_vad = vad_available()
    if not use_vad:
        print("提示：未安装 onnxruntime，静音过滤已关闭（可选：pip install onnxruntime）")

    try:
        segment_iter, meta = whisper.transcribe(
            str(wav_path),
            language=language or None,
            vad_filter=use_vad,
        )
        segments = []
        for segment in segment_iter:
            text = segment.text.strip()
            if not text:
                continue
            segments.append(
                {
                    "id": int(segment.id),
                    "start": round(float(segment.start), 3),
                    "end": round(float(segment.end), 3),
                    "text": text,
                }
            )
    except Exception as exc:
        raise TranscribeError(f"转写失败：{exc}") from exc

    return segments, meta


def format_clock(seconds: float, separator: str = ".") -> str:
    ms = int(round(float(seconds) * 1000))
    hours, rem = divmod(ms, 3600000)
    minutes, rem = divmod(rem, 60000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{millis:03d}"


def build_srt(segments: list[dict]) -> str:
    blocks = []
    for segment in segments:
        start = format_clock(segment["start"], ",")
        end = format_clock(segment["end"], ",")
        text = " ".join(segment["text"].split())
        blocks.append(f"{segment['id'] + 1}\n{start} --> {end}\n{text}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def build_txt(segments: list[dict]) -> str:
    return "\n".join(
        f"[{format_clock(segment['start'])}] {segment['text']}" for segment in segments
    )


def write_outputs(
    source: str,
    base: str,
    output_dir: Path,
    formats: list[str],
    segments: list[dict],
    meta: object,
    model: str,
    device: str,
    compute_type: str,
    duration_hint: float | None,
) -> list[Path]:
    language = getattr(meta, "language", None)
    language_probability = getattr(meta, "language_probability", None)
    whisper_duration = getattr(meta, "duration", None)
    duration = whisper_duration or duration_hint

    payload = {
        "source": source,
        "model": model,
        "device": device,
        "compute_type": compute_type,
        "language": language,
        "language_probability": (
            round(float(language_probability), 4) if language_probability is not None else None
        ),
        "duration_seconds": round(float(duration), 3) if duration else None,
        "segment_count": len(segments),
        "segments": segments,
        "text": "".join(segment["text"] for segment in segments),
        "generated_by": "video-transcriber",
        "generated_at": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    }

    written = []
    if "txt" in formats:
        path = output_dir / f"{base}.txt"
        path.write_text(build_txt(segments), encoding="utf-8")
        written.append(path)
    if "srt" in formats:
        path = output_dir / f"{base}.srt"
        path.write_text(build_srt(segments), encoding="utf-8")
        written.append(path)
    if "json" in formats:
        path = output_dir / f"{base}.json"
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        written.append(path)
    return written


def try_download_subtitles(
    url: str,
    tmpdir: Path,
    cookies: str | None,
    cookies_from_browser: str | None,
    verbose: bool,
) -> tuple[list[dict], dict] | None:
    """Try official/manual/automatic captions before downloading audio or running Whisper."""
    from yt_dlp import YoutubeDL

    opts = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["zh-Hans", "zh-Hant", "zh", "en"],
        "subtitlesformat": "vtt/best",
        "outtmpl": str(tmpdir / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": not verbose,
        "no_warnings": not verbose,
        "no_color": True,
        "ignoreerrors": True,
    }
    if cookies:
        cookie_path = Path(cookies).expanduser()
        if not cookie_path.is_file():
            raise TranscribeError(f"cookie 文件不存在：{cookie_path}")
        opts["cookiefile"] = str(cookie_path)
    if cookies_from_browser:
        opts["cookiesfrombrowser"] = (cookies_from_browser,)

    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as exc:
        if verbose:
            print(f"字幕优先尝试未成功，将回退到音频转写：{exc}", file=sys.stderr)
        return None
    if info and info.get("entries"):
        info = next((item for item in info["entries"] if item), None)
    if not info:
        return None

    caption_files = sorted(tmpdir.glob("*.vtt")) + sorted(tmpdir.glob("*.srt"))
    for caption_path in caption_files:
        raw = caption_path.read_text(encoding="utf-8", errors="ignore")
        cues = re.split(r"\n\s*\n", raw.replace("\r", ""))
        segments: list[dict] = []
        for cue in cues:
            lines = cue.splitlines()
            time_index = next((i for i, line in enumerate(lines) if "-->" in line), -1)
            if time_index < 0:
                continue
            match = re.match(r"\s*((?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3}))\s*-->", lines[time_index])
            if not match:
                continue
            hours = int(match.group(2) or 0)
            start = hours * 3600 + int(match.group(3)) * 60 + int(match.group(4)) + int(match.group(5)) / 1000
            right = re.search(r"-->\s*((?:(?:\d+):)?\d{2}:\d{2}[.,]\d{3})", lines[time_index])
            if not right:
                continue
            end_match = re.match(r"(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})", right.group(1))
            if not end_match:
                continue
            end = int(end_match.group(1) or 0) * 3600 + int(end_match.group(2)) * 60 + int(end_match.group(3)) + int(end_match.group(4)) / 1000
            text_lines = lines[time_index + 1:]
            text = " ".join(text_lines)
            text = re.sub(r"<[^>]+>", "", text)
            text = re.sub(r"&(?:amp|lt|gt|quot|apos|nbsp);", " ", text)
            text = re.sub(r"\s+", " ", text).strip()
            if not text:
                continue
            if segments and segments[-1]["text"] == text and abs(segments[-1]["start"] - start) < 0.1:
                continue
            segments.append({"start": start, "end": max(start, end), "text": text})
        if segments:
            return segments, info
    return None


def process_source(source: str, args: argparse.Namespace) -> None:
    source = source.strip()
    url_input = is_url(source)

    if url_input and args.no_download:
        raise TranscribeError("--no-download 只适用于本地文件，无法从链接跳过下载")
    if args.cookies and args.cookies_from_browser:
        raise TranscribeError("--cookies 与 --cookies-from-browser 只能二选一")

    local_path = None
    if not url_input:
        local_path = Path(source).expanduser()
        if not local_path.exists():
            raise TranscribeError(f"本地文件不存在：{local_path}")
        if not local_path.is_file():
            raise TranscribeError(f"输入不是文件：{local_path}")

    check_dependencies(url_input)

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    device = resolve_device(args.device)
    compute_type = args.compute_type or ("float16" if device == "cuda" else "int8")
    validate_compute_type(compute_type)
    formats = parse_formats(args.formats)

    with tempfile.TemporaryDirectory(prefix="video-transcriber-") as tmp:
        tmpdir = Path(tmp)

        if url_input:
            print("步骤 1/4：优先尝试现成字幕（含自动字幕）…")
            caption_result = try_download_subtitles(
                source, tmpdir, args.cookies, args.cookies_from_browser, args.verbose
            )
            if caption_result:
                caption_segments, caption_info = caption_result
                title = caption_info.get("title") or caption_info.get("id") or "video"
                base = slugify(title)
                duration = max((segment["end"] for segment in caption_segments), default=0)
                payload = {
                    "source": source,
                    "model": "existing-subtitles",
                    "device": "none",
                    "compute_type": "none",
                    "language": caption_info.get("language"),
                    "duration_seconds": round(duration, 3),
                    "segment_count": len(caption_segments),
                    "segments": caption_segments,
                    "text": " ".join(segment["text"] for segment in caption_segments),
                    "generated_by": "video-transcriber-subtitles",
                    "generated_at": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                }
                if "json" in formats:
                    (output_dir / f"{base}.json").write_text(
                        json.dumps(payload, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8"
                    )
                if "txt" in formats:
                    (output_dir / f"{base}.txt").write_text(
                        "\\n".join(segment["text"] for segment in caption_segments) + "\\n", encoding="utf-8"
                    )
                if "srt" in formats:
                    (output_dir / f"{base}.srt").write_text(build_srt(caption_segments), encoding="utf-8")
                print(f"已直接使用平台字幕：{len(caption_segments)} 段；跳过音频下载与 Whisper 推理。")
                return
            print("未找到可用字幕，回退到音频转写…")
            media_path, info = download_audio(
                source,
                tmpdir,
                args.cookies,
                args.cookies_from_browser,
                args.verbose,
            )
            base = slugify(info.get("title") or info.get("id") or "video")
            duration_hint = info.get("duration")
        else:
            print("步骤 1/4：使用本地文件，跳过下载…")
            media_path = local_path
            base = slugify(local_path.stem)
            info = None
            duration_hint = None

        wav_path = output_dir / f"{base}.wav"
        print("步骤 2/4：转换 16kHz 单声道 WAV…")
        convert_to_wav(media_path, wav_path, args.verbose)

        print("步骤 3/4：faster-whisper 本地转写…")
        segments, meta = transcribe(
            wav_path,
            args.model,
            args.language,
            device,
            compute_type,
        )
        print("步骤 4/4：写输出文件…")
        written = write_outputs(
            source,
            base,
            output_dir,
            formats,
            segments,
            meta,
            args.model,
            device,
            compute_type,
            duration_hint,
        )

        if args.keep_audio:
            print(f"已保留音频：{wav_path}")
        else:
            wav_path.unlink(missing_ok=True)

    duration = getattr(meta, "duration", None) or duration_hint
    if duration is not None:
        print(f"完成：视频时长 {duration:.1f} 秒，识别 {len(segments)} 段。")
    else:
        print(f"完成：识别 {len(segments)} 段。")
    for path in written:
        print(f"  - {path}")
    if not segments:
        print("提示：未识别到语音内容，请检查视频是否静音、语言是否受支持。")


def read_source_list(path: str) -> list[str]:
    file_path = Path(path).expanduser()
    if not file_path.is_file():
        raise TranscribeError(f"链接清单文件不存在：{file_path}")

    sources = []
    for raw in file_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = URL_RE.search(line)
        if match:
            sources.append(match.group(0).rstrip("，。；、,.;、"))
        else:
            sources.append(line)

    seen = set()
    unique = []
    for source in sources:
        if source not in seen:
            seen.add(source)
            unique.append(source)
    return unique


def run_batch(args: argparse.Namespace) -> int:
    sources = read_source_list(args.urls_file)
    if not sources:
        raise TranscribeError(f"链接清单为空或无法解析：{args.urls_file}")

    ok = 0
    failures = []
    for index, source in enumerate(sources, start=1):
        print(f"\n===== [{index}/{len(sources)}] {source} =====")
        try:
            process_source(source, args)
            ok += 1
        except TranscribeError as exc:
            print(f"错误：{exc}", file=sys.stderr)
            failures.append((source, str(exc)))
        except KeyboardInterrupt:
            print("\n已中断。", file=sys.stderr)
            return 130
        except Exception as exc:
            print(f"意外错误：{exc}", file=sys.stderr)
            if args.verbose:
                raise
            failures.append((source, str(exc)))

    print(f"\n批量完成：成功 {ok}/{len(sources)}，失败 {len(failures)}。")
    for source, message in failures:
        print(f"  - {source}：{message}", file=sys.stderr)
    return 1 if failures else 0


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        if args.urls_file:
            return run_batch(args)
        if not args.input:
            raise TranscribeError("需要提供 INPUT（链接或本地文件），或使用 --urls-file 批量处理")
        process_source(args.input, args)
        return 0
    except TranscribeError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("已中断。", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"意外错误：{exc}", file=sys.stderr)
        if args.verbose:
            raise
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
