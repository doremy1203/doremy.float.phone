# Doremy 本地视频解析服务（Termux / Windows）

「一起看」的可选本地解析服务：把平台视频**下载到本机缓存**再交给原生播放器播放，避免依赖平台网页播放器（也避免 iframe 跨域读不到状态、截不到画面）。

单文件实现 [server.py](./server.py)，**只用 Python 标准库 + yt-dlp**，没有任何需要编译的依赖，Android / Windows / Linux 跑的是同一份代码。

## 支持范围

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| 小红书（`xhslink` 短链 / 笔记长链） | ✅ 支持 | 内置通道，从页面提取 `masterUrl` 直链，免登录 |
| B 站（`BV`/`av`、`b23.tv` 短链） | ✅ 支持 | 走 yt-dlp，DASH 音视频用 ffmpeg 合并，默认优先 H.264 |
| 抖音 / 快手 | ❌ 不支持 | 平台要求 `a_bogus` 一类请求签名（浏览器 JS 现场计算），实测带上完整匿名 cookies 仍 `403 Blocked by ArgusSecurityPlugin` |
| 其它站点 | ⚠️ 看运气 | 取决于 yt-dlp 是否有对应 extractor，未逐一验证 |

抖音 / 快手的替代做法：在 App 内把视频保存到相册，再用「一起看 → 选择本地视频」。本地文件还能截帧给 AI 看画面。

## 为什么不再是 FastAPI 那版

旧实现 `app.py` 依赖 `fastapi + pydantic + parse-video-py`。在 Android 上这条路走不通：pip 只接受 `android_arm64` 平台的 wheel，`pydantic-core`（Rust）、`lxml`/`aiohttp`（C 扩展）在 PyPI 上只有 manylinux 轮子，落到源码编译就必然失败（`maturin: Rust not found`）。所以改成标准库实现，接口保持完全一致，网页端无需改动。

## 安装

### Android / Termux

```bash
curl -fsSL https://raw.githubusercontent.com/Zyxxx1203/doremy.float.phone/main/tools/video-resolver/install-android.sh | bash
```

脚本会 `pkg install python ffmpeg curl`、`pip install yt-dlp`，把服务装到 `~/.doremy-video-resolver`，并写入三个命令：

| 命令 | 作用 |
| --- | --- |
| `doremy-video-start` | 启动（已在跑就直接提示） |
| `doremy-video-status` | 健康检查 |
| `doremy-video-stop` | 停止 |

装完记得 `termux-wake-lock` 并把 Termux 加入电池优化白名单，否则被系统回收后服务会停，重开 Termux 执行 `doremy-video-start` 即可。

### Windows

PowerShell 进入此目录：

```powershell
Set-ExecutionPolicy -Scope Process Bypass   # 如脚本被策略拦截
./install-windows.ps1
.\.venv\Scripts\python.exe server.py
```

需要 ffmpeg（`ffmpeg.exe` 在 PATH 中）；脚本会检测并提示。B 站等音视频分离的平台缺 ffmpeg 就只能拿单文件格式。

### 任意平台手动

```bash
python -m pip install yt-dlp
python server.py          # 默认 http://127.0.0.1:8765
```

## API

- `GET /health` → `{ok, service, version, engines:{yt-dlp}, ffmpeg, cache_mb}`
- `POST /api/resolve` JSON `{"url":"https://...","quality":"best","cookies":"<Netscape 文本，可选>"}`
  - `quality`：`best` / `1080` / `720` / `480` / `360`
  - 返回 `{ok, id, title, size, mime, engine, downloadUrl}`，`engine` 为 `yt-dlp` 或 `xiaohongshu`
- `GET /api/videos/{id}` 播放/读取缓存，支持 `Range`（206）与 `HEAD`
- `DELETE /api/videos/{id}` 删除缓存
- 可选请求头 `X-Resolver-Token`，对应环境变量 `VIDEO_RESOLVER_TOKEN`

环境变量见 [.env.example](./.env.example)。默认只监听 `127.0.0.1`。

## 行为细节

- **小红书走独立通道**：yt-dlp 没有小红书 extractor（直接喂会报 `Unsupported URL`），所以命中 `xiaohongshu.com` / `xhslink.*` 时改用内置提取——取页面里的 `masterUrl` 直链，带 `Referer: xiaohongshu.com` 下载。笔记页需要有效的 `xsec_token`，所以要用 App 里「分享 → 复制链接」得到的完整短链；页面被登录墙挡住时按提示粘贴 Cookies。
- **优先 H.264**：B 站等平台的 `bestvideo` 默认给 AV1，部分机型/WebView 硬解不了会黑屏，所以格式选择先挑 `vcodec^=avc1`，再退回任意编码（同画质体积约大 60%）。
- **短链先在服务端展开**：`b23.tv`、`v.douyin.com`、`xhslink.com` 等先 302 跟到正式地址再解析；展开结果同样过安全校验。
- **SSRF 防护**：拒绝内网 / 回环 / 保留地址，但放行 `198.18.0.0/15` —— 那是手机代理 Fake-IP 模式分配的假地址，实际指向公网。
- **缓存策略**：24 小时或超过 `VIDEO_RESOLVER_MAX_MB`（默认 2048 MB）自动清理，`DELETE` 可手动删。

## 限制

小红书靠独立通道，其余平台靠 yt-dlp；两者都只处理各自支持的内容。会员/登录限制、地区限制、签名变更、DRM 或平台策略都可能失败；本工具不会绕过 DRM、付费墙或访问控制。

抖音 / 快手的原因与替代做法见上面的「支持范围」，本项目不实现对抗平台风控的签名算法。

大文件需要足够磁盘空间，播完可 `DELETE` 清理。遵守平台条款与内容版权。
