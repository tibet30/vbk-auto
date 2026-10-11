import { record } from '../../shared/product-storage-projection.js';

/** A missing collection is a protocol failure; a present empty list is a business result. */
export function assertPlatformQueryResponse(payload: unknown, paths: string[][], label: string): void {
  const root = record(payload);
  const status = record(root.ResponseStatus);
  if (status.Ack !== undefined && !/^(?:success|warning)$/i.test(String(status.Ack))) {
    const errors = Array.isArray(status.Errors) ? status.Errors : [];
    const detail = errors.map(error => {
      const row = record(error); return `${row.ErrorCode ?? ''} ${row.Message ?? ''}`.trim();
    }).join('；');
    throw new Error(`${label}业务拒绝: ${detail || String(status.Ack)}`);
  }
  const valid = paths.some(path => {
    let value: unknown = payload;
    for (const key of path) value = record(value)[key];
    return Array.isArray(value);
  });
  if (!valid) throw new Error(`${label}协议解析失败：资源集合字段缺失`);
}
