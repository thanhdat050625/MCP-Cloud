import os
import sys
import time
import shutil
import ctypes
import asyncio
import subprocess
import psutil
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse, JSONResponse

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# 1. Biến môi trường & cấu hình
PORT = int(os.environ.get("PORT", "10000"))
raw_enabled = os.environ.get("ENABLED_PROXIES", "headroom")
ENABLED_PROXIES = [p.strip().lower() for p in raw_enabled.split(",") if p.strip()]

HEADROOM_PORT = int(os.environ.get("HEADROOM_INTERNAL_PORT", "8787"))
MAX_RAM_MB = float(os.environ.get("MAX_RAM_MB", "380.0"))

START_TIME = time.time()
managed_processes = {}
http_client: httpx.AsyncClient = None
headroom_ready = False

# 2. Quản lý tiến trình Headroom
def start_headroom_sub():
    env = os.environ.copy()
    env["HEADROOM_HOST"] = "127.0.0.1"
    env["HEADROOM_PORT"] = str(HEADROOM_PORT)
    env["HEADROOM_STATELESS"] = "true"
    env["HEADROOM_TELEMETRY"] = "off"
    env["HEADROOM_SMART_ROUTING"] = "false"
    env["HEADROOM_CODE_AWARE_ENABLED"] = "false"
    env["PYTHONUNBUFFERED"] = "1"
    env["MALLOC_TRIM_THRESHOLD_"] = "100000"

    cmd = [
        sys.executable, "-m", "headroom.proxy.server",
        "--host", "127.0.0.1",
        "--port", str(HEADROOM_PORT),
        "--disable-kompress",
        "--no-code-aware",
        "--no-cache"
    ]
    print(f"[Proxy Hub] Spawning Headroom: {' '.join(cmd)}", flush=True)
    proc = subprocess.Popen(cmd, env=env)
    managed_processes["headroom"] = proc
    return proc

def stop_process(name: str):
    proc = managed_processes.get(name)
    if proc and proc.poll() is None:
        print(f"[Proxy Hub] Terminating {name} (PID {proc.pid})...", flush=True)
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    managed_processes.pop(name, None)

# 3. Memory Watchdog (Ép giải phóng RAM & chống Memory Leak)
def run_malloc_trim():
    """Ép Linux glibc trả RAM phân mảnh về lại cho hệ điều hành."""
    try:
        libc = ctypes.CDLL("libc.so.6")
        libc.malloc_trim(0)
    except Exception:
        pass

async def memory_watchdog():
    while True:
        await asyncio.sleep(60)
        run_malloc_trim()

        total_rss = 0.0
        try:
            hub_proc = psutil.Process()
            total_rss += hub_proc.memory_info().rss
            for p in managed_processes.values():
                if p.poll() is None:
                    try:
                        child = psutil.Process(p.pid)
                        total_rss += child.memory_info().rss
                    except Exception:
                        pass
        except Exception:
            pass

        total_rss_mb = total_rss / (1024 * 1024)
        if total_rss_mb > MAX_RAM_MB:
            print(f"[Watchdog ALERT] Total RAM ({total_rss_mb:.1f} MB) exceeds threshold ({MAX_RAM_MB} MB). Recycling workers...", flush=True)
            if "headroom" in managed_processes:
                stop_process("headroom")
                await asyncio.sleep(1)
                start_headroom_sub()
            run_malloc_trim()

async def background_headroom_launcher():
    global headroom_ready
    start_headroom_sub()
    while True:
        await asyncio.sleep(1)
        if "headroom" not in managed_processes:
            break
        proc = managed_processes.get("headroom")
        if proc and proc.poll() is not None:
            print(f"[Proxy Hub] Headroom exited with code {proc.poll()}, restarting...", flush=True)
            await asyncio.sleep(2)
            start_headroom_sub()
            continue

        try:
            r = await http_client.get(f"http://127.0.0.1:{HEADROOM_PORT}/livez", timeout=1.5)
            if r.status_code == 200:
                if not headroom_ready:
                    headroom_ready = True
                    print(f"[Proxy Hub] Headroom Proxy is READY and accepting traffic on 127.0.0.1:{HEADROOM_PORT}!", flush=True)
        except Exception:
            pass

# 4. Lifespan quản lý vòng đời ứng dụng
@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(timeout=None)

    # Khởi động Headroom bất đồng bộ trong background để port 10000 bind ngay lập tức
    launcher_task = None
    if "headroom" in ENABLED_PROXIES or "all" in ENABLED_PROXIES:
        launcher_task = asyncio.create_task(background_headroom_launcher())

    # Kích hoạt background watchdog
    watchdog_task = asyncio.create_task(memory_watchdog())

    yield

    # Dọn dẹp khi tắt server
    if launcher_task:
        launcher_task.cancel()
    watchdog_task.cancel()
    for name in list(managed_processes.keys()):
        stop_process(name)
    await http_client.aclose()

