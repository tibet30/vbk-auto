import { createRoot } from "react-dom/client";
import { useState } from "react";
import { AppWorkspaceReviewSummaryItinerary } from "../../../src/renderer/app/views/workspace/review-summary-itinerary";
import "../../../src/renderer/styles/global.css";
const day = { day: 6, title: "汉中送机 / 送高铁 → 返程", description: "早餐后从酒店出发，根据返程安排送至汉中城固机场或汉中站。", hotel: "无当日住宿安排", meals: "早餐含；正餐敬请自理。", spots: ["汉中市酒店", "汉中城固机场", "汉中站"].map(name => ({ name, kind: "other" as const, poiId: null, poiName: null })) };
function Fixture() {
  const [expanded, setExpanded] = useState(new Set([0]));
  return <main style={{ maxWidth: 640, margin: "24px auto", padding: 16 }}><AppWorkspaceReviewSummaryItinerary localProductId="fixture" days={[day]} expandedDayIndexes={expanded} onToggle={index => setExpanded(current => current.has(index) ? new Set() : new Set([index]))} /></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
