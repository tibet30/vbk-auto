/**
 * 渲染实现已按职责拆到 `agent-conversation/`（labels / activity / thread / event / tool-result）。
 * 本文件只保留原导入路径作为 barrel，调用方（agent-conversation.tsx、
 * agent-stage-timeline.tsx）无需改动。
 *
 * 注意：同目录存在 `agent-conversation.tsx`，因此必须显式指向 `/index`，
 * 否则 `./agent-conversation` 会解析到那个视图文件并形成循环。
 */
export { AgentEventItem, AgentAssistantThread } from "./agent-conversation/index";
export { ACTION_NAMES, EVENT_LABEL, STATUS, actionLabel, formatTime, toolCallLabel } from "./agent-conversation/index";
