import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ProductBriefForm } from "../../../src/renderer/app/helpers/product-brief-form";
import { BasicInfoCoverRow } from "../../../src/renderer/app/views/workspace/basic-info-cover-row";
import type { CreateProductInput } from "../../../src/shared/contracts";
import "../../../src/renderer/styles/reset.css";
import "../../../src/renderer/styles/tokens.css";
import "../../../src/renderer/styles/global.css";

function Fixture() {
  const [input, setInput] = useState<CreateProductInput>({ destination: "太原", days: 2, productForm: "privateTour" });
  const [autoConfirm, setAutoConfirm] = useState(false);
  return <main style={{ maxWidth: 1100, padding: 24, margin: "auto" }}>
    <ProductBriefForm input={input} setInput={setInput} autoConfirm={autoConfirm} setAutoConfirm={setAutoConfirm} submitting={false} onCancel={() => {}} onSubmit={() => {}} />
    <section style={{ marginTop: 24 }}><BasicInfoCoverRow cover={{ source: "ctripLibrary", poi: "晋祠", description: "晋祠", minQuality: 3,
      imageId: 1, imageUrl: "/src/renderer/assets/cover-fallback.png", missingPoiImages: ["云冈石窟"] }} fallback={null} previewUrl={null} saving={false} error={undefined}
      onClearError={() => {}} onUploadManual={async () => null} onPickCtripLibrary={async () => false} onSearchCtripLibraryPlaces={async () => null}
      onSearchCtripLibraryImages={async () => null} onReadPreviewUrl={async () => null} /></section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
