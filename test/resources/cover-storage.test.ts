import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MANUAL_UPLOAD_MAX_BYTES,
  MANUAL_UPLOAD_MIME_TYPES,
  pickManualCoverMime,
  readManualCoverDataUrl,
  releaseManualCoverFile,
  retainManualCoverFile,
  storeManualCoverFile,
} from "../../src/main/infrastructure/database/parts/cover-storage.js";

function makeDataPath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vbk-cover-test-"));
}

test("storeManualCoverFile：白名单 mime + 合法 size 返回 meta 并落盘", () => {
  const dataPath = makeDataPath();
  try {
    const bytes = Buffer.from("fake-jpeg-bytes");
    const meta = storeManualCoverFile({
      dataPath,
      originalName: "demo.jpg",
      mimeType: "image/jpeg",
      bytes,
    });
    assert.equal(meta.originalName, "demo.jpg");
    assert.equal(meta.sizeBytes, bytes.length);
    assert.equal(meta.mimeType, "image/jpeg");
    // 落盘文件存在
    const ext = path.extname(meta.originalName);
    const coverPath = path.join(dataPath, "covers", meta.fileId.slice(0, 2), `${meta.fileId}${ext || ".jpg"}`);
    assert.ok(fs.existsSync(coverPath));
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("storeManualCoverFile：拒绝非白名单 mime", () => {
  const dataPath = makeDataPath();
  try {
    assert.throws(() => storeManualCoverFile({
      dataPath,
      originalName: "demo.gif",
      mimeType: "image/gif",
      bytes: Buffer.from("xxx"),
    }), /不支持|image\/jpeg|image\/png|image\/webp/);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("storeManualCoverFile：拒绝超大文件", () => {
  const dataPath = makeDataPath();
  try {
    const tooLarge = Buffer.alloc(MANUAL_UPLOAD_MAX_BYTES + 1, 0);
    assert.throws(() => storeManualCoverFile({
      dataPath,
      originalName: "demo.png",
      mimeType: "image/png",
      bytes: tooLarge,
    }), /上限/);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("storeManualCoverFile：拒绝空文件 / 缺文件名", () => {
  const dataPath = makeDataPath();
  try {
    assert.throws(() => storeManualCoverFile({
      dataPath,
      originalName: "demo.jpg",
      mimeType: "image/jpeg",
      bytes: Buffer.alloc(0),
    }), /空/);
    assert.throws(() => storeManualCoverFile({
      dataPath,
      originalName: " ",
      mimeType: "image/jpeg",
      bytes: Buffer.from("x"),
    }), /文件名/);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("retainManualCoverFile + releaseManualCoverFile 引用计数与文件清理", () => {
  const dataPath = makeDataPath();
  try {
    const meta = storeManualCoverFile({
      dataPath,
      originalName: "demo.png",
      mimeType: "image/png",
      bytes: Buffer.from("hello"),
    });
    const ext = path.extname(meta.originalName);
    const coverPath = path.join(dataPath, "covers", meta.fileId.slice(0, 2), `${meta.fileId}${ext}`);
    // retain 后文件存在
    retainManualCoverFile({ dataPath, fileId: meta.fileId });
    assert.ok(fs.existsSync(coverPath));
    // 再次 retain 不抛错
    retainManualCoverFile({ dataPath, fileId: meta.fileId });
    // release 两次清零 + 删除文件
    releaseManualCoverFile({ dataPath, fileId: meta.fileId });
    releaseManualCoverFile({ dataPath, fileId: meta.fileId });
    assert.ok(!fs.existsSync(coverPath));
    // release 已清理的 fileId 不抛错（幂等）
    releaseManualCoverFile({ dataPath, fileId: meta.fileId });
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("retainManualCoverFile 在 fileId 不存在时抛错", () => {
  const dataPath = makeDataPath();
  try {
    assert.throws(() => retainManualCoverFile({ dataPath, fileId: "missing-file-id" }), /已被清理/);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("MANUAL_UPLOAD_MIME_TYPES 与 cover schema 字面量保持一致", () => {
  // schema 中 manualUploadCover.mimeType 用的是同一组字面量；这里锁住顺序，
  // 防止 main 与 schema 漂移。
  assert.deepEqual([...MANUAL_UPLOAD_MIME_TYPES], ["image/jpeg", "image/png", "image/webp"]);
});

test("readManualCoverDataUrl：合法文件返回 data:image/<mime>;base64,...", async () => {
  const dataPath = makeDataPath();
  try {
    const bytes = Buffer.from("fake-jpeg-bytes-for-data-url");
    const meta = storeManualCoverFile({
      dataPath,
      originalName: "demo.jpg",
      mimeType: "image/jpeg",
      bytes,
    });
    const result = await readManualCoverDataUrl({
      dataPath,
      fileId: meta.fileId,
      originalName: meta.originalName,
    });
    // 关键：必须是 data URL，绝不是 file:// 路径。
    assert.ok(result.url, "data URL 不能为 null");
    assert.match(result.url!, /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/);
    assert.doesNotMatch(result.url!, /^file:/);
    // 元数据保持原样。
    assert.equal(result.mimeType, "image/jpeg");
    assert.equal(result.sizeBytes, bytes.length);
    assert.equal(result.uploadedAt, meta.uploadedAt);
    assert.equal(result.originalName, "demo.jpg");
    // base64 解码后正好等于原始字节。
    const prefix = "data:image/jpeg;base64,";
    const decoded = Buffer.from(result.url!.slice(prefix.length), "base64");
    assert.ok(bytes.equals(decoded));
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("readManualCoverDataUrl：文件丢失时返回 url=null 但保留持久化 meta", async () => {
  const dataPath = makeDataPath();
  try {
    const bytes = Buffer.from("fake-jpeg-bytes");
    const meta = storeManualCoverFile({
      dataPath,
      originalName: "demo.jpg",
      mimeType: "image/jpeg",
      bytes,
    });
    // 模拟「图片已失效」：把落盘文件清掉但保留 meta。
    const bucket = path.join(dataPath, "covers", meta.fileId.slice(0, 2));
    for (const file of fs.readdirSync(bucket)) {
      if (file.startsWith(meta.fileId)) fs.rmSync(path.join(bucket, file));
    }
    const result = await readManualCoverDataUrl({
      dataPath,
      fileId: meta.fileId,
      originalName: meta.originalName,
    });
    assert.equal(result.url, null, "文件丢失时 url 必须为 null");
    // meta 仍能返回，UI 走「图片已失效」分支。
    assert.equal(result.mimeType, "image/jpeg");
    assert.equal(result.sizeBytes, bytes.length);
    assert.equal(result.uploadedAt, meta.uploadedAt);
    assert.equal(result.originalName, "demo.jpg");
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("readManualCoverDataUrl：fileId 完全不存在（无 meta）时全字段 null", async () => {
  const dataPath = makeDataPath();
  try {
    const result = await readManualCoverDataUrl({
      dataPath,
      fileId: "00000000-0000-0000-0000-000000000000",
      originalName: "nope.jpg",
    });
    assert.deepEqual(result, {
      url: null,
      mimeType: null,
      sizeBytes: null,
      uploadedAt: null,
      originalName: null,
    });
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("readManualCoverDataUrl：mime 缺失 / 非白名单时按扩展名 fallback", async () => {
  const dataPath = makeDataPath();
  try {
    const bytes = Buffer.from("fake-png-bytes");
    // 写入时仍用合法 mime，但调用方把 meta.mimeType 视为缺失 → 走扩展名兜底
    // 不易直接构造，这里改为直接覆盖 meta.json 让 mimeType 变成非法值。
    const meta = storeManualCoverFile({
      dataPath,
      originalName: "demo.png",
      mimeType: "image/png",
      bytes,
    });
    const metaPath = path.join(dataPath, "covers", "cover-meta.json");
    const records = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    records[meta.fileId].mimeType = "image/gif"; // 非白名单 → 走扩展名兜底
    fs.writeFileSync(metaPath, JSON.stringify(records, null, 2));
    const result = await readManualCoverDataUrl({
      dataPath,
      fileId: meta.fileId,
      originalName: meta.originalName,
    });
    assert.match(result.url!, /^data:image\/png;base64,/, "扩展名 .png 兜底到 image/png");
    assert.equal(result.sizeBytes, bytes.length);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("pickManualCoverMime：meta 优先 → 扩展名兜底 → image/jpeg", () => {
  // meta 优先
  assert.equal(pickManualCoverMime("image/png", "demo.jpg"), "image/png");
  assert.equal(pickManualCoverMime("image/webp", "demo.jpg"), "image/webp");
  // meta 缺失 → 扩展名
  assert.equal(pickManualCoverMime(null, "a.png"), "image/png");
  assert.equal(pickManualCoverMime(null, "b.WEBP"), "image/webp");
  assert.equal(pickManualCoverMime(null, "c.jpeg"), "image/jpeg");
  assert.equal(pickManualCoverMime(null, "d.jpg"), "image/jpeg");
  // meta 是非白名单 mime → 不使用 meta，按扩展名
  assert.equal(pickManualCoverMime("image/gif", "x.png"), "image/png");
  // 都识别不到 → image/jpeg 兜底
  assert.equal(pickManualCoverMime(null, "novideo.txt"), "image/jpeg");
});