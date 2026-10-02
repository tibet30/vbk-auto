import assert from "node:assert/strict";
import test from "node:test";

import { selectedClauseItems } from "../../src/main/automation/ctrip/traffic-line/clause-items.ts";
import { buildTrafficLineClauseSaveRequest } from "../../src/main/automation/ctrip/traffic-line/clauses.ts";
import {
  TrafficLineClauseReadbackError,
  verifyTrafficLineClauses,
} from "../../src/main/automation/ctrip/traffic-line/clause-readback.ts";

test("条款持久化投影忽略平台明确标记为模板的 selected T 项", () => {
  assert.deepEqual(selectedClauseItems({
    clauseTypeDtos: [{
      clauseTypeId: 4,
      clauseItemDtos: [
        { clauseItemId: 32269, itemType: "T", selected: "T" },
        { clauseItemId: 1060, itemType: "F", selected: "T" },
        { clauseItemId: 1006, selected: "T" },
      ],
    }],
  }).map((item) => item.clauseItemId), [1060, 1006]);
});

test("私家团上下文原样保留，selected F 条款及组件不因模板过滤丢失", () => {
  const packageItems = selectedClauseItems({
    clauseTypeDtos: [{
      clauseTypeId: 21,
      clauseItemDtos: [
        { clauseItemId: 32269, itemType: "T", selected: "T", clauseComponentDtos: [] },
        { clauseItemId: 1095, itemType: "F", selected: "T", clauseComponentDtos: [
          { componentCode: "private-tour-rule", value: "成人陪同" },
        ] },
      ],
    }],
  });
  assert.deepEqual(packageItems.map((item) => item.clauseItemId), [1095]);
  assert.deepEqual(packageItems[0]?.elementDtos, [{ componentCode: "private-tour-rule", value: "成人陪同" }]);
  const request = buildTrafficLineClauseSaveRequest({
    additionalInfoDto: { firstClassTypeIds: [21], isTra: "F", isPersonalTour: "T" },
    filterConditionDto: { productId: 79194665, pICategoryId: 1003 },
  }, packageItems);
  assert.equal((request.additionalInfoDto as any).isPersonalTour, "T");
  assert.equal((request.additionalInfoDto as any).isTra, "T");
  assert.deepEqual(request.clausePackageItemDtos, packageItems);
});

test("正式条款回读仍拒绝缺失的 selected F 持久化项", async () => {
  const mock = clauseReadbackMock({ transferItemType: "F" });
  await assert.rejects(
    () => verifyTrafficLineClauses(mock.page, "79194665", "flightRoundTrip", { syncRequired: false }),
    /子产品 79194665.*33006/,
  );
});

test("正式条款回读缺失时报告子产品、纯读模式及期望/实际 ID", async () => {
  const mock = clauseReadbackMock({ transferItemType: "F" });
  await assert.rejects(
    () => verifyTrafficLineClauses(mock.page, "79194665", "flightRoundTrip", { syncRequired: false }),
    (error: unknown) => {
      assert.ok(error instanceof TrafficLineClauseReadbackError);
      assert.equal(error.productId, "79194665");
      assert.equal(error.readMode, "pure-stable");
      assert.deepEqual(error.expectedIds, [38725, 38739, 33006, 1153]);
      assert.deepEqual(error.formalIds, [38725, 38739, 1153]);
      assert.deepEqual(error.responseKeys, ["ResponseStatus", "formalDtos"]);
      assert.match(error.message, /回读模式=pure-stable/);
      return true;
    },
  );
});

function clauseReadbackMock(options: { transferItemType: "F" | "T" }) {
  const page = {
    evaluate: async (_fn: unknown, arg: any) => {
      const endpoint = String(arg.endpoint);
      const body = arg.body as Record<string, any>;
      const ok = (payload: Record<string, unknown>) => ({
        status: 200,
        payload: { ResponseStatus: { Ack: "Success", Errors: [] }, ...payload },
        durationMs: 1,
        ctx: {},
      });
      if (endpoint.endsWith("/20698/getProductClause")) {
        return ok({ formalDtos: [38725, 38739, 1153].map((clauseItemId) => ({ clauseItemId })) });
      }
      if (endpoint.endsWith("/15638/listProductClauses")) {
        const tab = Number(body.tabEnum);
        return ok({ centralDataDto: central(tab) });
      }
      if (endpoint.endsWith("/20046/getClausePackage")) {
        return ok(schemaForTab(Number(body.firstClassClauseTypeIds?.[0])));
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  } as any;
  const central = (tab: number) => ({
    clausePackageId: 9000 + tab,
    additionalInfoDto: { firstClassTypeIds: [tab] },
    filterConditionDto: { productId: 79194665, pICategoryId: 1003 },
  });
  const schemaForTab = (tab: number) => {
    if (tab === 1) return {
      clauseTypeDtos: [{
        clauseTypeId: 86,
        clauseItemDtos: [
          { clauseItemId: 38725, selected: "T", clauseComponentDtos: [{ componentCode: "go", value: "去程机票" }] },
          { clauseItemId: 38739, selected: "T", clauseComponentDtos: [{ componentCode: "back", value: "返程机票" }] },
        ],
      }, {
        clauseTypeId: 316,
        clauseItemDtos: [{ clauseItemId: 33006, itemType: options.transferItemType, selected: "T", clauseComponentDtos: [] }],
      }],
    };
    if (tab === 4) return {
      clauseTypeDtos: [{ clauseTypeId: 21, containers: [{ clauseItemDtos: [{ clauseItemId: 1153, selected: "T", clauseComponentDtos: [] }] }] }],
    };
    return { clauseTypeDtos: [] };
  };
  return { page };
}
