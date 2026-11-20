// Lỗi nghiệp vụ thống nhất: { error: { code, message, details } }
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const E = {
  badRequest: (code, msg, d) => new AppError(400, code, msg, d),
  unauthorized: (msg = 'Bạn cần đăng nhập') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'Bạn không có quyền thực hiện thao tác này') => new AppError(403, 'FORBIDDEN', msg),
  notFound: (msg = 'Không tìm thấy dữ liệu') => new AppError(404, 'NOT_FOUND', msg),
  conflict: (code, msg, d) => new AppError(409, code, msg, d),
  unprocessable: (code, msg, d) => new AppError(422, code, msg, d),
};

// Lỗi ghi sổ (BPMN: cổng "Ghi sổ thành công?" → nhánh lỗi, hoàn tác + cảnh báo đối soát)
export class LedgerError extends AppError {
  constructor(message, details) {
    super(500, 'LEDGER_POSTING_FAILED', message, details);
  }
}
