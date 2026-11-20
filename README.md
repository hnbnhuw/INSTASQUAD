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
