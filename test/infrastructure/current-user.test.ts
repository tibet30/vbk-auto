import test from "node:test";
import assert from "node:assert/strict";
import { fetchCurrentUserInfo, normalizeVbkDisplayName } from "../../src/main/infrastructure/current-user.js";

/**
 * 模拟 Playwright Page：page.evaluate 不真的跑回调，直接把预先准备的接口响应
 * 包成与真实集成路径一致的 { __status, __raw, payload } 形态返回。
 * 这样测试覆盖的是 current-user.ts 里真实调用 decode 的完整路径。
 */
function fakePage(payload: unknown, { throwOnFetch = false }: { throwOnFetch?: boolean } = {}) {
  return {
    url: () => "https://vbooking.ctrip.com/fake",
    async evaluate(_fn: () => Promise<unknown>) {
      if (throwOnFetch) throw new Error("网络失败");
      return { status: 200, durationMs: 1, ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false }, payload };
    },
  } as unknown as Parameters<typeof fetchCurrentUserInfo>[0];
}

test("responseBody.userInfo.partyId 是字符串也能识别", async () => {
  const payload = { responseBody: { userInfo: { partyId: "1279416" }, user: { name: "小璐", account: "vbk_671205" } } };
  const info = await fetchCurrentUserInfo(fakePage(payload));
  assert.ok(info, "应当识别出 partyId");
  assert.equal(info?.partyId, 1279416);
  assert.equal(info?.displayName, "小璐");
  assert.equal(info?.loginAccount, "vbk_671205");
});

test("responseBody.currentUser.partyId 也能识别（不同接口版本）", async () => {
  const payload = { responseBody: { currentUser: { partyId: 1279416 } } };
  const info = await fetchCurrentUserInfo(fakePage(payload));
  assert.equal(info?.partyId, 1279416);
});

test("user.name 和 user.account 不依赖 partyId 所在层级", async () => {
  const payload = { responseBody: { data: { currentUser: { partyId: 1279416 } }, user: { name: "小璐", account: "vbk_671205" } } };
  const info = await fetchCurrentUserInfo(fakePage(payload));
  assert.equal(info?.partyId, 1279416);
  assert.equal(info?.displayName, "小璐");
  assert.equal(info?.loginAccount, "vbk_671205");
});

test("user.account 按接口字段原样展示", async () => {
  const payload = { responseBody: { userInfo: { partyId: 1279416 }, user: { name: "小璐", account: "671205" } } };
  const info = await fetchCurrentUserInfo(fakePage(payload));
  assert.equal(info?.displayName, "小璐");
  assert.equal(info?.loginAccount, "671205");
});

test("partyId 直接出现在根对象也能识别", async () => {
  const payload = { partyId: 1279416, userName: "root-level" };
  const info = await fetchCurrentUserInfo(fakePage(payload));
  assert.equal(info?.partyId, 1279416);
  assert.equal(info?.displayName, "root-level");
});

test("响应里完全没有 partyId 时返回 null", async () => {
  const payload = { responseBody: { userInfo: { userName: "no id" } } };
  const info = await fetchCurrentUserInfo(fakePage(payload));
  assert.equal(info, null);
});

test("partyId 不是正整数时返回 null", async () => {
  const payload = { responseBody: { userInfo: { partyId: 0 } } };
  assert.equal(await fetchCurrentUserInfo(fakePage(payload)), null);
  assert.equal(await fetchCurrentUserInfo(fakePage({ responseBody: { userInfo: { partyId: -1 } } })), null);
  assert.equal(await fetchCurrentUserInfo(fakePage({ responseBody: { userInfo: { partyId: "abc" } } })), null);
});

test("响应是字符串或 null 时不抛错", async () => {
  assert.equal(await fetchCurrentUserInfo(fakePage(null)), null);
  assert.equal(await fetchCurrentUserInfo(fakePage("garbage")), null);
});

test("page.evaluate 抛错时向上抛", async () => {
  await assert.rejects(fetchCurrentUserInfo(fakePage({}, { throwOnFetch: true })), /网络失败/);
});

test("partyId 嵌套在 data.currentUser 里也能识别", async () => {
  const payload = { data: { currentUser: { partyId: 1279416, userName: "运营小王" } } };
  const info = await fetchCurrentUserInfo(fakePage(payload));
  assert.equal(info?.partyId, 1279416);
  assert.equal(info?.displayName, "运营小王");
});

test("partyId 嵌套在 result.currentUserInfo 里也能识别", async () => {
  const payload = { result: { currentUserInfo: { partyId: 1279416 } } };
  const info = await fetchCurrentUserInfo(fakePage(payload));
  assert.equal(info?.partyId, 1279416);
});

test("providerId 字段名也能作为 partyId 识别（兼容携程不同接口）", async () => {
  const payload = { responseBody: { userInfo: { providerId: 1279416 } } };
  const info = await fetchCurrentUserInfo(fakePage(payload));
  assert.equal(info?.partyId, 1279416);
});

test("广撒网：partyId 出现在 3 层嵌套也能找到", async () => {
  const payload = { responseBody: { envelope: { header: { partyId: 1279416 } } } };
  const info = await fetchCurrentUserInfo(fakePage(payload));
  assert.equal(info?.partyId, 1279416);
});

test("账号展示名不会退化成 partyId 或 ID 标签", () => {
  assert.equal(normalizeVbkDisplayName("ID：1279416"), "");
  assert.equal(normalizeVbkDisplayName("providerId: 1279416"), "");
  assert.equal(normalizeVbkDisplayName("1279416"), "");
  assert.equal(normalizeVbkDisplayName("vbk_671205"), "vbk_671205");
});
