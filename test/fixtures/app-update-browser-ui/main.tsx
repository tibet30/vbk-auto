import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppUpdateProvider, useAppUpdate } from "../../../src/renderer/app/update/AppUpdateContext";
import { AppFrame } from "../../../src/renderer/app/views/shell/AppFrame";
import { confirmHotelDraftRetry } from "../../../src/renderer/app/actions/workflow/hotel-draft-confirm";
import { PlanningRerunConfirmDialog } from "../../../src/renderer/app/views/workspace/planning-rerun-confirm-dialog";
import { useBrowserDerived } from "../../../src/renderer/app/state/domains/browser-derived";
import type { AppStateBase } from "../../../src/renderer/app/state/base";
import "../../../src/renderer/styles/global.css";

function Fixture() {
  const [view, setView] = useState("workspace");
  const [mounted, setMounted] = useState(true);
  const [browserUrl, setBrowserUrl] = useState("");
  const [rerunOpen, setRerunOpen] = useState(false);
  const [hotelConfirmed, setHotelConfirmed] = useState(false);
  const browserRef = useRef<HTMLDivElement>(null);
  const rerunRef = useRef<HTMLButtonElement>(null);
  const { openDialog, closeDialog } = useAppUpdate();
  useBrowserDerived({ view, browserRef, setBrowserUrl, stage: "review", loginPanelOpen: false,
    product: null, vbkLogin: null, vbkLoginAccounts: { current: null, saved: [] },
  } as unknown as AppStateBase, mounted);
  Object.assign(window, { updateBrowserFixture: { setView, setMounted, openDialog, closeDialog } });
  return <>
    <button onClick={openDialog}>下载与更新</button>
    <button onClick={() => { void confirmHotelDraftRetry({ token: "isolated", localProductId: "local", productId: "100",
      accountKey: "isolated", stays: [{ cityName: "广安", nights: 1 }] }).then(setHotelConfirmed); }}>酒店草稿确认</button>
    <button ref={rerunRef} onClick={() => setRerunOpen(true)}>重生成确认</button>
    <output aria-label="酒店确认结果">{String(hotelConfirmed)}</output>
    <div ref={browserRef} style={{ position: "absolute", top: 80, left: 460, width: 600, height: 600 }} />
    <output>{browserUrl}</output>
    <PlanningRerunConfirmDialog stage={rerunOpen ? { id: "foundation", label: "基础方案", description: "隔离验证", invalidates: "方案" } : null}
      onCancel={() => setRerunOpen(false)} onConfirm={() => setRerunOpen(false)} returnFocusRef={rerunRef} />
  </>;
}

createRoot(document.getElementById("root")!).render(<AppUpdateProvider><AppFrame><Fixture /></AppFrame></AppUpdateProvider>);
