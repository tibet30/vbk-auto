import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultCommercialInventory } from "../../src/main/data/commercial-defaults.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

test("旧版本地数据库会无损迁移为产品表与本地产品关联列", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-product-migration-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));

  const seeded = new VbkDatabase(dataPath);
  const product = seeded.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  seeded.addResearchTask(product.id, { label: "迁移保留项", type: "vbk", detail: "必须保留" });
  const legacy = (seeded as unknown as {
    db: { exec(sql: string): void; prepare(sql: string): { run(...values: unknown[]): void }; close(): void };
  }).db;
  legacy.exec(`
    ALTER TABLE products RENAME TO projects;
    ALTER TABLE messages RENAME COLUMN local_product_id TO project_id;
    ALTER TABLE research_tasks RENAME COLUMN local_product_id TO project_id;
    ALTER TABLE automation_runs RENAME COLUMN local_product_id TO project_id;
    ALTER TABLE planning_generation RENAME COLUMN local_product_id TO project_id;
    ALTER TABLE operation_log RENAME COLUMN local_product_id TO project_id;
    ALTER TABLE operation_log RENAME COLUMN product_name TO project_name;
  `);
  legacy.prepare("DELETE FROM migrations WHERE id=?").run("0007_product_naming");
  legacy.close();

  const migrated = new VbkDatabase(dataPath);
  const loaded = migrated.getProduct(product.id);
  assert.equal(loaded?.name, "太原2天1晚私家团");
  assert.equal(loaded?.messages.length, 1);
  assert.equal(loaded?.researchTasks[0]?.label, "迁移保留项");
  const current = (migrated as unknown as {
    db: { prepare(sql: string): { all(): Array<{ name: string }> } };
  }).db;
  const tables = current.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  assert.ok(tables.includes("products"));
  assert.equal(tables.includes("projects"), false);
});

test("最小产品信息创建可审查的通用私家团草稿", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-product-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });

  assert.equal(product.name, "太原2天1晚私家团");
  assert.deepEqual(product.product.sales, { productType: "domesticShort", productForm: "privateTour", splitGroup: false });
  const basicInfo = product.product.basicInfo as Record<string, unknown>;
  assert.equal(basicInfo.supplierProductName, "太原2天1晚私家团");
  assert.equal(basicInfo.days, 2);
  assert.equal(basicInfo.nights, 1);
  assert.equal(basicInfo.meetingCity, "太原");
  assert.equal(basicInfo.destinationCity, "太原");
  assert.deepEqual((product.product.operations as Record<string, unknown>).vehicleResource, {});
  assert.deepEqual(product.product.commercial, { inventory: defaultCommercialInventory() });
  assert.match(product.messages[0].content, /目的地「太原」/);
  // 开场白只留产品上下文事实，不再表达"AI 正在生成"等 loading 状态 —— 后者由
  // user-running 消息下方的"正在等待 AI 回复"提示负责，避免两处文案重复。
  assert.match(product.messages[0].content, /产品形态「私家团」/);
  assert.match(product.messages[0].content, /行程「2天1晚」/);
});

test("创建草稿先把行政目的地归一为平台短名", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-product-city-short-name-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const product = db.createProduct({ destination: "成都市", days: 2, productForm: "privateTour" });
  const basicInfo = product.product.basicInfo as Record<string, unknown>;

  assert.equal(product.name, "成都2天1晚私家团");
  assert.equal(basicInfo.destination, "成都");
  assert.equal(basicInfo.meetingCity, "成都");
  assert.equal(basicInfo.destinationCity, "成都");
});

test("创建产品会保存用户初始想法，并限制为 1000 个字", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-product-idea-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour", userIdea: "想慢一点，多安排当地文化体验。" });
  assert.equal((product.product.basicInfo as Record<string, unknown>).userIdea, "想慢一点，多安排当地文化体验。");
  assert.throws(
    () => db.createProduct({ destination: "太原", days: 2, productForm: "privateTour", userIdea: "字".repeat(1001) }),
    /用户想法不能超过 1000 个字/,
  );
});

test("读取旧产品时补齐空 vehicleResource", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-vehicle-default-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  const raw = (db as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): void } } }).db;
  raw.prepare("UPDATE products SET product_json=? WHERE id=?").run(JSON.stringify({
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: { supplierProductName: "太原2天1晚私家团", supplierProductCode: "TY", days: 2, nights: 1, meetingCity: "太原", destinationCity: "太原" },
    operations: { hotelSource: "nonPlatform", hotelTier: "当地5钻酒店/-38", mealsIncluded: false },
    itinerary: [],
  }), product.id);

  const loaded = db.getProduct(product.id)!;
  assert.deepEqual((loaded.product.operations as Record<string, unknown>).vehicleResource, {});
});

test("读取已有 commercial 但缺库存的旧产品时补默认班期库存", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-inventory-default-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  const raw = (db as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): void } } }).db;
  raw.prepare("UPDATE products SET product_json=? WHERE id=?").run(JSON.stringify({
    sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
    basicInfo: { supplierProductName: "太原2天1晚跟团游", supplierProductCode: "TY", days: 2, nights: 1, meetingCity: "太原", destinationCity: "太原" },
    commercial: {
      packageName: "标准套餐",
      pricing: { currency: "CNY", adult: 599, child: 399, minimumTravelers: 2 },
    },
    itinerary: [],
  }), product.id);

  const loaded = db.getProduct(product.id)!;
  const commercial = loaded.product.commercial as Record<string, unknown>;
  assert.deepEqual(commercial.inventory, defaultCommercialInventory());
  assert.equal(commercial.packageName, "标准套餐");
  assert.deepEqual(commercial.pricing, { currency: "CNY", adult: 599, child: 399, minimumTravelers: 2 });
});

