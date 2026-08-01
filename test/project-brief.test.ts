import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../src/main/database.js";

test("最小产品信息创建可审查的通用私家团草稿", async (t) => {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-project-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  const db = new VbkDatabase(dataPath);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });

  assert.equal(project.name, "太原2天1晚私家团");
  assert.deepEqual(project.product.sales, { productType: "domesticShort", productForm: "privateTour", splitGroup: false });
  assert.deepEqual(project.product.basicInfo, {
    supplierProductName: "太原2天1晚私家团", days: 2, nights: 1, meetingCity: "太原", destinationCity: "太原",
  });
  assert.match(project.messages[0].content, /目的地「太原」/);
  assert.match(project.messages[0].content, /请告诉我/);
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
