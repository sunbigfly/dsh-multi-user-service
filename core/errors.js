export class LanError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'LanError';
    this.code = code;
    this.status = status;
  }
}

export function reject(code, message, status = 400) {
  throw new LanError(code, message, status);
}
