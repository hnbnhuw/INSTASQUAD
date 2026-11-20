// Realtime bằng Server-Sent Events (SSE): đơn giản, không cần thư viện/WebSocket server.
// Mỗi user có thể mở nhiều kết nối (nhiều tab). Kênh: thông báo, cập nhật booking, chat, tín hiệu WebRTC.
const clients = new Map(); // userId -> Set<res>

export function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  return () => {
    const set = clients.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) clients.delete(userId);
  };
}

export function pushToUser(userId, event, data) {
  const set = clients.get(userId);
  if (!set) return 0;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      /* kết nối đã đóng */
    }
  }
  return set.size;
}

export function isOnline(userId) {
  return clients.has(userId);
}

export function connectionCount() {
  let n = 0;
  for (const s of clients.values()) n += s.size;
  return n;
}
