$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command py -ErrorAction SilentlyContinue)) { throw '请先安装 Python 3.11+，并勾选 Add Python to PATH。' }

py -3 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install --upgrade yt-dlp

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Warning '未检测到 ffmpeg。单文件视频仍可下载；B站等音视频分离的平台无法合并音轨。请安装 FFmpeg 并把 ffmpeg.exe 加入 PATH，然后重新打开终端。'
}

Write-Host '安装完成。运行 .\.venv\Scripts\python.exe server.py 启动服务（默认仅监听 127.0.0.1:8765）。' -ForegroundColor Green
