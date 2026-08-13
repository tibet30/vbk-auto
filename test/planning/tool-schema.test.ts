/**
 * 阶段 tool_call schema 的结构性契约测试：
 *  - 必须是合法 strict JSON schema（不包含 Zod 对象 / 函数 / 非法关键字）；
 *  - 每个 stage 的 modules.value 必须能反映该 stage 允许产出的 module；
 *  - 顶层 properties 必须是对象而非 Zod 节点。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PLANNING_STAGES } from "../../src/shared/contracts-planning.js";
import { buildStageToolSchema } from "../../src/main/planning/tool-schema.js";

const FORBIDDEN_VALUE_KEYS = new Set(["_def", "_type", "parse", "safeParse"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 检查 `value` 不包含函数 / Zod 残留 / 非法 type；
 * 跳过 `value.type === "function"` 这种 OpenAI 容器顶层节点。
 */
function assertCleanStructure(value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  if (typeof value === "function") throw new Error(`${path}: JSON schema 不允许包含函数`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertCleanStructure(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_VALUE_KEYS.has(key)) {
      throw new Error(`${path}.${key}: 出现 Zod 内部字段，不允许出现在 JSON schema`);
    }
  }
  assertCleanStructure(Object.values(record), path);
}

/**
 * 递归校验 strict JSON schema 子树（不校验 `type: "function"` 这种 OpenAI 容器）。
 */
function assertValidJsonSchema(value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  if (typeof value === "function") throw new Error(`${path}: JSON schema 不允许包含函数`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertValidJsonSchema(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string") {
    const valid = new Set([
      "object", "array", "string", "number", "integer", "boolean", "null",
    ]);
    if (!valid.has(record.type)) {
      throw new Error(`${path}.type = ${record.type}: 不是合法 JSON schema type`);
    }
    if (record.type === "object") {
      if (!record.properties) throw new Error(`${path}: type=object 必须有 properties`);
      if (record.additionalProperties !== false) {
        throw new Error(`${path}: strict 模式必须 additionalProperties=false`);
      }
    }
    if (record.type === "array" && !record.items) {
      throw new Error(`${path}: type=array 必须有 items`);
    }
  }
  assertValidJsonSchema(record.properties, `${path}.properties`);
  assertValidJsonSchema(record.items, `${path}.items`);
  assertValidJsonSchema(record.oneOf, `${path}.oneOf`);
  assertValidJsonSchema(record.anyOf, `${path}.anyOf`);
  assertValidJsonSchema(record.allOf, `${path}.allOf`);
}

test("buildStageToolSchema 产出合法 strict JSON schema（无 Zod / 函数 / 非法关键字）", () => {
  for (const stage of PLANNING_STAGES) {
    const schema = buildStageToolSchema(stage);
    assert.equal(schema.type, "function");
    assert.equal(schema.function.strict, true);
    // 顶层 type=function 是 OpenAI 容器；递归校验 function.parameters 才进入 JSON schema 主体。
    assertCleanStructure(schema, stage);
    assertValidJsonSchema(schema.function.parameters, `${stage}.parameters`);
  }
});

test("每个 stage 的 modules.value 与允许 module 列表一致", () => {
  for (const stage of PLANNING_STAGES) {
    const schema = buildStageToolSchema(stage);
    const params = schema.function.parameters as Record<string, unknown>;
    const props = (params.properties ?? {}) as Record<string, unknown>;
    // skeleton / validation 是本地阶段，不调用 AI；但 schema 仍可生成（空模块列表）。
    if (stage === "skeleton" || stage === "validation") {
      continue;
    }
    // research 是本地 deterministic；AI tool schema 只暴露 reply，不包含 modules。
    if (stage === "research") {
      const required = (params.required ?? []) as string[];
      assert.deepEqual(required, ["reply"]);
      assert.equal(props.modules, undefined, `${stage}: AI tool schema 不应暴露 modules`);
      continue;
    }
    const modulesNode = props.modules as Record<string, unknown>;
    assert.ok(modulesNode, `${stage}: 必须有 modules 字段`);
    assert.equal(modulesNode.type, "array");
    // modules.items 可以是单 branch 或 oneOf branch 数组；逐个拆解后
    // 检查 module.const 与该 stage 的 allowed 列表一致。
    const items = modulesNode.items as Record<string, unknown>;
    const branches = Array.isArray(items.oneOf)
      ? (items.oneOf as Array<Record<string, unknown>>)
      : [items];
    const moduleConsts = branches.map((branch) => {
      const moduleField = (branch.properties as Record<string, unknown>).module as Record<string, unknown>;
      return moduleField.const as string;
    }).sort();
    if (stage === "itinerary") {
      assert.deepEqual(moduleConsts, ["itinerary"]);
    } else if (stage === "presentation") {
      assert.deepEqual(moduleConsts, ["presentation"]);
    } else if (stage === "commercial") {
      assert.deepEqual(moduleConsts, ["inventory", "packageName", "pricing", "release", "terms"]);
    }
  }
});

test("tool_call parameters.required 包含 reply 与 modules（strict mode 强制）", () => {
  for (const stage of PLANNING_STAGES) {
    const schema = buildStageToolSchema(stage);
    const required = (schema.function.parameters as Record<string, unknown>).required as string[];
    if (stage === "research") {
      // research 阶段本地 deterministic，AI schema 只暴露 reply。
      assert.deepEqual(required, ["reply"]);
      continue;
    }
    assert.ok(required.includes("reply"));
    assert.ok(required.includes("modules"));
  }
});

test("value 子节点不会出现 Zod 内部字段 / 函数 / moduleProperties 这类非法关键字", () => {
  const schema = buildStageToolSchema("presentation");
  const params = schema.function.parameters as Record<string, unknown>;
  const stringified = JSON.stringify(params);
  assert.ok(!stringified.includes("moduleProperties"), "tool schema 不应包含 moduleProperties 这类非法关键字");
  assert.ok(!stringified.includes("_def"), "tool schema 不应包含 Zod 内部字段");
  assert.ok(!stringified.includes("safeParse"), "tool schema 不应包含 Zod 内部方法");
});

test("presentation 主推荐分类与推荐理由分类使用同一组 VBK 下拉枚举", () => {
  const schema = buildStageToolSchema("presentation");
  const params = schema.function.parameters as Record<string, unknown>;
  const modules = (params.properties as Record<string, unknown>).modules as Record<string, unknown>;
  const value = ((modules.items as Record<string, unknown>).properties as Record<string, unknown>).value as Record<string, unknown>;
  const props = value.properties as Record<string, unknown>;
  const primary = (props.recommendationCategory as Record<string, unknown>).enum;
  const recommendation = props.recommendations as Record<string, unknown>;
  const itemProps = ((recommendation.items as Record<string, unknown>).properties as Record<string, unknown>);
  assert.deepEqual(primary, (itemProps.category as Record<string, unknown>).enum);
  assert.deepEqual(primary, ["优选行程", "服务保障", "贴心赠送", "精选酒店", "缤纷景点", "特色美食", "度假首选", "超值赠送", "五星精选"]);
});
