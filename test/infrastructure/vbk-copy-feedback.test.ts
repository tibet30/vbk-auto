import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { composePlanningSystemPrompt } from "../../src/main/planning/adapters/planning-prompt.js";

test("新非法词和修复预算本地持久化，生成提示只作用于图文", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-copy-feedback-"));
  try {
    const db = new VbkDatabase(directory);
    const entry = { word: "江鲜", module: "presentation" as const, paths: ["recommendations.2.text"], source: "savedescriptioninfo", detail: "Ack=Warning：非法关键词：江鲜" };
    db.recordCopyFeedback(entry);
    db.recordCopyFeedback(entry);
    db.savePresentationCopyRecovery("p", {
      productId: "79231894", inputHash: "original", currentHash: "candidate", rewrites: 2,
      words: ["江鲜"], status: "failed", history: [],
    });
    const reopened = new VbkDatabase(directory);
    assert.deepEqual(reopened.listRejectedPresentationWords(), ["江鲜"]);
    assert.equal(reopened.getPresentationCopyRecovery("p")?.rewrites, 2);
    assert.match(composePlanningSystemPrompt("presentation", reopened.listRejectedPresentationWords()), /江鲜/);
    assert.doesNotMatch(composePlanningSystemPrompt("itinerary", reopened.listRejectedPresentationWords()), /江鲜/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("远端词库缓存持久化并按当前应用账号读取，不反向上传其他账号词库", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-copy-cloud-"));
  try {
    const db = new VbkDatabase(directory);
    let userId = 3;
    db.setExtensionUserIdResolver(() => userId);
    db.recordCopyFeedback({ word: "江鲜", module: "presentation", paths: [], source: "save", detail: "非法关键词" });
    const cloud = { version: "a".repeat(64), rules: [{ key: "other-device", term: "另端反馈词", module: "presentation", source: "platform_feedback", matchKind: "literal", reason: "反馈", alternatives: [], identityProtected: true, enabled: true }] };
    db.setSetting("vbk-copy-rules:3", JSON.stringify(cloud));
    assert.deepEqual(db.listRejectedPresentationWords(), ["江鲜", "另端反馈词"]);
    assert.deepEqual(db.listLocalRejectedPresentationWords(), ["江鲜"]);
    userId = 4;
    assert.deepEqual(db.listRejectedPresentationWords(), ["江鲜"]);
    const reopened = new VbkDatabase(directory);
    reopened.setExtensionUserIdResolver(() => 3);
    assert.deepEqual(reopened.listRejectedPresentationWords(), ["江鲜", "另端反馈词"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
