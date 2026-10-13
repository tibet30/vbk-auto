import { randomUUID } from "node:crypto";
import type { ProductDetail } from "../../shared/contracts.js";
import type { HotelDraftRetryPlan, HotelDraftRetryResult } from "../../shared/hotel-draft-retry.js";
import { defaultPlatformHotelRules, normalisePlatformHotelProduct, platformHotelStayGroups } from "../../shared/platform-hotel-rules.js";
import { ensurePlatformHotelRulesApi } from "../automation/ctrip/hotel-rule-api.js";
import type { VbkSessionRequestBrowser } from "../infrastructure/vbk-session-request.js";
import { hotelDraftRequestScope } from "./hotel-draft-request-scope.js";

export interface HotelDraftRetryDependencies {
  getProduct(id: string): ProductDetail | null | undefined;
  saveProduct(id: string, product: Record<string, unknown>, expectedVersion: number): ProductDetail;
  accountKey(): string;
  assertIdle(id: string): void;
  withLocks<T>(id: string, work: () => Promise<T>): Promise<T>;
  getPage(): Promise<VbkSessionRequestBrowser>;
  record(id: string, status: "running" | "succeeded" | "failed", message: string, payload: Record<string, unknown>): void;
  message(id: string, content: string): void;
  complete?: (id: string, proof: HotelDraftRetryResult, expectedVersion: number) => void;
  now?: () => number;
}
type Reservation = { plan: HotelDraftRetryPlan; product: ProductDetail; expires: number };
const fingerprint = (product: ProductDetail) => JSON.stringify([product.productId, product.vbkAccount, product.productJsonVersion, product.product]);

/** Fresh, one-use human confirmation; it never borrows or broadens an Agent approval. */
export class HotelDraftRetry {
  private readonly reservations = new Map<string, Reservation>();
  constructor(private readonly deps: HotelDraftRetryDependencies) {}
  prepare(id: string): HotelDraftRetryPlan {
    this.deps.assertIdle(id);
    const product = this.requireProduct(id);
    this.assertAccount(product);
    const normalized = this.normalize(product);
    const plan: HotelDraftRetryPlan = { token: randomUUID(), localProductId: id, productId: product.productId!,
      accountKey: product.vbkAccount!, stays: platformHotelStayGroups(normalized).map(({ cityName, nights }) => ({ cityName, nights })) };
    const now = this.now();
    for (const [token, reservation] of this.reservations) if (reservation.expires <= now) this.reservations.delete(token);
    this.reservations.set(plan.token, { plan, product: structuredClone(product), expires: now + 300_000 });
    return plan;
  }
  async execute(token: string): Promise<HotelDraftRetryResult> {
    const reservation = this.reservations.get(token);
    this.reservations.delete(token);
    if (!reservation || reservation.expires <= this.now()) throw new Error("酒店草稿确认已过期或已使用，请重新执行");
    const { plan } = reservation;
    return this.deps.withLocks(plan.localProductId, async () => {
      const current = this.requireProduct(plan.localProductId);
      this.assertAccount(current);
      if (fingerprint(current) !== fingerprint(reservation.product)) throw new Error("产品方案已变化，请重新确认酒店草稿范围");
      const normalized = this.normalize(current);
      const saved = this.deps.saveProduct(current.id, normalized, current.productJsonVersion ?? 0);
      const assertCurrent = () => {
        const latest = this.requireProduct(current.id);
        this.assertAccount(latest);
        if (fingerprint(latest) !== fingerprint(saved)) throw new Error("酒店草稿执行期间产品方案已变化，已停止写入");
      };
      this.deps.record(current.id, "running", "用户确认仅保存酒店规则草稿", { ...plan, token: undefined,
        authorizationId: token, autoMatch: true, grades: [3, 4, 5], specifiedHotels: [], draftOnly: true });
      try {
        const page = hotelDraftRequestScope(await this.deps.getPage(), plan.productId, assertCurrent);
        const result = await ensurePlatformHotelRulesApi(page, normalized, plan.productId, { draftOnly: true });
        assertCurrent();
        const receipt: HotelDraftRetryResult = { verified: true, productId: plan.productId, segmentIds: result.segmentIds ?? [],
          rules: { autoMatch: true, grades: [3, 4, 5] }, specifiedHotels: [], draftOnly: true };
        this.deps.complete?.(current.id, receipt, saved.productJsonVersion ?? 0);
        this.deps.record(current.id, "succeeded", "酒店规则草稿已保存并回读成功", { ...receipt, authorizationId: token });
        this.deps.message(current.id, "酒店规则草稿已保存并回读成功：自动匹配为是，三钻、四钻、五钻全选，指定酒店为空。本次仅执行酒店阶段，未提交审核、未发布。");
        return receipt;
      } catch (error) {
        this.deps.record(current.id, "failed", String(error), { authorizationId: token, draftOnly: true, verified: false });
        throw error;
      }
    });
  }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private requireProduct(id: string) {
    const product = this.deps.getProduct(id);
    if (!product?.productId) throw new Error("远程草稿尚未创建，不能重新执行酒店规则");
    if (product.automation?.status === "running") throw new Error("产品自动录入正在运行，不能同时保存酒店草稿");
    return product;
  }
  private assertAccount(product: ProductDetail) {
    if (!product.vbkAccount || product.vbkAccount !== this.deps.accountKey()) throw new Error("VBK 账号已变化，请切换至产品所属账号");
  }
  private normalize(product: ProductDetail) {
    // Explicit human conversion overrides stale/missing historical rules with the reviewed defaults.
    const normalized = normalisePlatformHotelProduct({ ...product.product, operations: { ...(product.product.operations as Record<string, unknown> | undefined),
      hotelMatchingMode: "rules", hotelRules: defaultPlatformHotelRules() } });
    delete normalized.operations.hotelTier;
    delete normalized.operations.hotelSource;
    return normalized;
  }
}
