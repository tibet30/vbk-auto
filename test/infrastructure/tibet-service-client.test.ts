import assert from "node:assert/strict";
import test from "node:test";
import {
  createTibetServiceClient,
  isValidServiceToken,
  TibetServiceAuthError,
  TibetServiceScopeError,
  type TibetServiceClient,
} from "../../src/main/infrastructure/tibet-service-client.js";

const TOKEN = `stk_${"a".repeat(64)}`;

type Call = { url: string; headers: Record<string, string> };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(
  handler: (call: Call) => Response,
  calls: Call[] = [],
): typeof fetch {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    return handler({ url, headers });
  }) as unknown as typeof fetch;
  return fetchImpl;
}

function client(fetchImpl: typeof fetch, token: string = TOKEN): TibetServiceClient {
  return createTibetServiceClient({ baseUrl: "https://example.test", token, fetchImpl });
}

test("服务令牌格式校验：只认 stk_ 前缀且必须有秘密部分", () => {
  assert.equal(isValidServiceToken(TOKEN), true);
  assert.equal(isValidServiceToken("stk_"), false);
  assert.equal(isValidServiceToken("Bearer abc"), false);
  assert.equal(isValidServiceToken(undefined), false);
});

test("自检把服务端令牌事实映射成结构化记录，不携带凭证", async () => {
  const calls: Call[] = [];
  const instance = client(stubFetch(() => jsonResponse({
    code: 200,
    message: "success",
    data: {
      name: "ansike",
      token_prefix: "stk_7d3c74e8",
      permissions: ["read", "create"],
      permission_labels: ["只读", "创建"],
      status: "active",
      status_label: "生效中",
      expires_at: "2027-05-16 21:10:30",
      remaining_days: 180,
      bound_identity: { type: "extension", label: "扩展用户", key: "13800000000" },
      last_used_at: "2026-11-17 21:21:05",
      use_count: 4,
    },
  }), calls));

  const identity = await instance.selfCheck();
  assert.equal(identity.name, "ansike");
  assert.deepEqual(identity.permissions, ["read", "create"]);
  assert.equal(identity.statusLabel, "生效中");
  assert.equal(identity.remainingDays, 180);
  assert.deepEqual(identity.boundIdentity, {
    type: "extension", label: "扩展用户", key: "13800000000", inherited: false,
  });
  assert.equal(identity.boundIdentities.length, 1, "旧版回包只有主身份时也要能解析");
  assert.equal(calls[0].url, "https://example.test/api/open/me");
  assert.equal(calls[0].headers["X-Service-Token"], TOKEN);
});

test("未绑定身份时服务端 403 必须变成明确的权限错误，而不是空数据", async () => {
  const instance = client(stubFetch(() => jsonResponse({
    code: 403,
    message: "该服务令牌未绑定扩展用户身份，不能访问个人数据接口",
    data: null,
  }, 403)));

  await assert.rejects(() => instance.selfCheck(), (error: unknown) => {
    assert.ok(error instanceof TibetServiceScopeError);
    assert.equal(error.code, 403);
    assert.match(error.message, /未绑定扩展用户身份/u);
    return true;
  });
});

test("令牌无效/过期属于认证错误，与权限错误分开", async () => {
  for (const message of ["服务令牌无效", "服务令牌已过期", "服务令牌已被吊销"]) {
    const instance = client(stubFetch(() => jsonResponse({ code: 401, message, data: null }, 401)));
    await assert.rejects(() => instance.selfCheck(), (error: unknown) => {
      assert.ok(error instanceof TibetServiceAuthError, `${message} 应映射为认证错误`);
      assert.match(error.message, new RegExp(message, "u"));
      return true;
    });
  }
});

