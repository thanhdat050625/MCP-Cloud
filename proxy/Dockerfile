FROM python:3.12-slim

WORKDIR /app

# Thiết lập biến môi trường tối ưu hóa bộ nhớ và chống rò rỉ
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MALLOC_TRIM_THRESHOLD_=100000 \
    HEADROOM_STATELESS=true \
    HEADROOM_TELEMETRY=off \
    PORT=10000 \
    ENABLED_PROXIES=headroom

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Cài đặt các gói cần thiết và gỡ bỏ các thư viện ML nặng (torch, transformers, onnxruntime)
# để RAM giữ ở mức ~80MB, tránh vượt ngưỡng 512MB của Render Free
RUN pip install --no-cache-dir -r requirements.txt \
    && pip uninstall -y torch transformers onnxruntime safetensors || true

COPY . .

EXPOSE 10000

CMD ["python", "proxy_hub.py"]
