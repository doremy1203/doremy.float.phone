# video-transcriber

多平台视频文案 / 口播稿本地提取 Skill：粘贴抖音、快手、B站、小红书、YouTube 等平台的分享链接（或提供本地视频/音频文件），输出带时间戳的 `.txt` 口播稿、`.srt` 字幕、`.json` 结构化分段。

处理链路全部在本地完成：`yt-dlp` 下载最佳音轨 → `ffmpeg` 转 16kHz 单声道 WAV → `faster-whisper` 本地转写。不依赖任何在线解析服务。

转写完成后，可用 AI 通读全文、根据语境自动纠正错别字与专业术语（时间戳保持不变），无需更换更大的模型。

## 功能

- 支持平台：抖音、快手、B站、小红书、YouTube，以及其它 yt-dlp 能解析的平台（微博、视频号等直接尝试）。
- 支持输入：平台分享链接或本地视频/音频文件。
- 输出：带时间戳的 `.txt`、`.srt`、`.json` 三种格式。
- 可选分析：基于已提取文本拆解文案结构、钩子、爆款逻辑（只读 `.json`，不重复下载视频）。
- AI 语境纠错：通读全文修正同音字与专业术语，时间戳不变，不依赖更大模型。
- 模型：faster-whisper，默认 `small`（约 0.5GB），支持中文；可切换模型大小、CPU/GPU，切换到大模型前需用户确认下载体积。
- 抖音公开视频自动兜底：yt-dlp 撞上抖音签名墙时，自动改走无登录直连接口，无需 cookie。

## 环境要求

- Python 3.10+（faster-whisper 已弃用 Python 3.9，3.9 可运行但有警告）
- ffmpeg：
  - macOS：`brew install ffmpeg`
  - Ubuntu/Debian：`sudo apt install ffmpeg`
- 首次转写需联网下载模型（small 约 75MB），之后可离线使用；模型缓存在 `~/.cache/huggingface`

## 安装

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 使用

```bash
# 平台链接（默认 small 模型）
python video-transcriber/scripts/transcribe_video.py "https://v.douyin.com/xxxx/" --output-dir output

# 本地视频，指定中文与较大模型
python video-transcriber/scripts/transcribe_video.py ~/Downloads/video.mp4 --language zh --model medium --output-dir output

# 需要登录的平台，使用 cookie 文件
python video-transcriber/scripts/transcribe_video.py "https://www.bilibili.com/video/BVxxxxxx/" --cookies cookies.txt --output-dir output

# 需要登录的平台，直接从浏览器读取 cookie
python video-transcriber/scripts/transcribe_video.py "https://www.bilibili.com/video/BVxxxxxx/" --cookies-from-browser chrome --output-dir output

# 批量处理（每行一个链接或本地文件，支持粘贴抖音分享文本）
python video-transcriber/scripts/transcribe_video.py --urls-file links.txt --output-dir output/batch

```

### 主要参数

| 参数 | 说明 |
|---|---|
| `--output-dir` | 输出目录（默认 `./output`） |
| `--model` | 模型：`tiny/base/small/medium/large-v3/turbo` 或 HF 仓库路径（默认 `small`） |
| `--language` | 语言代码，如 `zh`、`en`；不传则自动检测 |
| `--device` | `auto/cpu/cuda`（默认 auto） |
| `--compute-type` | `float16/int8/int8_float16/float32` |
| `--formats` | 输出格式，逗号分隔（默认 `txt,srt,json`） |
| `--keep-audio` | 保留 16kHz WAV 中间文件 |
| `--no-download` | 跳过下载，只处理本地文件 |
| `--cookies` | Netscape 格式 cookie 文件 |
| `--cookies-from-browser` | 从浏览器读取 cookie（`chrome`/`safari`/`firefox`） |
| `--urls-file` | 批量模式：每行一个链接或本地文件路径的清单文件 |

### 错别字纠正

识别质量不佳时不需要换更大的模型：让 Codex 通读整篇转写文案，基于全文语境修正同音字与专业术语（时间戳不变，输出 `_corrected` 文件）。

## 输出说明

- `.txt`：带时间戳的口播稿/逐字稿
- `.srt`：标准字幕
- `.json`：结构化分段（`segments[]` 含 start/end/text），供文案结构、钩子、爆款逻辑分析

## 平台现状（2026-08 实测）

| 平台 | 状态 | 说明 |
|---|---|---|
| 抖音 | ✅ | 公开视频可无登录直连；私密/直播/图文不支持 |
| YouTube | ✅ | yt-dlp 支持成熟 |
| B站 | ⚠️ | yt-dlp 支持；部分网络直连返回 412 风控，建议 cookie |
| 快手 | ⚠️ | yt-dlp 的 `short-video` 解析器存在上游问题，待修复 |
| 小红书 | ⚠️ | 反爬严格，建议 cookie 或本地文件 |
| 微博 | ⚠️ | 直接尝试，部分视频需登录 |
| 视频号 | ❌ | 一般需微信登录态，建议本地文件 |

## 版权

只转写自己拥有或有授权的视频。收到他人视频时，先确认授权再处理。
批量处理他人视频前，请先获得作者明确授权；本工具不提供按账号 ID 自动抓取全部视频的功能。

## 免责声明

抖音无登录直连依赖平台新旧 API 并存的窗口期，可能随时失效；失效后请使用 cookie 或本地文件。本项目不提供、不依赖任何第三方在线解析服务。

## 作为 Codex Skill 安装

```bash
# 复制
cp -R video-transcriber ~/.codex/skills/

# 或软链接（便于跟随仓库更新）
ln -s "$PWD/video-transcriber" ~/.codex/skills/video-transcriber
```

当用户粘贴平台视频链接并要求提取文案/口播稿/逐字稿时，Skill 会自动触发。

## License

[MIT](LICENSE)
