# Decision log

Nhãn: **REQUIRED** (bắt buộc để đáp ứng nguồn) · **DEMO_POLICY** (quy ước tạm, cần PO duyệt) · **DEFERRED** · **TECH** (lựa chọn kỹ thuật của nhóm). "Người duyệt" = người cần xác nhận trước khi coi là chính thức.

| Mã | Ngày | Quyết định | Lý do / tác động | Nhãn | Người duyệt |
|---|---|---|---|---|---|
| DL-01 | 2026-11-20 | Tệp `INSTASQUAD_WBS_Detailed.xlsx` **không có** trong thư mục; người dùng giao toàn quyền quyết định. Truy vết theo BR/UR/FR/NFR/UC + bước BPMN thay cho WBS ID/TC01–TC70; **không** tự tạo D01–D18. Vấn đề "M1 ghi D01–D15 nhưng sheet có D01–D18" không kiểm tra được | Không bịa yêu cầu; khi có workbook cần đối chiếu lại `TRACEABILITY.md` | REQUIRED | Nhóm/GV |
| DL-02 | 2026-11-20 | Stack: Node.js + Express + React/Vite; DB **SQLite qua `node:sqlite`** thay vì PostgreSQL | Máy không có PostgreSQL; SQLite đi kèm Node ⇒ `npm run setup` là chạy được, không Docker/cloud. Transaction đồng bộ + `BEGIN IMMEDIATE` cho tuần tự hóa tuyệt đối trong 1 tiến trình. Trade-off: không mở rộng ngang nhiều tiến trình (NFR-003 DEFERRED); có phương án chuyển PostgreSQL trong ARCHITECTURE §8 | TECH | Nhóm |
| DL-03 | 2026-11-20 | Thứ tự **ký quỹ trước → Companion trả lời 180s** theo BPMN 1A/1B, không theo UC03 ("chấp nhận rồi mới thanh toán") | BPMN chi tiết hơn và nhất quán với quy tắc "phải đủ tiền mới đặt được"; ghi nhận mâu thuẫn trong REQUIREMENTS §2 | REQUIRED (cần PO xác nhận mâu thuẫn) | PO |
| DL-04 | 2026-11-20 | Slot rời rạc 1 giờ; đơn 1–5 giờ liên tiếp | Đơn giản hóa concurrency (UNIQUE + update có điều kiện) | TECH | Nhóm |
| DL-05 | 2026-11-20 | WALLET = tập tài khoản sổ cái của user (không có bảng wallet riêng chứa số dư) | Một nguồn sự thật duy nhất; số dư cache nằm ngay trên tài khoản và được đối soát | TECH | Nhóm |
| DL-06 | 2026-11-20 | Đóng băng Escrow = bút toán ESCROW → FROZEN (không chỉ đổi cờ) | BPMN 2C b3 yêu cầu "ghi vào sổ giao dịch"; ví hiển thị riêng khoản đóng băng | REQUIRED | – |
| DL-07 | 2026-11-20 | Lỗi ghi sổ: rollback + `ops_alerts` + Admin "Thử lại" (dùng lại reference) hoặc "Đóng cảnh báo" có ghi chú; scheduler không tự thử lại thao tác đang có cảnh báo | BPMN: "Kết thúc lỗi, chờ kiểm toán viên"; tự thử lại phân tán là DEFERRED | REQUIRED + DEFERRED | – |
| DL-08 | 2026-11-20 | Realtime bằng SSE + REST POST; WebRTC voice P2P không STUN/TURN | Không thêm WebSocket server/dịch vụ ngoài; voice qua Internet cần TURN → DEFERRED; UC04 3a: lỗi voice thì dùng chat | TECH/DEFERRED | Nhóm |
| DL-09 | 2026-11-20 | Không ghi âm cuộc gọi | Quyền riêng tư + chi phí lưu trữ; hồ sơ khiếu nại dùng chat log + sự kiện phiên | DEFERRED | PO |
| DL-10 | 2026-11-20 | Tích hợp ngoài đều mô phỏng: VNPay/MoMo (HMAC callback), eKYC, OAuth2, Game API, payout | Không dùng tiền/giấy tờ thật; giữ đúng hình dạng giao thức để thay thật sau | MOCKED | GV |
| DL-11 | 2026-11-20 | Đồng hồ server dịch được + giả lập lỗi ghi sổ + reset dữ liệu, chỉ khi `DEMO_TOOLS=true`; cấm ở production (kiểm tra lúc khởi động) | Demo được các hạn 180s/15'/giờ hẹn và nhánh lỗi BPMN trong vài phút | TECH | Nhóm |
| DL-12 | 2026-11-20 | TrustScore làm mượt bằng 10 đơn ảo (DP-08) | Test phát hiện: theo công thức thuần, Companion mới lỡ 1 đơn có tỷ lệ hoàn thành 0% ⇒ 37 điểm ⇒ bị khóa ngay | DEMO_POLICY | PO |
| DL-13 | 2026-11-20 | Conversion = cặp (người xem, Companion) có booking sau lần xem / tổng cặp đã xem (DP-11) | Định nghĩa đầu tiên (booking/lượt xem) cho kết quả > 100% với dữ liệu seed | DEMO_POLICY | PO |
| DL-14 | 2026-11-20 | Tìm kiếm cho phép khách chưa đăng nhập; đặt lịch bắt buộc đăng nhập Renter | UC02 ghi tiền điều kiện "Renter đã đăng nhập"; nới lỏng để tăng chuyển đổi, không ảnh hưởng an toàn tiền | DEMO_POLICY | PO |
| DL-15 | 2026-11-20 | DP-01…DP-12 (xem DEMO_POLICY.md) | Các điểm tiền bạc nguồn chưa chốt | DEMO_POLICY | PO |
