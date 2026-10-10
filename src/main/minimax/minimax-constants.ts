/**
 * minimax 子系统的常量 / schema / 工具 barrel。
 *
 * 本文件不持有具体实现：实际内容按 "关注点" 拆分到
 * `minimax-constants/` 子目录下的 5 个文件，原模块导入路径
 * (`./minimax-constants.js`) 由这里重新聚合转发，所有调用方零改动。
 *
 * 子模块分工：
 *   - errors.ts            MiniMaxServiceError 类型；
 *   - writable-paths.ts    可写路径白名单、patch / researchTask / response 的 zod schema 与 patchValueSchemas；
 *   - tools.ts             4 个 OpenAI function-calling 工具描述（responseTool / diagnosisTool / disambiguateTool / subtitleTool）；
 *   - schemas.ts           工具返回值 zod schema + 封面完整/满足判定函数；
 *   - prompts.ts           writablePatchGuide / outputGuide（私有）+ systemPrompt / diagnosisSystemPrompt / subtitleSystemPrompt / disambiguateSystemPrompt。
 *
 * 调用方（如 minimax-service、minimax-operations、minimax-runtime、
 * minimax-parsing-value、minimax-parsing-sparse、minimax、main/readiness、
 * database/parts/research-tasks、test/planning/vbk-copy-policy、test/planning/planning-prompt）
 * 继续 `import {...} from "./minimax-constants.js"`，符号来自下面这五行。
 *
 * 私有字符串 `writablePatchGuide` / `outputGuide` 不导出，仅 prompts.ts 内部组装 systemPrompt。
 */

export { MiniMaxServiceError } from "./minimax-constants/errors.js";

export {
  writablePatchPrefixes,
  responseJsonSchema,
  patchOperationSchema,
  researchTaskSchema,
  aiResponsePayloadKeys,
  aiResponseSchema,
  patchValueSchemas,
} from "./minimax-constants/writable-paths.js";

export {
  responseTool,
  diagnosisTool,
  disambiguateTool,
  subtitleTool,
} from "./minimax-constants/tools.js";

export {
  presentationCoverValueSchema,
  disambiguateOutcomeSchema,
  subtitleOutcomeSchema,
  advisorOutcomeSchema,
  hasCompleteCtripLibraryCover,
  hasCompleteProductCover,
  isCoverResearchTaskSatisfiedByProduct,
} from "./minimax-constants/schemas.js";

export {
  systemPrompt,
  diagnosisSystemPrompt,
  subtitleSystemPrompt,
  disambiguateSystemPrompt,
} from "./minimax-constants/prompts.js";
