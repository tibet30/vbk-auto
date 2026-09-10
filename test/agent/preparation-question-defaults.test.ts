import assert from "node:assert/strict";
import test from "node:test";
import { automaticPreparationAnswer } from "../../src/main/agent/preparation-question-defaults.js";
import type { AgentQuestion } from "../../src/shared/contracts.js";

function single(id: string, label: string, options: Array<[string, string]>): AgentQuestion {
  return { id, label, kind: "single", required: true, options: options.map(([optionId, optionLabel]) => ({ id: optionId, label: optionLabel })) };
}

test("historical preparation control questions resolve without operator interaction", () => {
  const cases: Array<[AgentQuestion, string | string[]]> = [
    [single("poi_pending", "日喀则非物质遗产中心 VBK 未匹配到本地可用候选，如何处理？", [
      ["keep_pending", "保持原名、原位、POI 留空，由你后续人工录入"], ["drop_spot", "移除"],
    ]), "keep_pending"],
    [single("vehicle_tier", "日喀则 5座用车资源组查询为空，如何处理？", [
      ["try_comfort", "改用舒适型"], ["try_economy", "改用经济型档位重新查询"],
    ]), "try_economy"],
    [single("stage_gate", "Itinerary 阶段门禁，如何推进？", [
      ["best_effort_here", "在当前节点尽力写入"], ["stop_here", "暂停"],
    ]), "best_effort_here"],
    [single("rollback_poi", "自动将原景点绑定到可用 POI，与你之前的留空指示冲突，如何处理？", [
      ["keep_bind", "接受 VBK 推荐的绑定"], ["force_empty", "坚持留空"],
    ]), "keep_bind"],
    [single("final_poi", "POI 约束冲突，如何结束处理？", [
      ["accept_bind", "接受 VBK 自动绑定"], ["manual_rollback", "手动调整"],
    ]), "accept_bind"],
    [single("checkin_node", "如何处理日喀则（入住）这一景点 POI？", [
      ["drop", "移出景点列表"], ["keep", "保留并标注为住宿节点"],
    ]), "drop"],
    [single("research_resolve", "如何闭环日喀则（入住）研究任务？", [
      ["close", "确认是住宿节点，关闭研究任务并推进"], ["keep", "人工补录"],
    ]), "close"],
    [single("next_stage", "如何解锁展示/商业字段？", [
      ["proceed", "推进到下一阶段"], ["stay", "保持当前阶段"],
    ]), "proceed"],
    [single("resolve_research", "住宿研究任务闭环方式", [
      ["skip", "按住宿节点处理，无需 POI"], ["manual", "手动补录"],
    ]), "skip"],
    [single("recovery", "字段类型错误，如何修复以解锁 ready=true？", [
      ["retry", "以当前数据重试一次"], ["manual", "手动修复"],
    ]), "retry"],
    [single("hotelAnchor", "finalValidation 阶段下酒店锚点错误，如何处理？", [
      ["rollback", "退回 hotelResolution，以正确城市重跑"], ["keep", "保持当前酒店"],
    ]), "rollback"],
    [single("cover_poi", "封面图取景", [
      ["a", "扎什伦布寺"], ["b", "白居寺"],
    ]), "a"],
    [single("package_name", "套餐名称", [
      ["standard", "标准人文 2 日"], ["deluxe", "深度人文 2 日"],
    ]), "standard"],
  ];

  for (const [question, expected] of cases) {
    assert.deepEqual(automaticPreparationAnswer(question), expected, question.id);
  }
});

test("a substantive preference with no safe inference remains visible", () => {
  const question: AgentQuestion = {
    id: "pace",
    label: "希望每天怎样安排？",
    kind: "text",
    required: true,
  };
  assert.equal(automaticPreparationAnswer(question), undefined);
});
