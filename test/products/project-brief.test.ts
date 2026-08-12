import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultCommercialInventory } from "../../src/main/data/commercial-defaults.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

test("最小产品信息创建可审查的通用私家团草稿", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-project-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });

  assert.equal(project.name, "太原2天1晚私家团");
  assert.deepEqual(project.product.sales, { productType: "domesticShort", productForm: "privateTour", splitGroup: false });
  const basicInfo = project.product.basicInfo as Record<string, unknown>;
  assert.equal(basicInfo.supplierProductName, "太原2天1晚私家团");
  assert.equal(basicInfo.days, 2);
  assert.equal(basicInfo.nights, 1);
  assert.equal(basicInfo.meetingCity, "太原");
  assert.equal(basicInfo.destinationCity, "太原");
  assert.deepEqual((project.product.operations as Record<string, unknown>).vehicleResource, {});
  assert.deepEqual(project.product.commercial, { inventory: defaultCommercialInventory() });
  assert.match(project.messages[0].content, /目的地「太原」/);
  // 开场白只留项目上下文事实，不再表达"AI 正在生成"等 loading 状态 —— 后者由
  // user-running 消息下方的"正在等待 AI 回复"提示负责，避免两处文案重复。
  assert.match(project.messages[0].content, /产品形态「私家团」/);
  assert.match(project.messages[0].content, /行程「2天1晚」/);
});

test("读取旧项目时补齐空 vehicleResource", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-vehicle-default-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  const raw = (db as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): void } } }).db;
  raw.prepare("UPDATE projects SET product_json=? WHERE id=?").run(JSON.stringify({
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: { supplierProductName: "太原2天1晚私家团", supplierProductCode: "TY", days: 2, nights: 1, meetingCity: "太原", destinationCity: "太原" },
    operations: { hotelSource: "nonPlatform", hotelTier: "当地5钻酒店/-38", mealsIncluded: false },
    itinerary: [],
  }), project.id);

  const loaded = db.getProject(project.id)!;
  assert.deepEqual((loaded.product.operations as Record<string, unknown>).vehicleResource, {});
});

test("读取已有 commercial 但缺库存的旧项目时补默认班期库存", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-inventory-default-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  const raw = (db as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): void } } }).db;
  raw.prepare("UPDATE projects SET product_json=? WHERE id=?").run(JSON.stringify({
    sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
    basicInfo: { supplierProductName: "太原2天1晚跟团游", supplierProductCode: "TY", days: 2, nights: 1, meetingCity: "太原", destinationCity: "太原" },
    commercial: {
      packageName: "标准套餐",
      pricing: { currency: "CNY", adult: 599, child: 399, minimumTravelers: 2 },
    },
    itinerary: [],
  }), project.id);

  const loaded = db.getProject(project.id)!;
  const commercial = loaded.product.commercial as Record<string, unknown>;
  assert.deepEqual(commercial.inventory, defaultCommercialInventory());
  assert.equal(commercial.packageName, "标准套餐");
  assert.deepEqual(commercial.pricing, { currency: "CNY", adult: 599, child: 399, minimumTravelers: 2 });
});

test("新建项目自带供应商产品编号，运营可再编辑", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-code-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  const basicInfo = project.product.basicInfo as Record<string, unknown>;

  // 编号是自动录入的 schema 必填项，AI 被禁止写入，因此必须在建项目时就位，
  // 否则「确认并保存草稿」永远无法启用。
  assert.ok(typeof basicInfo.supplierProductCode === "string" && basicInfo.supplierProductCode.length > 0);
  assert.match(String(basicInfo.supplierProductCode), /^[A-Z0-9-]+$/);

  const updated = db.updateBasicInfoField(project.id, "supplierProductCode", "TY-REAL-001");
  assert.equal((updated.product.basicInfo as Record<string, unknown>).supplierProductCode, "TY-REAL-001");
});

test("两个项目的供应商产品编号不重复", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-code-unique-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const first = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  const second = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });

  const codeOf = (project: typeof first) => (project.product.basicInfo as Record<string, unknown>).supplierProductCode;
  assert.notEqual(codeOf(first), codeOf(second));
});

test("项目标题按天数自动换算晚数", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-title-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const project = db.createProject({ destination: "太原", days: 4, productForm: "privateTour" });

  assert.equal(project.name, "太原4天3晚私家团");
  assert.equal((project.product.basicInfo as { nights: number }).nights, 3);
});

