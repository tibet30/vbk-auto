import { randomUUID } from "node:crypto";
import type { ProductDetail } from "../../shared/contracts.js";
import type {
  ItineraryReviewUnlockPlan,
  ItineraryReviewUnlockReceipt,
  ItineraryReviewUnlockState,
} from "../../shared/itinerary-review-unlock.js";
import { ITINERARY_REVIEW_LEGACY_VALIDATION_ONLY_RECOVERY_MESSAGE } from "../../shared/itinerary-review-unlock.js";
import {
  readItineraryReviewEvidence,
  submitItineraryReviewUnlock,
  verifyPlannedItinerary,
  verifyItineraryReviewUnlockEventually,
} from "../automation/ctrip/itinerary-review/index.js";
import { runProductPreflightApi } from "../automation/ctrip/preflight-api.js";
import {
  reviewMenuProgressVerified as reviewAdvanced,
  assertMatchingReviewEvidence,
  assertPlannedReviewEvidence,
  isReviewDraftMenuBoundary,
  reviewRelationFingerprint,
  reviewProductFingerprint as fingerprint,
  type ItineraryReviewEvidence as Evidence,
  type ItineraryReviewProtocol as Protocol,
  type ItineraryReviewReservation as Reservation,
} from "./itinerary-review-unlock-support.js";
import type { ItineraryReviewUnlockDependencies } from "./itinerary-review-unlock-dependencies.js";
import { uncertainItineraryReviewState, verifiedItineraryReviewState } from "./itinerary-review-unlock-state.js";
import { recoverValidationOnlyReview } from "./itinerary-review-unlock-recovery.js";
export type { ItineraryReviewUnlockDependencies } from "./itinerary-review-unlock-dependencies.js";

export class ItineraryReviewUnlock {
  private readonly reservations = new Map<string, Reservation>();
  private readonly protocol: Protocol;
  private readonly preflight: NonNullable<ItineraryReviewUnlockDependencies["preflight"]>;
  private readonly verifyPlan: NonNullable<ItineraryReviewUnlockDependencies["verifyPlan"]>;

  constructor(private readonly deps: ItineraryReviewUnlockDependencies) {
    this.protocol = deps.protocol ?? {
      read: readItineraryReviewEvidence as Protocol["read"],
      submit: submitItineraryReviewUnlock as Protocol["submit"],
      verify: verifyItineraryReviewUnlockEventually as Protocol["verify"],
    };
    this.preflight = deps.preflight ?? runProductPreflightApi;
    this.verifyPlan = deps.verifyPlan ?? verifyPlannedItinerary;
  }

  async prepare(id: string): Promise<ItineraryReviewUnlockPlan> {
    this.deps.assertIdle(id);
    const product = this.requireProduct(id);
    this.assertAccount(product);
    let previous = this.deps.stateStore.get(id);
    if (previous && hasUnresolvedReviewWrite(previous)) {
      const reconciled = await this.refresh(id);
      if (reconciled.status === "verified" && reconciled.receipt) {
        return this.readonlyPlan(product, reconciled.receipt);
      }
      if (reconciled.status !== "requires_review") {
        throw new Error("上次行程审核写入结果尚未确认；只能只读核查，不能再次提交");
      }
      previous = reconciled;
    }
    const page = await this.deps.getPage(product.productId!);
    let evidence = await this.protocol.read(page, product.productId!);
    this.assertEvidenceProduct(evidence, product.productId!);
    if (reviewAdvanced(evidence)) {
      const receipt = { ...await this.protocol.verify(page, product.productId!,
        previous?.status === "verified" ? undefined : previous?.beforeDigest, product.product),
        beforeDigest: previous?.beforeDigest ?? evidence.contentDigest };
      this.assertProductSnapshot(product);
      this.persistVerified(product, previous?.attemptId ?? randomUUID(), receipt);
      return this.readonlyPlan(product, receipt);
    }
    this.assertReviewBoundary(evidence);
    await this.preflight(page, product.product, product.productId!, { itineraryTourInfoId: evidence.tourInfoId });
    const planned = await this.verifyPlan(page, product.product, product.productId!, evidence.tourInfoId);
    assertPlannedReviewEvidence(planned, evidence);
    const confirmed = await this.protocol.read(page, product.productId!);
    assertMatchingReviewEvidence(confirmed, evidence);
    evidence = confirmed;
    this.assertProductSnapshot(product);
    const now = this.now();
    this.prune(now);
    const token = randomUUID();
    const plan: ItineraryReviewUnlockPlan = {
      token,
      localProductId: product.id,
      productId: product.productId!,
      productName: product.name,
      accountKey: product.vbkAccount!,
      productJsonVersion: product.productJsonVersion ?? 0,
      tourInfoId: evidence.tourInfoId,
      contentDigest: evidence.contentDigest,
      maxStep: evidence.maxStep,
      lockedMenus: evidence.menus.filter(menu => menu.enabled === "F").map(menu => menu.title || menu.key),
      expiresAt: new Date(now + 300_000).toISOString(),
    };
    this.reservations.set(token, { plan, fingerprint: fingerprint(product),
      relationFingerprint: reviewRelationFingerprint(evidence.relation), expires: now + 300_000 });
    return plan;
  }

