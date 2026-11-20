# AI progress

Cập nhật: 2026-11-20. File WBS không có ⇒ theo dõi theo milestone của chuỗi prompt + mã yêu cầu nguồn (DL-01). Trạng thái chỉ là **Done** khi có sản phẩm + bằng chứng (test/E2E trong QA_REPORT.md).

| Milestone / gói | Nội dung | Trạng thái | Bằng chứng |
|---|---|---|---|
| M0 – Audit & scope | Đọc 3 PDF, phát hiện thiếu WBS, khóa phạm vi | Done | SCOPE_BASELINE.md, DECISION_LOG.md DL-01 |
| M1 – Yêu cầu, state machine, policy | REQUIREMENTS, DEMO_POLICY DP-01…12, FINANCIAL_RULES | Done | docs/ |
| M2 – Kiến trúc, ERD, API | ARCHITECTURE, DATA_MODEL, API_CONTRACT, TRACEABILITY | Done | docs/ |
| M3 – Nền tảng repo | Cấu trúc server/client, env validate, migration, seed idempotent, health, error handler, README | Done | clean setup ở QA §2 |
| FR-001 Auth, RBAC, OAuth2 mock, eKYC mock | | Done | AZ-01…04 |
| FR-002/003 Tìm kiếm, hồ sơ, Slot Calendar | | Done | AZ-05, BK-06, E2E |
| FR-004 Booking, idempotency, giữ chỗ, concurrency | | Done | BK-01…13 |
| FR-005 Wallet, Ledger, Escrow, Payment simulator | | Done | LEDGER-*, PAY-*, MONEY-01 |
| BPMN 1B/1C – 180s, hủy 30/10 | | Done | RS-*, CN-*, FL-* |
| FR-006 Session, chat realtime, voice WebRTC | Chat: Done. Voice: **Partial** (cài đặt xong, chưa kiểm thử âm thanh thật) | Done / Partial | SS-01, CH-01, E2E chat |
| BPMN 2B – Nghiệm thu, 88/12 | | Done | ST-01…03 |
| BPMN 2C – Dispute, bằng chứng, CS | | Done | DS-01…08 |
| FR-007 – Review, TrustScore, dashboard | | Done | RV-01, TS-*, E2E |
| Withdrawal mock | | Done | WD-01…03 |
| Frontend MVP (Renter/Companion/CS/Admin, responsive) | | Done | E2E desktop + 375px |
| QA & đối soát | | Done | QA_REPORT.md |
| Báo cáo cuối / slide / template trường | Chưa có template môn học | Not Started | – |
| NFR-003/006 mở rộng & HA, ghi âm, STUN/TURN | | Deferred | SCOPE_BASELINE |

## Việc cần người dùng/PO
1. Bổ sung `INSTASQUAD_WBS_Detailed.xlsx` nếu muốn đối chiếu TC01–TC70 và D01–D18.
2. Xác nhận/sửa các quy ước DEMO_POLICY (đặc biệt DP-03, DP-04, DP-06, DP-08) và mâu thuẫn thứ tự thanh toán UC03 vs BPMN (DL-03).
3. Cung cấp template báo cáo môn học (nếu có) để soạn báo cáo cuối.
