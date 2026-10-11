import { useEffect, useRef, useState } from "react";
import { api } from "../../helpers";
import type { ItineraryDay, TimelineItem } from "./review-summary-itinerary-timeline";

type Removal = { item: TimelineItem; signature: string };

/** 删除只走人工字段命令；确认、保存中、失败与完成都在页面内反馈。 */
export function useItinerarySpotRemoval(localProductId: string, days: ItineraryDay[]) {
  const [confirmation, setConfirmation] = useState<Removal | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const locked = useRef(false);
  const currentProduct = useRef(localProductId);
  currentProduct.current = localProductId;
  const signature = JSON.stringify(days.map(day => day.spots));

  useEffect(() => {
    setConfirmation(null); setError(null); setNotice(null); setSaving(false);
  }, [localProductId]);

  useEffect(() => {
    if (confirmation && confirmation.signature !== signature && !locked.current) {
      setConfirmation(null);
      setNotice("行程已变化，请重新选择要删除的站点。");
    }
  }, [signature, confirmation]);

  function requestRemoval(item: TimelineItem) {
    if (item.spotIndex === undefined || locked.current) return;
    setConfirmation({ item, signature }); setError(null); setNotice(null);
  }

  function cancelRemoval() {
    if (locked.current) return;
    setConfirmation(null); setError(null);
  }

  async function confirmRemoval() {
    if (!confirmation || locked.current) return;
    if (confirmation.signature !== signature) {
      setConfirmation(null); setNotice("行程已变化，请重新选择要删除的站点。"); return;
    }
    const { item } = confirmation;
    locked.current = true; setSaving(true); setError(null);
    try {
      const ipc = api();
      if (!ipc) throw new Error("未连接桌面保存服务，请重新打开应用后重试。");
      await ipc.products.updateReviewField(localProductId, {
        field: "itinerarySpotRemove", dayIndex: item.dayIndex, spotIndex: item.spotIndex!,
      });
      if (currentProduct.current !== localProductId) return;
      setConfirmation(null); setNotice(`已删除「${item.title}」。`);
    } catch (failure) {
      if (currentProduct.current === localProductId) {
        setError(failure instanceof Error ? failure.message : "删除站点失败，请重试。");
      }
    } finally {
      locked.current = false;
      if (currentProduct.current === localProductId) setSaving(false);
    }
  }

  return { confirmation, saving, error, notice, requestRemoval, cancelRemoval, confirmRemoval };
}