  async execute(token: string): Promise<ItineraryReviewUnlockReceipt> {
    const reservation = this.reservations.get(token);
    this.reservations.delete(token);
    if (!reservation || reservation.expires <= this.now()) {
      throw new Error("行程审核确认已过期或已使用，请重新确认");
    }
    const { plan } = reservation;
    return this.deps.withLocks(plan.localProductId, async () => {
      const product = this.requireProduct(plan.localProductId);
      this.assertAccount(product);
      this.assertReservation(product, reservation);
      const unresolved = this.deps.stateStore.get(plan.localProductId);
      if (hasUnresolvedReviewWrite(unresolved)) {
        throw new Error("已有行程审核写入结果尚未确认；当前确认不能再次提交");
      }
      const page = await this.deps.getPage(plan.productId);
      const assertCurrent = () => {
        const latest = this.requireProduct(product.id);
        this.assertAccount(latest);
        this.assertReservation(latest, reservation);
      };
      let before = await this.protocol.read(page, plan.productId);
      assertCurrent();
      this.assertFreshEvidence(before, reservation);
      if (reviewAdvanced(before)) {
        const receipt = await this.protocol.verify(page, plan.productId, plan.contentDigest, product.product);
        assertCurrent();
        this.persistVerified(product, randomUUID(), receipt);
        return receipt;
      }
      this.assertReviewBoundary(before);
      await this.preflight(page, product.product, plan.productId, { itineraryTourInfoId: plan.tourInfoId });
      const planned = await this.verifyPlan(page, product.product, plan.productId, plan.tourInfoId);
      assertPlannedReviewEvidence(planned, before);
      const confirmed = await this.protocol.read(page, plan.productId);
      this.assertFreshEvidence(confirmed, reservation);
      assertMatchingReviewEvidence(confirmed, before);
      before = confirmed;
      assertCurrent();
      const attemptId = randomUUID();
      let state: ItineraryReviewUnlockState = {
        localProductId: product.id,
        status: "dispatched",
        attemptId,
        productId: plan.productId,
        accountKey: plan.accountKey,
        tourInfoId: plan.tourInfoId,
        beforeDigest: plan.contentDigest,
        requestSteps: [],
        message: "行程审核请求已开始；完成前不得重复提交",
        updatedAt: this.isoNow(),
      };
      this.deps.stateStore.save(state);
      try {
        this.deps.record(product.id, "running", "用户已确认提交当前行程审核并解锁菜单", {
          attemptId, productId: plan.productId, tourInfoId: plan.tourInfoId,
          beforeDigest: plan.contentDigest, publish: false, createTrafficChildren: false,
        });
      } catch (error) {
        const failed: ItineraryReviewUnlockState = { ...state, status: "failed",
          message: error instanceof Error ? error.message : String(error), updatedAt: this.isoNow() };
        try { this.deps.stateStore.save(failed); } catch { /* dispatched barrier remains durable */ }
        throw error;
      }
      try {
        await this.protocol.submit(page, before, {
          assertCurrent,
          onStep: step => {
            state = { ...state, requestSteps: [...(state.requestSteps ?? []), step], updatedAt: this.isoNow() };
            this.deps.stateStore.save(state);
          },
        });
        assertCurrent();
        const verified = await this.protocol.verify(page, plan.productId, plan.contentDigest, product.product);
        assertCurrent();
        const receipt = { ...verified, requestSteps: state.requestSteps ?? [] };
        this.persistVerified(product, attemptId, receipt);
        try {
          this.deps.record(product.id, "succeeded", "行程审核已提交并完成菜单解锁回读", {
            attemptId, ...receipt,
          });
        } catch { /* verified state and authoritative receipt are already durable */ }
        return receipt;
      } catch (error) {
        state = uncertainItineraryReviewState(state, error, this.isoNow());
        try { this.deps.stateStore.save(state); } catch { /* dispatched barrier remains durable */ }
        this.deps.record(product.id, "failed", "行程审核写入结果尚未确认，只能只读核查", {
          attemptId, uncertainWrite: true, requestSteps: state.requestSteps ?? [], message: state.message,
          ...(state.digestMismatch ? { digestMismatch: state.digestMismatch } : {}),
        });
        throw Object.assign(new Error(state.message), {
          uncertainWrite: true,
          ...(state.digestMismatch ? { digestMismatch: state.digestMismatch } : {}),
        });
      }
    });
  }

