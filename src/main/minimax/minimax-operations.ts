import type {
  AdvisorOutcome,
  AdvisorRequest,
  AiUsageEvent,
  DisambiguateOutcome,
  DisambiguateRequest,
} from "../../shared/contracts.js";
import { logInfo, logWarn } from "../../shared/log-timestamp.js";
import { logAIPrompt } from "../ai/prompt-log.js";
import {
  MiniMaxServiceError,
  advisorOutcomeSchema,
  diagnosisSystemPrompt,
  diagnosisTool,
  disambiguateOutcomeSchema,
  disambiguateSystemPrompt,
  disambiguateTool,
  subtitleOutcomeSchema,
  subtitleSystemPrompt,
  subtitleTool,
} from "./minimax-constants.js";
import {
  createMiniMaxClient,
  disambiguationTimeout,
  emitMiniMaxUsage,
  isDeepSeek,
  miniMaxProviderError,
  miniMaxServiceTier,
  providerLabel,
  replyTimeout,
  type MiniMaxConfig,
} from "./minimax-runtime.js";

function parseDisambiguateContext(
  product: Record<string, unknown>,
  input: DisambiguateRequest,
): Record<string, unknown> {
  const { kind, desired } = input;
  const ctx: Record<string, unknown> = { desired };
  const basic = (product.basicInfo as Record<string, unknown> | undefined) ?? {};
  const presentation = (product.presentation as Record<string, unknown> | undefined) ?? {};
  const operations = (product.operations as Record<string, unknown> | undefined) ?? {};
  if (kind === "province") {
    ctx.provinceInProduct = basic.province ?? null;
    ctx.recommendation = typeof presentation.recommendation === "string" ? presentation.recommendation : null;
    ctx.features = typeof presentation.features === "string" ? presentation.features : null;
  } else if (kind === "city") {
    ctx.meetingCity = basic.meetingCity ?? null;
    ctx.destinationCity = basic.destinationCity ?? null;
    ctx.pickupCity = operations.pickupCity ?? null;
  } else if (kind === "spot") {
    const itinerary = Array.isArray(product.itinerary) ? product.itinerary as Array<Record<string, unknown>> : [];
    ctx.itinerarySpots = itinerary.map((day) => Array.isArray(day.spots) ? day.spots : [])
      .flat().filter((spot): spot is string => typeof spot === "string");
    ctx.recommendation = typeof presentation.recommendation === "string" ? presentation.recommendation : null;
  } else if (kind === "station") {
    ctx.pickupCity = operations.pickupCity ?? null;
    ctx.destinationCity = basic.destinationCity ?? null;
    ctx.stationSubtype = input.stationSubtype ?? null;
  }
  return ctx;
}

