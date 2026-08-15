import { logWarn } from "../../../../shared/log-timestamp.js";
// @ts-nocheck
/**
 * 「产品图文」阶段保存结果严格门禁 monitor：
 *
 * 真实证据：保存按钮被点击后，VBK 页面会发起 `POST /15638/savedescriptioninfo`，携程 React store
 * 的 editproductDesc 在被 UEditor setContent+sync 时未被同步写入（详见 features.react-sync.ts 的
 * 注释），但 UI 仍会显示「保存成功」，目标 tab 也可能立刻被解锁；先于官方保存响应判定「保存完成」
 * 会让 saveThenAdvance 误判为 navigated → 流程照常推进但描述 tab 上后续操作拿到的是空值。
 *
 * 本 monitor 把「保存成功」判定从「目标 tab 解锁」收窄为「官方 POST 响应 success=true 且
 * ResponseStatus.Ack=Success」：
 *   - 同时挂 page.on('request') 与 page.on('response')：
 *     1) request 阶段：/15638/checkSensitiveWord 请求「发出去」时 pendingSensitive++，
 *        给后续保存响应一个「先等敏感词结果」的口子。
 *     2) response 阶段：/15638/savedescriptioninfo 到达时若 pendingSensitive>0
 *        仍要等敏感词响应，再决定成功 / 失败 —— 防止「保存响应先到、敏感词后到被
 *        错判为成功」的脱节。
 *     3) /15638/checkSensitiveWord 响应到达时 pendingSensitive--，命中敏感词
 *        **永远优先失败**（即便 save 已收到 success=true 也覆盖）。
 *   - 任何超时 / 业务失败 / Ack 非 Success 都走 Error；不允许 fallback 到「目标 tab 已解锁」。
 *   - 永远不读取 / 持久化 cookie，不构造残缺 payload，只读官方响应业务字段。
 *
 * 设计要点：
 *   - install()/uninstall() 严格成对；uninstall 必须清掉 request/response 两个
 *     handler，清掉所有 setInterval timer，并把 disposed 置 true —— 后续到达的
 *     response 直接被 guard 拦截，避免「uninstall 后还在调用 settle」的隐式 leak。
 *   - 内部 settlement（resolve / reject）通过 queueMicrotask 推迟到下一个微任务执行，
 *     这样如果 response handler 在 waitForSave() 被调用之前就触发了 reject，
 *     Node 不会因为「Promise 已 reject 但还没有 await」而打 unhandledRejection 警告；
 *     同时缓存 cachedOutcome / cachedError，保证 waitForSave 之后调用也能正确结算。
 *   - sensitiveWords 命中后仍等一个合理超时让官方 savedescriptioninfo 落到 sink 里，
 *     避免 UI 已跳走但 monitor 报错的脱节。
 *   - 异步 response handler 必须用 `void handler().catch(...)` 包裹，避免未处理的
 *     Promise rejection；handler 内部所有副作用都要在 disposed guard 之内执行。
 */

/** 携程官方「保存产品描述」endpoint 路径片段；忽略 query string。 */
const SAVE_DESCRIPTION_INFO_PATH = "/15638/savedescriptioninfo";
/** 携程官方「产品描述敏感词检测」endpoint 路径片段。 */
const CHECK_SENSITIVE_WORD_PATH = "/15638/checkSensitiveWord";
/** 默认等待官方保存响应的总时长（ms）。 */
const DEFAULT_SAVE_TIMEOUT_MS = 15_000;
/** 默认等待敏感词先于保存回响的额外时长（ms）。 */
const DEFAULT_SENSITIVE_WORD_TIMEOUT_MS = 6_000;

export interface SaveMonitorOutcome {
  /** 是否捕获到 success=true 且 ResponseStatus.Ack=Success 的官方保存响应。 */
  saved: boolean;
  /** 命中字段（用于诊断 + 测试断言；不允许做凭据相关回放）。 */
  httpStatus: number;
  ack: string;
  success: boolean;
  /** 命中敏感词列表（可能为空）。 */
  sensitiveWords: string[];
}

