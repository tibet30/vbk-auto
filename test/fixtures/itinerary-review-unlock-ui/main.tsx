import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProductDetail } from "../../../src/shared/contracts";
import type { ItineraryReviewUnlockState } from "../../../src/shared/itinerary-review-unlock";
import { ItineraryReviewUnlockAction } from "../../../src/renderer/app/views/workspace/vbk/itinerary-review-unlock-action";
import "../../../src/renderer/styles/global.css";

type Mode = "verified" | "uncertain" | "failed";
const product = (id: string, account: string, version: number): ProductDetail => ({
  id, name: `隔离产品 ${id}`, status: "draft_saved", productId: id === "one" ? "79713744" : "79713745",
  vbkAccount: account, productJsonVersion: version, product: {} as ProductDetail["product"],
});
const state = (id: string, mode: Mode): ItineraryReviewUnlockState => ({
  localProductId: id, status: mode, attemptId: mode === "uncertain" ? "attempt" : "", productId: id === "one" ? "79713744" : "79713745",
  accountKey: "vbk_isolated", tourInfoId: "tour-isolated", beforeDigest: "digest-isolated",
  ...(mode === "uncertain" ? {
    message: "上次结果未确认，只能只读核查",
    digestMismatch: {
      step: "审核校验", beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64),
      paths: ["$.tourDailyDescriptions[0].tourDailyInfos[0].description"],
      body: "保留行程正文",
    } as ItineraryReviewUnlockState["digestMismatch"],
  } : {}),
  ...(mode === "failed" ? { message: "自动审核尚未完成" } : {}), updatedAt: "2099-01-01T00:00:00.000Z",
});

function Fixture() {
  const [id, setId] = useState("one");
  const [account, setAccount] = useState("vbk_isolated");
  const [version, setVersion] = useState(4);
  const [mode, setMode] = useState<Mode>("verified");
  const [phase, setPhase] = useState("idle");
  const [disabled, setDisabled] = useState(false);
  const [holdRefresh, setHoldRefresh] = useState(false);
  const calls = (window as any).unlockFixtureCalls ?? { local: 0, refresh: 0 };
  (window as any).unlockFixtureCalls = calls;
  (window as any).vbk = { automation: {
    getItineraryReviewUnlockState: async (localId: string) => { calls.local += 1; return state(localId, mode); },
    refreshItineraryReviewUnlock: async (localId: string) => {
      calls.refresh += 1;
      if (holdRefresh) await new Promise<void>(resolve => { (window as any).releaseUnlockRefresh = resolve; });
      return state(localId, mode);
    },
  } };
  return <main>
    <button onClick={() => { setMode("verified"); setPhase("verified"); }}>已解锁状态</button>
    <button onClick={() => { setMode("uncertain"); setPhase("uncertain"); }}>结果不确定</button>
    <button onClick={() => { setMode("failed"); setPhase("failed"); }}>审核失败</button>
    <button onClick={() => { setMode("uncertain"); setPhase("delayed"); setHoldRefresh(true); }}>延迟核查</button>
    <button onClick={() => setHoldRefresh(false)}>结束延迟</button>
    <button onClick={() => setDisabled(true)}>禁用入口</button>
    <button onClick={() => setDisabled(false)}>启用入口</button>
    <button onClick={() => setId(current => current === "one" ? "two" : "one")}>切换产品</button>
    <button onClick={() => { setAccount("vbk_changed"); setVersion(5); }}>切换账号与版本</button>
    <output aria-label="当前产品">{id}</output>
    <ItineraryReviewUnlockAction product={{ ...product(id, account, version), automation: { status: "succeeded", currentPhase: phase } as ProductDetail["automation"] }} disabled={disabled} />
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