export async function diagnoseAutomationFailure(
  config: MiniMaxConfig,
  input: AdvisorRequest & {
    usage?: { localProductId: string; stage?: string; onEvent?: (event: AiUsageEvent) => void };
  },
): Promise<AdvisorOutcome> {
  const label = providerLabel(config);
  if (!config.apiKey) throw new MiniMaxServiceError("provider_not_configured", `尚未配置 ${label} API Key。`);
  const startedAt = Date.now();
  const messages = [
    { role: "system", content: diagnosisSystemPrompt },
    { role: "user", content: `请根据以下最小安全上下文诊断，只通过 submit_failure_diagnosis 返回结果：\n${JSON.stringify({
      phase: input.phase,
      attempt: input.attempt,
      error: input.error,
      productIdExists: input.productIdExists,
      basicInfoSaved: input.basicInfoSaved,
      completedPhases: input.completedPhases,
      diagnosisHistory: input.diagnosisHistory,
    })}` },
  ];
  try {
    logAIPrompt({ entry: "MiniMax.diagnoseAutomationFailure", provider: config.provider ?? "minimax", model: config.model, messages });
    const response = await createMiniMaxClient(config, replyTimeout()).chat.completions.create({
      model: config.model,
      messages,
      max_completion_tokens: 1024,
      tools: [diagnosisTool],
      tool_choice: { type: "function", function: { name: "submit_failure_diagnosis" } },
      thinking: { type: "disabled" },
      service_tier: miniMaxServiceTier(),
    } as never);
    emitMiniMaxUsage(config, input.usage, "automation.diagnose", input.phase, Date.now() - startedAt, response);
    const toolCall = response.choices[0]?.message.tool_calls?.find(
      (call) => "function" in call && call.function.name === "submit_failure_diagnosis",
    );
    if (!toolCall || !("function" in toolCall)) {
      throw new MiniMaxServiceError("invalid_model_output", `${label} 返回的自动录入诊断格式无效。`);
    }
    let value: unknown;
    try { value = JSON.parse(toolCall.function.arguments); }
    catch { throw new MiniMaxServiceError("invalid_model_output", `${label} 返回的自动录入诊断格式无效。`); }
    const parsed = advisorOutcomeSchema.safeParse(value);
    if (!parsed.success) throw new MiniMaxServiceError("invalid_model_output", `${label} 返回的自动录入诊断格式无效。`);
    const outcome = parsed.data.action === "wait_for_user"
      ? { ...parsed.data, userInstruction: parsed.data.userInstruction!.trim() }
      : {
          summary: parsed.data.summary,
          rootCause: parsed.data.rootCause,
          action: parsed.data.action,
          expectedEvidence: parsed.data.expectedEvidence,
        };
    logInfo("[AI] diagnosis completed", {
      provider: config.provider ?? "minimax",
      phase: input.phase,
      attempt: input.attempt,
      action: outcome.action,
      elapsedMs: Date.now() - startedAt,
    });
    return outcome;
  } catch (error) {
    const serviceError = miniMaxProviderError(config, error);
    emitMiniMaxUsage(config, input.usage, "automation.diagnose", input.phase, Date.now() - startedAt, undefined, serviceError);
    logWarn("[AI] diagnosis failed", {
      provider: config.provider ?? "minimax",
      phase: input.phase,
      attempt: input.attempt,
      errorCode: serviceError.code,
      elapsedMs: Date.now() - startedAt,
    });
    throw serviceError;
  }
}

export async function disambiguateOption(
  config: MiniMaxConfig,
  input: DisambiguateRequest & {
    usage?: { localProductId: string; stage?: string; onEvent?: (event: AiUsageEvent) => void };
  },
): Promise<DisambiguateOutcome> {
  const label = providerLabel(config);
  if (!config.apiKey) throw new MiniMaxServiceError("provider_not_configured", `尚未配置 ${label} API Key。`);
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    return { pickedText: null, confidence: 0, reasoning: "候选项为空" };
  }
  const startedAt = Date.now();
  try {
    const messages = [
      { role: "system", content: disambiguateSystemPrompt(input.kind) },
      { role: "user", content: JSON.stringify({
        desired: input.desired,
        stationSubtype: input.stationSubtype ?? null,
        candidates: input.candidates.map((candidate) => ({ id: candidate.id, text: candidate.text })),
        productContext: parseDisambiguateContext(input.product, input),
      }) },
    ];
    logAIPrompt({ entry: "MiniMax.disambiguateOption", provider: config.provider ?? "minimax", model: config.model, messages });
    const response = await createMiniMaxClient(config, disambiguationTimeout()).chat.completions.create({
      model: config.model,
      messages,
      max_completion_tokens: 512,
      temperature: 0.1,
      tools: [disambiguateTool],
      tool_choice: { type: "function", function: { name: "submit_disambiguation" } },
      thinking: { type: "disabled" },
      service_tier: miniMaxServiceTier(),
    } as never);
    emitMiniMaxUsage(config, input.usage, "automation.disambiguate", input.usage?.stage ?? input.kind, Date.now() - startedAt, response);
    const toolCall = response.choices[0]?.message.tool_calls?.find(
      (call) => "function" in call && call.function.name === "submit_disambiguation",
    );
    if (!toolCall || !("function" in toolCall)) {
      throw new MiniMaxServiceError("invalid_model_output", `${label} 未返回结构化选择结果。`);
    }
    let value: unknown;
    try { value = JSON.parse(toolCall.function.arguments); }
    catch { throw new MiniMaxServiceError("invalid_model_output", `${label} 返回的选择结果不是合法 JSON。`); }
    const parsed = disambiguateOutcomeSchema.safeParse(value);
    if (!parsed.success) throw new MiniMaxServiceError("invalid_model_output", `${label} 返回的选择结果不合法。`);
    const pickedText = parsed.data.pickedText && input.candidates.some((candidate) => candidate.text === parsed.data.pickedText)
      ? parsed.data.pickedText
      : null;
    const confidence = Math.min(1, Math.max(0, Number(parsed.data.confidence) || 0));
    logInfo("[AI] disambiguation completed", {
      provider: config.provider ?? "minimax",
      kind: input.kind,
      desired: input.desired,
      picked: pickedText,
      elapsedMs: Date.now() - startedAt,
    });
    return { pickedText, confidence, reasoning: parsed.data.reasoning };
  } catch (error) {
    const serviceError = miniMaxProviderError(config, error);
    emitMiniMaxUsage(config, input.usage, "automation.disambiguate", input.usage?.stage ?? input.kind, Date.now() - startedAt, undefined, serviceError);
    logWarn("[AI] disambiguation failed", {
      provider: config.provider ?? "minimax",
      kind: input.kind,
      desired: input.desired,
      errorCode: serviceError.code,
      elapsedMs: Date.now() - startedAt,
    });
    throw serviceError;
  }
}

