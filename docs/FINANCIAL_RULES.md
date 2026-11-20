# Quy tắc tài chính – Wallet / Escrow / Ledger

## 1. Nguyên tắc
1. Mọi số tiền là **số nguyên VND** (`INTEGER`), không dùng số thực.
2. **Không sửa số dư trực tiếp.** Mọi thay đổi đi qua `postTransaction()` (`server/src/services/ledger.js`), gồm ≥ 2 bút toán, **tổng Nợ = tổng Có**.
3. Mỗi giao dịch có `reference` **duy nhất** (UNIQUE) ⇒ gửi lặp (callback, click, scheduler phát lại) trả về giao dịch cũ, không ghi lần hai.
4. Giao dịch + đổi trạng thái nghiệp vụ (Escrow/Booking/Dispute/Withdrawal) nằm trong **cùng một transaction DB**. Lỗi ⇒ ROLLBACK toàn bộ, tạo **cảnh báo đối soát** (`ops_alerts`), không có trạng thái nửa vời (BPMN: "Ghi sổ thành công? → Không").
5. Số dư cache (`ledger_accounts.balance`) cập nhật cùng transaction; mỗi bút toán lưu `balance_after`. `reconcile()` kiểm tra: cache = tổng bút toán, `balance_after` cuối = cache, mọi giao dịch cân bằng, **tổng mọi tài khoản = 0**, Σ escrow HELD = Σ tài khoản ESCROW, Σ FROZEN, Σ rút tiền đang chờ = Σ WITHDRAW_HOLD, mỗi payment SUCCESS có đúng 1 giao dịch nạp. Đối soát **chỉ báo cáo**, không tự sửa.

## 2. Tài khoản sổ cái

Quy ước: **số dư = tổng Có − tổng Nợ** (Có làm tăng, Nợ làm giảm), áp dụng cho mọi tài khoản.

| Tài khoản | Chủ | Ý nghĩa | Được âm? |
|---|---|---|---|
| `AVAILABLE` | mỗi user | Ví khả dụng | Không |
| `ESCROW` | Renter | Tiền ký quỹ đang giữ (WALLET.escrow trong ERD) | Không |
| `FROZEN` | Renter | Tiền ký quỹ bị đóng băng do khiếu nại | Không |
| `WITHDRAW_HOLD` | Companion | Tiền đã giữ cho yêu cầu rút | Không |
| `RECEIVABLE` | Companion | Nợ phạt chưa thu được (âm = đang nợ) – DP-06 | Có |
| `PLATFORM_REVENUE` | hệ thống | Hoa hồng 12% + phí hủy muộn | Không |
| `PLATFORM_PENALTY` | hệ thống | Phạt khiếu nại 20% | Không |
| `GATEWAY_CLEARING` | hệ thống | Đối ứng tiền vào từ cổng thanh toán (âm = tiền đã vào hệ thống) | Có |
| `PAYOUT_CLEARING` | hệ thống | Đối ứng tiền đã chi ra ngoài | Có |

## 3. Bút toán theo nghiệp vụ (ví dụ số nguyên)

Giả sử đơn **2 giờ × 60.000đ = 120.000đ**.

