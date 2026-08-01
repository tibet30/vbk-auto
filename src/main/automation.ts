import { randomUUID } from "node:crypto";
import {
  configureProductShell, createProductShell, ensureVehicleResource, fillAndSaveBasicInfo,
  fillAndSavePackage, fillAndSavePresentation, fillAndSaveTerms, fillAndSubmitPricingInventory,
  fillItineraryDraft, openProductEditor, runProductPreflight, saveScreenshot,
} from "./automation/ctrip.js";
import { automationBlockers, parseProduct } from "./automation/schema.js";
import type { AutomationRun, ProjectDetail } from "../shared/contracts.js";
import { VbkDatabase } from "./database.js";
import { VbkBrowser } from "./vbk-browser.js";

const draftPhases = ["basic", "presentation", "itinerary", "package", "pricingInventory", "terms", "vehicleResource", "preflight"];

export class DraftAutomation {
  private running = new Set<string>();

  constructor(private db: VbkDatabase, private browser: VbkBrowser, private onUpdate: (project: ProjectDetail) => void) {}

  async start(projectId: string) {
    // 同一项目并发录入会共用一个 Playwright 页面互相抢占，甚至创建出两个草稿。
    if (this.running.has(projectId)) throw new Error("该项目的自动录入正在进行中，请等待本轮结束。");
    this.running.add(projectId);
    try {
      await this.run(projectId);
    } finally {
      this.running.delete(projectId);
    }
  }

  private async run(projectId: string) {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    const product = parseProduct(project.product);
    // 后面几个阶段强制要求这些字段，但它们在 productSchema 里是可选的。
    // 必须在创建远程草稿之前拦下，否则会在携程留下一个半成品产品。
    const blockers = automationBlockers(project.product);
    if (blockers.length) {
      throw new Error(`录入前检查未通过：${blockers.map((item) => item.label).join("、")}`);
    }
    const run: AutomationRun = { id: randomUUID(), status: "running", phases: draftPhases.map((phase) => ({ phase, status: "pending" })), logs: [] };
    const log = (message: string, level: "info" | "warning" | "error" = "info") => { run.logs.push({ at: new Date().toISOString(), message, level }); this.db.saveAutomation(projectId, run); this.emit(projectId); };
    this.db.updateProduct(projectId, project.product, "automating");
    this.browser.setVisible(true);
    try {
      const page = await this.browser.page();
      let productId = project.productId;
      run.currentPhase = "basic"; run.phases[0].status = "running";
      if (!productId) {
        log("正在创建 VBK 产品草稿…");
        await configureProductShell(page, product);
        productId = (await createProductShell(page)) as string;
        this.db.setProductId(projectId, productId);
        await fillAndSaveBasicInfo(page, product);
        // 基本信息保存成功后才算本阶段完成；此前 productId 一落库，
        // 重试就会直接跳过 basic，永远补不上那次失败的填写。
        this.db.setBasicInfoSaved(projectId);
        log(`产品草稿已创建：${productId}`);
      } else if (!project.basicInfoSaved) {
        log("上次基本信息未保存成功，正在重新填写…", "warning");
        await openProductEditor(page, productId);
        await fillAndSaveBasicInfo(page, product);
        this.db.setBasicInfoSaved(projectId);
      } else {
        await openProductEditor(page, productId);
      }
      run.phases[0].status = "completed";
      const handlers: Record<string, () => Promise<unknown>> = {
        presentation: () => fillAndSavePresentation(page, product), itinerary: () => fillItineraryDraft(page, product), package: () => fillAndSavePackage(page, product),
        pricingInventory: () => fillAndSubmitPricingInventory(page, product, productId!), terms: () => fillAndSaveTerms(page, product),
        vehicleResource: () => ensureVehicleResource(page, product, productId!), preflight: () => runProductPreflight(page, product, productId!),
      };
      for (let index = 1; index < draftPhases.length; index += 1) {
        const phase = draftPhases[index]; run.currentPhase = phase; run.phases[index].status = "running"; log(`正在保存：${phase}`);
        await handlers[phase](); run.phases[index].status = "completed"; log(`已保存：${phase}`);
      }
      run.status = "succeeded"; run.currentPhase = undefined; run.screenshot = await saveScreenshot(page, "desktop-draft", productId!);
      log("产品草稿已保存，未提交审核、未发布。", "warning"); this.db.updateProduct(projectId, project.product, "draft_saved"); this.db.saveAutomation(projectId, run); this.emit(projectId);
    } catch (error) {
      run.status = "failed"; const current = run.phases.find((phase) => phase.phase === run.currentPhase); if (current) current.status = "failed";
      log(error instanceof Error ? error.message : "自动录入发生未知错误", "error"); this.db.updateProduct(projectId, project.product, "blocked"); this.db.saveAutomation(projectId, run); this.emit(projectId); throw error;
    }
  }
  private emit(projectId: string) { const current = this.db.getProject(projectId); if (current) this.onUpdate(current); }
}