export async function regenerateSubtitle(
  config: MiniMaxConfig,
  input: {
    product: Record<string, unknown>;
    usage?: { localProductId: string; onEvent?: (event: AiUsageEvent) => void };
    signal?: AbortSignal;
  },
): Promise<string> {
  const label = providerLabel(config);
  if (!config.apiKey) throw new MiniMaxServiceError("provider_not_configured", `尚未配置 ${label} API Key。`);
  const startedAt = Date.now();
  const basic = (input.product.basicInfo as Record<string, unknown> | undefined) ?? {};
  const sales = (input.product.sales as Record<string, unknown> | undefined) ?? {};
  const presentation = (input.product.presentation as Record<string, unknown> | undefined) ?? {};
  const messages = [
    { role: "system", content: subtitleSystemPrompt },
    { role: "user", content: `产品上下文：${JSON.stringify({
      meetingCity: basic.meetingCity ?? null,
      destinationCity: basic.destinationCity ?? null,
      days: basic.days ?? null,
      nights: basic.nights ?? null,
      productForm: sales.productForm ?? null,
      productType: sales.productType ?? null,
      existingSubtitle: typeof basic.subtitle === "string" ? basic.subtitle : null,
      recommendation: typeof presentation.recommendation === "string" ? presentation.recommendation : null,
    })}\n\n请生成一个新的副标题候选。` },
  ];
  try {
    logAIPrompt({ entry: "MiniMax.regenerateSubtitle", provider: config.provider ?? "minimax", model: config.model, messages });
    const providerParams = isDeepSeek(config)
      ? {}
      : { thinking: { type: "disabled" as const }, service_tier: miniMaxServiceTier() };
    const response = await createMiniMaxClient(config, replyTimeout()).chat.completions.create({
      model: config.model,
      messages,
      max_completion_tokens: 256,
      temperature: 0.9,
      tools: [subtitleTool],
      tool_choice: { type: "function", function: { name: "submit_subtitle" } },
      ...providerParams,
    } as never, { signal: input.signal });
    emitMiniMaxUsage(config, input.usage, "chat.regenerate", "subtitle", Date.now() - startedAt, response);
    const toolCall = response.choices[0]?.message.tool_calls?.find(
      (call) => "function" in call && call.function.name === "submit_subtitle",
    );
    if (!toolCall || !("function" in toolCall)) {
      throw new MiniMaxServiceError("invalid_model_output", `${label} 未返回副标题候选。`);
    }
    let value: unknown;
    try { value = JSON.parse(toolCall.function.arguments); }
    catch { throw new MiniMaxServiceError("invalid_model_output", `${label} 返回的副标题格式无效。`); }
    const parsed = subtitleOutcomeSchema.safeParse(value);
    if (!parsed.success) throw new MiniMaxServiceError("invalid_model_output", `${label} 返回的副标题不合法。`);
    const subtitle = parsed.data.subtitle.trim();
    logInfo("[AI] subtitle regeneration completed", { provider: config.provider ?? "minimax", elapsedMs: Date.now() - startedAt });
    return subtitle;
  } catch (error) {
    const serviceError = miniMaxProviderError(config, error);
    emitMiniMaxUsage(config, input.usage, "chat.regenerate", "subtitle", Date.now() - startedAt, undefined, serviceError);
    logWarn("[AI] subtitle regeneration failed", {
      provider: config.provider ?? "minimax",
      errorCode: serviceError.code,
      elapsedMs: Date.now() - startedAt,
    });
    throw serviceError;
  }
}
