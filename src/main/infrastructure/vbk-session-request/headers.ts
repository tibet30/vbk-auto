/**
 * vbk-session-request 请求头合并：
 *   - 把 DEFAULT_VBK_SOA_HEADERS 与调用方 overrides 合并；
 *   - 强制小写键，避免 VBK 校验因大小写不一致而漏字段。
 */

import { DEFAULT_VBK_SOA_HEADERS } from "./types.js";

export function requestHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries([...Object.entries(DEFAULT_VBK_SOA_HEADERS), ...Object.entries(overrides)]
    .map(([key, value]) => [key.toLowerCase(), value]));
}