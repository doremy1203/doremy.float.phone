FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HOME=/models/huggingface VIDEO_TRANSCRIBER_HOST=0.0.0.0 VIDEO_TRANSCRIBER_PORT=8765
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY tools/video-transcriber/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY tools/video-transcriber/server.py /app/server.py
COPY tools/video-transcriber/vendor/transcribe_video.py /app/vendor/transcribe_video.py
VOLUME ["/models"]
EXPOSE 8765
CMD ["python", "/app/server.py", "--host", "0.0.0.0", "--port", "8765"]
