# DEMO_POLICY – Quy ước demo của nhóm (CHƯA được PO phê duyệt)

Các điểm dưới đây tài liệu nguồn **chưa quy định** hoặc **ghi rõ cần PO xác nhận**. Để có thể demo, nhóm chọn phương án đơn giản, an toàn về tiền và **cấu hình được** trong `server/src/policy.js`. Đây **không** phải yêu cầu gốc.

| Mã | Điểm chưa rõ (nguồn) | Quy ước demo | Tham số | Lý do / an toàn tiền |
|---|---|---|---|---|
| DP-01 | Thời gian giữ chỗ "ngắn" (BPMN 1A b4) | Giữ **10 phút**; **không gia hạn** khi payment pending. Hết hạn → đơn `EXPIRED`, slot mở lại | `SLOT_HOLD_MS` | Không treo slot; nếu tiền nạp về sau khi hết hạn thì vẫn cộng ví, chỉ đơn bị hết hạn (BPMN 1A b11) |
| DP-02 | Thời gian chờ cổng thanh toán | Payment `PENDING` quá **15 phút** → `EXPIRED` (đi nhánh thất bại; đơn gắn kèm bị hủy) | `PAYMENT_PENDING_TTL_MS` | PENDING không bao giờ được tính là thành công |
| DP-03 | Hết 15 phút nghiệm thu mà Renter im lặng (BPMN 2A b8 – "đề xuất của nhóm") | **Tự động nghiệm thu** và giải ngân 88/12. Đúng mốc 15 phút chưa tự nghiệm thu; > 15 phút mới chạy | `AUTO_CONFIRM_ON_TIMEOUT` | Tiền Companion không bị treo; Renter vẫn có 15 phút để báo sự cố |
| DP-04 | Phân bổ khoản phạt 100% khi hủy < 10 phút (BPMN 1C b4c – "cần PO xác nhận") | Chia như đơn hoàn tất: **88% Companion / 12% nền tảng** (`platform_revenue.kind = LATE_CANCEL_FEE`) | `LATE_CANCEL_SPLIT` | Tổng luôn bằng số tiền ký quỹ; UI ghi rõ "DEMO_POLICY" |
| DP-05 | Renter hủy khi Companion **chưa** chấp nhận (BPMN 1C chỉ mô tả sau khi chấp nhận) | Hoàn **100%** | – | Companion chưa cam kết thời gian |
| DP-06 | Phạt Companion 20% "trừ từ ví nào, chuyển cho ai" (BPMN 2C b8a – "cần PO xác nhận") | Trừ ví khả dụng của Companion; phần thiếu ghi **nợ phạt** (tài khoản `RECEIVABLE` âm), tự **bù trừ** vào thu nhập kế tiếp; khoản phạt ghi vào `PLATFORM_PENALTY`. Companion có nợ thì không rút tiền được | – | Ví khả dụng không bao giờ âm; khoản nợ minh bạch trên sổ cái |
| DP-06b | Lỗi Companion 1–79% (BPMN 2C b7 – giả định nhóm) | Đi nhánh "Không": giải phóng 88/12 cho Companion | `DISPUTE_FAULT_THRESHOLD` | Theo đúng giả định đã ghi trên Hình 2C |
| DP-07 | Hạn bổ sung chứng cứ (BPMN 2C b6b – "do PO quy định") | **24 giờ**, hiển thị cho các bên; hết hạn **không** tự động phán quyết – CS vẫn quyết định | `EVIDENCE_WINDOW_MS` | Không tự động chuyển tiền khi chưa có người quyết |
| DP-08 | Đổi rating 1–5 sang 0–100, mẫu số các tỷ lệ TrustScore | rating100 = TB sao / 5 × 100 (chưa có đánh giá = 5★). Tỷ lệ hoàn thành = (hoàn tất + 10) / (hoàn tất + lỗi + 10); tỷ lệ khiếu nại = khiếu nại / (số phiên + 10). "Lỗi" của Companion = quá 180s hoặc thua khiếu nại (từ chối đơn **không** tính lỗi). Renter: "lỗi" = tự hủy sau ký quỹ; khiếu nại = 0 (nguồn không định nghĩa). Điểm ban đầu = 80 (= tối đa theo công thức khi chưa có dữ liệu) | `TRUST_PRIOR_BOOKINGS` | Làm mượt bằng 10 đơn ảo để 1 lần lỡ hẹn của Companion mới không làm khóa tài khoản ngay (lỗi phát hiện khi test) |
| DP-09 | "10 giờ/ngày" tính theo ngày nào | Ngày theo **giờ Việt Nam (UTC+7)**, đếm slot đang giữ/đã đặt; đơn qua nửa đêm tính tách từng ngày | `TIMEZONE_OFFSET_MIN` | Server quyết định, không dựa vào giờ máy client |
| DP-10 | Làm tròn 88/12, 70/30, 20% | Số nguyên VND; phần của **nền tảng/Renter-hoàn** làm tròn **xuống**, phần dư dồn cho bên còn lại ⇒ tổng luôn bảo toàn | `splitPct()` | Có property test 5.000 mẫu |
| DP-11 | Cách đo Conversion Rate (BR-003) | Số cặp (người xem, Companion) có booking sau lần xem đầu / tổng số cặp đã xem hồ sơ | – | Chỉ số ≤ 100%, đo được từ dữ liệu thật |
| DP-12 | Kênh liên lạc, payout, quyền CS | Chat chữ + gọi thoại P2P (không ghi âm); rút tiền tới mã `PAYOUT-XXXX`; CS chỉ xem dữ liệu che (CCCD 4 số cuối), phán quyết **bắt buộc** lý do ≥ 10 ký tự, được audit kèm danh sách bằng chứng; lỗi ghi sổ → hoàn tác, cảnh báo đối soát, kiểm toán viên thử lại/đóng có ghi chú | – | Minh bạch, truy vết được |

Các tham số khác (không phải quyết định tiền): tối thiểu nạp 10.000đ, tối đa 50.000.000đ; rút tối thiểu 50.000đ; giá/giờ 10.000–2.000.000đ; tối đa 5 giờ/đơn; tệp bằng chứng ≤ 2MB (PNG/JPEG/WEBP/PDF/TXT).

**Nhánh `BLOCKED_BY_POLICY`:** không có – mọi điểm chưa rõ đã có quy ước tạm ở trên và được gắn nhãn trong UI/tài liệu. Nếu PO quyết định khác, chỉ cần đổi `policy.js` và hàm tương ứng; test `CN-04`, `ST-02`, `DS-06`, `DS-07`, `TS-01` sẽ chỉ ra chỗ cần cập nhật.