export interface InstallOptions {
  saveTimeoutMs?: number;
  sensitiveWordTimeoutMs?: number;
}

/**
 * 平台明确返回敏感词时使用的结构化错误。上层自动化据此触发 AI 局部重写，
 * 不再依赖解析面向运营的错误字符串。
 */
export class PresentationSensitiveWordsError extends Error {
  constructor(
    public readonly sensitiveWords: string[],
    public readonly httpStatus: number,
  ) {
    super(`产品图文触发敏感词，请先调整文案：${sensitiveWords.join("、")}（HTTP=${httpStatus}）`);
    this.name = "PresentationSensitiveWordsError";
  }
}

/**
 * 在 page 上挂监听 /15638/savedescriptioninfo 与 /15638/checkSensitiveWord，
 * 并返回 monitor 对象。调用方负责：
 *   - 在点击保存按钮之前 install；
 *   - 点击之后立即 waitForSave()；
 *   - 不管成功失败，都要在最外层 finally 调 uninstall()，避免污染下一次会话。
 */
function installSaveMonitor(page: any, options: InstallOptions = {}) {
  const saveTimeoutMs = options.saveTimeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS;
  const sensitiveWordTimeoutMs = options.sensitiveWordTimeoutMs ?? DEFAULT_SENSITIVE_WORD_TIMEOUT_MS;

  let savedResponse: { body: any; httpStatus: number } | null = null;
  let sensitiveResponse: { body: any; httpStatus: number } | null = null;
  let cachedError: Error | null = null;
  let cachedOutcome: SaveMonitorOutcome | null = null;
  let resolveWait: ((outcome: SaveMonitorOutcome) => void) | null = null;
  let rejectWait: ((error: Error) => void) | null = null;
  let waitPromise: Promise<SaveMonitorOutcome> | null = null;
  let settled = false;
  /** monitor 已 uninstall：所有后续事件都直接丢弃，避免「uninstall 后还在跑 timer」的 leak。 */
  let disposed = false;
  /** 当前还在等待响应的 /15638/checkSensitiveWord 请求数；
   *  >0 时 save 响应到达后必须先等所有 pending 收尾，再决定成功。 */
  let pendingSensitive = 0;
  /** 排队中的 save response：pendingSensitive>0 时若 save 已到，先缓存到这，
   *  等敏感词全部收尾后回放结算。 */
  let pendingSaveResponse: { httpStatus: number; body: any } | null = null;
  /** 全部 setInterval handle 集合：uninstall 时一并 clearInterval。 */
  const timers: Set<ReturnType<typeof setInterval>> = new Set();

  /**
   * 把官方响应 business body 归一化；我们只读 success / ResponseStatus.Ack / sensitiveWords，
   * 不读任何 cookie / Authorization / X-* 等凭据字段。
   */
  function readBodyFields(body: any) {
    if (!body || typeof body !== "object") {
      return { success: null, ack: "", sensitiveWords: [] as string[] };
    }
    const responseStatus = (body as any).ResponseStatus ?? (body as any).responseStatus;
    const ack = typeof responseStatus === "object" && responseStatus !== null
      ? String((responseStatus as any).Ack ?? "")
      : "";
    const success = (body as any).success;
    const rawSensitive = (body as any).sensitiveWords ?? (body as any).SensitiveWords ?? [];
    const sensitiveWords = Array.isArray(rawSensitive)
      ? rawSensitive.map((value: unknown) => String(value ?? "").trim()).filter(Boolean)
      : [];
    return {
      success: typeof success === "boolean" ? success : null,
      ack,
      sensitiveWords,
    };
  }

  /**
   * 内部结算：缓存 outcome/error，并把 resolve/reject 推到下一个 microtask；
   * 这样如果 response handler 在 waitForSave() 还没被调用时就触发，
   * 不会因为 reject 找不到 awaiter 而打 unhandledRejection 警告。
   * 同时缓存状态，waitForSave() 在 microtask 里再消费。
   *
   * 已被 disposed 或已 settled 时直接返回；调用方无需自己双重判定。
   */
  function settle(outcome: SaveMonitorOutcome | null, error: Error | null) {
    if (settled || disposed) return;
    settled = true;
    if (error) cachedError = error;
    else cachedOutcome = outcome as SaveMonitorOutcome;
    queueMicrotask(() => {
      if (cachedError) {
        if (rejectWait) rejectWait(cachedError);
      } else if (cachedOutcome && resolveWait) {
        resolveWait(cachedOutcome);
      }
    });
  }

  /**
   * 官方保存响应命中：success=true 且 Ack=Success → 立即结算为成功；
   * success=false 或 Ack 非 Success → 立即结算为业务失败（不允许 retry，不允许兜底）。
   *
   * 当 pendingSensitive>0 时（敏感词检测请求还在飞），把本次响应缓存到
   * pendingSaveResponse，等所有敏感词响应收尾再回放 —— 防止「保存先到、敏感词
   * 后到」被错判为成功。
   *
   * 异常 ordering 兜底：若 waitStartTs 已经超过 sensitiveWordTimeoutMs（说明
   * 已经给敏感词一个完整等待窗口却仍 pendingSensitive>0），不再继续缓存，强制结算
   * save —— 否则「敏感词请求飞出但 response 永不回响」会让 waitForSave 永远 pending。
   */
  function onSaveResponse(httpStatus: number, body: any) {
    if (disposed) return;
    savedResponse = { body, httpStatus };
    if (pendingSensitive > 0) {
      // waitStartTs 未启动：response 早于 waitForSave()；说明这次 save 响应
      // 在 waitForSave 还没调用之前就已经到达，但之前还没有任何 waitForSave
      // 注册过 resolveWait。这种情况下 applySaveOutcome 调用后还是会缓存
      // outcome 等被消费，所以安全。
      const waitElapsed = waitStartTs == null ? 0 : Date.now() - waitStartTs;
      if (waitElapsed < sensitiveWordTimeoutMs) {
        pendingSaveResponse = { httpStatus, body };
        return;
      }
      // 已经超出敏感词窗口仍 pending：判定为「敏感词响应永不回响」异常 ordering，
      // 不再等待；先把 pending 清零再结算，否则 applySaveOutcome 会反复缓存。
      pendingSensitive = 0;
      pendingSaveResponse = null;
    }
    applySaveOutcome(httpStatus, body);
  }

  /**
   * 真正按业务字段结算 save 响应。被 onSaveResponse + pending 回放两个入口共用。
   */
  function applySaveOutcome(httpStatus: number, body: any) {
    if (settled || disposed) return;
    const fields = readBodyFields(body);
    const ackOk = fields.ack === "Success" || fields.ack === "SUCCESS";
    if (fields.success === true && ackOk) {
      settle({
        saved: true,
        httpStatus,
        ack: fields.ack,
        success: true,
        sensitiveWords: fields.sensitiveWords,
      }, null);
      return;
    }
    const detail = `success=${String(fields.success)} Ack=${fields.ack || "<empty>"}`;
    settle(null, new Error(`产品图文保存业务未成功：${detail}；HTTP=${httpStatus}`));
  }

  function onSensitiveResponse(httpStatus: number, body: any) {
    if (disposed) return;
    sensitiveResponse = { body, httpStatus };
    const fields = readBodyFields(body);
    if (fields.sensitiveWords.length > 0) {
      // 敏感词命中永远优先失败 —— 即便 save 已收 success=true 也覆盖。
      // 用 include save httpStatus 的方式保留诊断上下文。
      settle(null, new PresentationSensitiveWordsError(fields.sensitiveWords, httpStatus));
      return;
    }
    // 敏感词响应到达且无敏感词：递减 pending；若 save 已缓存且现在 pending=0，回放结算。
    if (pendingSensitive > 0) pendingSensitive -= 1;
    sensitiveResponsesSeen += 1;
    if (pendingSaveResponse && pendingSensitive === 0) {
      const cached = pendingSaveResponse;
      pendingSaveResponse = null;
      applySaveOutcome(cached.httpStatus, cached.body);
    }
  }

  /** 已观察到的「checkSensitiveWord 请求」数量（包括未回响的）；
   *  当 pendingSensitive 收到 decrement 时此值也跟着收尾 —— 这里用于统计
   *  「飞出但未回响」的请求数。*/
  let sensitiveRequestsSeen = 0;
  /** 已观察到的「checkSensitiveWord 响应」数量（含无敏感词命中）；用于
   *  判定"request 飞到后 response 仍未回响"导致 pendingSensitive 永远 > 0 的情况。*/
  let sensitiveResponsesSeen = 0;
  /** waitForSave() 启动的时间戳；用于在「save 响应到达 + pendingSensitive>0」时
   *  判定「敏感词请求已经等了多久」：超过 sensitiveWordTimeoutMs 时直接结算 save，
   *  防止「request 飞出但 response 永不回响」永久悬挂。 */
  let waitStartTs: number | null = null;

  /**
   * 监听官方 endpoint 路径；只看 path 含目标片段（容忍 query string、协议、host 差异），
   * 不读取 URL 里的任何凭据信息。
   */
  function pathMatches(urlValue: string, target: string): boolean {
    if (typeof urlValue !== "string") return false;
    try {
      const parsed = new URL(urlValue);
      return parsed.pathname.includes(target);
    } catch {
      return urlValue.includes(target);
    }
  }

  /**
   * 响应处理：playwright Page 的 'response' 回调可能为 async，handler 内
   * 必须用 void + .catch 包裹，避免未处理 Promise rejection。
   */
  const handleResponse = async (response: any) => {
    if (disposed) return;
    if (!response || typeof response.url !== "function") return;
    const url: string = (() => {
      try { return response.url(); } catch { return ""; }
    })();
    if (!url) return;
    try {
      if (pathMatches(url, SAVE_DESCRIPTION_INFO_PATH)) {
        const body = await response.json().catch(() => null);
        if (disposed) return;
        onSaveResponse(response.status?.() ?? 0, body);
        return;
      }
      if (pathMatches(url, CHECK_SENSITIVE_WORD_PATH)) {
        const body = await response.json().catch(() => null);
        if (disposed) return;
        onSensitiveResponse(response.status?.() ?? 0, body);
      }
    } catch (error) {
      // 网络 / 解析错误时不静默：等 waitForSave 超时再抛；已 settled 时直接吞。
      if (settled || disposed) return;
      // 不在这里 settle —— 协议上我们等超时再判定「未在窗口内收到业务响应」；
      // 解析失败只是一次响应坏掉，不应直接 reject（可能还有下一次同路径响应）。
    }
  };

  /**
   * 请求阶段处理：一旦看到 /15638/checkSensitiveWord 飞出，pendingSensitive++，
   * 让 onSaveResponse 知道「现在先不要结算」；save 自身不需要 pending —— 业务上
   * 一个产品图文保存只对应一次 save 响应，且响应先到 / 后到是同效的。
   */
  const handleRequest = (request: any) => {
    if (disposed) return;
    if (!request || typeof request.url !== "function") return;
    const url: string = (() => {
      try { return request.url(); } catch { return ""; }
    })();
    if (!url) return;
    if (pathMatches(url, CHECK_SENSITIVE_WORD_PATH)) {
      pendingSensitive += 1;
      sensitiveRequestsSeen += 1;
    }
  };

  /**
   * 异步 wrapper：uninstall 时 off 必须 off 同一个引用。Page.on('response') 在
   * Playwright 里是 EventEmitter 语义，匿名函数无法 off 掉 —— 所以这里把 wrapper
   * 提为命名函数 + 用 handleResponse 的引用做 key。
   */
  const onResponseSync = (response: any) => {
    if (disposed) return;
    void handleResponse(response).catch((error) => {
      if (settled || disposed) return;
      // 不在这里 settle：单次响应解析失败不应让整个 wait 失败；
      // 留给超时窗口判定「未在窗口内收到业务响应」。
      logWarn("[save-monitor] response handler error", {
        message: (error as Error)?.message ?? String(error),
      });
    });
  };

  if (typeof page?.on === "function") {
    page.on("request", handleRequest);
    // 异步 handler：playwright 不会 await 回调，handleResponse 自身是 async。
    // 用 void + .catch 包裹避免未处理 Promise rejection；disposed guard 内
    // 已经吸收了所有 settle 副作用，理论上不会 reject，但仍保留兜底。
    // 必须传命名函数 onResponseSync，uninstall 才能 off 同一个引用。
    page.on("response", onResponseSync);
  }

  /**
   * 卸载监听器、清掉所有 timer、置 disposed=true 防 leak；
   * 仍等待中的 waitForSave() 会被显式 reject 取消，避免「调用方 fire-and-forget
   * uninstall 后 waitForSave 永远 pending」的资源泄漏。
   *
   * 顺序很关键：
   *   1) 先把 listener / timer 都摘掉，避免后续 settle 之后还有事件进来；
   *   2) 仍等待中 → 缓存 cancel error 到 cachedError；
   *   3) 再把 disposed 置 true —— 因为 settle 内部会读 disposed，且我们必须保证
   *      这次主动 settle 调用一定要把 cancel error 落到 rejectWait 上（不能
   *      因为「提前 disposed=true」导致 settle 直接 return，waitForSave 永远悬挂）。
   *      所以**先 settle 后置 disposed**，否则 fire-and-forget uninstall 后
   *      waitForSave 永远 pending。
   */
  function uninstall() {
    try {
      if (typeof page?.off === "function") {
        // 必须 off 与 page.on 时同一个引用：onResponseSync（命名 wrapper），
        // 不能是 handleResponse（async 内部函数）；Playwright EventEmitter 是按引用匹配。
        page.off("response", onResponseSync);
        page.off("request", handleRequest);
      }
    } catch {
      // ignore
    }
    for (const timer of timers) {
      try { clearInterval(timer); } catch { /* ignore */ }
    }
    timers.clear();
    // 仍等待中：必须明确取消 / 失败，让 await 端能退出；调用方一般在外层
    // finally 同步 uninstall + 抛错，所以这里只是兜底。
    // **关键**：先 settle（settle 内部检测 disposed 会直接 return —— 所以
    // 这里必须在置 disposed=true 之前调 settle），并保证 rejectWait 已注册
    // （只有 waitForSave() 被调用过才会注册；未注册就是 fire-and-forget）。
    if (!settled) {
      const err = new Error("save monitor 已被卸载（disposed），等待已取消");
      // 直接走 cancel 路径：缓存 error + 调 rejectWait（如果有的话）；
      // 不走 settle（settle 在 disposed=true 后会被 guard 吞掉）。
      if (rejectWait) {
        // 标记 settled 防止后续事件 handler 重复 reject
        settled = true;
        cachedError = err;
        queueMicrotask(() => {
          if (rejectWait) rejectWait(err);
        });
      } else {
        // 没有 await 端在等：缓存 error，等之后有人 waitForSave 时消费。
        // waitForSave 的入口会先检查 cachedError 直接 reject。
        settled = true;
        cachedError = err;
      }
    }
    disposed = true;
  }

  /**
   * 等待官方 /15638/savedescriptioninfo 响应：
   *   - 必须 success=true 且 Ack=Success 才返回 saved=true；
   *   - 业务失败 / Ack 异常 / 无响应（超时）都抛错；
   *   - 敏感词命中同样抛错（独立于 save 响应，已在 onSensitiveResponse 内 settle）。
   *
   * 返回 SaveMonitorOutcome；失败直接抛 Error，不返回 saved=false 的「温和」结果，
   * 调用方不要 try-catch 后默认走兜底。
   *
   * 同一 monitor 实例只允许调一次 waitForSave()；重复调用复用同一 promise。
   */
  function waitForSave(): Promise<SaveMonitorOutcome> {
    if (waitPromise) return waitPromise;
    // 已 disposed：直接返回失败 promise，避免挂在 unhandled 状态。
    if (disposed) {
      return Promise.reject(new Error("save monitor 已被卸载（disposed），无法等待保存响应"));
    }
    waitPromise = new Promise<SaveMonitorOutcome>((resolve, reject) => {
      // 先检查缓存：如果 response handler 已经在 waitForSave() 之前触发并 settle，
      // 缓存里会有 outcome / error；直接消费掉。
      if (cachedError) {
        queueMicrotask(() => reject(cachedError));
        return;
      }
      if (cachedOutcome) {
        queueMicrotask(() => resolve(cachedOutcome as SaveMonitorOutcome));
        return;
      }
      // 未结算：注册 handler 等 settle 触发。
      resolveWait = resolve;
      rejectWait = reject;
      waitStartTs = Date.now();

      // 优先给敏感词一个先于保存回响的窗口；命中就立即抛错。
      const sensDeadline = Date.now() + sensitiveWordTimeoutMs;
      const sensTimer = setInterval(() => {
        if (settled || disposed) {
          clearInterval(sensTimer);
          timers.delete(sensTimer);
          return;
        }
        if (Date.now() >= sensDeadline) {
          clearInterval(sensTimer);
          timers.delete(sensTimer);
          const saveDeadline = Date.now() + saveTimeoutMs;
          const saveTimer = setInterval(() => {
            if (settled || disposed) {
              clearInterval(saveTimer);
              timers.delete(saveTimer);
              return;
            }
            if (Date.now() >= saveDeadline) {
              clearInterval(saveTimer);
              timers.delete(saveTimer);
              // 若 save 已收到但仍被 pendingSensitive 卡住，强制清算：当作
              // 「敏感词响应永不回响」异常 ordering 兜底。savedResponse 存在时
              // 走正常结算，否则按业务失败 reject。
              if (pendingSaveResponse) {
                const cached = pendingSaveResponse;
                pendingSaveResponse = null;
                pendingSensitive = 0;
                applySaveOutcome(cached.httpStatus, cached.body);
                return;
              }
              settle(null, new Error(
                `产品图文保存未在 ${saveTimeoutMs}ms 内收到官方 /15638/savedescriptioninfo 响应；` +
                `savedResponse=${savedResponse ? `已捕获 HTTP=${savedResponse.httpStatus}` : "<未捕获>"}，` +
                `sensitiveResponse=${sensitiveResponse ? `已捕获 HTTP=${sensitiveResponse.httpStatus}` : "<未捕获>"}` +
                `，pendingSensitive=${pendingSensitive}，` +
                `sensitiveRequestsSeen=${sensitiveRequestsSeen}，` +
                `sensitiveResponsesSeen=${sensitiveResponsesSeen}`,
              ));
            }
          }, 80);
          timers.add(saveTimer);
        }
      }, 80);
      timers.add(sensTimer);
    });
    return waitPromise;
  }

  return {
    waitForSave,
    uninstall,
  };
}

export {
  CHECK_SENSITIVE_WORD_PATH,
  DEFAULT_SAVE_TIMEOUT_MS,
  DEFAULT_SENSITIVE_WORD_TIMEOUT_MS,
  SAVE_DESCRIPTION_INFO_PATH,
  installSaveMonitor,
};
