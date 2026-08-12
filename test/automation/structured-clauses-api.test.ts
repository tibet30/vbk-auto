import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureRequiredClause,
  formatSelectedClauseItems,
  setClauseComponentValue,
} from "../../src/main/automation/ctrip/clauses-api.js";

const clauseTypes = [{
  clauseTypeId: 4,
  clauseItemDtos: [{
    clauseItemId: 3014,
    selected: "F",
    clauseComponentDtos: [{
      componentCode: "language",
      value: "A",
      componentElementDtos: [{ elementCode: "A", elementValue: "普通话" }],
    }],
  }, {
    clauseItemId: 38536,
    selected: "T",
    clauseComponentDtos: [{ componentCode: "transfer", value: "接送" }],
  }],
  containers: [],
}];

test("只格式化平台 selected=T 条款，并把枚举码还原成展示值", () => {
  assert.deepEqual(formatSelectedClauseItems(clauseTypes), [{
    clauseItemId: 38536,
    secondClassTypeId: 4,
    elementDtos: [{ componentCode: "transfer", value: "接送" }],
  }]);
});

test("确定性补入必选条款且保持幂等", () => {
  const initial = formatSelectedClauseItems(clauseTypes);
  const once = ensureRequiredClause(initial, clauseTypes, 3014);
  const twice = ensureRequiredClause(once, clauseTypes, 3014);
  assert.equal(once.length, 2);
  assert.deepEqual(twice, once);
  assert.deepEqual(once[1], {
    clauseItemId: 3014,
    secondClassTypeId: 4,
    elementDtos: [{ componentCode: "language", value: "普通话", elementCode: "A" }],
  });
});

test("为已选结构化条款写入必填组件值，且不改动其它条款", () => {
  const items = [{
    clauseItemId: 1079,
    secondClassTypeId: 60,
    elementDtos: [
      { componentCode: "otherfeewithout1", value: "" },
      { componentCode: "otherfeewithout0", value: "住宿费用" },
    ],
  }, {
    clauseItemId: 1120,
    secondClassTypeId: 15,
    elementDtos: [{ componentCode: "otheraddinfo0", value: "其它费用" }],
  }];

  const next = setClauseComponentValue(items, 1079, "otherfeewithout1", "单房差及儿童占床费用");
  assert.equal(next[0].elementDtos[0].value, "单房差及儿童占床费用");
  assert.deepEqual(next[1], items[1]);
  assert.equal(items[0].elementDtos[0].value, "");
});

test("目标组件不存在时失败，避免把空必填项误判成已保存", () => {
  assert.throws(
    () => setClauseComponentValue([], 1079, "otherfeewithout1", "住宿费用"),
    /缺少组件 otherfeewithout1/,
  );
});