test("服务目录查询把筛选条件翻译成契约参数，并解析分页", async () => {
  const calls: Call[] = [];
  const instance = client(stubFetch(() => jsonResponse({
    code: 200,
    message: "ok",
    data: {
      items: [
        {
          id: 8,
          public_id: "172708729898149707",
          title: "悉尼蓝山小团观光日游",
          subtitle: "城市出发,当天往返自然景观与小镇",
          country_code: "au",
          city_code: "sydney",
          service_type: "sightseeing",
          duration_label: "约10小时",
          price_from: 760,
          available_label: "固定发团日可询",
          tags: ["小团日游"],
          hot: true,
        },
        { id: 9, public_id: "not-enough-digits", title: "" },
      ],
      total: 41,
      page: 2,
      page_size: 10,
    },
  }), calls));

  const page = await instance.listServices({
    search: "蓝山",
    city: "sydney",
    type: "sightseeing",
    hot: true,
    priceMin: 100,
    priceMax: 900,
    page: 2,
    pageSize: 10,
  });

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/services");
  assert.equal(url.searchParams.get("search"), "蓝山");
  assert.equal(url.searchParams.get("city"), "sydney");
  assert.equal(url.searchParams.get("type"), "sightseeing");
  assert.equal(url.searchParams.get("hot"), "1");
  assert.equal(url.searchParams.get("price_min"), "100");
  assert.equal(url.searchParams.get("price_max"), "900");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("page_size"), "10");

  assert.equal(page.total, 41);
  assert.equal(page.page, 2);
  assert.equal(page.items.length, 1, "缺字段的条目被丢弃，不能伪造成有效服务");
  assert.equal(page.items[0].publicId, "172708729898149707");
  assert.equal(page.items[0].priceFrom, 760);
  assert.equal(page.items[0].hot, true);
});

test("未配置令牌时公共目录仍可读，且不发送凭证头", async () => {
  const calls: Call[] = [];
  const instance = client(stubFetch(() => jsonResponse({
    code: 200,
    message: "ok",
    data: { items: [], total: 0, page: 1, page_size: 20 },
  }), calls), "");

  assert.equal(instance.configured(), false);
  const page = await instance.listServices();
  assert.equal(page.total, 0);
  assert.equal(calls[0].headers["X-Service-Token"], undefined);
  await assert.rejects(() => instance.selfCheck(), TibetServiceAuthError);
});

test("服务详情按 public_id 请求，并解析须知与包含项", async () => {
  const calls: Call[] = [];
  const instance = client(stubFetch(() => jsonResponse({
    code: 200,
    message: "ok",
    data: {
      public_id: "172708729898149707",
      title: "悉尼蓝山小团观光日游",
      highlights: ["蓝山经典观景点"],
      includes: ["当地用车"],
      excludes: ["餐饮"],
      meeting: "按确认方案在市区集合点上车。",
      notice: ["请携带防晒和轻便外套。"],
      cancel_policy: "固定团期确认后取消按供应商规则处理。",
      price_from: 760,
    },
  }), calls));

  const detail = await instance.getService("172708729898149707");
  assert.equal(calls[0].url, "https://example.test/api/services/172708729898149707");
  assert.deepEqual(detail.notices, ["请携带防晒和轻便外套。"]);
  assert.deepEqual(detail.includes, ["当地用车"]);
  assert.equal(detail.meeting, "按确认方案在市区集合点上车。");

  await assert.rejects(() => instance.getService("123"), /public_id 必须是 18 位数字/u);
});

test("服务端返回非 JSON 时给出可定位的协议错误", async () => {
  const instance = client(stubFetch(() => new Response("<html>not found</html>", {
    status: 404,
    headers: { "Content-Type": "text/html" },
  })));
  await assert.rejects(() => instance.selfCheck(), /无法识别的数据.*HTTP 404/u);
});

