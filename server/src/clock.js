// Đồng hồ phía server: mọi quyết định thời gian (180s, 15 phút, giữ chỗ, hủy) dùng clock.now(), không dùng giờ client.
// Có thể dịch thời gian (demo tools / test) để mô phỏng mà không phải chờ thật.
let offsetMs = 0;
let frozenAt = null;

export const clock = {
  now: () => (frozenAt ?? Date.now()) + offsetMs,
  getOffset: () => offsetMs,
  setOffset: (ms) => {
    offsetMs = Math.trunc(ms);
  },
  advance: (ms) => {
    offsetMs += Math.trunc(ms);
  },
  // Chỉ dùng trong test: cố định thời điểm hiện tại.
  freeze: (at) => {
    frozenAt = at;
    offsetMs = 0;
  },
  unfreeze: () => {
    frozenAt = null;
  },
};
