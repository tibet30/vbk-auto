import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ProductBriefForm } from "../../../src/renderer/app/helpers/product-brief-form";
import { BasicInfoCoverRow } from "../../../src/renderer/app/views/workspace/basic-info-cover-row";
import type { CreateProductInput } from "../../../src/shared/contracts";
import "../../../src/renderer/styles/reset.css";
import "../../../src/renderer/styles/tokens.css";
import "../../../src/renderer/styles/global.css";

const ideaFixture = { failNext: false };
(window as typeof window & { ideaFixture?: typeof ideaFixture }).ideaFixture = ideaFixture;
window.vbk = { ai: { optimizeProductIdea: async () => {
  if (ideaFixture.failNext) { ideaFixture.failNext = false; throw new Error("AI 服务暂时不可用，请稍后重试。"); }
  return ({
  optimizedIdea: "产品方向：太原亲子文化慢游。\n核心要求：必须游览晋祠，下午保留休息时间。\n建议：优先安排轻松的文化体验。",
  preservedItems: ["晋祠", "亲子客群", "慢节奏"],
  changes: [{ before: "慢一点", after: "下午保留休息时间", reason: "转成可执行安排" }],
  recommendations: ["优先安排轻松的文化体验"],
  warnings: ["晋祠门票是否包含需要确认"],
  sourceFingerprint: "a".repeat(64), provider: "minimax", model: "MiniMax-M3",
  optimizedAt: "2026-10-24T08:00:00.000Z",
  });
} } } as unknown as typeof window.vbk;

function Fixture() {
  const [input, setInput] = useState<CreateProductInput>({ destination: "太原", days: 2, productForm: "privateTour", userIdea: "带孩子去晋祠，慢一点。" });
  const [autoConfirm, setAutoConfirm] = useState(false);
  (window as typeof window & { ideaInput?: CreateProductInput }).ideaInput = input;
  return <main style={{ maxWidth: 1100, padding: 24, margin: "auto" }}>
    <ProductBriefForm input={input} setInput={setInput} autoConfirm={autoConfirm} setAutoConfirm={setAutoConfirm} submitting={false} onCancel={() => {}} onSubmit={() => {}} />
    <section style={{ marginTop: 24 }}><BasicInfoCoverRow cover={{ source: "ctripLibrary", poi: "晋祠", description: "晋祠", minQuality: 3,
      imageId: 1, imageUrl: "/src/renderer/assets/cover-fallback.png", missingPoiImages: ["云冈石窟"] }} fallback={null} previewUrl={null} saving={false} error={undefined}
      onClearError={() => {}} onUploadManual={async () => null} onPickCtripLibrary={async () => false} onSearchCtripLibraryPlaces={async () => null}
      onSearchCtripLibraryImages={async () => null} onReadPreviewUrl={async () => null} /></section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
