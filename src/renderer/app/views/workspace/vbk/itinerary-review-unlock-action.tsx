/**
 * 「自动录入进度」列表底部的行程审核边界说明。
 *
 * 正常态只输出一行边界文案（即原来的静态 automationNote 位置），
 * 仅在审核结果不确定 / 失败 / 摘要不一致时追加只读核查入口。
 * 组件不提供二次审核提交：授权与提交都发生在自动录入流程里。
 */

import { LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProductDetail } from "../../../../../shared/contracts";
import {
  readItineraryReviewDigestMismatch,
  type ItineraryReviewUnlockState,
} from "../../../../../shared/itinerary-review-unlock";
import { api } from "../../../helpers";
import shared from "../../shared.module.less";
import { describeItineraryReviewBoundary } from "./itinerary-review-unlock-boundary";
import styles from "./itinerary-review-unlock-action.module.less";

type RefreshError = { text: string } | null;
type LocalStateReader = { getItineraryReviewUnlockState?: (localProductId: string) => Promise<ItineraryReviewUnlockState | null | undefined> };

function identity(product: ProductDetail) {
  return [product.id, product.productId ?? "", product.vbkAccount ?? "", product.productJsonVersion ?? 0].join("|");
}

function shortDigest(value: string) { return `${value.slice(0, 12)}…`; }

/** 只呈现已持久化 / 只读核查结果；真正的审核提交由产品授权的自动录入触发。 */
export function ItineraryReviewUnlockAction({ product, disabled }: { product: ProductDetail; disabled: boolean }) {
  const productIdentity = identity(product);
  const mountedRef = useRef(true);
  const serialRef = useRef(0);
  const activeIdentityRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ItineraryReviewUnlockState | null>(null);
  const [refreshError, setRefreshError] = useState<RefreshError>(null);

  useEffect(() => {
    mountedRef.current = true;
    if (activeIdentityRef.current !== productIdentity) {
      activeIdentityRef.current = productIdentity;
      serialRef.current += 1;
      setBusy(false);
      setState(null);
      setRefreshError(null);
    }
    return () => {
      serialRef.current += 1;
      setBusy(false);
      mountedRef.current = false;
    };
  }, [productIdentity, disabled]);

  // 本地专表读不使用嵌入式 VBK 页面：产品刚打开时可安全展示已持久化的结果。
  useEffect(() => {
    const reader = (api()?.automation as LocalStateReader | undefined)?.getItineraryReviewUnlockState;
    if (!reader) return;
    const serial = ++serialRef.current;
    void reader(product.id).then(next => {
      if (!mountedRef.current || serial !== serialRef.current || !next) return;
      setState(next);
      setRefreshError(null);
    }).catch(() => {
      // 旧 preload 或本地状态暂不可读时，保留主动的远端只读核查入口。
    });
    return () => { serialRef.current += 1; };
  }, [product.id, productIdentity, product.automation?.currentPhase, product.automation?.status]);

  const refresh = async () => {
    const client = api();
    if (!client?.automation?.refreshItineraryReviewUnlock || busy || disabled) return;
    const serial = ++serialRef.current;
    setBusy(true);
    setRefreshError(null);
    try {
      const next = await client.automation.refreshItineraryReviewUnlock(product.id);
      if (!mountedRef.current || serial !== serialRef.current) return;
      setState(next);
    } catch (error) {
      if (mountedRef.current && serial === serialRef.current) {
        setRefreshError({ text: error instanceof Error ? error.message : "标签状态核查失败。" });
      }
    } finally {
      if (mountedRef.current && serial === serialRef.current) setBusy(false);
    }
  };

  if (!product.productId) return null;
  const boundary = describeItineraryReviewBoundary(state);
  const digestMismatch = readItineraryReviewDigestMismatch(state?.digestMismatch);
  const bannerTone = refreshError ? "error" : boundary.tone === "error" ? "error" : "attention";

  return <>
    {boundary.needsAttention && <div
      className={styles.banner}
      data-tone={bannerTone}
      role={bannerTone === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      <ShieldCheck size={14} aria-hidden="true" />
      <span className={styles.bannerText}>{refreshError?.text ?? boundary.note}</span>
      <button
        type="button"
        className={shared.btn}
        data-variant="primary"
        disabled={disabled || busy}
        onClick={() => void refresh()}
      >
        {busy ? <LoaderCircle size={13} className={styles.spin} /> : <RefreshCw size={13} />}
        {busy ? "正在检查…" : "检查标签状态"}
      </button>
    </div>}
    <p className={styles.note} data-tone={boundary.tone}>{boundary.note}</p>
    {digestMismatch && <div className={styles.mismatch} role="status">
      <strong>审核摘要不一致（已脱敏）</strong>
      <span>步骤：{digestMismatch.step}；摘要：{shortDigest(digestMismatch.beforeDigest)} → {shortDigest(digestMismatch.afterDigest)}</span>
      {digestMismatch.paths.length > 0 && <ul>{digestMismatch.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul>}
    </div>}
  </>;
}
