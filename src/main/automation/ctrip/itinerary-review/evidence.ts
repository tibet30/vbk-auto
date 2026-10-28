import { createHash } from "node:crypto";
import {
  ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_LIMIT,
  ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_MAX_LENGTH,
  type ItineraryReviewDigestMismatch,
} from "../../../../shared/itinerary-review-unlock.js";
import { getProductBaseInfoApi } from "../basic-info/read-base.js";
import { fetchTourDailyDetail, fetchTourInfoId } from "../itinerary-api/steps.js";
import { isUnsubmittedAuditStatus, linkedVersionId, linkedVersionSummary } from "../itinerary-api/versioning.js";
import { verifyProductDraftMenus, type ProductMenu } from "../product-menu-readback.js";
import { readTrafficLineChildren } from "../traffic-line/relationships.js";
import type { TrafficLinePage } from "../traffic-line/client.js";
import { buildReadOnlyItineraryReadbackExpectations } from "../preflight-readonly.js";
import { resolveStationsForItinerary } from "../itinerary-api/stations-resolver.js";
import { verifyItineraryReadback } from "../itinerary-api/readback.js";
import { canonicalItineraryContent } from "./content-normalization.js";
import { isUnpublishedActive } from "../../../../shared/vbk-publication.js";

export interface ItineraryReviewEvidence {
  productId: string;
  tourInfoId: string;
  base: Record<string, any>;
  relation: Record<string, unknown>;
  detail: Record<string, unknown>;
  contentDigest: string;
  menus: ProductMenu[];
  maxStep: number;
  fullyUnlocked: boolean;
  publication: { active: string; isonline: string; releaseActive: string };
  trafficChildren: number;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function positiveId(value: unknown): string {
  const text = String(value ?? "");
  return /^\d+$/.test(text) && Number(text) > 0 ? text : "";
}

/** Never review a formal version when a distinct writable draft exists. */
export function reviewTourInfoId(relation: Record<string, unknown>): string {
  const formal = linkedVersionId(relation, "tourInfoId");
  const audit = linkedVersionId(relation, "auditTourInfoId");
  const draft = linkedVersionId(relation, "draftTourInfoId");
  const preview = linkedVersionId(relation, "previewTourInfoId");
  const aliases = [formal, audit, preview].filter(Boolean);
  if (draft && !aliases.includes(draft)) return String(draft);
  const draftStatus = String(relation.draftTourInfoStatus ?? "");
  if (formal && formal === audit && (draftStatus === "1" || draftStatus === "2")) return String(formal);
  if (!formal && !audit && preview && isUnsubmittedAuditStatus(relation.auditStatus)) return String(preview);
  throw new Error(`行程审核关联没有可证明的当前草稿版本：${linkedVersionSummary(relation)}`);
}

const MAX_DIFFERENCE_DEPTH = 32;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedPath(path: string, parent?: string): string {
  if (path.length <= ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_MAX_LENGTH) return path;
  const wildcard = parent ? `${parent}[*]` : "$[*]";
  return wildcard.length <= ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_MAX_LENGTH ? wildcard : "$[*]";
}

function pathForKey(parent: string, key: string): string {
  return boundedPath(/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? `${parent}.${key}` : `${parent}[*]`, parent);
}

/**
 * Compares only fields included in the digest. Values are intentionally never
 * returned: callers persist these bounded JSON paths for diagnosis only.
 */
export function itineraryContentDifferencePaths(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const leftDescriptions = canonicalItineraryContent(before.tourDailyDescriptions);
  const rightDescriptions = canonicalItineraryContent(after.tourDailyDescriptions);
  const paths: string[] = [];
  const add = (path: string) => {
    const bounded = boundedPath(path);
    if (paths.length < ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_LIMIT && !paths.includes(bounded)) paths.push(bounded);
  };
  const visit = (left: unknown, right: unknown, path: string, depth: number): void => {
    if (paths.length >= ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_LIMIT || Object.is(left, right)) return;
    if (depth >= MAX_DIFFERENCE_DEPTH) return add(path);
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right)) return add(path);
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        if (paths.length >= ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_LIMIT) return;
        const next = boundedPath(`${path}[${index}]`, path);
        if (index >= left.length || index >= right.length) add(next);
        else visit(left[index], right[index], next, depth + 1);
      }
      return;
    }
    const leftObject = object(left); const rightObject = object(right);
    if (leftObject || rightObject) {
      if (!leftObject || !rightObject) return add(path);
      const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])]
        .sort((a, b) => a.localeCompare(b));
      for (const key of keys) {
        if (paths.length >= ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_LIMIT) return;
        const next = pathForKey(path, key);
        if (!(key in leftObject) || !(key in rightObject)) add(next);
        else visit(leftObject[key], rightObject[key], next, depth + 1);
      }
      return;
    }
    add(path);
  };
  visit(leftDescriptions, rightDescriptions, "$.tourDailyDescriptions", 0);
  return paths;
}