| Nghiệp vụ (BPMN) | Reference | Nợ | Có |
|---|---|---|---|
| Nạp 200.000đ thành công (1A b8) | `TOPUP:<paymentId>` | GATEWAY_CLEARING 200.000 | Renter.AVAILABLE 200.000 |
| Ký quỹ (1A b10) | `ESCROW_HOLD:<bookingId>` | Renter.AVAILABLE 120.000 | Renter.ESCROW 120.000 |
| Từ chối / quá 180s / hủy ≥ 30 phút – hoàn 100% (1B b4, 1C b4a) | `REFUND:<id>` / `CANCEL:<id>` | Renter.ESCROW 120.000 | Renter.AVAILABLE 120.000 |
| Hủy 10–29 phút – 70/30 (1C b4b) | `CANCEL:<id>` | Renter.ESCROW 120.000 | Renter.AVAILABLE 84.000; Companion.AVAILABLE 36.000 |
| Hủy < 10 phút – phạt 100% (1C b4c, **DP-04**) | `CANCEL:<id>` | Renter.ESCROW 120.000 | Companion.AVAILABLE 105.600; PLATFORM_REVENUE 14.400 |
| Nghiệm thu – giải ngân 88/12 (2B b1) | `SETTLE:<id>` | Renter.ESCROW 120.000 | Companion.AVAILABLE 105.600; PLATFORM_REVENUE 14.400 |
| Báo sự cố – đóng băng (2C b3) | `FREEZE:<id>` | Renter.ESCROW 120.000 | Renter.FROZEN 120.000 |
| Phán quyết ≥ 80% – hoàn 100% (2C b8a) | `DISPUTE_REFUND:<disputeId>` | Renter.FROZEN 120.000 | Renter.AVAILABLE 120.000 |
| … và phạt 20% (2C b8a, **DP-06**), ví Companion còn 10.000đ | `DISPUTE_PENALTY:<disputeId>` | Companion.AVAILABLE 10.000; Companion.RECEIVABLE 14.000 | PLATFORM_PENALTY 24.000 |
| Phán quyết < 80% – giải phóng 88/12 (2C b8b) | `DISPUTE_RELEASE:<disputeId>` | Renter.FROZEN 120.000 | Companion.AVAILABLE 105.600; PLATFORM_REVENUE 14.400 |
| Thu nhập mới khi đang nợ 14.000đ (bù trừ) | (cùng giao dịch SETTLE) | thêm: Companion.AVAILABLE 14.000 | thêm: Companion.RECEIVABLE 14.000 |
| Tạo yêu cầu rút 100.000đ | `WITHDRAW_RESERVE:U<uid>:<key>` | Companion.AVAILABLE 100.000 | Companion.WITHDRAW_HOLD 100.000 |
| Admin xác nhận đã chuyển | `WITHDRAW_PAYOUT:<wid>` | Companion.WITHDRAW_HOLD 100.000 | PAYOUT_CLEARING 100.000 |
| Admin từ chối rút | `WITHDRAW_RELEASE:<wid>` | Companion.WITHDRAW_HOLD 100.000 | Companion.AVAILABLE 100.000 |

## 4. Làm tròn (DP-10)
`splitPct(amount, pct)` = [⌊amount × pct / 100⌋, phần còn lại]. Ví dụ 33.333đ:
- 88/12 → nền tảng ⌊3.999,96⌋ = **3.999**, Companion **29.334** (tổng 33.333 ✔).
- 70/30 → Renter ⌊23.333,1⌋ = **23.333**, Companion **10.000** (tổng 33.333 ✔).
- Phạt 20% → ⌊6.666,6⌋ = **6.666**.

## 5. Phương trình bảo toàn
- Mỗi giao dịch: Σ Nợ = Σ Có (kiểm tra trong `postTransaction`, test `LEDGER-03`).
- Toàn hệ thống: Σ số dư mọi tài khoản = 0 (`reconcile`, mọi test kết thúc bằng `reconcile().ok === true`).
- Mỗi lần chia: các phần cộng lại đúng bằng tổng (test `MONEY-01`, 5.000 mẫu ngẫu nhiên).

## 6. TrustScore (BPMN 2B b7)
`Điểm = 0,40 × rating100 + 0,40 × tỷ lệ hoàn thành(%) − 1,20 × tỷ lệ bị khiếu nại(%) − tổng điểm trừ trực tiếp`, giới hạn 0–100, < 40 → tạm khóa. Quy ước mẫu số: DP-08.

Ví dụ tính tay (test `TS-01`): 1 đánh giá 4★ (rating100 = 80), 1 đơn hoàn tất, 1 lần quá 180s (−3):
tỷ lệ hoàn thành = (1+10)/(1+1+10) = 91,67% ⇒ 0,4×80 + 0,4×91,67 − 0 − 3 = **65,67 → 66**.
