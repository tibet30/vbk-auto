import type { AgentInputRequest, AgentQuestion } from "../../shared/contracts.js";

type JsonSchema = Record<string, unknown>;

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean || undefined;
}

export function parseQuestions(value: unknown): AgentQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return undefined;
  const ids = new Set<string>();
  const questions: AgentQuestion[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const item = raw as Record<string, unknown>;
    const id = cleanString(item.id);
    const label = cleanString(item.label);
    const kind = String(item.kind) as AgentQuestion["kind"];
    if (!id || !label || ids.has(id) || !["text", "single", "multiple", "confirm"].includes(kind)) return undefined;
    ids.add(id);

    let options: AgentQuestion["options"];
    if (item.options !== undefined) {
      if (!Array.isArray(item.options)) return undefined;
      const optionIds = new Set<string>();
      options = [];
      for (const rawOption of item.options) {
        if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return undefined;
        const option = rawOption as Record<string, unknown>;
        const optionId = cleanString(option.id);
        const optionLabel = cleanString(option.label);
        if (!optionId || !optionLabel || optionIds.has(optionId)) return undefined;
        optionIds.add(optionId);
        options.push({ id: optionId, label: optionLabel });
      }
    }
    if ((kind === "single" || kind === "multiple") && !options?.length) return undefined;
    questions.push({
      id,
      label,
      kind,
      required: item.required !== false,
      ...(options?.length ? { options } : {}),
      ...(cleanString(item.placeholder) ? { placeholder: cleanString(item.placeholder) } : {}),
    });
  }
  return questions;
}

export function validateAnswers(
  request: AgentInputRequest,
  answers: Record<string, string | string[]>,
): boolean {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;
  const known = new Map(request.questions.map((question) => [question.id, question]));
  if (Object.keys(answers).some((key) => !known.has(key))) return false;
  return request.questions.every((question) => {
    const answer = answers[question.id];
    if (answer === undefined) return !question.required;
    const values = Array.isArray(answer) ? answer : [answer];
    if (!values.length || (question.kind !== "multiple" && values.length !== 1)) return false;
    if (values.some((value) => typeof value !== "string" || !value.trim() || value.length > 3_000)) return false;
    return !question.options || values.every((value) => question.options!.some((option) => option.id === value));
  });
}

function validateValue(schema: JsonSchema, value: unknown, path: string): string | undefined {
  if (schema.type === "string" && (typeof value !== "string" || !value.trim())) return `${path} 必须是非空字符串`;
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `${path} 类型错误`;
  if (schema.type === "boolean" && typeof value !== "boolean") return `${path} 类型错误`;
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} 类型错误`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} 数量不足`;
    if (schema.items && typeof schema.items === "object") {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateValue(schema.items as JsonSchema, value[index], `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} 类型错误`;
    const error = validateSchema(schema, value as Record<string, unknown>, path);
    if (error) return error;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} 不在允许范围`;
  return undefined;
}

export function validateSchema(schema: JsonSchema, args: Record<string, unknown>, prefix = ""): string | undefined {
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, JsonSchema>
    : {};
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (typeof key !== "string") continue;
    const value = args[key];
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
      return `缺少 ${prefix}${key}`;
    }
  }
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).find((key) => !(key in properties));
    if (unknown) return `${prefix}${unknown} 不是允许字段`;
  }
  for (const [key, value] of Object.entries(args)) {
    const definition = properties[key];
    if (!definition) continue;
    const error = validateValue(definition, value, `${prefix}${key}`);
    if (error) return error;
  }
  return undefined;
}

export function nativeToolSchemas() {
  const option = {
    type: "object",
    additionalProperties: false,
    required: ["id", "label"],
    properties: { id: { type: "string" }, label: { type: "string" } },
  };
  return [
    {
      name: "ask_user",
      description: "向用户请求信息",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["questions"],
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "label", "kind"],
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                kind: { enum: ["text", "single", "multiple", "confirm"] },
                required: { type: "boolean" },
                options: { type: "array", items: option },
                placeholder: { type: "string" },
              },
            },
          },
        },
      },
    },
    {
      name: "request_approval",
      description: "请求外部写入授权",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["scope", "summary"],
        properties: {
          scope: { type: "array", minItems: 1, items: { type: "string" } },
          summary: { type: "string" },
        },
      },
    },
  ];
}

export function cleanList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.flatMap((item) => cleanString(item) ?? []))]
    : [];
}