  async refresh(id: string): Promise<ItineraryReviewUnlockState> {
    this.deps.assertIdle(id);
    return this.deps.withLocks(id, () => this.refreshLocked(id));
  }

  private async refreshLocked(id: string): Promise<ItineraryReviewUnlockState> {
    const product = this.requireProduct(id);
    this.assertAccount(product);
    const previous = this.deps.stateStore.get(id);
    const page = await this.deps.getPage(product.productId!);
    const evidence = await this.protocol.read(page, product.productId!);
    this.assertProductSnapshot(product);
    this.assertEvidenceProduct(evidence, product.productId!);
    if (reviewAdvanced(evidence)) {
      const verified = await this.protocol.verify(
        page, product.productId!, previous?.status === "verified" ? undefined : previous?.beforeDigest, product.product,
      );
      this.assertProductSnapshot(product);
      const receipt = { ...verified, beforeDigest: previous?.beforeDigest ?? verified.beforeDigest,
        requestSteps: previous?.requestSteps ?? verified.requestSteps };
      return this.persistVerified(product, previous?.attemptId ?? randomUUID(), receipt);
    }
    this.assertReviewBoundary(evidence);
    if (previous && hasUnresolvedReviewWrite(previous)) {
      const recovered = await recoverValidationOnlyReview({
        product, previous, evidence,
        verifyPlan: () => this.verifyPlan(page, product.product, product.productId!, evidence.tourInfoId),
        assertCurrent: () => this.assertProductSnapshot(product),
        updatedAt: this.isoNow(),
      });
      if (recovered) {
        this.deps.stateStore.save(recovered);
        return recovered;
      }
      const uncertain: ItineraryReviewUnlockState = {
        ...previous,
        status: "uncertain",
        message: "远端仍未形成完整解锁证据；禁止重复提交，只能继续只读核查",
        updatedAt: this.isoNow(),
      };
      this.deps.stateStore.save(uncertain);
      return uncertain;
    }
    return {
      localProductId: product.id,
      status: "requires_review",
      attemptId: "",
      productId: product.productId!,
      accountKey: product.vbkAccount!,
      tourInfoId: evidence.tourInfoId,
      beforeDigest: evidence.contentDigest,
      message: "当前产品停在行程审核边界，需要新的明确确认",
      updatedAt: this.isoNow(),
    };
  }

