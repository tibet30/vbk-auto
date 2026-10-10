import "../../../src/renderer/styles/tokens.css";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ProductList } from "../../../src/renderer/app/helpers/components";
import type { ProductSummary, VbkApi } from "../../../src/shared/contracts";
import "../../../src/renderer/app/views/shared.module.less";

window.vbk = { products: { executionTimes: async ids => {
  const response = await fetch(`/__executionTimes?ids=${encodeURIComponent(JSON.stringify(ids))}`);
  return response.json();
} } } as VbkApi;

function Fixture() {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  Object.assign(window, { executionFixture: { setProducts } });
  return <ProductList products={products} onOpen={async () => {}} onDelete={async () => false} onResumeTask={async () => false} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
