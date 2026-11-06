#!/data/data/com.termux/files/usr/bin/bash
# 在 Termux 上安装 doremy 本地视频解析服务（Android 友好版）
#
#   curl -fsSL https://raw.githubusercontent.com/Zyxxx1203/doremy.float.phone/main/tools/video-resolver/install-android.sh | bash
#
# 和 install-termux.sh 的区别：
#   * 不装 fastapi / uvicorn / pydantic —— Android 上没有 android_arm64 轮子，
#     pydantic-core 需要 Rust 编译，必然失败；
#   * 只装 yt-dlp（纯 Python）和 pkg 提供的 ffmpeg；
#   * 服务端用 server.py（标准库 http.server 实现），接口和 app.py 完全一致。
set -euo pipefail

APP_DIR="$HOME/.doremy-video-resolver"
RAW_BASE="https://raw.githubusercontent.com/Zyxxx1203/doremy.float.phone/main/tools/video-resolver"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"

echo "[1/4] 安装 python / ffmpeg / curl …"
pkg update -y >/dev/null 2>&1 || true
pkg install -y python ffmpeg curl

echo "[2/4] 部署服务到 $APP_DIR …"
mkdir -p "$APP_DIR/cache"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/server.py" ]]; then
  cp "$SCRIPT_DIR/server.py" "$APP_DIR/server.py"
else
  curl -fsSL "$RAW_BASE/server.py" -o "$APP_DIR/server.py"
fi

echo "[3/4] 安装 yt-dlp（纯 Python，无需编译）…"
python -m pip install -U --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple yt-dlp

echo "[4/4] 写入 doremy-video-start / stop / status …"
mkdir -p "$PREFIX/bin"

cat > "$PREFIX/bin/doremy-video-start" <<'START_EOF'
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
APP_DIR="$HOME/.doremy-video-resolver"
PORT="${VIDEO_RESOLVER_PORT:-8765}"
if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "已经在运行：http://127.0.0.1:$PORT"
  exit 0
fi
cd "$APP_DIR"
nohup python server.py >> "$APP_DIR/service.log" 2>&1 </dev/null &
echo $! > "$APP_DIR/service.pid"
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health"; then
    echo
    echo "服务已启动。建议执行 termux-wake-lock，避免 Termux 被系统回收。"
    exit 0
  fi
  sleep 1
done
echo "启动失败，日志：$APP_DIR/service.log"
tail -n 40 "$APP_DIR/service.log" || true
exit 1
START_EOF

cat > "$PREFIX/bin/doremy-video-stop" <<'STOP_EOF'
#!/data/data/com.termux/files/usr/bin/bash
APP_DIR="$HOME/.doremy-video-resolver"
if [ -f "$APP_DIR/service.pid" ]; then
  kill "$(cat "$APP_DIR/service.pid")" 2>/dev/null || true
  rm -f "$APP_DIR/service.pid"
fi
if curl -fsS --max-time 2 "http://127.0.0.1:${VIDEO_RESOLVER_PORT:-8765}/health" >/dev/null 2>&1; then
  echo "仍在运行，见 $APP_DIR/service.log"
else
  echo "已停止。"
fi
STOP_EOF

cat > "$PREFIX/bin/doremy-video-status" <<'STATUS_EOF'
#!/data/data/com.termux/files/usr/bin/bash
if curl -fsS --max-time 3 "http://127.0.0.1:${VIDEO_RESOLVER_PORT:-8765}/health"; then
  echo
else
  echo "未运行。执行 doremy-video-start 启动。"
  exit 1
fi
STATUS_EOF

chmod +x "$PREFIX/bin/doremy-video-start" "$PREFIX/bin/doremy-video-stop" "$PREFIX/bin/doremy-video-status"

doremy-video-start
echo
echo "部署完成："
echo "  状态检查：doremy-video-status"
echo "  启动服务：doremy-video-start"
echo "  停止服务：doremy-video-stop"
echo "  日志文件：$APP_DIR/service.log"
echo "  健康检查：http://127.0.0.1:8765/health"
