import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SELECTED_CLAUSE_IDS,
  REQUIRED_CLAUSE_IDS,
  ensureRequiredClause,
  formatSelectedClauseItems,
  setClauseComponentValue,
} from "../../src/main/automation/ctrip/clauses-api.js";
import { buildAdultTicketInclusionText } from "../../src/main/automation/ctrip/terms.js";

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

test("格式化平台保存项，并把枚举码还原成展示值", () => {
  assert.deepEqual(formatSelectedClauseItems(clauseTypes), [{
    clauseItemId: 38536,
    secondClassTypeId: 4,
    elementDtos: [{ componentCode: "transfer", value: "接送" }],
  }]);
});

test("容器单选项按 selectedClauseItemId 保存，门票成人与儿童可同时进入条款包", () => {
  const ticketTypes = [{
    clauseTypeId: 8,
    clauseItemDtos: [{
      clauseItemId: 13,
      itemType: "F",
      isShow: "T",
      hasSelectBox: "T",
      selected: "T",
      clauseComponentDtos: [],
    }],
    containers: [{
      selectedClauseItemId: 10087,
      clauseItemDtos: [{
        clauseItemId: 10087,
        itemType: "F",
        isShow: "T",
        hasSelectBox: "T",
        selected: "F",
        clauseComponentDtos: [],
      }, {
        clauseItemId: 10088,
        itemType: "F",
        isShow: "T",
        hasSelectBox: "T",
        selected: "T",
        clauseComponentDtos: [],
      }],
    }],
  }];

  assert.deepEqual(
    formatSelectedClauseItems(ticketTypes).map((item) => item.clauseItemId),
    [13, 10087],
  );
});

test("平台无选择框的必带条款即使 selected=F 也进入保存包", () => {
  const automatic = [{
    clauseTypeId: 9,
    clauseItemDtos: [{
      clauseItemId: 999,
      itemType: "F",
      isShow: "T",
      hasSelectBox: "F",
      selected: "F",
      clauseComponentDtos: [],
    }],
    containers: [],
  }];

  assert.deepEqual(formatSelectedClauseItems(automatic).map((item) => item.clauseItemId), [999]);
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

test("成人首道门票文本仅汇总明确收费的行程景点，并按景点名去重", () => {
  assert.equal(buildAdultTicketInclusionText([{
    spots: [
      { name: "晋祠", ticketType: { key: 1 } },
      { name: "山西博物院", ticketType: { key: 2 } },
      { name: "晋祠", ticketType: { key: 1 } },
      { name: "未知票型景点", ticketType: null },
    ],
  }, {
    spots: [{ poiName: "太原古县城", ticketType: { key: 1 } }],
  }]), "晋祠+太原古县城");
});

test("成人和儿童门票条款分别写入对应备注字段，不改动其它组件", () => {
  const items = [{
    clauseItemId: 13,
    secondClassTypeId: 8,
    elementDtos: [
      { componentCode: "landticketremarks", value: "" },
      { componentCode: "adultTicketCategory", value: "首道大门票" },
    ],
  }];
  const withAdultRemarks = setClauseComponentValue(items, 13, "landticketremarks", "晋祠");
  const withChildRemarks = setClauseComponentValue([
    ...withAdultRemarks,
    {
      clauseItemId: 10087,
      secondClassTypeId: 8,
      elementDtos: [{ componentCode: "landticket2", value: "" }],
    },
  ], 10087, "landticket2", "晋祠");
  assert.deepEqual(withChildRemarks, [{
    clauseItemId: 13,
    secondClassTypeId: 8,
    elementDtos: [
      { componentCode: "landticketremarks", value: "晋祠" },
      { componentCode: "adultTicketCategory", value: "首道大门票" },
    ],
  }, {
    clauseItemId: 10087,
    secondClassTypeId: 8,
    elementDtos: [{ componentCode: "landticket2", value: "晋祠" }],
  }]);
  assert.throws(
    () => setClauseComponentValue(items, 13, "landticketremarks-missing", "晋祠"),
    /缺少组件 landticketremarks-missing/,
  );
});

test("默认条款集合使用已保存的平台 ID，覆盖门票成人/儿童及四个页签", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../src/main/automation/ctrip/clauses-api.ts", import.meta.url),
    "utf8",
  );
  assert.deepEqual([...DEFAULT_SELECTED_CLAUSE_IDS[1]], [38536, 134, 10095, 7, 10091, 13, 10087, 3014]);
  assert.equal(REQUIRED_CLAUSE_IDS.localExclusiveVehicle, 134);
  assert.deepEqual([...DEFAULT_SELECTED_CLAUSE_IDS[2]], [1082, 1079, 1120]);
  assert.deepEqual([...DEFAULT_SELECTED_CLAUSE_IDS[3]], [3031, 46, 1095]);
  assert.deepEqual([...DEFAULT_SELECTED_CLAUSE_IDS[4]], [3011, 98, 383, 478, 37682, 642, 32716, 563]);
  assert.equal(REQUIRED_CLAUSE_IDS.outboundTransportExcluded, 1082);
  assert.equal(REQUIRED_CLAUSE_IDS.excessBaggageAndPersonalExpenses, 1120);
  assert.equal(REQUIRED_CLAUSE_IDS.pregnancyBookingRestriction, 1095);
  assert.equal(REQUIRED_CLAUSE_IDS.flightForceMajeureNotice, 98);
  assert.equal(REQUIRED_CLAUSE_IDS.complimentaryActivityNotice, 383);
  assert.match(source, /requestBaseData:\s*\{\s*locale:\s*["']zh-CN["']/);
  assert.match(source, /保存后回读缺少条款/);
  assert.doesNotMatch(source, /FORCE_CHECK|resolveClauseIdsByText|ensureClausesByText/);
});