test("新建产品不预置供应商产品编号，运营仍可手工编辑", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-code-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  const basicInfo = product.product.basicInfo as Record<string, unknown>;

  assert.equal(basicInfo.supplierProductCode, "");

  const updated = db.updateBasicInfoField(product.id, "supplierProductCode", "TY-REAL-001");
  assert.equal((updated.product.basicInfo as Record<string, unknown>).supplierProductCode, "TY-REAL-001");
});

test("两个产品壳都不预置供应商产品编号", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-code-unique-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const first = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  const second = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });

  const codeOf = (product: typeof first) => (product.product.basicInfo as Record<string, unknown>).supplierProductCode;
  assert.equal(codeOf(first), "");
  assert.equal(codeOf(second), "");
});

test("产品标题按天数自动换算晚数", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-title-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const product = db.createProduct({ destination: "太原", days: 4, productForm: "privateTour" });

  assert.equal(product.name, "太原4天3晚私家团");
  assert.equal((product.product.basicInfo as { nights: number }).nights, 3);
});

test("一地多日游不因超过五天被误判为需要大交通的境内长途", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-product-seven-day-type-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const product = db.createProduct({ destination: "西安", days: 7, productForm: "privateTour" });

  assert.equal((product.product.sales as { productType: string }).productType, "domesticShort");
});

test("异常创建参数会返回清晰校验提示", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-product-invalid-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);

  assert.throws(
    () => db.createProduct({ destination: { value: "太原" } as unknown as string, days: 2, productForm: "privateTour" }),
    /请填写有效的目的地/,
  );
});

test("运营人员确认核查时会保存人工核查证据", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-research-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  db.addResearchTask(product.id, { label: "核查车辆资源组", type: "vbk", detail: "在 VBK 资源库选择可用资源组" });
  const task = db.getProduct(product.id)!.researchTasks[0];
  db.markResearchAccepted(product.id, task.id, "已核对资源组与供应商编码");
  const confirmed = db.getProduct(product.id)!.researchTasks[0];

  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.evidence?.[0].title, "已核对资源组与供应商编码");
  assert.equal(confirmed.evidence?.[0].source, "user");
});

test("重复返回的同名待核查任务只保留一项", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-research-dedupe-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });

  db.addResearchTask(product.id, { label: "核查车辆资源", type: "vbk", detail: "第一次说明" });
  db.addResearchTask(product.id, { label: "核查车辆资源", type: "vbk", detail: "最新说明" });

  const tasks = db.getProduct(product.id)!.researchTasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].detail, "最新说明");
});

test("历史 POI 待办在详情中合并呈现，且续跑不会再新增同义项", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-poi-task-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  const raw = (db as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): void; get(...values: unknown[]): { count: number } } } }).db;
  const insert = raw.prepare("INSERT INTO research_tasks VALUES(?,?,?,?,?,?,?,?)");
  for (const [index, name] of ["山西博物院", "晋祠", "蒙山大佛"].entries()) {
    insert.run(`legacy-no-match-${index}`, product.id, `待核查景点 ${name} 的 VBK POI`, "vbk", "queued", "researching", "suggestPoi 未匹配，请人工核查", "[]");
    insert.run(`legacy-city-poi-${index}`, product.id, `核查 ${name} 在 VBK 资源库的 city / poi 映射`, "vbk", "queued", "researching", "由目的地「太原」延伸", "[]");
  }
  // 标签相近的门票 / 成本任务不属于严格定义的 POI 映射，必须保留为独立项。
  insert.run("ticket-cost", product.id, "核查 晋祠 门票成本", "cost", "queued", "researching", "待供应商确认", "[]");
  insert.run("ticket-vbk", product.id, "核查 晋祠 在 VBK 资源库的 city / poi 映射（含门票）", "vbk", "queued", "researching", "待人工核查票价", "[]");

  const visible = db.getProduct(product.id)!.researchTasks;
  assert.equal(visible.length, 5, "六条历史 POI 行应合为三项，门票/成本任务保持独立");
  assert.deepEqual(visible.map((task) => task.label).sort(), [
    "核查 山西博物院 的 VBK POI 映射",
    "核查 晋祠 的 VBK POI 映射",
    "核查 蒙山大佛 的 VBK POI 映射",
    "核查 晋祠 门票成本",
    "核查 晋祠 在 VBK 资源库的 city / poi 映射（含门票）",
  ].sort());
  assert.equal(raw.prepare("SELECT count(*) AS count FROM research_tasks WHERE local_product_id=?").get(product.id).count, 8, "历史行必须保留，不能无痕删除");

  db.addResearchTask(product.id, { label: "核查 晋祠 的 VBK POI 映射", type: "vbk", detail: "本轮续跑仍需人工核查" });
  assert.equal(raw.prepare("SELECT count(*) AS count FROM research_tasks WHERE local_product_id=?").get(product.id).count, 8, "canonical label 应识别 legacy 行并避免新增第七行");
  const afterResume = db.getProduct(product.id)!.researchTasks;
  assert.equal(afterResume.length, 5);
  assert.match(afterResume.find((task) => task.label === "核查 晋祠 的 VBK POI 映射")?.detail ?? "", /suggestPoi 未匹配/, "legacy detail 保留为可追溯历史");
});

test("应用重启后会把没有回复的消息标记为可重试失败", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-message-recovery-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  db.addMessage(product.id, "user", "生成第一版方案", "running");

  db.recoverUnansweredMessages();
  const messages = db.getProduct(product.id)!.messages;

  assert.equal(messages.at(-2)?.taskStatus, "failed");
  assert.equal(messages.at(-1)?.role, "assistant");
  assert.equal(messages.at(-1)?.taskStatus, "failed");
  assert.match(messages.at(-1)?.content || "", /没有完成/);
});
