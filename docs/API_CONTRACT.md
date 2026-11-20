# API contract (REST, JSON, tiền là số nguyên VND)

- Base: `/api`. Xác thực: cookie `isq_session` (httpOnly). Request ghi phải có `Content-Type: application/json`.
- Lỗi thống nhất: `{"error": {"code": "SLOT_UNAVAILABLE", "message": "…", "details": …, "alertId": 12?}}`.
  400 dữ liệu sai · 401 chưa đăng nhập · 403 sai quyền · 404 · 409 xung đột trạng thái/idempotency · 422 vi phạm quy tắc nghiệp vụ · 500 `LEDGER_POSTING_FAILED` (đã rollback, có `alertId`) · 503 dịch vụ mock lỗi.
- Idempotency: `requestKey`/`idempotencyKey` trong body **hoặc** header `Idempotency-Key`. Gửi lại cùng key + cùng nội dung → 200 kèm `duplicate: true` và kết quả cũ; cùng key khác nội dung → 409 `IDEMPOTENCY_KEY_REUSED`.

## Auth & tài khoản
| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| POST | /auth/register | khách | `{email,password(≥8),displayName,role:RENTER|COMPANION}` |
| POST | /auth/login · /auth/logout | khách / user | Sai mật khẩu → 401 `INVALID_CREDENTIALS` |
| GET | /auth/me | mọi người | `{user, wallet, kyc}` hoặc `{user:null}` |
| GET | /auth/oauth/start?role= | khách | Redirect provider mô phỏng (cookie state) |
| POST | /auth/oauth/mock/authorize | provider mock | trả URL callback có `code` |
| GET | /auth/oauth/callback?code&state | khách | Kiểm tra state, đổi code (dùng 1 lần) |
| POST | /auth/kyc | user | `{fullName,idNumber(12 số),dob}` → `{status,message}`; 503 `EKYC_UNAVAILABLE` |

## Danh mục, tìm kiếm, Companion
| GET | /games | public | |
|---|---|---|---|
| GET | /companions?gameId&rank&minPrice&maxPrice&minTrust&date&q&sort&availableOnly | public | `{companions:[…match_score,next_slot,rating_avg], tookMs}` |
| GET | /companions/:id | public | hồ sơ, games, slots 8 ngày (AVAILABLE/BUSY), reviews; ghi lượt xem |
| GET/PUT | /me/companion/profile | COMPANION | `{headline,bio,hourlyRate,accepting,games:[{gameId,rank,inGameName}]}` |
| POST | /me/companion/games/:gameId/verify-rank | COMPANION | Game API mock |
| GET/POST | /me/companion/slots | COMPANION | POST `{date:"YYYY-MM-DD", hours:[0..23]}` |
| DELETE | /me/companion/slots/:id | COMPANION | chỉ slot AVAILABLE |

## Booking & phiên
| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | /bookings | RENTER/COMPANION | đơn của tôi |
| POST | /bookings | RENTER | `{companionId,gameId,startAt,hours,note?,requestKey}` → 201 `{booking, duplicate, escrow:{escrowed, reason?, details:{shortfall}}, wallet}`. Lỗi: `SLOT_UNAVAILABLE` 409, `DAILY_LIMIT_EXCEEDED` 422, `COMPANION_UNAVAILABLE` 422, `INVALID_HOURS`/`INVALID_SLOT` 400 |
| GET | /bookings/:id | bên của đơn, CS, ADMIN | chi tiết + history + escrow + transactions(entries) + session + dispute + cancelPreview |
| POST | /bookings/:id/escrow | RENTER chủ đơn | ký quỹ; `INSUFFICIENT_BALANCE` 422 (details.shortfall), `HOLD_EXPIRED` 409 |
| POST | /bookings/:id/respond | COMPANION của đơn | `{decision: ACCEPT|REJECT}`; quá 180s → 409 `RESPONSE_WINDOW_CLOSED` |
| POST | /bookings/:id/cancel | RENTER chủ đơn | áp quy tắc 100% / 70-30 / phạt; sau giờ hẹn → 409 `SESSION_STARTED` |
| POST | /bookings/:id/confirm | RENTER | nghiệm thu → giải ngân 88/12 |
| POST | /bookings/:id/dispute | RENTER | `{reason,detail?}` → 201 (hoặc 200 `duplicate`) |
| POST | /bookings/:id/review | bên của đơn | `{rating 1..5, comment?}`; trùng → 409 `ALREADY_REVIEWED` |
| GET | /bookings/:id/room | bên của đơn; CS/ADMIN nếu có khiếu nại | tin nhắn + trạng thái phòng |
| POST | /bookings/:id/messages | bên của đơn, chỉ khi IN_SESSION | `{body ≤1000}`; SĐT/link/STK bị thay `[đã ẩn]`, `flagged=1` |
| POST | /bookings/:id/rtc | bên của đơn, IN_SESSION | `{type: call-request|call-accept|call-decline|offer|answer|ice|hangup, data}` → `{delivered}` |
| GET | /events | user | SSE: `hello`, `ping`, `notification`, `booking`, `chat`, `rtc` |

