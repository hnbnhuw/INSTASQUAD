# Ma trận truy vết

Do thiếu file WBS (DL-01), truy vết theo: **Yêu cầu nguồn / bước BPMN → module/API/entity → test tự động → bằng chứng**. Test nằm trong `server/test/*.test.js` (62 test, kết quả ở QA_REPORT.md). "E2E" = đã thao tác thực tế trên trình duyệt ngày 2026-11-20.

| Nguồn | Nội dung | Code (service / route / UI) | Entity | Test | Bằng chứng khác |
|---|---|---|---|---|---|
| FR-001, UC01 | Đăng ký/đăng nhập, OAuth2, eKYC | `services/users.js`, `routes/auth.js`, `pages/Auth.jsx`, `Account.jsx` | users, auth_sessions, kyc_records | AZ-03, AZ-04 | E2E đăng nhập 3 vai trò |
| NFR-002 | AES-256, RBAC | `util.js encrypt*`, `http.js requireRole`, `disputes.js addEvidence` | kyc_records, evidence | AZ-01, AZ-02, AZ-03, DS-03, DS-04 | |
| FR-002, UC02, NFR-001 | Tìm/lọc/matchmaking ≤ 2s | `services/companions.js searchCompanions`, `pages/Home.jsx` | companion_profiles, companion_games, slots | AZ-05, TS-02 | E2E tìm kiếm (3ms) |
| FR-003, UR-004 | Profile, giá, Slot Calendar | `companions.js updateProfile/addSlots`, `CompanionDashboard.jsx` | slots | BK-06, BK-13 | E2E |
| BPMN 1A b1–b3 | Mã request, kiểm tra trùng/slot/10h | `bookings.js createBooking` | bookings | BK-02, BK-03, BK-05, BK-07, BK-08 | |
| BPMN 1A b4, UC03 2a | Khóa tạm slot, chống đặt trùng | `createBooking` (update có điều kiện + UNIQUE) | slots | BK-04 (20 request song song), BK-12 | |
| BPMN 1A b5–b9 | Đủ số dư / nạp / không nạp / nạp lỗi / vẫn thiếu | `escrowBooking`, `payments.js`, `cancelForPaymentFailure`, `expireHolds` | payments | BK-09, BK-10, BK-11, CN-06 | E2E nạp tiền qua cổng mô phỏng |
| BPMN 1A b10–b12 | Ký quỹ 1 lần, 2 bút toán, 180s | `escrowBooking` | escrows, ledger_* | BK-01, FL-02 | E2E BK000008 |
| BPMN 1A b7, NFR-004 | Mã chống nạp trùng, callback | `payments.js handleGatewayCallback` | payments, payment_callbacks | PAY-01…PAY-05 | E2E callback lặp 3 lần → cộng 1 lần |
| BPMN 1B | Accept/Reject/quá 180s −3 điểm, hoàn trước rồi hủy | `respondToBooking`, `timeoutBooking` | trust_deductions | RS-01…RS-04, FL-01 | E2E accept realtime |
| BPMN 1C | Hủy ≥30 / 10–29 / <10 phút | `cancelPreview`, `cancelByRenter` | escrows (SPLIT/FORFEITED), platform_revenue | CN-01…CN-05 | |
| BPMN 1B b5a, 1C b5a, 2B b2a, 2C b9a | Ghi sổ lỗi → hoàn tác + cảnh báo | `ledger.js runFinancial`, `admin.js retryAlert` | ops_alerts | LEDGER-06, FL-01, FL-02, ST-03 | |
| BPMN 2A, UC04, FR-006 | Mở/đóng phiên, chat, voice, log, lọc liên lạc | `startDueSessions/endDueSessions`, `sessions.js`, `Room.jsx` | play_sessions, messages, session_events | SS-01, CH-01 | E2E chat 2 chiều realtime, che SĐT/link |
| BPMN 2A b7–b8 | Nghiệm thu 15', tự nghiệm thu (DP-03) | `confirmCompletion`, `autoConfirmDue` | | ST-01, ST-02 | E2E |
| BPMN 2B b1–b3 | Giải ngân 88/12, mã chống trùng | `settleBooking` | platform_revenue | ST-01, MONEY-01 | E2E 105.600 / 14.400 |
| BPMN 2B b4–b7, FR-007 | Đánh giá 2 chiều, TrustScore, khóa <40 | `reviews.js`, `trust.js` | reviews, trust_score_logs | RV-01, TS-01, TS-02, TRUST-01, RS-03 | E2E đánh giá 4★ |
| BPMN 2C b1–b4, UC05 | Báo sự cố, chống trùng, đóng băng ngay, hồ sơ + chat log | `disputes.js openDispute` | disputes, evidence | DS-01, DS-02, DS-08 | |
| BPMN 2C b5–b6b | CS xem hồ sơ, yêu cầu bổ sung, bằng chứng | `requestMoreEvidence`, `addEvidence`, `Admin.jsx DisputeCase` | evidence | DS-03, DS-04 | E2E màn hình hồ sơ CS |
| BPMN 2C b7–b11 | Ngưỡng 80%, hoàn 100% + phạt 20% / giải phóng 88/12 | `decideDispute` | platform_revenue, ledger RECEIVABLE | DS-05, DS-06, DS-07 | E2E phán quyết 85% |
| FR-005 (Withdrawal), BT3 Luồng 2 | Rút tiền PENDING→PROCESSING→COMPLETED/REJECTED | `withdrawals.js` | withdraw_requests | WD-01…WD-03 | |
| FR-005, NFR-004 | Sổ cái ghi kép, idempotency, đối soát | `ledger.js` | ledger_* | LEDGER-01…05, mọi test gọi `reconcile()` | `npm run reconcile` |
| FR-007 | Dashboard quản trị, BR-003 conversion | `admin.js dashboard`, `Admin.jsx` | profile_views | AZ-02 (quyền) | E2E dashboard |
| NFR-005 | Trạng thái rõ ràng | `BookingDetail.jsx` (stepper, countdown giờ server, xem trước tiền hoàn, sổ cái theo đơn) | | – | E2E desktop + mobile 375px |
| NFR-003, NFR-006, BR-002 | Mở rộng, 99,9%, chỉ tiêu KD | – | – | – | DEFERRED (SCOPE_BASELINE) |

## Kiểm tra ngược
- Entity trong ERD BT3 đều có bảng tương ứng (WALLET → ledger_accounts, xem DATA_MODEL).
- Mọi trạng thái Booking đều có transition vào/ra trong `TRANSITIONS` (bookings.js) và được test bao phủ (trừ đường `IN_SESSION → DISPUTED` chỉ test qua DS-08 gián tiếp; đường này được thao tác bằng UI "Companion vắng mặt? Báo sự cố").
- Route chưa có test tự động riêng: OAuth2 mock, `verify-rank`, `DELETE /me/companion/slots/:id`, `/admin/users/:id/status`, `/admin/audit`, công cụ demo (đã kiểm thử thủ công trên trình duyệt hoặc gián tiếp).
