import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  basicInfoCompletenessIssues,
  findButlerOptionIndex,
  findFirstEnabledOptionIndex,
  findProvinceOptionIndex,
  parseProduct,
  pickKeySpotsFromItinerary,
  resolveAdvanceBooking,
  shouldRefillBasicInfo,
} from "../../src/main/automation/schema/schema.js";
import { pickCityOption, PRODUCT_IMAGE_TEXT_PATH, isProductImageTextUrl } from "../../src/main/automation/ctrip/ctrip.js";

function productFixture(extra: Record<string, unknown> = {}) {
  return {
    sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
    basicInfo: {
      supplierProductName: "测试产品",
      supplierProductCode: "TEST-1",
      subtitle: "测试副标题",
      days: 2,
      nights: 1,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "测试",
    },
    operations: { transport: "charter", pickupCity: "太原", reusePickupForDropoff: true, hotelSource: "nonPlatform", mealsIncluded: false },
    itinerary: [
      { day: 1, title: "第一天" },
      { day: 2, title: "第二天" },
    ],
    ...extra,
  };
}

const here = new URL(".", import.meta.url).pathname;
const projectRoot = path.resolve(here, "..", "..");
const ctripSourceRoot = path.resolve(here, "..", "..", "src", "main", "automation", "ctrip");
const automationSourceRoot = path.resolve(here, "..", "..", "src", "main", "automation");

function readSourceTree(directory: string): string {
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const chunks: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) chunks.push(readSourceTree(fullPath));
    else if (/\.(?:ts|tsx|cts)$/.test(entry.name)) chunks.push(`\n// FILE: ${fullPath}\n${readFileSync(fullPath, "utf8")}`);
  }
  return chunks.join("\n");
}

function helperBody(source: string, marker: string, endMarker: string) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `找不到 helper 标记：${marker}`);
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end > 0 ? end : source.length);
}

function stripComments(source: string): string {
  return source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

function readCtripSource() { return readSourceTree(ctripSourceRoot); }

function readAutomationSource() { return readSourceTree(automationSourceRoot); }

export {
  test,
  assert,
  fs,
  productFixture,
  helperBody,
  stripComments,
  readCtripSource,
  readAutomationSource,
  basicInfoCompletenessIssues,
  findButlerOptionIndex,
  findFirstEnabledOptionIndex,
  findProvinceOptionIndex,
  parseProduct,
  pickKeySpotsFromItinerary,
  resolveAdvanceBooking,
  shouldRefillBasicInfo,
  pickCityOption,
  isProductImageTextUrl,
  PRODUCT_IMAGE_TEXT_PATH,
};
