FROM python:3.12-slim

WORKDIR /app

# Thiết lập biến môi trường tối ưu hóa bộ nhớ và chống rò rỉ
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MALLOC_TRIM_THRESHOLD_=100000 \
    HEADROOM_STATELESS=false \
    HEADROOM_TELEMETRY=off \
    HEADROOM_SMART_ROUTING=false \
    HEADROOM_CODE_AWARE_ENABLED=false \
    PORT=10000 \
    ENABLED_PROXIES=headroom

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Giữ onnxruntime siêu nhẹ (~30MB) và gỡ bỏ PyTorch (torch) khổng lồ (~800MB)
# để Headroom chạy ổn định ở mức ~150MB RAM trên Render Free
RUN pip install --no-cache-dir -r requirements.txt \
    && pip uninstall -y torch || true

COPY . .

EXPOSE 10000

CMD ["python", "proxy_hub.py"]
