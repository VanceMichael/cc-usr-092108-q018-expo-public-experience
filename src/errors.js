// 领域错误：code 供调用方与断网同步结果稳定识别。
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new DomainError(code, message);
}
