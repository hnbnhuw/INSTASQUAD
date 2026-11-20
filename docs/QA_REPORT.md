# QA report – 2026-11-20

## 1. Môi trường
Windows 11, Node.js v24.15.0 (SQLite 3.51.3 kèm Node), npm 11.12.1. Trình duyệt kiểm thử: pane trình duyệt Chromium của ứng dụng Claude desktop.

## 2. Lệnh đã chạy & kết quả thực tế

| Lệnh | Kết quả |
|---|---|
| `npm test` (repo) | **62 / 62 pass**, 0 fail |
| Bản sao sạch (không node_modules/data/dist) → `npm run setup` → `npm test` → `npm run build` → chạy server cổng 4100 → `GET /api/health`, `GET /`, `GET /api/companions?gameId=1` | setup OK, seed OK, **62/62 pass**, build OK, health `{"status":"ok","db":true}`, index 200, tìm kiếm trả dữ liệu |
| `npm run dev` (bản sao sạch) | API + Vite khởi động, health OK |
| `node src/cli.js reconcile` sau seed | `ok: true`, 0 issue |
| `vite build` | OK (≈266 KB JS, 82 KB gzip) |

## 3. Danh sách test tự động (server/test)

| Nhóm | Test | Nội dung chính |
|---|---|---|
| Ledger & tiền | LEDGER-01…06, MONEY-01, TRUST-01 | Cân bằng Nợ=Có, idempotency reference, chặn giao dịch lệch/tiền lẻ/âm, thiếu số dư rollback, lỗi ghi sổ rollback cả thay đổi khác trong transaction + tạo cảnh báo, property test 5.000 mẫu chia 88/12 & 70/30, ví dụ TrustScore tính tay |
| Booking & payment | BK-01…13, PAY-01…05 | Luồng đặt lịch, request lặp, key tái dùng, **20 request song song cùng slot → 1 thành công**, chồng lấn, phí snapshot, 10h/ngày, validation, thiếu số dư → nạp gắn đơn → tự ký quỹ, nạp xong vẫn thiếu → hết giữ chỗ, nạp lỗi → hủy đơn, race hết hạn giữ chỗ, Companion không nhận đơn; callback lặp 3 lần cộng 1 lần, sai chữ ký/số tiền, PENDING → EXPIRED, số tiền không hợp lệ |
| Phản hồi & hủy | RS-01…04, CN-01…06, FL-01…02 | Accept đúng 180s, accept lặp, reject hoàn 100%, quá 180s (accept bị chặn, −3 điểm, phát lại scheduler không trừ 2 lần), race accept vs timeout; hủy đúng 30', 29'59", đúng 10', 9' (DEMO_POLICY), sau giờ hẹn, hủy lặp; lỗi ghi sổ khi hoàn tiền/ký quỹ + Admin thử lại |
| Phiên, giải ngân, khiếu nại | SS-01, ST-01…03, CH-01, DS-01…08 | 1 session/booking, hạn nghiệm thu, giải ngân 88/12 số lẻ, nghiệm thu lặp, tự nghiệm thu đúng mốc, lỗi khi giải ngân (scheduler không tự giải ngân), chat quyền + lọc SĐT/link/STK; đóng băng, khiếu nại trùng, không giải ngân khi tranh chấp, phân quyền CS, tệp sai loại/quá lớn/tên độc hại, yêu cầu bổ sung, lý do bắt buộc, **đúng 80%** (hoàn + phạt + ghi nợ khi ví 0đ, chặn rút khi nợ), **79%** (giải phóng + bù trừ nợ), báo sự cố quá hạn |
| Review, rút tiền, bảo mật | RV-01, TS-01…02, WD-01…03, AZ-01…05 | Review trùng/người ngoài/trước khi hoàn tất, review không đổi tiền; TrustScore + log + phát lại; khóa < 40 ẩn khỏi tìm kiếm; rút vượt số dư, mã payout giả, key lặp, process→complete, **2 lệnh complete song song → 1 thành công**, reject trả tiền; IDOR, ma trận quyền 6 API admin × 4 vai trò, không có endpoint sửa số dư, không lộ password_hash, eKYC lưu mã hóa, eKYC lỗi dịch vụ/từ chối, CSRF (non-JSON bị từ chối), SQL injection cơ bản ở login & tìm kiếm, tìm kiếm < 2 giây |

Mọi test có thao tác tiền đều kết thúc bằng `reconcile().ok === true` (sổ cái cân, cache khớp, Escrow/withdraw khớp tài khoản).

