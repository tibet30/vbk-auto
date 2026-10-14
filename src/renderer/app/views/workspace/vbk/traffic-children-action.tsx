import { useState } from "react";
import { LoaderCircle, Play } from "lucide-react";
import { api } from "../../../helpers";
import type { ProductDetail } from "../../../../../shared/contracts.js";
import styles from "./traffic-children-action.module.less";
import shared from "../../shared.module.less";

export function TrafficChildrenAction({ product, disabled }: { product: ProductDetail; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [routeReview, setRouteReview] = useState(false);
  const [message, setMessage] = useState("");
  const parentSaved = product.status === "draft_saved" && Boolean(product.productId)
    && product.automation?.phases.some(phase => phase.phase === "preflight" && phase.status === "completed");
  return <div className={styles.action}>
    <p>默认不创建子产品。母产品录入完成后，可在此单独创建；已有子产品将从保存的进度继续。只保存草稿。</p>
    <label>
      <input type="checkbox" checked={routeReview} disabled={disabled || busy} onChange={event => setRouteReview(event.target.checked)} />
      同时授权玩法线路匹配审核
    </label>
    <button type="button" className={shared.btn} disabled={disabled || busy || !parentSaved}
      title={parentSaved ? "授权创建并录入交通子产品" : "请先完成母产品录入及最终回读"}
      onClick={async () => {
        if (!api() || busy) return;
        setBusy(true); setMessage("");
        try {
          const result = await api()!.agent.createTrafficChildren(product.id, routeReview);
          setMessage(result.run?.status === "running" ? "已授权子产品录入，请查看下方进度。" : result.events.at(-1)?.content ?? "子产品录入已暂停。");
        } catch (error) { setMessage(error instanceof Error ? error.message : "子产品录入未能启动。"); }
        finally { setBusy(false); }
      }}>
      {busy ? <LoaderCircle size={12} /> : <Play size={12} />}创建并录入子产品
    </button>
    {message && <p role="status">{message}</p>}
  </div>;
}
