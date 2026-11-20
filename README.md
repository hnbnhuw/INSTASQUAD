# INSTASQUAD – E-Commerce Game Companion Platform

Đồ án TMĐT: sàn C2C cho thuê **Companion chơi game**, bảo vệ giao dịch bằng **ký quỹ (Escrow)** và **sổ cái ghi kép (double-entry ledger)**.
Bản này là **MVP chạy được end-to-end** trên máy cá nhân, bám theo các tài liệu trong `docs/source/` (Requirements, BPMN, ERD/Class Diagram).

> ⚠️ Không dùng tiền thật. Cổng VNPay/MoMo, eKYC, OAuth2 (Google), Game API và chi trả rút tiền đều là **mô phỏng** (xem [docs/SCOPE_BASELINE.md](docs/SCOPE_BASELINE.md)).

## Tính năng chính

| Nhóm | Tính năng |
|---|---|
| Tài khoản | Đăng ký/đăng nhập (mật khẩu scrypt, cookie httpOnly), OAuth2 Authorization Code (nhà cung cấp mô phỏng), eKYC mô phỏng (dữ liệu mã hóa AES-256-GCM), phân quyền Renter / Companion / CS / Admin |
| Tìm kiếm | Lọc theo game, rank tối thiểu, giá/giờ, TrustScore, ngày rảnh, tên; sắp xếp "phù hợp nhất" (matchmaking minh bạch) |
| Companion | Hồ sơ, giá, bật/tắt nhận đơn, game & rank (đối chiếu Game API mô phỏng), Slot Calendar 1 giờ/slot |
| Đặt lịch (BPMN 1A–1C) | Mã request chống gửi trùng, giữ chỗ 10 phút, giới hạn 10 giờ/ngày/Companion, chốt phí, thiếu số dư → nạp tiền, ký quỹ một lần duy nhất, Companion trả lời trong 180 giây (quá hạn: tự hủy, hoàn 100%, −3 điểm), hủy theo mốc 30/10 phút |
| Phiên chơi (2A) | Tự mở/đóng phiên đúng giờ, chat real-time (SSE) có lọc SĐT/link/số tài khoản, gọi thoại WebRTC P2P, nghiệm thu 15 phút |
| Tiền (2B) | Ví (khả dụng/ký quỹ/đóng băng/chờ rút/nợ phạt), nạp tiền qua cổng mô phỏng có callback ký HMAC + chống cộng trùng, giải ngân 88/12, rút tiền mô phỏng, đối soát sổ cái |
| Khiếu nại (2C) | Báo sự cố → đóng băng Escrow ngay, hồ sơ kèm nhật ký chat, bằng chứng (tệp mã hóa), CS yêu cầu bổ sung, phán quyết theo ngưỡng 80% (hoàn 100% + phạt 20% hoặc giải phóng 88/12) |
| Uy tín | Đánh giá hai chiều 1–5★, TrustScore theo công thức BPMN, tạm khóa < 40 điểm |
| Quản trị | Dashboard (GMV, hoa hồng, conversion, thời gian xử lý khiếu nại), hàng chờ khiếu nại, rút tiền, cảnh báo đối soát (thử lại có audit), sổ cái, người dùng, audit log, công cụ demo |

## Công nghệ

- **Backend**: Node.js ≥ 22.13 (đã kiểm tra với Node 24), Express 4, Zod (validate), **SQLite có sẵn trong Node (`node:sqlite`)** – không cần cài DB server.
- **Frontend**: React 18 + Vite 6 + React Router 6, CSS thuần.
- **Realtime**: Server-Sent Events (chat, thông báo, cập nhật đơn, tín hiệu WebRTC). **Test**: `node:test` (62 test tích hợp/đơn vị).
- Không Docker, không cloud, không dịch vụ trả phí. Lý do chọn: [docs/DECISION_LOG.md](docs/DECISION_LOG.md).

## Cài đặt & chạy (Windows / macOS / Linux)

Yêu cầu: **Node.js 22.13+** (khuyến nghị 24 LTS) và npm. Kiểm tra: `node -v`.

```powershell
npm run setup
```
Lệnh này cài dependencies cho `server/` và `client/`, tạo DB `server/data/instasquad.db`, chạy migration và nạp dữ liệu demo.

