/**
 * cover-ipc 静态 / 行为断言：
 *   - cover:read IPC 不再返回 file:// URL；
 *   - readManualCoverDataUrl 是无副作用的纯函数：拿到本地副本 → 读字节 →
 *     编码成 data:${mime};base64,...；
 *   - 文件丢失时 url=null + 持久化 meta（如果有）；
 *   - 不会写 product JSON / 任何持久层（断言「读取」对外只返回 url + meta 形状）；
 *   - cover:searchCtripLibrary 走 ctrip-library-search 的
 *     suggestPoi → searchImage → getImageInfo 直接链路，不再依赖
 *     「从图库资源导入」弹窗 / importpic-modal / DOM candidates。
 *
 * 这里**避开**直接调 IPC handler：handler 依赖 electron 的 IpcMainInvokeEvent 与
 * assertTrustedSender，要跑就要构造 fake webContents，没必要的复杂度；
 * 改成直接测试 readManualCoverDataUrl 与 IPC 源码里的关键字符串断言，行为同样
 * 稳健、可读。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  readManualCoverDataUrl,
  pickManualCoverMime,
  storeManualCoverFile,
} from "../../src/main/infrastructure/database/parts/cover-storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function makeDataPath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vbk-cover-ipc-test-"));
}

function makeMinimalJpeg(): Buffer {
  // 1x1 JPEG 最简字节（base64 形式）。解码后能在 fs.readFile 上正常读取。
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYjomJvygNFLxwc4gvLys7Mj00SXF1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
    "base64",
  );
}

function makeMinimalPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=",
    "base64",
  );
}

test("readManualCoverDataUrl：合法文件返回 data: URL（而非 file://）", () => {
  const dataPath = makeDataPath();
  try {
    const bytes = makeMinimalJpeg();
    const meta = storeManualCoverFile({
      dataPath,
      originalName: "demo.jpg",
      mimeType: "image/jpeg",
      bytes,
    });
    return readManualCoverDataUrl({
      dataPath,
      fileId: meta.fileId,
      originalName: meta.originalName,
    }).then((result) => {
      assert.ok(result.url, "data URL 不能为 null");
      assert.match(result.url!, /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/);
      // 关键：绝不能是 file://（这是迁移目标）。
      assert.doesNotMatch(result.url!, /^file:/);
      // 元数据必须保留。
      assert.equal(result.mimeType, "image/jpeg");
      assert.equal(result.sizeBytes, bytes.length);
      assert.equal(result.uploadedAt, meta.uploadedAt);
      assert.equal(result.originalName, "demo.jpg");
    });
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("readManualCoverDataUrl：PNG 文件以 image/png 返回 data URL", () => {
  const dataPath = makeDataPath();
  try {
    const bytes = makeMinimalPng();
    const meta = storeManualCoverFile({
      dataPath,
      originalName: "demo.png",
      mimeType: "image/png",
      bytes,
    });
    return readManualCoverDataUrl({
      dataPath,
      fileId: meta.fileId,
      originalName: meta.originalName,
    }).then((result) => {
      assert.match(result.url!, /^data:image\/png;base64,/);
      assert.doesNotMatch(result.url!, /^file:/);
      assert.equal(result.mimeType, "image/png");
    });
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("readManualCoverDataUrl：文件丢失时 url=null 但保留 meta", () => {
  const dataPath = makeDataPath();
  try {
    const bytes = makeMinimalJpeg();
    const meta = storeManualCoverFile({
      dataPath,
      originalName: "demo.jpg",
      mimeType: "image/jpeg",
      bytes,
    });
    // 删除落盘文件，模拟「图片已失效」。
    const dir = path.join(dataPath, "covers", meta.fileId.slice(0, 2));
    for (const file of fs.readdirSync(dir)) {
      if (file.startsWith(meta.fileId)) fs.rmSync(path.join(dir, file));
    }
    return readManualCoverDataUrl({
      dataPath,
      fileId: meta.fileId,
      originalName: meta.originalName,
    }).then((result) => {
      assert.equal(result.url, null);
      assert.equal(result.mimeType, "image/jpeg");
      assert.equal(result.sizeBytes, bytes.length);
      assert.equal(result.originalName, "demo.jpg");
      assert.equal(result.uploadedAt, meta.uploadedAt);
    });
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("readManualCoverDataUrl：fileId 完全不存在（无 meta）时全字段 null", () => {
  const dataPath = makeDataPath();
  try {
    return readManualCoverDataUrl({
      dataPath,
      fileId: "00000000-0000-0000-0000-000000000000",
      originalName: "nope.jpg",
    }).then((result) => {
      assert.deepEqual(result, {
        url: null,
        mimeType: null,
        sizeBytes: null,
        uploadedAt: null,
        originalName: null,
      });
    });
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("readManualCoverDataUrl：返回的 base64 解码后正好等于原始字节", () => {
  const dataPath = makeDataPath();
  try {
    const bytes = makeMinimalJpeg();
    const meta = storeManualCoverFile({
      dataPath,
      originalName: "demo.jpg",
      mimeType: "image/jpeg",
      bytes,
    });
    return readManualCoverDataUrl({
      dataPath,
      fileId: meta.fileId,
      originalName: meta.originalName,
    }).then((result) => {
      assert.ok(result.url);
      const prefix = "data:image/jpeg;base64,";
      assert.ok(result.url!.startsWith(prefix));
      const decoded = Buffer.from(result.url!.slice(prefix.length), "base64");
      assert.ok(bytes.equals(decoded), "data URL 内嵌的 base64 必须能还原成原字节");
    });
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("pickManualCoverMime：meta 优先，缺失 / 非白名单时按扩展名拼兜底", () => {
  // meta 优先
  assert.equal(pickManualCoverMime("image/png", "demo.jpg"), "image/png");
  assert.equal(pickManualCoverMime("image/webp", "demo.jpg"), "image/webp");
  // meta 缺失 → 按扩展名
  assert.equal(pickManualCoverMime(null, "a.png"), "image/png");
  assert.equal(pickManualCoverMime(null, "b.WEBP"), "image/webp");
  assert.equal(pickManualCoverMime(null, "c.jpeg"), "image/jpeg");
  assert.equal(pickManualCoverMime(null, "d.jpg"), "image/jpeg");
  // meta 是非白名单 mime → 不使用 meta，按扩展名
  assert.equal(pickManualCoverMime("image/gif", "x.png"), "image/png");
  // 都识别不到 → image/jpeg 兑底
  assert.equal(pickManualCoverMime(null, "novideo.txt"), "image/jpeg");
});

test("cover-ipc.ts 源码不再 import 任何 file:// URL 工具", () => {
  const coverIpcPath = resolve(__dirname, "../../src/main/operations/cover-ipc.ts");
  const source = readFileSync(coverIpcPath, "utf8");
  assert.doesNotMatch(source, /pathToFileURL/);
  assert.doesNotMatch(source, /from\s+["']node:url["']/);
});

test("cover-ipc.ts 的 cover:read handler 注释已不再声称「file:// / file 路径」", () => {
  const coverIpcPath = resolve(__dirname, "../../src/main/operations/cover-ipc.ts");
  const source = readFileSync(coverIpcPath, "utf8");
  // 只剔除真正用于 handler 行为描述的旧措辞；保留「file: / file:// origin 同源」
  // 这种与 img CSP 同源策略相关的措辞是允许的，因为 CSP 仍保留 file: 以兼容旧调用。
  assert.doesNotMatch(source, /file:\s*\/\/\s*供\s*<img/);
  assert.doesNotMatch(source, /直接返回\s*file:\/\/\s*协议\s*URL/);
  assert.doesNotMatch(source, /返回\s*file:\/\/\s*URL\s*或\s*null/);
  // 新行为（data URL）必须在 header 注释里出现。
  assert.match(source, /data:\s*\$\{mime\};base64,/);
  assert.match(source, /不再.*file:\/\/|返回\s*data\s*URL/);
});

test("readManualCover IPC handler 已经不再导出 readManualCoverPath（避免误用 file:// API）", () => {
  const coverIpcPath = resolve(__dirname, "../../src/main/operations/cover-ipc.ts");
  const source = readFileSync(coverIpcPath, "utf8");
  assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+readManualCoverPath\b/);
  assert.match(source, /export\s+(?:async\s+)?function\s+readManualCover\b/);
});

/**
 * cover:* 两条 handler（places / images）必须分别把 console 桥接
 * logger 注入到对应的 searchCtripLibrary* 调用点，并且使用独立的前缀常量
 * （COVER_SEARCH_LOG_PREFIX_PLACES / IMAGES）便于在日志里区分调用路径。
 * 之前 logger helpers 被 import 了但调用点直接走「无 logger 选项」分支，等于
 * 「日志模块写了、调用点没接」，主进程 console.warn 看不到任何 Ctrip 图库检索
 * 事件。这里用源码字符串守住接线，避免后续 refactor 把 logger 又退回 silent。
 */