export class ItineraryReviewDigestMismatchError extends Error {
  constructor(readonly digestMismatch: ItineraryReviewDigestMismatch) {
    super(`${digestMismatch.step}改写了已保存行程内容，已停止后续提交。`);
    this.name = "ItineraryReviewDigestMismatchError";
  }
}

export function itineraryContentDigest(detail: Record<string, unknown>): string {
  const descriptions = detail.tourDailyDescriptions;
  if (!Array.isArray(descriptions) || !descriptions.length) throw new Error("行程审核缺少已保存的每日行程内容。");
  return createHash("sha256").update(JSON.stringify(canonicalItineraryContent(descriptions))).digest("hex");
}

/** Complete read-only comparison against the locally confirmed itinerary plan. */
export async function verifyPlannedItinerary(
  page: TrafficLinePage,
  product: any,
  productId: string,
  tourInfoId: string,
): Promise<{ tourInfoId: string; days: number; contentDigest: string }> {
  if (!/^\d+$/.test(productId) || !/^\d+$/.test(tourInfoId)) throw new Error("行程方案回读产品或行程 ID 无效。");
  const operations = record(product?.operations);
  const pickupCity = typeof operations.pickupCity === "string" ? operations.pickupCity.trim() : "";
  if (!pickupCity) throw new Error("行程方案回读缺少 operations.pickupCity。");
  const stations = await resolveStationsForItinerary(page, {
    pickupCity, dropoffCity: typeof operations.dropoffCity === "string" ? operations.dropoffCity.trim() : undefined,
    endpointPlan: record(operations.trafficLine).availability?.endpointPlan,
  });
  const expectations = await buildReadOnlyItineraryReadbackExpectations(page, product, stations);
  const result = await verifyItineraryReadback(page, tourInfoId, expectations);
  const detail = (await fetchTourDailyDetail(page, tourInfoId)).tourInfo;
  if (!detail) throw new Error("行程方案回读缺少详情。");
  return { tourInfoId, days: result.days, contentDigest: itineraryContentDigest(detail) };
}

function publication(base: Record<string, any>) {
  const info = record(base.baseInfo);
  const meta = record(base.meta);
  return {
    active: String(info.active ?? base.active ?? ""),
    isonline: String(meta.isonline ?? info.isonline ?? base.isonline ?? ""),
    releaseActive: String(meta.releaseActive ?? base.releaseActive ?? ""),
  };
}

/** Reads the same narrow review boundary used by normal draft preflight. */
export async function readItineraryReviewEvidence(page: TrafficLinePage, productId: string): Promise<ItineraryReviewEvidence> {
  if (!/^\d+$/.test(productId) || Number(productId) <= 0) throw new Error("行程审核产品 ID 无效。");
  const [base, association] = await Promise.all([getProductBaseInfoApi(page, productId), fetchTourInfoId(page, productId)]);
  if (String(association.tourInfo.productId ?? "") !== String(Number(productId))) throw new Error("行程审核关联产品身份不一致。");
  const tourInfoId = reviewTourInfoId(association.tourInfo);
  const menus = await verifyProductDraftMenus(page, productId, {
    base, tourInfo: association.tourInfo, verifiedTourInfoId: tourInfoId,
  });
  if (menus.advancementRequiresReview === true
    && String(association.tourInfo.draftTourInfoStatus ?? "") !== "1") {
    throw new Error("行程审核边界未返回可提交的当前草稿版本。");
  }
  const detail = (await fetchTourDailyDetail(page, tourInfoId)).tourInfo;
  if (!detail) throw new Error("行程审核未读取到已保存的行程详情。");
  if (positiveId(detail.tourInfoId) !== tourInfoId) throw new Error("行程审核详情与当前草稿版本不一致。");
  if (detail.productId !== undefined && String(detail.productId) !== String(Number(productId))) throw new Error("行程审核详情产品身份不一致。");
  const children = await readTrafficLineChildren(page, productId);
  const result = {
    productId, tourInfoId, base, relation: association.tourInfo, detail,
    contentDigest: itineraryContentDigest(detail), menus: menus.menus, maxStep: menus.maxStep,
    fullyUnlocked: menus.fullyUnlocked, publication: publication(base), trafficChildren: children.length,
  };
  const { active, isonline, releaseActive } = result.publication;
  if (!isUnpublishedActive(active) || isonline !== "F" || releaseActive !== "F") throw new Error("行程审核前产品必须保持未发布状态。");
  if (result.trafficChildren !== 0) throw new Error("行程审核前存在交通子产品，不能作为母产品解锁提交。");
  return result;
}