app = FastAPI(title="Proxy Gateway Hub", lifespan=lifespan)

# 5. Endpoint Health Check
@app.get("/health")
@app.get("/livez")
async def health_check():
    total_rss = 0
    hub_rss = 0
    children_rss = {}

    try:
        hub_p = psutil.Process()
        hub_rss = hub_p.memory_info().rss
        total_rss += hub_rss
        for name, p in managed_processes.items():
            if p.poll() is None:
                try:
                    c_rss = psutil.Process(p.pid).memory_info().rss
                    children_rss[name] = round(c_rss / (1024 * 1024), 2)
                    total_rss += c_rss
                except Exception:
                    pass
    except Exception:
        pass

    return {
        "status": "OK",
        "service": "proxy-gateway-hub",
        "enabled_proxies": ENABLED_PROXIES,
        "headroom_ready": headroom_ready,
        "uptime_seconds": round(time.time() - START_TIME, 1),
        "memory": {
            "hub_rss_mb": round(hub_rss / (1024 * 1024), 2),
            "children_rss_mb": children_rss,
            "total_rss_mb": round(total_rss / (1024 * 1024), 2)
        },
        "processes": {k: ("running" if v.poll() is None else "stopped") for k, v in managed_processes.items()}
    }

@app.get("/")
async def root():
    return {
        "status": "OK",
        "service": "Proxy Gateway Hub",
        "enabled_proxies": ENABLED_PROXIES,
        "headroom_ready": headroom_ready,
        "description": "Multi-tenant Stateless HTTP LLM Compression & Proxy Gateway"
    }

# 6. Streaming Reverse Proxy Handler
HOP_BY_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "content-length"
}

async def forward_request(target_url: str, request: Request):
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in HOP_BY_HOP_HEADERS and k.lower() != "host"
    }

    req_body = await request.body()
    try:
        upstream_req = http_client.build_request(
            method=request.method,
            url=target_url,
            headers=headers,
            content=req_body,
            params=dict(request.query_params)
        )
        upstream_res = await http_client.send(upstream_req, stream=True)

        res_headers = {
            k: v for k, v in upstream_res.headers.items()
            if k.lower() not in HOP_BY_HOP_HEADERS
        }

        return StreamingResponse(
            upstream_res.aiter_raw(),
            status_code=upstream_res.status_code,
            headers=res_headers,
            background=upstream_res.aclose
        )
    except httpx.ConnectError:
        return JSONResponse({"error": "Target proxy service is unavailable or starting up"}, status_code=503)
    except Exception as e:
        return JSONResponse({"error": f"Proxy forwarding error: {str(e)}"}, status_code=502)

# 7. Định tuyến Reverse Proxy đến Headroom (Hỗ trợ cả root /v1/* và namespace /headroom/*)
@app.api_route("/headroom/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def proxy_headroom_namespaced(path: str, request: Request):
    if "headroom" not in ENABLED_PROXIES and "all" not in ENABLED_PROXIES:
        return JSONResponse({"error": "Headroom proxy is not enabled in ENABLED_PROXIES"}, status_code=503)
    target = f"http://127.0.0.1:{HEADROOM_PORT}/{path}"
    return await forward_request(target, request)

@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def proxy_v1(path: str, request: Request):
    if "headroom" in ENABLED_PROXIES or "all" in ENABLED_PROXIES:
        target = f"http://127.0.0.1:{HEADROOM_PORT}/v1/{path}"
        return await forward_request(target, request)
    return JSONResponse({"error": "No proxy enabled to handle /v1/* requests"}, status_code=503)

@app.api_route("/v1internal:{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def proxy_v1internal(path: str, request: Request):
    if "headroom" in ENABLED_PROXIES or "all" in ENABLED_PROXIES:
        target = f"http://127.0.0.1:{HEADROOM_PORT}/v1internal:{path}"
        return await forward_request(target, request)
    return JSONResponse({"error": "No proxy enabled to handle /v1internal requests"}, status_code=503)

@app.api_route("/readyz", methods=["GET"])
@app.api_route("/stats", methods=["GET"])
async def proxy_headroom_meta(request: Request):
    if "headroom" in ENABLED_PROXIES or "all" in ENABLED_PROXIES:
        target = f"http://127.0.0.1:{HEADROOM_PORT}{request.url.path}"
        return await forward_request(target, request)
    return JSONResponse({"error": "Headroom proxy is not enabled"}, status_code=503)

if __name__ == "__main__":
    import uvicorn
    print(f"[Proxy Hub] Starting Proxy Gateway Hub on port {PORT} (Active: {ENABLED_PROXIES})...", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT, access_log=False)
