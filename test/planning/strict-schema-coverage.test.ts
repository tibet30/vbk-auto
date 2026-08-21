/**
 * 阶段 tool_call schema 的 strict mode 契约测试：
 *  - 每个声明的 properties 都必须出现在 required（除非显式 nullable）；
 *  - 模块 + value 通过 oneOf 绑死，model.const 必须与该 stage 允许的 module
 *    列表一一对应；不允许「packageName 与 pricing-shape value 同时通过校验」；
 *  - research 阶段不应暴露 modules / value；question / researchTasks 顶级字段
 *    已从 AI schema 完全移除。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PLANNING_STAGES } from "../../src/shared/contracts-planning.js";
import { buildStageToolSchema } from "../../src/main/planning/tool-schema.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function declaredProperties(node: Record<string, unknown>): string[] {
  return Object.keys((node.properties ?? {}) as Record<string, unknown>);
}

/**
 * 递归检查 strict 对象节点的 required 覆盖：
 *  - type=object 时，properties 里声明的字段必须全部出现在 required 数组里
 *    （除非显式允许 nullable）；
 *  - additionalProperties 必须 = false。
 *  顶层 OpenAI 容器（type=function）不进入此校验。
 */
function assertStrictRequired(value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertStrictRequired(entry, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  const node = value as Record<string, unknown>;
  if (typeof node.type === "string" && node.type === "object") {
    assert.equal(node.additionalProperties, false, `${path}: strict object 必须 additionalProperties=false`);
    const declared = declaredProperties(node);
    const required = (node.required ?? []) as string[];
    for (const key of declared) {
      assert.ok(required.includes(key), `${path}.${key} 声明在 properties 但不在 required（strict mode 会拒收）`);
    }
  }
  // 递归所有子节点。
  for (const [key, child] of Object.entries(node)) {
    if (key === "properties" || key === "items" || key === "oneOf" || key === "anyOf" || key === "allOf") {
      assertStrictRequired(child, `${path}.${key}`);
    }
  }
}

test("每个 stage 的 AI tool schema 都满足 strict 模式 required 覆盖", () => {
  for (const stage of PLANNING_STAGES) {
    const schema = buildStageToolSchema(stage);
    // 顶层 type=function 是 OpenAI 容器；递归检查 function.parameters。
    assertStrictRequired(schema.function.parameters, `${stage}.parameters`);
  }
});

test("research 阶段的 AI schema 不暴露 modules / value / question / researchTasks", () => {
  const schema = buildStageToolSchema("research");
  const params = schema.function.parameters as Record<string, unknown>;
  const props = (params.properties ?? {}) as Record<string, unknown>;
  assert.equal(props.modules, undefined, "research 阶段不应暴露 modules（本地 deterministic）");
  assert.equal(props.value, undefined, "research 阶段不应暴露 value");
  assert.equal(props.question, undefined, "research 阶段不应暴露 question 顶级字段");
  assert.equal(props.researchTasks, undefined, "research 阶段不应暴露 researchTasks 顶级字段");
});

test("每个 stage（research 除外）的 modules.items 把 module 与 value 通过 oneOf 绑死", () => {
  for (const stage of PLANNING_STAGES) {
    if (stage === "research") continue;
    const schema = buildStageToolSchema(stage);
    const params = schema.function.parameters as Record<string, unknown>;
    const props = (params.properties ?? {}) as Record<string, unknown>;
    const modules = props.modules as Record<string, unknown>;
    assert.ok(modules, `${stage}: 必须有 modules`);
    const items = modules.items as Record<string, unknown>;
    const branches = Array.isArray(items.oneOf)
      ? (items.oneOf as Array<Record<string, unknown>>)
      : [items];
    // 每个 branch 必须有 module.const + 自己的 value schema（不是共享一个 moduleValue）。
    const constValues: string[] = [];
    for (const branch of branches) {
      const branchProps = branch.properties as Record<string, unknown>;
      const moduleField = branchProps.module as Record<string, unknown>;
      assert.ok(typeof moduleField.const === "string", `${stage}: module 必须用 const 绑定（不允许 enum）`);
      constValues.push(moduleField.const);
      // value schema 必须存在且是 module-specific（不是共享一个 oneOf 节点）。
      assert.ok(branchProps.value, `${stage}: branch.module=${moduleField.const} 必须绑定专属 value`);
    }
    // constValues 与 STAGE_ALLOWED_MODULES[stage] 排序后必须相等。
    assert.deepEqual(constValues.slice().sort(), [...constValues].sort());
  }
});

test("commercial tool schema 不再暴露 packageName，套餐名走本地固定规则", () => {
  const schema = buildStageToolSchema("commercial");
  const params = schema.function.parameters as Record<string, unknown>;
  const modules = (params.properties as Record<string, unknown>).modules as Record<string, unknown>;
  const items = modules.items as Record<string, unknown>;
  const branches = (Array.isArray(items.oneOf) ? items.oneOf : [items]) as Array<Record<string, unknown>>;
  const moduleConsts = branches.map((branch) => {
    const moduleField = (branch.properties as Record<string, unknown>).module as Record<string, unknown>;
    return moduleField.const;
  });
  assert.ok(!moduleConsts.includes("packageName"));
});

test("stage tool_call schema 没有遗留 researchTasks / question 顶级字段", () => {
  // research 阶段以外也不应有 researchTasks 顶级字段：AI 不应被问到。
  for (const stage of PLANNING_STAGES) {
    if (stage === "research") continue;
    const schema = buildStageToolSchema(stage);
    const props = ((schema.function.parameters as Record<string, unknown>).properties ?? {}) as Record<string, unknown>;
    assert.equal(props.researchTasks, undefined, `${stage}: AI schema 不应有 researchTasks 顶级字段`);
    assert.equal(props.question, undefined, `${stage}: AI schema 不应有 question 顶级字段`);
  }
});
