// @ts-nocheck
/**
 * 资源配置阶段共享的纯函数与小颗粒度等待 helper：
 *   - classifyPackageManagedSegments：纯函数判定「套餐承载住宿」分支；
 *   - waitForSaveButtonReady / waitForSubmitButtonReady：可观察信号等待，
 *     替代「点完按钮后固定 delay 赌异步重渲染」的写法。
 *
 * 顶部带 `// @ts-nocheck`，因为 page 是动态传入。
 */

/**
 * 纯函数：根据「住宿段证据 items」判定是否可走套餐承载住宿路径。
 *   - items[i] = { title: string, nights: number, hasEnabledPackage: boolean }
 *   - 正住宿段：nights > 0
 *   - 无任何正住宿段 → { ok: false, reason: "no-lodging" }
 *   - 任一正住宿段缺可用套餐入口 → { ok: false, reason: "missing-package", missing: [...] }
 *   - 否则 → { ok: true, segments: items }
 *
 * 设计要点：把 DOM 扫描结果固化成稳定输入，纯函数只判断语义、不接触浏览器，
 * 便于单测覆盖 ok / no-lodging / missing-package 三条分支。
 */
export function classifyPackageManagedSegments(items) {
  const list = Array.isArray(items) ? items : [];
  const positive = list.filter((seg) => Number(seg?.nights) > 0);
  if (positive.length === 0) {
    return { ok: false, reason: "no-lodging" };
  }
  const missing = positive.filter((seg) => seg?.hasEnabledPackage !== true);
  if (missing.length > 0) {
    return { ok: false, reason: "missing-package", missing };
  }
  return { ok: true, segments: list };
}

/**
 * 点击「编辑」后等「保存」按钮进入可点击状态，作为「编辑面板就绪」的可观察信号。
 * 找不到按钮或一直 disabled → 超时抛错，避免依赖固定 delay 赌资源异步加载。
 */
export async function waitForSaveButtonReady(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const candidate = buttons.find(
          (b) => (b.textContent || "").trim().replace(/\s+/g, "") === "保存",
        );
        if (!candidate) return false;
        if (candidate.disabled) return false;
        if (candidate.getAttribute("aria-disabled") === "true") return false;
        return true;
      },
      undefined,
      { timeout: timeoutMs, polling: 100 },
    );
  } catch (err) {
    const raw = err && typeof err === "object" ? err : { message: String(err) };
    if (raw && raw.name === "TimeoutError") {
      throw new Error(`编辑面板未就绪：等待「保存」按钮变为可点击超时 ${timeoutMs}ms`);
    }
    const msg = typeof raw.message === "string" ? raw.message : "";
    throw new Error(`编辑面板就绪检查失败：${msg}`);
  }
}

/** 点开资源段面板后等「提交」按钮可见，作为面板就绪的证据。 */
export async function waitForSubmitButtonReady(page, timeoutMs) {
  const submit = page.getByRole("button", { name: "提 交", exact: true }).first();
  try {
    await submit.waitFor({ state: "visible", timeout: timeoutMs });
  } catch (err) {
    const raw = err && typeof err === "object" ? err : { message: String(err) };
    if (raw && raw.name === "TimeoutError") {
      throw new Error(`资源面板未就绪：等待「提交」按钮可见超时 ${timeoutMs}ms`);
    }
    throw err;
  }
}