test("后台服务目录：携带 include_disabled 与排序，并解析上下架字段", async () => {
  const calls: Call[] = [];
  const instance = client(stubFetch(() => jsonResponse({
    code: 200,
    message: "ok",
    data: {
      items: [{
        public_id: "172708729898149707",
        title: "悉尼蓝山小团观光日游",
        price_from: 760,
        is_enabled: false,
        sort_order: 30,
        hot: false,
      }],
      total: 1,
      page: 1,
      page_size: 20,
    },
  }), calls));

  const page = await instance.listAdminServices({ includeDisabled: true, sort: "hot_first", search: "蓝山" });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/admin/services");
  assert.equal(url.searchParams.get("include_disabled"), "1");
  assert.equal(url.searchParams.get("sort"), "hot_first");
  assert.equal(url.searchParams.get("search"), "蓝山");
  assert.equal(page.items[0].enabled, false);
  assert.equal(page.items[0].sortOrder, 30);
});

test("VBK 绑定：解析账号、管家联系人、400 电话与当前使用账号", async () => {
  const calls: Call[] = [];
  const instance = client(stubFetch(() => jsonResponse({
    code: 200,
    message: "success",
    data: {
      items: [{
        vbkAccountKey: "vbk_671205",
        vbkAccountName: "小璐",
        servicePhone: "4000000000",
        providerId: 1279416,
        butler: { contactCardId: 66, displayName: "王管家", providerId: 1279416 },
        lastUsedAt: "2026-11-16 10:00:00",
      }],
      activeVbkAccountKey: "vbk_671205",
    },
  }), calls));

  const snapshot = await instance.listVbkBindings();
  assert.equal(calls[0].url, "https://example.test/api/extension/vbk-bindings");
  assert.equal(snapshot.activeVbkAccountKey, "vbk_671205");
  assert.equal(snapshot.items[0].butler?.displayName, "王管家");
  assert.equal(snapshot.items[0].providerId, 1279416);
});

test("客户订单：按状态筛选，缺字段的条目丢弃；详情按订单号请求", async () => {
  const calls: Call[] = [];
  let payload: unknown = {
    code: 200,
    message: "ok",
    data: [
      {
        id: "223016566171929308",
        orderNo: "223016566171929308",
        serviceTitle: "悉尼蓝山小团观光日游",
        travelDate: "2026-12-01",
        peopleCount: 2,
        totalPrice: 1520,
        status: "paid",
        createdAt: "2026-11-17T10:00:00+08:00",
      },
      { id: "", status: "paid" },
    ],
  };
  const instance = client(stubFetch(() => jsonResponse(payload), calls));

  const orders = await instance.listOrders({ status: "paid" });
  assert.equal(new URL(calls[0].url).searchParams.get("status"), "paid");
  assert.equal(orders.length, 1, "缺订单号的脏数据被丢弃");
  assert.equal(orders[0].totalPrice, 1520);
  assert.equal(orders[0].status, "paid");

  payload = { code: 200, message: "ok", data: { id: "223016566171929308", status: "paid", totalPrice: 1520 } };
  const detail = await instance.getOrder("223016566171929308");
  assert.equal(new URL(calls[1].url).pathname, "/api/user/orders/223016566171929308");
  assert.equal(detail.status, "paid");

  await assert.rejects(() => instance.getOrder("abc"), /订单号必须是数字串/u);
});

test("字典：城市的展示名在 label 字段，也必须能读出来", async () => {
  const instance = client(stubFetch(() => jsonResponse({
    code: 200,
    message: "ok",
    data: {
      city: [
        { code: "guangzhou", label: "广州", type: "city" },
        { code: "chengdu", name: "成都", type: "city" },
        { code: "broken", type: "city" },
      ],
      service_type: [{ code: "private_tour", name: "私家团", type: "service_type" }],
    },
  })));
  const items = await instance.listDictionaries();
  assert.deepEqual(
    items.map((item) => `${item.type}:${item.code}:${item.name}`).sort(),
    ["city:chengdu:成都", "city:guangzhou:广州", "service_type:private_tour:私家团"],
  );
});