test("cover:searchCtripLibrary* 两条 handler 都把 console logger 注入到对应 searchCtripLibrary* 调用点", () => {
  const coverIpcPath = resolve(__dirname, "../../src/main/operations/cover-ipc.ts");
  const source = readFileSync(coverIpcPath, "utf8");
  // 阶段 A：places handler → PLACES 前缀 + searchCtripLibraryPlaces 调用
  assert.match(
    source,
    /createConsoleCoverPlaceLogger\(\s*\{\s*prefix:\s*COVER_SEARCH_LOG_PREFIX_PLACES\s*\}\s*\)/,
  );
  assert.match(
    source,
    /searchCtripLibraryPlaces\(\s*browser\s*,\s*keyword\s*,\s*\{\s*logger:\s*searchLogger\s*\}\s*\)/,
  );
  // 阶段 B：images handler → IMAGES 前缀 + searchCtripLibraryImagesForPlace 调用
  assert.match(
    source,
    /createConsoleCoverPlaceLogger\(\s*\{\s*prefix:\s*COVER_SEARCH_LOG_PREFIX_IMAGES\s*\}\s*\)/,
  );
  // searchCtripLibraryImagesForPlace 调用点需要带上 logger 选项。
  assert.match(
    source,
    /searchCtripLibraryImagesForPlace\(\s*browser\s*,\s*\{\s*keyword\s*,\s*place:/,
  );
  assert.match(
    source,
    /searchCtripLibraryImagesForPlace\([\s\S]*?\{\s*logger:\s*searchLogger\s*\}/,
  );
});

/**
 * cover:searchCtripLibrary 链路必须：
 *  - 不再 import 旧 DOM 实现 / cover-place-search（旧 POI 并行搜索链路）；
 *  - 走 ctrip-library-search 的两阶段函数 searchCtripLibraryPlaces +
 *    searchCtripLibraryImagesForPlace（阶段 A / B），旧链路仍保留为兼容
 *    wrapper；
 *  - 旧链路 / DOM 相关字符串（从图库资源导入 / importpic-modal /
 *    CANDIDATE_CARD_SELECTOR / searchCoverPlaceCandidates 等）全部清除。
 */
test("cover:searchCtripLibrary* 源码已切到直接 BrowserView fetch 两阶段链路", () => {
  const coverIpcPath = resolve(__dirname, "../../src/main/operations/cover-ipc.ts");
  const source = readFileSync(coverIpcPath, "utf8");
  // 必须 import 新模块 + 两个阶段函数
  assert.match(source, /from\s+["']\.\.\/infrastructure\/ctrip-library-search\.js["']/);
  assert.match(source, /searchCtripLibraryPlaces/);
  assert.match(source, /searchCtripLibraryImagesForPlace/);
  // 不允许再 import cover-place-search / 旧 DOM 实现
  assert.doesNotMatch(source, /from\s+["']\.\.\/infrastructure\/cover-place-search\.js["']/);
  assert.doesNotMatch(source, /searchCoverPlaceCandidates/);
  assert.doesNotMatch(source, /fetchCtripImageInfoMap/);
  // 不允许出现旧链路 / DOM 相关字符串
  for (const banned of ["从图库资源导入", "importpic-modal", "importpic_modal", "CANDIDATE_CARD_SELECTOR"]) {
    assert.doesNotMatch(source, new RegExp(banned), `cover-ipc 不应再出现 ${banned}`);
  }
});
