import { CheckCircle2, CircleAlert, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProductDetail } from "../../../../../shared/contracts";
import {
  readItineraryReviewDigestMismatch,
  type ItineraryReviewUnlockState,
} from "../../../../../shared/itinerary-review-unlock";
import { api } from "../../../helpers";
import shared from "../../shared.module.less";
import styles from "./itinerary-review-unlock-action.module.less";

type Notice = { tone: "success" | "warning" | "error"; text: string } | null;
type LocalStateReader = { getItineraryReviewUnlockState?: (localProductId: string) => Promise<ItineraryReviewUnlockState | null | undefined> };

function identity(product: ProductDetail) {
  return [product.id, product.productId ?? "", product.vbkAccount ?? "", product.productJsonVersion ?? 0].join("|");
}

function describe(state: ItineraryReviewUnlockState): Notice {
  if (state.status === "verified") return { tone: "success", text: "行程审核已完成，10/10 个标签已可用。" };
  if (state.status === "dispatched" || state.status === "uncertain") {
    return { tone: "warning", text: state.message ?? "自动审核结果尚待核实；只能检查标签状态。" };
  }
  if (state.status === "failed") return { tone: "error", text: state.message ?? "自动审核未完成，可检查标签状态。" };
  return { tone: "warning", text: state.message ?? "等待已授权的录入流程自动审核行程。" };
}

function shortDigest(value: string) { return `${value.slice(0, 12)}…`; }

/** Only presents persisted/read-only status; the original product approval starts the automation. */
export function ItineraryReviewUnlockAction({ product, disabled }: { product: ProductDetail; disabled: boolean }) {
  const productIdentity = identity(product);
  const mountedRef = useRef(true);
  const serialRef = useRef(0);
  const activeIdentityRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ItineraryReviewUnlockState | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    mountedRef.current = true;
    if (activeIdentityRef.current !== productIdentity) {
      activeIdentityRef.current = productIdentity;
      serialRef.current += 1;
      setBusy(false);
      setState(null);
      setNotice(null);
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
      setNotice(describe(next));
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
    setNotice(null);
    try {
      const next = await client.automation.refreshItineraryReviewUnlock(product.id);
      if (!mountedRef.current || serial !== serialRef.current) return;
      setState(next);
      setNotice(describe(next));
    } catch (error) {
      if (mountedRef.current && serial === serialRef.current) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "标签状态核查失败。" });
      }
    } finally {
      if (mountedRef.current && serial === serialRef.current) setBusy(false);
    }
  };

  if (!product.productId) return null;
  const verified = state?.status === "verified";
  const pending = state?.status === "dispatched" || state?.status === "uncertain";
  const digestMismatch = readItineraryReviewDigestMismatch(state?.digestMismatch);

  return <div className={styles.action} data-status={state?.status ?? "idle"}>
    <div className={styles.copy}>
      <ShieldCheck size={15} aria-hidden="true" />
      <div>
        <strong>行程审核与标签解锁</strong>
        <p>录入授权后，程序会自动审核行程并解锁标签。产品保持未发布，不创建交通子产品。</p>
      </div>
    </div>
    <div className={styles.controls}>
      <button type="button" className={shared.btn} data-variant={verified ? undefined : "primary"}
        disabled={disabled || busy} onClick={() => void refresh()}>
        {busy ? <LoaderCircle size={13} className={styles.spin} /> : <RefreshCw size={13} />}
        {busy ? "正在检查…" : "检查标签状态"}
      </button>
      {verified && <span className={styles.verified}><CheckCircle2 size={13} />10/10 已可用</span>}
      {pending && <span className={styles.pending}>等待核验</span>}
    </div>
    {notice && <p className={styles.notice} data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
      {notice.tone !== "success" && <CircleAlert size={13} aria-hidden="true" />}{notice.text}
    </p>}
    {digestMismatch && <div className={styles.mismatch} role="status">
      <strong>审核摘要不一致（已脱敏）</strong>
      <span>步骤：{digestMismatch.step}；摘要：{shortDigest(digestMismatch.beforeDigest)} → {shortDigest(digestMismatch.afterDigest)}</span>
      {digestMismatch.paths.length > 0 && <ul>{digestMismatch.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul>}
    </div>}
  </div>;
}
