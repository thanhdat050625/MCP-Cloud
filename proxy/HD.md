# Proxy Gateway Hub (Stateless & Memory-Optimized)

Trung tâm điều phối các HTTP Proxy & Middleware cho các mô hình ngôn ngữ lớn (LLM), hỗ trợ nén ngữ cảnh (Context Compression) và giảm thiểu chi phí token.

---

## 1. Cấu hình biến môi trường (`Environment Variables`)

| Biến Môi Trường | Mặc Định | Ý Nghĩa |
| :--- | :--- | :--- |
| `PORT` | `10000` | Cổng HTTP mà Render gán cho container |
| `ENABLED_PROXIES` | `headroom` | Danh sách các proxy kích hoạt (cách nhau bởi dấu phẩy, vd: `headroom`). Proxy nào không bật sẽ **tiêu thụ 0 MB RAM**. |
| `HEADROOM_INTERNAL_PORT`| `8787` | Cổng nội bộ cho Headroom proxy |
| `MAX_RAM_MB` | `380.0` | Ngưỡng cảnh báo RAM kích hoạt dọn dẹp bộ nhớ |
| `HEADROOM_STATELESS` | `true` | Bắt buộc `true` để không ghi SQLite/file đĩa, chống memory leak |
| `MALLOC_TRIM_THRESHOLD_`| `100000` | Ép glibc trả RAM phân mảnh về OS sau mỗi request |

---

## 2. Cách kết nối từ Client / Coding Agent

Trong cửa sổ cài đặt proxy (ví dụ Setup Headroom):
* **Proxy URL**: `https://tools-cloud-thongnguyenthanh286.onrender.com`
* Bấm **Recheck** hoặc **Done**.