  private persistVerified(product: ProductDetail, attemptId: string, receipt: ItineraryReviewUnlockReceipt) {
    const state = verifiedItineraryReviewState(
      product, this.deps.stateStore.get(product.id), attemptId, receipt, this.isoNow(),
    );
    this.deps.stateStore.save(state);
    return state;
  }

  private readonlyPlan(product: ProductDetail, receipt: ItineraryReviewUnlockReceipt): ItineraryReviewUnlockPlan {
    return {
      readonlyVerified: true,
      localProductId: product.id,
      productId: product.productId!,
      productName: product.name,
      accountKey: product.vbkAccount!,
      productJsonVersion: product.productJsonVersion ?? 0,
      tourInfoId: receipt.tourInfoId,
      contentDigest: receipt.contentDigest,
      maxStep: receipt.maxStep,
      lockedMenus: [],
      expiresAt: this.isoNow(),
      receipt,
    };
  }

  private requireProduct(id: string) {
    const product = this.deps.getProduct(id);
    if (!product?.productId) throw new Error("远程草稿尚未创建，不能提交行程审核");
    if (product.automation?.status === "running") throw new Error("产品自动录入正在运行，不能同时提交行程审核");
    return product;
  }

  private assertAccount(product: ProductDetail) {
    if (!product.vbkAccount || product.vbkAccount !== this.deps.accountKey()) {
      throw new Error("VBK 账号已变化，请切换至产品所属账号");
    }
  }

  private assertProductSnapshot(product: ProductDetail) {
    const latest = this.requireProduct(product.id);
    this.assertAccount(latest);
    if (fingerprint(latest) !== fingerprint(product)) {
      throw new Error("产品方案、账号或远程身份已变化，请重新读取行程审核状态");
    }
  }

  private assertReservation(product: ProductDetail, reservation: Reservation) {
    const { plan } = reservation;
    if (fingerprint(product) !== reservation.fingerprint
      || product.productId !== plan.productId
      || (product.productJsonVersion ?? 0) !== plan.productJsonVersion
      || product.vbkAccount !== plan.accountKey) {
      throw new Error("产品方案、账号或远程身份已变化，请重新确认行程审核范围");
    }
  }

  private assertFreshEvidence(evidence: Evidence, reservation: Reservation) {
    const { plan } = reservation;
    this.assertEvidenceProduct(evidence, plan.productId);
    if (evidence.tourInfoId !== plan.tourInfoId || evidence.contentDigest !== plan.contentDigest
      || reviewRelationFingerprint(evidence.relation) !== reservation.relationFingerprint) {
      throw new Error("远端行程或关联身份已变化，请重新确认行程审核范围");
    }
  }

  private assertEvidenceProduct(evidence: Evidence, productId: string) {
    if (String(evidence.productId) !== String(productId)) throw new Error("行程审核远端产品身份不一致");
  }

  private assertReviewBoundary(evidence: Evidence) {
    if (!isReviewDraftMenuBoundary(evidence)
      || !evidence.tourInfoId || !evidence.contentDigest) {
      throw new Error("当前远端状态不是可确认的行程审核边界");
    }
  }

  private prune(now: number) {
    for (const [token, reservation] of this.reservations) {
      if (reservation.expires <= now) this.reservations.delete(token);
    }
  }

  private now() { return this.deps.now?.() ?? Date.now(); }
  private isoNow() { return new Date(this.now()).toISOString(); }
}

/** A missing step receipt cannot distinguish pre-dispatch failure from check8 reaching VBK. */
function hasUnresolvedReviewWrite(state: ItineraryReviewUnlockState | undefined): boolean {
  return state?.status === "dispatched" || state?.status === "uncertain"
    || state?.digestMismatch !== undefined
    || (state?.status === "requires_review"
      && state.attemptId === ""
      && state.message === ITINERARY_REVIEW_LEGACY_VALIDATION_ONLY_RECOVERY_MESSAGE);
}
