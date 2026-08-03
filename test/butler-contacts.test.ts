import test from "node:test";
import assert from "node:assert/strict";
import { listProviderContactCards } from "../src/main/butler-contacts.js";

/**
 * 模拟 Playwright Page：evaluate 不真正执行回调（回调里会用到浏览器 API，
 * Node 里没有 document / fetch）。直接把预先准备的 payload 当作「接口返回」
 * 透给 listProviderContactCards 内的解码逻辑。
 */
function fakePage(payload: unknown, { throwOnFetch = false }: { throwOnFetch?: boolean } = {}) {
  return {
    async evaluate(_fn: (args: { providerId: number }) => Promise<unknown>, _args: { providerId: number }) {
      if (throwOnFetch) throw new Error("网络失败");
      return payload;
    },
  } as unknown as Parameters<typeof listProviderContactCards>[0];
}

test("从 responseBody.contactCardList 里提取联系人", async () => {
  const payload = {
    responseBody: {
      contactCardList: [
        { contactCardId: 1753732, contactCardName: "张三", mobile: "13800138000" },
        { contactCardId: 1753733, providerContactName: "李四" },
      ],
    },
  };
  const cards = await listProviderContactCards(fakePage(payload), 1279416);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].displayName, "张三");
  assert.equal(cards[0].contactCardId, 1753732);
  assert.equal(cards[0].providerId, 1279416);
  assert.deepEqual(cards[0].extra, { mobile: "13800138000" });
  assert.equal(cards[1].displayName, "李四");
});

test("contactCardList 出现在根对象时也能解码", async () => {
  const payload = { contactCardList: [{ contactCardId: 1, name: "王五" }] };
  const cards = await listProviderContactCards(fakePage(payload), 100);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].contactCardId, 1);
  assert.equal(cards[0].displayName, "王五");
  assert.equal(cards[0].providerId, 100);
});

test("空返回或非对象返回解码为空数组", async () => {
  assert.deepEqual(await listProviderContactCards(fakePage(null), 1), []);
  assert.deepEqual(await listProviderContactCards(fakePage("garbage"), 1), []);
  assert.deepEqual(await listProviderContactCards(fakePage({ responseBody: {} }), 1), []);
});

test("缺 contactCardId 的记录会被丢弃", async () => {
  const payload = {
    contactCardList: [
      { contactCardId: 1, contactCardName: "OK" },
      { contactCardName: "no id" },
      { contactCardId: "abc", contactCardName: "bad id" },
    ],
  };
  const cards = await listProviderContactCards(fakePage(payload), 1);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].displayName, "OK");
});

test("page.evaluate 抛错会原样上抛", async () => {
  await assert.rejects(
    listProviderContactCards(fakePage({}, { throwOnFetch: true }), 1),
    /网络失败/,
  );
});

test("providerId 必须为正整数", async () => {
  await assert.rejects(listProviderContactCards(fakePage({}), 0), /providerId/);
  await assert.rejects(listProviderContactCards(fakePage({}), -1), /providerId/);
  await assert.rejects(listProviderContactCards(fakePage({}), 1.5), /providerId/);
});

test("searchKeyword 会被传到接口 searchKeyWord 字段", async () => {
  let captured: unknown = null;
  const fake = {
    async evaluate(_fn: () => Promise<unknown>, _args: { providerId: number; keyword: string }) {
      // 让真正执行不到的 page.evaluate 接受我们提供的 payload；
      // 同时把 keyword 暴露给测试断言。
      captured = _args.keyword;
      return { responseBody: { contactCardList: [] } };
    },
  };
  await listProviderContactCards(fake as unknown as Parameters<typeof listProviderContactCards>[0], 1, "  张三  ");
  assert.equal(captured, "张三", "关键字应当 trim 后透传");
});