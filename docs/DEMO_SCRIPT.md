# Kịch bản demo (8–12 phút)

**Chuẩn bị**: `npm run reset` rồi `npm start` (một cổng, http://localhost:4000). Mở 3 cửa sổ với 3 host khác nhau để có 3 phiên đăng nhập riêng:
- Renter: http://localhost:4000 → đăng nhập nhanh "Renter (ví 1.000.000đ)" (An)
- Companion: http://127.0.0.1:4000 → "Companion" (Mai)
- Admin/CS: http://[::1]:4000 → "Admin" (hoặc "CS Agent")

Dự phòng: nếu WebRTC/micro không dùng được trên máy chiếu, chỉ demo chat. Nếu demo lỗi, vào Admin → Công cụ demo → Reset dữ liệu (≈1 giây).

| # | Thời lượng | Thao tác | Kết quả cần chỉ ra |
|---|---|---|---|
| 1 | 1' | Renter: trang chủ, lọc game "Liên Minh", rank "Kim Cương", TrustScore ≥ 70 | Kết quả lọc, thời gian truy vấn (NFR-001), huy hiệu eKYC/rank ✓ |
| 2 | 1,5' | Mở hồ sơ Mai, chọn khung giờ gần nhất (≥ 1 giờ sau), 2 giờ → Gửi yêu cầu | Đơn "Chờ Companion phản hồi", đồng hồ 180s, panel **Dòng tiền**: Nợ Khả dụng / Có Ký quỹ (`ESCROW_HOLD:n`) |
| 3 | 0,5' | Companion: thông báo realtime → mở đơn → **Chấp nhận** | Tab Renter tự chuyển "Đã chấp nhận" (SSE) |
| 4 | 1' | Renter: xem "Nếu hủy bây giờ" (quy tắc 30/10 phút). Admin → Công cụ demo → **+1 giờ** | Đơn chuyển "Đang diễn ra", phòng chat mở |
| 5 | 1' | Hai bên chat; Companion gõ "zalo 0912345678" | Tin nhắn bị che `[đã ẩn]` ⚠; nút 📞 Gọi thoại (nếu có micro) |
| 6 | 1' | Admin: **+1 giờ** lần nữa → Renter: **Hoàn tất** | Giải ngân: Nợ Ký quỹ 120.000 / Có Mai 105.600 / Có PLATFORM_REVENUE 14.400. Gửi đánh giá 4★ → TrustScore cập nhật |
| 7 | 1,5' | Renter Chi (ví 40.000đ) đặt đơn 60.000đ | "Còn thiếu 20.000đ", giữ chỗ 10 phút → Nạp qua VNPay mock → **Thành công + callback lặp 3 lần** → tự ký quỹ; log callback: CREDITED, DUPLICATE_IGNORED ×2 |
| 8 | 1' | Đặt 1 đơn khác cho Khoa, **không** chấp nhận; Admin **+3 phút** | Đơn tự hủy, hoàn 100%, Khoa bị −3 điểm (lịch sử trạng thái + log TrustScore) |
| 9 | 1,5' | CS: Khiếu nại → hồ sơ #1 (seed) | Tiền **Đóng băng**, chat log có SĐT bị che, sự kiện phiên. Kéo tỷ lệ lỗi 85%, nhập lý do → Phán quyết: hoàn 70.000đ, phạt 14.000đ (Tuấn ví 0đ → **nợ phạt**) |
| 10 | 1' | Admin → Công cụ demo → **Bật lỗi ghi sổ** → Companion từ chối một đơn đang chờ | Báo lỗi; đơn vẫn "Chờ Companion", ký quỹ vẫn "Đang giữ"; Admin → Cảnh báo đối soát → **Thử lại** → hoàn tiền thành công |
| 11 | 0,5' | Companion: Ví → Rút 50.000đ (`PAYOUT-DEMO01`); Admin: Rút tiền → Từ chối (lý do) | Tiền giữ trả về ví bằng bút toán `WITHDRAW_RELEASE` |
| 12 | 0,5' | Admin → Sổ cái & đối soát | "✔ Sổ cái khớp", tổng tài khoản = 0, danh sách reference |

Câu chốt: "Mọi thay đổi số dư đều có bút toán đối ứng, có mã chống trùng, chạy trong transaction; khi lỗi thì tiền giữ nguyên và có cảnh báo cho kiểm toán viên."
