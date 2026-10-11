import { EMPTY_VBK_SESSION_CONTEXT, type VbkSessionRequestBrowser } from '../../src/main/infrastructure/vbk-session-request.js';

const POST_QUERIES = new Set([
  'https://online.ctrip.com/restapi/soa2/20049/suggestPoi',
  'https://online.ctrip.com/restapi/soa2/20049/suggestDistrict',
  'https://online.ctrip.com/restapi/soa2/20049/suggestAirport',
  'https://online.ctrip.com/restapi/soa2/20049/suggestTrainStation',
  'https://online.ctrip.com/restapi/soa2/15638/searchResourceGroup',
  'https://m.ctrip.com/restapi/soa2/18109/json/getSightOnlinePage',
  'https://m.ctrip.com/restapi/soa2/21881/json/gaHotelSearchEngine',
]);
export function assertReadOnlyRequest(input: string | URL | Request, method = 'GET') {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const endpoint = url.origin + url.pathname;
  const allowed = method.toUpperCase() === 'POST' && POST_QUERIES.has(endpoint)
    || method.toUpperCase() === 'GET' && endpoint === 'https://hotels.ctrip.com/hotels/list';
  if (!allowed || url.username || url.password) throw new Error(`只读核验拒绝请求：${method} ${endpoint}`);
  return url;
}
/** No browser/profile, credential files, redirects, arbitrary evaluate or business writes. */
export function readOnlyFetcher(transport: typeof fetch = fetch, ticket = ''): typeof fetch {
  if (/[\r\n;]/u.test(ticket)) throw new Error('无效会话票据');
  return async (input, init = {}) => {
    const method = init.method ?? (input instanceof Request ? input.method : 'GET');
    const url = assertReadOnlyRequest(input, method);
    const headers = new Headers(init.headers);
    headers.delete('cookie'); headers.delete('authorization');
    if (url.hostname === 'online.ctrip.com' && ticket) headers.set('cookie', `vbkticket=${ticket}`);
    const response = await transport(url, { ...init, method, headers, redirect: 'manual',
      signal: init.signal ?? AbortSignal.timeout(20_000) });
    if (response.status >= 300 && response.status < 400) throw new Error('只读查询要求登录或发生跳转');
    return response;
  };
}
export function readOnlySession(fetcher: typeof fetch): VbkSessionRequestBrowser {
  return {
    nativeOnly: true,
    evaluate: async () => { throw new Error('只读核验禁止浏览器执行'); },
    vbkSessionFetch: async request => {
      if (request.businessContext) throw new Error('只读核验禁止业务写入上下文');
      const response = await fetcher(request.endpoint, { method: 'POST', headers: request.headers,
        body: JSON.stringify(request.body), signal: AbortSignal.timeout(request.timeoutMs ?? 12_000) });
      if (!response.ok) throw new Error(`只读资源查询失败：HTTP ${response.status}`);
      return { status: response.status, payload: await response.json(), durationMs: 0,
        ctx: { ...EMPTY_VBK_SESSION_CONTEXT } };
    },
  };
}
export function classifyQueryError(error: unknown): 'blocked' | 'failed' {
  return /登录|跳转|HTTP (?:401|403|408|429|430|5\d\d)|timeout|abort|fetch failed|会话|网络|验证码/i.test(String(error))
    ? 'blocked' : 'failed';
}