## 4. Kiểm thử thủ công trên trình duyệt (E2E)
Đã thực hiện với 3 phiên đăng nhập song song (Renter An, Companion Mai, Admin):
1. Đăng nhập nhanh tài khoản demo; trang chủ, lọc, hồ sơ Companion, lịch slot. ✔
2. Đặt đơn 2 giờ → ký quỹ 120.000đ, đếm ngược 180s, panel sổ cái. ✔
3. Companion chấp nhận → tab Renter tự cập nhật qua SSE. ✔
4. Dịch đồng hồ +1h → phiên bắt đầu; chat hai chiều realtime; SĐT và link bị che. ✔
5. +1h → hết phiên, thông báo nghiệm thu, Renter "Hoàn tất" → 105.600đ / 14.400đ. ✔ Đánh giá 4★. ✔
6. CS/Admin: hồ sơ khiếu nại seed, phán quyết 85% → hoàn 70.000đ, phạt 14.000đ ghi nợ; đối soát OK. ✔
7. Nạp 200.000đ qua cổng mô phỏng, callback lặp 3 lần → CREDITED + 2 DUPLICATE_IGNORED, ví +200.000đ đúng 1 lần. ✔
8. Trang Admin: dashboard, rút tiền, cảnh báo, sổ cái, người dùng, audit, khiếu nại – render không lỗi. ✔
9. Responsive 375px: menu ☰, không cuộn ngang. ✔

**Lỗi phát hiện & đã sửa trong quá trình QA**

| Mức | Lỗi | Sửa |
|---|---|---|
| High | Theo công thức TrustScore thuần, Companion mới lỡ 1 đơn → 37 điểm → bị khóa ngay | Làm mượt 10 đơn ảo (DP-08, DL-12), test TS-01 |
| Medium | Sau khi backend khởi động lại, kết nối SSE qua proxy treo im lặng → tab không nhận cập nhật | Server gửi `ping` 15s; client watchdog 40s tự kết nối lại và phát `resync` để tải lại dữ liệu |
| Medium | Conversion > 100% với dữ liệu seed | Định nghĩa lại theo phễu (DP-11) |
| Low | Ô thống kê dashboard/ví bị kéo cao (class `.main` trùng) | Đổi tên class |
| Low | Menu chữ xuống dòng ở 1024px; không có nút đăng xuất trên mobile | `nowrap`, menu ☰ dưới 1100px có Tài khoản/Đăng xuất |
| Low | Slot đã qua vẫn hiển thị nút xóa; nhật ký chat trong hồ sơ khiếu nại theo giờ UTC | Ẩn nút với slot quá khứ; hiển thị giờ Việt Nam |
| Low | Thiếu ErrorBoundary (lỗi render ⇒ trang trắng) | Thêm ErrorBoundary thân thiện |

Không còn lỗi Critical/High đã biết.

## 5. Chưa kiểm thử / giới hạn & rủi ro
- **Gọi thoại WebRTC**: đã cài đặt (signaling qua SSE, hàng đợi ICE) nhưng **chưa kiểm thử âm thanh thật** (môi trường kiểm thử không có micro). Không dùng STUN/TURN ⇒ chỉ đáng tin cậy trong cùng máy/LAN. Khi lỗi, UI hướng dẫn dùng chat (UC04 3a).
- Đăng nhập OAuth2 mô phỏng, đối chiếu rank, xóa slot, khóa/mở khóa người dùng: kiểm tra thủ công/gián tiếp, chưa có test tự động riêng.
- Không có frontend unit test; chưa có test tải (NFR-001 chỉ đo trên dữ liệu demo nhỏ).
- Không phải pentest chuyên nghiệp: chỉ kiểm tra IDOR, phân quyền, CSRF cơ bản, SQL injection cơ bản, upload, lộ dữ liệu nhạy cảm như liệt kê ở trên.
- Scheduler trong tiến trình: khi server tắt, hạn chót xử lý bù lúc khởi động (đơn quá 180s lúc server tắt sẽ bị hủy + hoàn tiền khi bật lại).
- Cookie phiên dùng chung giữa các cổng cùng host (`localhost:4000` và `localhost:5173`) – đặc tính của trình duyệt; demo nhiều vai cần host khác nhau hoặc cửa sổ ẩn danh.
- 70 test case TC01–TC70 của workbook **không đối chiếu được** vì thiếu file (DL-01).