## Ví & thanh toán
| GET | /wallet | user | `{wallet:{available,escrow,frozen,withdrawHold,receivable}, entries, payments, withdrawals}` |
|---|---|---|---|
| POST | /payments/topup | user | `{amount,method:VNPAY_MOCK|MOMO_MOCK,idempotencyKey,bookingId?}` → `{payment, payUrl}` |
| GET | /payments/sim/:gtx | chủ payment | trang cổng mô phỏng + log callback |
| POST | /payments/sim/:gtx/complete | chủ payment | `{outcome:SUCCESS|FAILED|PENDING, times?:1..3}` – cổng mô phỏng gửi callback **đã ký** qua handler IPN |
| POST | /payments/gateway/callback | public (HMAC) | `{gatewayTxnId,status,amount,signature}` → `CREDITED | MARKED_FAILED | STILL_PENDING | DUPLICATE_IGNORED`; sai chữ ký 400 |
| POST | /withdrawals | COMPANION (eKYC, không nợ) | `{amount ≥50000, payoutCode:"PAYOUT-XXXX", idempotencyKey}` |
| GET / POST | /notifications · /notifications/read | user | |

## Khiếu nại
| GET | /disputes/:id | bên liên quan, CS, ADMIN | hồ sơ + bằng chứng |
|---|---|---|---|
| POST | /disputes/:id/evidence | bên liên quan, CS, ADMIN | `{text?, file?:{name,mime,base64}}` (≤2MB, PNG/JPEG/WEBP/PDF/TXT) |
| GET | /evidence/:id/file | bên liên quan, CS, ADMIN | tệp giải mã, CSP chặt |
| GET | /admin/disputes · /admin/disputes/:id/case | CS, ADMIN | hàng chờ; hồ sơ đầy đủ (booking, chat, sự kiện, lịch sử Companion) |
| POST | /admin/disputes/:id/request-evidence | CS, ADMIN | `{note}` → NEEDS_EVIDENCE |
| POST | /admin/disputes/:id/decide | CS, ADMIN | `{faultPercent 0..100, reason ≥10}` → `{dispute, summary}`; đã xử lý → 409 |

## Quản trị (ADMIN)
`GET /admin/dashboard`, `GET /admin/reconcile`, `GET /admin/ledger`, `GET /admin/withdrawals`, `POST /admin/withdrawals/:id/(process|complete|reject)` (`{reason}` khi reject), `GET /admin/alerts`, `POST /admin/alerts/:id/retry`, `POST /admin/alerts/:id/resolve {note}`, `GET /admin/users`, `POST /admin/users/:id/status {status}`, `GET /admin/audit`.
Công cụ demo (chỉ khi `DEMO_TOOLS=true`, 404 nếu tắt): `GET /admin/demo`, `POST /admin/demo/clock {advanceMinutes|reset}`, `POST /admin/demo/ledger-fault {armed}`, `POST /admin/demo/scheduler`, `POST /admin/demo/reset {confirm:"RESET"}`.

Không có endpoint nào cho phép sửa số dư trực tiếp (test AZ-02).

## Ví dụ
```http
POST /api/bookings
Idempotency-Key: bk-lw3k2-88123
{"companionId":6,"gameId":1,"startAt":1795176000000,"hours":2,"note":"leo rank"}

201 {"booking":{"id":8,"code":"BK000008","status":"PENDING_COMPANION","total_fee_snapshot":120000,"respond_deadline":1795172859000,…},
     "duplicate":false,"escrow":{"escrowed":true},"wallet":{"available":545000,"escrow":120000,…}}
```