test("异常创建参数会返回清晰校验提示", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-project-invalid-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);

  assert.throws(
    () => db.createProject({ destination: { value: "太原" } as unknown as string, days: 2, productForm: "privateTour" }),
    /请填写有效的目的地/,
  );
});

test("运营人员确认核查时会保存人工核查证据", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-research-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  db.addResearchTask(project.id, { label: "核查车辆资源组", type: "vbk", detail: "在 VBK 资源库选择可用资源组" });
  const task = db.getProject(project.id)!.researchTasks[0];
  db.markResearchAccepted(project.id, task.id, "已核对资源组与供应商编码");
  const confirmed = db.getProject(project.id)!.researchTasks[0];

  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.evidence?.[0].title, "已核对资源组与供应商编码");
  assert.equal(confirmed.evidence?.[0].source, "user");
});

test("重复返回的同名待核查任务只保留一项", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-research-dedupe-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });

  db.addResearchTask(project.id, { label: "核查车辆资源", type: "vbk", detail: "第一次说明" });
  db.addResearchTask(project.id, { label: "核查车辆资源", type: "vbk", detail: "最新说明" });

  const tasks = db.getProject(project.id)!.researchTasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].detail, "最新说明");
});

test("历史 POI 待办在详情中合并呈现，且续跑不会再新增同义项", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-poi-task-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  const raw = (db as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): void; get(...values: unknown[]): { count: number } } } }).db;
  const insert = raw.prepare("INSERT INTO research_tasks VALUES(?,?,?,?,?,?,?,?)");
  for (const [index, name] of ["山西博物院", "晋祠", "蒙山大佛"].entries()) {
    insert.run(`legacy-no-match-${index}`, project.id, `待核查景点 ${name} 的 VBK POI`, "vbk", "queued", "researching", "suggestPoi 未匹配，请人工核查", "[]");
    insert.run(`legacy-city-poi-${index}`, project.id, `核查 ${name} 在 VBK 资源库的 city / poi 映射`, "vbk", "queued", "researching", "由目的地「太原」延伸", "[]");
  }
  // 标签相近的门票 / 成本任务不属于严格定义的 POI 映射，必须保留为独立项。
  insert.run("ticket-cost", project.id, "核查 晋祠 门票成本", "cost", "queued", "researching", "待供应商确认", "[]");
  insert.run("ticket-vbk", project.id, "核查 晋祠 在 VBK 资源库的 city / poi 映射（含门票）", "vbk", "queued", "researching", "待人工核查票价", "[]");

  const visible = db.getProject(project.id)!.researchTasks;
  assert.equal(visible.length, 5, "六条历史 POI 行应合为三项，门票/成本任务保持独立");
  assert.deepEqual(visible.map((task) => task.label).sort(), [
    "核查 山西博物院 的 VBK POI 映射",
    "核查 晋祠 的 VBK POI 映射",
    "核查 蒙山大佛 的 VBK POI 映射",
    "核查 晋祠 门票成本",
    "核查 晋祠 在 VBK 资源库的 city / poi 映射（含门票）",
  ].sort());
  assert.equal(raw.prepare("SELECT count(*) AS count FROM research_tasks WHERE project_id=?").get(project.id).count, 8, "历史行必须保留，不能无痕删除");

  db.addResearchTask(project.id, { label: "核查 晋祠 的 VBK POI 映射", type: "vbk", detail: "本轮续跑仍需人工核查" });
  assert.equal(raw.prepare("SELECT count(*) AS count FROM research_tasks WHERE project_id=?").get(project.id).count, 8, "canonical label 应识别 legacy 行并避免新增第七行");
  const afterResume = db.getProject(project.id)!.researchTasks;
  assert.equal(afterResume.length, 5);
  assert.match(afterResume.find((task) => task.label === "核查 晋祠 的 VBK POI 映射")?.detail ?? "", /suggestPoi 未匹配/, "legacy detail 保留为可追溯历史");
});

test("应用重启后会把没有回复的消息标记为可重试失败", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-message-recovery-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  db.addMessage(project.id, "user", "生成第一版方案", "running");

  db.recoverUnansweredMessages();
  const messages = db.getProject(project.id)!.messages;

  assert.equal(messages.at(-2)?.taskStatus, "failed");
  assert.equal(messages.at(-1)?.role, "assistant");
  assert.equal(messages.at(-1)?.taskStatus, "failed");
  assert.match(messages.at(-1)?.content || "", /没有完成/);
});
