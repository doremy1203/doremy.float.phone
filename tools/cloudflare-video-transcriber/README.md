# Cloudflare Workers AI transcription bridge

This cloud endpoint uses Cloudflare Workers AI Whisper Large v3 Turbo for **direct audio files**. After deployment, your computer does not need to stay on.

## One-time setup, then deploy from GitHub Actions

You do not need to install Node.js or run commands on your own computer for each deployment. GitHub Actions can deploy the Worker to **your own Cloudflare account**.

### 1. Create the required Cloudflare credentials

1. Sign in to Cloudflare and copy your **Account ID** from the account overview.
2. Create a Cloudflare API token with permission to deploy Workers and use Workers AI on that account. Keep it private.
3. Generate a long random service token. This is separate from the Cloudflare API token; the app uses this service token to authenticate transcription requests.

### 2. Add three GitHub repository secrets

In your repository, open **Settings → Secrets and variables → Actions → New repository secret** and add:

- `CLOUDFLARE_API_TOKEN`: the Cloudflare API token.
- `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID.
- `TRANSCRIBE_TOKEN`: the random service token used by the app.

Never put any of these secrets in source code, a chat message, or a public workflow input.

### 3. Run the deployment workflow

1. Open the repository's **Actions** tab.
2. Choose **Deploy video transcription service** → **Run workflow**.
3. Keep the branch set to `main`.
4. Fill in:
   - **Allowed origins**: exact origins for the deployed web app, comma-separated, e.g. `https://zfloat.netlify.app`. No trailing path.
   - **Allowed media hosts**: exact hostnames serving direct audio files, comma-separated, e.g. `audio.example.com,cdn.example.com`. Do not include a scheme or path, and do not use `*`.
5. Click **Run workflow**. The workflow installs dependencies, type-checks the Worker, configures the allowlists, stores the service token as a Cloudflare secret, and deploys the Worker. The deploy log prints the resulting `workers.dev` address.

The deployment happens in GitHub's hosted runner and Cloudflare. Your own computer can be turned off. If the workflow fails, open its failed step; it will report whether a secret, configuration, type-check, or deploy step failed.

## App configuration

In Watch Together's transcription settings:

- **Service URL**: `https://YOUR-WORKER.workers.dev` (do not add `/transcribe`; the app adds it).
- **Service token**: the same value you saved as `TRANSCRIBE_TOKEN`.

Use a **direct audio-file URL** (for example an authorized MP3, WAV, M4A, OGG, or audio WebM file) in the link field, then choose “Parse link and generate script”. The Worker returns timestamped segments compatible with the app's script parser.

## Important boundary: this is not yet a universal video-link parser

A Bilibili/YouTube/TikTok page URL is not an audio-file URL. This Worker does not extract audio from arbitrary platform pages, bypass login, regional restrictions, DRM, or platform protections, or analyze video frames. Platform captions that you can lawfully access/import should be preferred; the existing optional local `yt-dlp + FFmpeg + faster-whisper` bridge remains the fallback for supported platforms. A cloud-hosted general extractor would be a separate service and would need platform-specific maintenance and additional resource/security controls.

The Worker currently accepts HTTPS direct audio URLs whose hostname is explicitly allowlisted, and caps the downloaded audio at 8 MB. Shorter clips may be needed for larger files.

## Cost and limits

Workers AI has usage-based pricing and plan limits that can change. Check the current official pages before relying on a particular allowance:

- Model: https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
- Pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Limits: https://developers.cloudflare.com/workers-ai/platform/limits/


## 与当前一起看解析链路的边界

该 Worker 是独立的转写组件，不是网页端内置视频解析 API，也不是通用平台视频下载器。当前一起看可先尝试内置解析/同源缓存；需要本机提取器时可配置 `tools/video-resolver`；有可用字幕或音频时再使用转写链路。成功播放不表示已有字幕/转写或完整视频理解结果。同步部署时请分别检查 Worker、站点环境变量与本地服务，不能用其中一个的部署成功代替另外两个的验收。
