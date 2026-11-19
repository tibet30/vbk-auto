import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTibetServiceTokenStore,
  isValidTibetServiceToken,
  LOCAL_TIBET_SERVICE_TOKEN_FILE_NAME,
  maskTibetServiceToken,
} from "../../src/main/infrastructure/tibet-service-token-store.js";

const TOKEN = `stk_${"a1".repeat(32)}`;
const OTHER = `stk_${"b2".repeat(32)}`;

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-tibet-token-"));
  return path.join(dir, LOCAL_TIBET_SERVICE_TOKEN_FILE_NAME);
}

test("令牌格式校验：必须 stk_ 前缀且有足够长的秘密部分", () => {
  assert.equal(isValidTibetServiceToken(TOKEN), true);
  assert.equal(isValidTibetServiceToken(`  ${TOKEN}  `), true);
  assert.equal(isValidTibetServiceToken("stk_short"), false);
  assert.equal(isValidTibetServiceToken("Bearer abc"), false);
  assert.equal(isValidTibetServiceToken(undefined), false);
});

test("掩码只保留可识别前缀，秘密部分不出圈", () => {
  const masked = maskTibetServiceToken(TOKEN);
  assert.equal(masked, `${TOKEN.slice(0, 12)}…`);
  assert.equal(masked.includes(TOKEN.slice(12)), false);
});

test("保存后落到 0600 文件，读回与掩码一致，且不残留临时文件", () => {
  const filePath = tempFile();
  const store = createTibetServiceTokenStore(filePath, { env: {} });

  assert.deepEqual(store.state(), { configured: false, source: null, maskedToken: null, savedAt: null });
  assert.equal(store.get(), null);

  const saved = store.save(TOKEN);
  assert.equal(saved.configured, true);
  assert.equal(saved.source, "file");
  assert.equal(saved.maskedToken, `${TOKEN.slice(0, 12)}…`);
  assert.ok(saved.savedAt, "保存时间必须记录");
  assert.equal(store.get(), TOKEN);

  const mode = fs.statSync(filePath).mode & 0o777;
  assert.equal(mode, 0o600, "令牌文件必须仅本人可读写");
  const cramped = {
    mode: fs.statSync(filePath).mode,
    content: fs.readFileSync(filePath, "utf8"),
  };
  assert.equal(cramped.content.includes(TOKEN), true, "文件里存的是完整令牌");
  const leftovers = fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, [], "临时文件必须被 rename 消费掉");
});

test("非法令牌直接拒绝且不落盘", () => {
  const filePath = tempFile();
  const store = createTibetServiceTokenStore(filePath, { env: {} });
  for (const bad of ["", "stk_", "token-xxxx", "Bearer stk_aeae"]) {
    assert.throws(() => store.save(bad), /格式不正确/u);
  }
  assert.equal(fs.existsSync(filePath), false, "校验失败不能留下文件");
  assert.equal(store.state().configured, false);
});

test("覆盖保存会替换旧令牌，清除会删掉文件", () => {
  const filePath = tempFile();
  const store = createTibetServiceTokenStore(filePath, { env: {} });
  store.save(TOKEN);
  store.save(OTHER);
  assert.equal(store.get(), OTHER);

  const cleared = store.clear();
  assert.equal(cleared.configured, false);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(store.get(), null);
});

test("环境变量优先于本地文件，且不写入文件", () => {
  const filePath = tempFile();
  const store = createTibetServiceTokenStore(filePath, { env: { TIBET_SERVICE_TOKEN: OTHER } });
  store.save(TOKEN);

  assert.equal(store.get(), OTHER, "环境变量是临时覆盖，必须优先生效");
  assert.equal(store.state().source, "env");
  assert.equal(store.state().maskedToken, `${OTHER.slice(0, 12)}…`);
  assert.equal(store.state().savedAt, null, "环境变量没有保存时间");
  assert.equal(fs.readFileSync(filePath, "utf8").includes(TOKEN), true, "本地文件内容不受覆盖影响");

  // 覆盖值非法时退回本地文件，不把垃圾当成令牌
  const bogus = createTibetServiceTokenStore(filePath, { env: { TIBET_SERVICE_TOKEN: "not-a-token" } });
  assert.equal(bogus.get(), TOKEN);
  assert.equal(bogus.state().source, "file");
});

test("文件被破坏或版本不符时按未配置处理，不抛异常", () => {
  const filePath = tempFile();
  fs.writeFileSync(filePath, "{ not json", "utf8");
  const broken = createTibetServiceTokenStore(filePath, { env: {} });
  assert.equal(broken.state().configured, false);
  assert.equal(broken.get(), null);

  fs.writeFileSync(filePath, JSON.stringify({ version: 99, token: TOKEN, savedAt: "2026-01-01T00:00:00.000Z" }), "utf8");
  const wrongVersion = createTibetServiceTokenStore(filePath, { env: {} });
  assert.equal(wrongVersion.state().configured, false);
});

test("读取旧令牌后仍能再次保存（缓存与磁盘一致）", () => {
  const filePath = tempFile();
  createTibetServiceTokenStore(filePath, { env: {} }).save(TOKEN);
  const reopened = createTibetServiceTokenStore(filePath, { env: {} });
  assert.equal(reopened.get(), TOKEN);
  assert.equal(reopened.state().source, "file");
  assert.equal(reopened.save(OTHER).configured, true);
  assert.equal(createTibetServiceTokenStore(filePath, { env: {} }).get(), OTHER);
});
