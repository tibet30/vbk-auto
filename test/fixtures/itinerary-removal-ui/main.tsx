import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { AppWorkspaceReviewSummaryItinerary } from "../../../src/renderer/app/views/workspace/review-summary-itinerary";
import type { ProductDetail, ManualReviewFieldInput } from "../../../src/shared/contracts";
import "../../../src/renderer/styles/global.css";

function Fixture() {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  useEffect(() => {
    fetch("/__product").then(response => response.json()).then(setProduct);
    const bridge = { products: { updateReviewField: async (id: string, input: ManualReviewFieldInput) => {
      const response = await fetch("/__remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, input }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setProduct(result);
      return result;
    } } };
    (window as any).vbk = bridge;
    (window as any).removalFixture = { setProduct, disconnect: () => { (window as any).vbk = undefined; }, reconnect: () => { (window as any).vbk = bridge; } };
  }, []);
  if (!product) return null;
  return <main style={{ maxWidth: 640, margin: "24px auto", padding: 16 }}>
    <AppWorkspaceReviewSummaryItinerary localProductId={product.id} days={product.product.itinerary as any}
      expandedDayIndexes={new Set([0])} onToggle={() => {}} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
