import type { AgentQuestion, AgentSnapshot } from "../../shared/contracts.js";
import { validateAnswers } from "./core-validation.js";
import type { AgentCoreDependencies } from "./types.js";
import { isPreparationRun } from "./preparation-run.js";

export function isAutomaticProductInputRun(deps: AgentCoreDependencies, snapshot: AgentSnapshot): boolean {
  return isPreparationRun(snapshot) || Boolean(deps.preparationProduct?.(snapshot.localProductId));
}

/** Product draft choices are delegated to AI; access and final approval remain external facts. */
export function canAutomaticallyAnswerProductQuestion(question: AgentQuestion): boolean {
  // Hotel recovery labels may quote a query error mentioning CAPTCHA; that is
  // still a resource strategy question, rather than a request for credentials.
  if (/^hotel\d+$/.test(question.id) && /住宿.*(?:未取得|未完成)/.test(question.label)) return true;
  return !/登录|验证码|密码|凭证|发布|上架|支付|删除产品|cookie|token|(?:VBK|携程|平台|远端|外部|录入|写入).{0,12}(?:授权|审批|批准)|(?:授权|审批|批准).{0,12}(?:VBK|携程|平台|远端|外部|录入|写入)/i.test(`${question.id} ${question.label}`);
}

export async function answerProductQuestionsWithAi(
  deps: AgentCoreDependencies,
  localProductId: string,
  questions: AgentQuestion[],
): Promise<Record<string, string | string[]>> {
  const model = await deps.modelFor?.(localProductId) ?? deps.model;
  if (!model) throw new Error("自动资料问答的 AI 服务未就绪");
  const context = await deps.contextFor?.(localProductId)
    ?? JSON.stringify(deps.preparationProduct?.(localProductId)?.product ?? {});
  const result = await model.complete({
    tools: [],
    messages: [
      { role: "system", content: "你负责自动回答旅游产品草稿的资料问题。当前目标是补齐内容，不追求报价等文案的精确性，不向运营反问。依据已保存产品和选项自行判断；价格可估算、酒店可按同地点降档、地点可选择同日同地区候选。保持用户明确的城市、天数、原地点、顺序和活动，不删除明确行程；优先选择能自动落实的检索或降档策略，避免需要运营手动配置的选项。不能编造酒店/POI/图片的真实ID、凭证或远端成功证据，需要真实资源时回答检索策略，由工具查询落实。不得代替用户批准外部写入、发布或登录。仅输出JSON对象，以问题id为key；text/confirm/single值为字符串，multiple值为非空字符串数组；有选项时值必须使用选项id。" },
      { role: "user", content: JSON.stringify({ productContext: context, questions }) },
    ],
  });
  const content = result.content?.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") ?? "";
  let answers: Record<string, string | string[]>;
  try { answers = JSON.parse(content); } catch { throw new Error("AI 自动资料回答不是有效 JSON，请重新生成"); }
  if (!validateAnswers({ id: "automatic", createdAt: new Date().toISOString(), questions }, answers)) {
    throw new Error("AI 自动资料回答不符合问题选项或必填格式，请重新生成");
  }
  return answers;
}