**Chế độ phát triển** (2 cổng, tự reload):
```powershell
npm run dev
```
Mở http://localhost:5173 (API tại http://localhost:4000/api/health).

**Chế độ demo một cổng** (build frontend rồi backend phục vụ luôn):
```powershell
npm start
```
Mở http://localhost:4000.

Các lệnh khác:

| Lệnh | Tác dụng |
|---|---|
| `npm test` | Chạy 62 test backend (DB in-memory, đồng hồ giả lập) |
| `npm run reset` | Xóa dữ liệu và seed lại bộ demo |
| `npm run reconcile` | Đối soát sổ cái, in báo cáo JSON (exit code 2 nếu lệch) |

Cấu hình tùy chọn: sao chép `server/.env.example` → `server/.env`. Production bắt buộc `DATA_ENCRYPTION_KEY`, `PAYMENT_GATEWAY_SECRET` và **cấm** `DEMO_TOOLS=true`.

## Tài khoản demo (chỉ dùng minh họa)

Mật khẩu chung: `Demo@123`. Trang đăng nhập có nút đăng nhập nhanh.

| Email | Vai trò | Ghi chú |
|---|---|---|
| an.renter@instasquad.local | Renter | Ví ~1.000.000đ, có lịch sử đơn |
| binh.renter@instasquad.local | Renter | Có 1 khiếu nại đang mở |
| chi.renter@instasquad.local | Renter | Ví 40.000đ → demo thiếu số dư/nạp tiền |
| mai/khoa/linh/tuan/ha/duc.companion@instasquad.local | Companion | Đã eKYC, có lịch 7 ngày |
| newbie.companion@instasquad.local | Companion | Chưa eKYC (không xuất hiện khi tìm kiếm) |
| cs@instasquad.local | CS Agent | Xử lý khiếu nại |
| admin@instasquad.local | Admin | Toàn quyền quản trị + công cụ demo |

> Mẹo demo nhiều vai cùng lúc: cookie không tách theo cổng, nên hãy mở mỗi vai bằng một host khác nhau, ví dụ `http://localhost:4000`, `http://127.0.0.1:4000` và `http://[::1]:4000`, hoặc dùng cửa sổ ẩn danh.

## Kịch bản demo nhanh

Xem [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md). Mục **Quản trị → Công cụ demo** cho phép dịch đồng hồ hệ thống (+3 phút, +1 giờ…) để thấy ngay các nhánh hết 180 giây, bắt đầu/kết thúc phiên, tự nghiệm thu, và bật **lỗi ghi sổ giả lập** để minh họa nhánh rollback + cảnh báo đối soát.

## Cấu trúc thư mục

```
server/   API Express, services nghiệp vụ, migrations SQL, seed, test
client/   React SPA
docs/     Tài liệu: phạm vi, yêu cầu, policy demo, quy tắc tài chính, kiến trúc, API, truy vết, QA, kịch bản demo
docs/source/  Tài liệu gốc (PDF) của nhóm
scripts/  dev.mjs (chạy song song API + web)
```

## Khắc phục sự cố

- `Cannot find module 'node:sqlite'` hoặc lỗi cú pháp → nâng Node lên ≥ 22.13.
- Cổng 4000/5173 bận → đổi `PORT` trong `server/.env` (và `vite.config.js` proxy nếu đổi cổng API).
- Muốn dữ liệu sạch → `npm run reset` (hoặc Quản trị → Công cụ demo → Reset).
- Dịch đồng hồ demo được lưu lại; về giờ thật bằng nút **Về giờ thật** trong Công cụ demo.

## Giới hạn đã biết

Xem [docs/QA_REPORT.md](docs/QA_REPORT.md) mục "Giới hạn & rủi ro". Tóm tắt: các tích hợp bên ngoài là mô phỏng; gọi thoại WebRTC không dùng STUN/TURN nên chỉ chắc chắn hoạt động trong cùng mạng LAN/máy; không ghi âm; scheduler chạy trong tiến trình backend (tắt máy thì hạn chót được xử lý bù khi khởi động lại); file WBS `.xlsx` không có trong thư mục nên truy vết theo mã BR/UR/FR/NFR/UC/BPMN.
