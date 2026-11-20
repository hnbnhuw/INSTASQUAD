# Scope baseline – INSTASQUAD MVP

## 1. Nguồn đã dùng

| Tài liệu | Trạng thái |
|---|---|
| `docs/source/INSTASQUAS_REQUIREMENTS.pdf` (21 trang) – BR-001…004, UR-001…005, FR-001…007, NFR-001…006, UC01–UC05 | Đọc được toàn văn |
| `docs/source/INSTASQUAD_BPMN_TKHT.pdf` (19 trang) – Luồng 1 (Hình 1A, 1B, 1C), Luồng 2 (Hình 2A, 2B, 2C) | Đọc được toàn văn bảng bước |
| `docs/source/BT3_INSTASQUAD.pdf` (6 trang) – mô tả ERD/Class Diagram 2 luồng | Đọc được phần chữ; **4 trang sơ đồ là ảnh, không trích được chữ** – entity được lấy từ phần mô tả (SLOT_CALENDAR, BOOKING, BOOKING_STATUS_HISTORY, ESCROW, WALLET, LEDGER_TRANSACTION, LEDGER_ENTRY, PAYMENT, PLATFORM_REVENUE, WITHDRAW_REQUEST, REVIEW, TRUST_SCORE_LOG) |
| `INSTASQUAD_WBS_Detailed.xlsx` (WBS_Detail, Acceptance_Tests TC01–TC70, PO_Decisions D01–D18) | **Không có trong thư mục dự án.** Không thể truy vết theo WBS ID / TCxx / Dxx. Thay vào đó truy vết theo mã yêu cầu + bước BPMN; quyết định được đánh mã `DL-xx` (nhóm) và `DP-xx` (policy demo), **không** giả danh D01–D18 |

## 2. Phân loại phạm vi

### REQUIRED – đã làm thật
- Đăng ký/đăng nhập, phân quyền 4 vai trò, khóa tài khoản (FR-001, UC01).
- Tìm kiếm/lọc/matchmaking theo game, rank, giá, thời gian rảnh, TrustScore; hồ sơ + trạng thái xác thực (FR-002, UC02).
- Profile, giá, trạng thái nhận booking, Slot Calendar (FR-003, UR-004).
- Booking request + idempotency, khóa tạm slot, chống đặt trùng đồng thời, giới hạn 10h/ngày, chốt phí, đủ số dư mới ký quỹ, nạp tiền khi thiếu, 180 giây, hủy 30/10 phút, lịch sử trạng thái (FR-004, Hình 1A–1C).
- Wallet, Payment, Escrow (HELD/FROZEN/RELEASED/REFUNDED…), Ledger ghi kép có `balance_after`, Withdrawal, đối soát (FR-005, NFR-004, BT3 Luồng 2).
- Session tự mở/đóng, chat real-time, log phiên, nghiệm thu 15 phút, giải ngân 88/12 (FR-006, Hình 2A–2B).
- Đánh giá hai chiều, TrustScore + log + tạm khóa < 40, Dispute đầy đủ (đóng băng, bằng chứng, bổ sung, phán quyết 80%, phạt 20%), Dashboard quản trị (FR-007, Hình 2B–2C).
- Nhánh lỗi: request lặp, slot bị chiếm, callback lặp, ghi sổ thất bại (rollback + cảnh báo đối soát + thử lại), hết 180s, hoàn tiền, đóng băng, review trùng, rút tiền bị từ chối.

### MOCKED – mô phỏng có ghi rõ
| Thành phần | Cách mô phỏng |
|---|---|
| VNPay/MoMo | Trang cổng giả lập; callback IPN ký HMAC-SHA256 đi qua đúng handler như cổng thật; SUCCESS/FAILED/PENDING/lặp callback |
| eKYC | Dịch vụ giả lập theo đuôi số CCCD (000 từ chối, 111 cần bổ sung, 999 dịch vụ lỗi) |
| OAuth2 Google | Nhà cung cấp nội bộ, đủ luồng Authorization Code + state chống CSRF + code dùng 1 lần |
| Game API | Đối chiếu rank theo tên in-game ("fake" → không khớp, "offline" → API lỗi) |
| Payout ngân hàng | Rút tiền chỉ tới "mã nhận tiền" `PAYOUT-XXXX`; Admin xác nhận "đã chuyển" |
| Email/SMS | Thông báo trong ứng dụng (realtime) |
| Đồng hồ | Đồng hồ server có thể dịch (chỉ DEMO_TOOLS) để demo các hạn chót |

### DEFERRED – ngoài phạm vi
- Ghi âm cuộc gọi và lưu media cloud (BPMN 2C nhắc "ghi âm"): không ghi âm người dùng; hồ sơ khiếu nại dùng nhật ký chat + sự kiện phiên.
- STUN/TURN cho WebRTC qua Internet/NAT.
- Mở rộng ngang/HA 99,9% (NFR-003, NFR-006): kiến trúc monolith một tiến trình; ghi nhận là giới hạn.
- Tự động thử lại phân tán cho lỗi ghi sổ (BPMN 2B bước 2a cũng xác định là ngoài phạm vi) – thay bằng hàng chờ cảnh báo + nút thử lại có audit.
- Chỉ tiêu kinh doanh BR-002 (10.000 booking/3 tháng) – chỉ đo được, không "triển khai" được; dashboard hiển thị số booking hoàn tất.
- Companion chủ động hủy sau khi đã chấp nhận (nguồn không mô tả).

### DEMO_POLICY – quy ước tạm, chưa được PO duyệt
Xem [DEMO_POLICY.md](DEMO_POLICY.md) (DP-01…DP-12).

## 3. Định nghĩa "đủ để bảo vệ"
Dữ liệu seed cho phép demo: booking thành công; thiếu số dư → nạp; timeout 180s/hoàn tiền; hủy 3 mốc; session + chat + nghiệm thu + giải ngân 88/12; khiếu nại + đóng băng + phán quyết; đánh giá + TrustScore; rút tiền + từ chối; lỗi ghi sổ + rollback + thử lại; đối soát sổ cái.
