/** 仅供已确认无写入副作用的请求使用；网络错误不授权重复提交。 */
export async function retryVbkRead<T>(read: () => Promise<T>, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await read(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 3 || !/net::ERR_(?:FAILED|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|NETWORK_CHANGED)|fetch failed|network request failed/i.test(message)) throw error;
      await wait(attempt * 500);
    }
  }
}
