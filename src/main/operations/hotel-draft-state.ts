import { randomUUID } from "node:crypto";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import type { HotelDraftRetryResult } from "../../shared/hotel-draft-retry.js";
import { usesPlatformHotelRules, validPlatformHotelRules, platformHotelStayGroups } from "../../shared/platform-hotel-rules.js";

type Store = Pick<VbkDatabase, "runProductTransaction" | "getProduct" | "getAgentSnapshot" | "saveAgentSnapshot" | "saveAutomation" | "appendOperationLog">;
const message = "酒店规则草稿已回读确认：自动匹配为是，三钻、四钻、五钻全选，指定酒店为空。住宿使用平台资源，无需准备酒店；任务保持暂停，未执行其他阶段。";

/** Only a fresh verified readback may retire a failed hotel checkpoint. */
export function applyVerifiedHotelDraftState(db: Store, id: string, proof: HotelDraftRetryResult, expectedVersion: number) {
  return db.runProductTransaction(() => {
    const current = db.getProduct(id);
    if (!current || current.productJsonVersion !== expectedVersion || current.productId !== proof.productId)
      throw new Error("产品方案已变化，不能同步酒店状态");
    if (!usesPlatformHotelRules(current.product) || !validPlatformHotelRules((current.product.operations as Record<string, unknown> | undefined)?.hotelRules)
      || proof.verified !== true || proof.draftOnly !== true || !validPlatformHotelRules(proof.rules)
      || !Array.isArray(proof.specifiedHotels) || proof.specifiedHotels.length
      || !Array.isArray(proof.segmentIds) || proof.segmentIds.some(segment => !segment)
      || new Set(proof.segmentIds).size !== proof.segmentIds.length
      || proof.segmentIds.length !== platformHotelStayGroups(current.product).length)
      throw new Error("酒店规则缺失或无效，不能清除失败提示");
    const snapshot = db.getAgentSnapshot(id);
    if (current.automation?.status === "running" || snapshot?.run && ["running", "queued"].includes(snapshot.run.status))
      throw new Error("任务正在执行，不能同步酒店状态");
    const run = current.automation;
    const recovery = run?.recovery?.phases.hotelResource;
    const hotel = run?.phases.find(phase => phase.phase === "hotelResource");
    const uncertainHotel = snapshot?.uncertainWrite?.toolCallId === "phase:hotelResource";
    if (!run || !hotel || hotel.status === "completed" && recovery?.state !== "needs_user" && !recovery?.finalError && !uncertainHotel)
      return current;
    const at = new Date().toISOString();
    hotel.status = "completed";
    if (recovery) {
      recovery.attemptsHistory = [...(recovery.attemptsHistory ?? []), ...recovery.attempts];
      recovery.attempts = []; recovery.state = "completed";
      delete recovery.finalError; delete recovery.userInstruction;
    }
    if (run.currentPhase === "hotelResource") delete run.currentPhase;
    run.updatedAt = at;
    run.logs.push({ at, level: "info", message });
    // Keep the whole run stopped: later phases and whole-product completion are untouched.
    db.saveAutomation(id, run);
    if (snapshot?.run && ["paused", "failed"].includes(snapshot.run.status)) {
      if (uncertainHotel) delete snapshot.uncertainWrite;
      snapshot.updatedAt = at;
      snapshot.run.updatedAt = at;
      snapshot.events.push({ id: randomUUID(), runId: snapshot.run.id, type: "status", createdAt: at,
        content: message, data: { status: snapshot.run.status, hotelDraftReadback: true } });
      db.saveAgentSnapshot(snapshot);
    }
    db.appendOperationLog({ id: randomUUID(), type: "automation", name: "酒店草稿本地状态同步", status: "succeeded",
      localProductId: id, phase: "hotelResource", startedAt: at, message,
      payload: { ...proof, productJsonVersion: expectedVersion, automationRunId: run.id, localStateOnly: true } });
    return db.getProduct(id)!;
  });
}
