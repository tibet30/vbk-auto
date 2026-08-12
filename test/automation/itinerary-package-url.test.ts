// isPackageManageUrl 纯函数单元测试：
//   - 真实 VBK tourdays 页「存为草稿 / 提交审核并下一步」之后 WebContents
//     URL 直接落到
//         https://vbooking.ctrip.com/ivbk/vendor/packageManage?productid=...&from=vbk
//   - 旧契约 `isTargetUrl: () => false` 会让真实跳转被判为「未到达目标」，
//     继续点「下一步」生成 attempt3 噪声。
//   - 新契约：必须 protocol === "https:"、hostname 严格 === "vbooking.ctrip.com"、
//     pathname 严格 === "/ivbk/vendor/packageManage"（不含尾斜杠 / 子路径），
//     query 任意。
//   - 拒绝 packageManageList / baseInfoMerge / 其他 origin / http（非 https）/
//     带端口 / 子域名伪装 / 仅 query 含 packageManage 关键字 / 中文 tab 名
//     兜底 / 非字符串输入 / 解析失败。
//
// 该文件是 isPackageManageUrl 真值表边界的唯一权威来源。状态机级的源码
// 契约锁（fillItineraryDraft 必须把 isTargetUrl 写成 isPackageManageUrl
// 引用，禁止回退到 () => false / baseInfoMerge / 中文 tab 名）见
// test/basic-info-fixes/basic-info-fixes.ctrip-part4.test.ts。
import test from "node:test";
import assert from "node:assert/strict";
import {
  isPackageManageUrl,
  PACKAGE_MANAGE_PATH,
  PACKAGE_MANAGE_HOSTNAME,
  PACKAGE_MANAGE_PROTOCOL,
  PACKAGE_MANAGE_ORIGIN,
} from "../../src/main/automation/ctrip/itinerary/main.js";

test("PACKAGE_MANAGE_* 常量锁：与真实 VBK 跳转目标保持字面一致", () => {
  // 这些常量一旦被改坏，下面所有测试的「正向命中」都会失效，因此单独
  // 锁一层契约，让改动常量也能立刻被本文件抓到。
  assert.strictEqual(PACKAGE_MANAGE_PATH, "/ivbk/vendor/packageManage");
  assert.strictEqual(PACKAGE_MANAGE_HOSTNAME, "vbooking.ctrip.com");
  assert.strictEqual(PACKAGE_MANAGE_PROTOCOL, "https:");
  assert.strictEqual(PACKAGE_MANAGE_ORIGIN, "https://vbooking.ctrip.com");
});

test("正向命中：真实 VBK 跳转目标 URL 必须命中，任意 query 都允许", () => {
  // 1. 产品 ID 76906037、from=vbk 的真实跳转形态（最关键）。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/packageManage?productid=76906037&from=vbk",
    ),
    true,
    "真实 VBK tourdays → 套餐管理 的跳转目标必须被命中",
  );
  // 2. 最小可命中形态：无 query。
  assert.strictEqual(
    isPackageManageUrl("https://vbooking.ctrip.com/ivbk/vendor/packageManage"),
    true,
    "无 query 的最小形态必须命中",
  );
  // 3. 多 query 键（含 fragment 后再挂 query）也命中。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/packageManage?productid=76906037&from=vbk&extra=1",
    ),
    true,
    "任意 query 键值都必须命中",
  );
  // 4. 单 query 键的不同键名也命中（不限定键名）。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/packageManage?id=42",
    ),
    true,
    "其它 query 键名（如 id）也命中",
  );
  // 5. URL-encoded 字符的 query 也命中（query 不参与判定）。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/packageManage?productid=76%20906037",
    ),
    true,
    "URL-encoded query 也命中",
  );
});

test("反向命中 1：相似 / 扩展 pathname 变体一律拒绝", () => {
  // 1. packageManageList：与 packageManage 拼成一个 segment 的相似子路径。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/packageManageList?productid=76906037",
    ),
    false,
    "packageManageList 等相似子路径不得命中",
  );
  // 2. 大小写不同：pathname 区分大小写，必须严格相等。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/PACKAGEMANAGE?productid=76906037",
    ),
    false,
    "大小写不同的 pathname 不得命中",
  );
  // 3. 子路径变体（多一段 segment）也得拒绝。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/packageManage/sub?productid=76906037",
    ),
    false,
    "子路径变体（packageManage/sub）不得命中",
  );
  // 4. 尾斜杠变体：pathname === "/ivbk/vendor/packageManage/" !== PACKAGE_MANAGE_PATH。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/packageManage/?productid=76906037&from=vbk",
    ),
    false,
    "尾斜杠变体不得命中（pathname 严格相等）",
  );
  // 5. 路径前缀出现一次但 pathname 多了一级（不命中）。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/extra/packageManage?productid=76906037",
    ),
    false,
    "pathname 多了一级的变体不得命中",
  );
});

test("反向命中 2：packageManage 仅出现在 query 串时不得命中", () => {
  // 1. 路径里没有同名 segment，但 query 含 ?ref=packageManage。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/?ref=packageManage&productid=76906037",
    ),
    false,
    "packageManage 仅出现在 query 时不得命中（避免 mock / 中间页兜底误中）",
  );
  // 2. 路径只是 /，query 含 packageManage。
  assert.strictEqual(
    isPackageManageUrl("https://vbooking.ctrip.com/?from=packageManage"),
    false,
    "根路径 + query 含 packageManage 关键字时不得命中",
  );
});

test("反向命中 3：其它 origin / 协议 / 端口 / 子域名一律拒绝", () => {
  // 1. 其它 origin：路径再像也不命中。
  assert.strictEqual(
    isPackageManageUrl(
      "https://example.com/ivbk/vendor/packageManage?productid=76906037",
    ),
    false,
    "其它 origin（example.com）不得命中",
  );
  // 2. http（非 https）必须被 protocol 严格匹配拒绝。
  assert.strictEqual(
    isPackageManageUrl(
      "http://vbooking.ctrip.com/ivbk/vendor/packageManage?productid=76906037",
    ),
    false,
    "http 协议不得命中（仅允许 https）",
  );
  // 3. 带端口（默认 443 之外）必须被 hostname 严格匹配拒绝。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com:8080/ivbk/vendor/packageManage?productid=76906037",
    ),
    false,
    "带端口（:8080）的 origin 不得命中",
  );
  // 4. 子域名伪装（booking.ctrip.com 而非 vbooking.ctrip.com）。
  assert.strictEqual(
    isPackageManageUrl(
      "https://booking.ctrip.com/ivbk/vendor/packageManage?productid=76906037",
    ),
    false,
    "子域名伪装（booking.ctrip.com）不得命中",
  );
  // 5. 父域（vbooking.ctrip.com.cn 之类）也得拒绝。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com.cn/ivbk/vendor/packageManage?productid=76906037",
    ),
    false,
    "父域（vbooking.ctrip.com.cn）不得命中",
  );
  // 6. www. 前缀也得拒绝。
  assert.strictEqual(
    isPackageManageUrl(
      "https://www.vbooking.ctrip.com/ivbk/vendor/packageManage?productid=76906037",
    ),
    false,
    "www. 前缀（不是合法 hostname）不得命中",
  );
});

test("反向命中 4：其它 VBK 子路径段（基本信息 / 产品图片）不得命中", () => {
  // 1. 旧 baseInfoMerge 路径段（基本信息页）不得命中。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productId=76906037",
    ),
    false,
    "baseInfoMerge 路径段不得命中（避免 itinerary 阶段 URL 误中基本信息页）",
  );
  // 2. productImageText 路径段不得命中。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/productImageText?productId=76906037",
    ),
    false,
    "productImageText 路径段不得命中（basic-info 阶段的命中条件不能跨阶段复用）",
  );
  // 3. 任意其它 /ivbk/vendor/<x> 路径段都得拒绝。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/orderList?productId=76906037",
    ),
    false,
    "其它 ivbk/vendor 路径段不得命中",
  );
});

test("反向命中 5：用户中文 tab 名 / 关键词被嵌入 pathname / query 也不得命中", () => {
  // 1. 中文 tab 名「套餐管理」出现在 pathname（被 URL 编码）时不得命中。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/ivbk/vendor/%E5%A5%97%E9%A4%90%E7%AE%A1%E7%90%86?productId=76906037",
    ),
    false,
    "中文「套餐管理」tab 名被嵌入 pathname 时不得命中",
  );
  // 2. 「套餐管理」只出现在 query 也不命中。
  assert.strictEqual(
    isPackageManageUrl(
      "https://vbooking.ctrip.com/?tab=%E5%A5%97%E9%A4%90%E7%AE%A1%E7%90%86",
    ),
    false,
    "中文「套餐管理」tab 名只出现在 query 时不得命中",
  );
});

test("反向命中 6：非字符串 / 空串 / 解析失败的输入必须降级为 false，不能抛错", () => {
  // 1. 空串。
  assert.strictEqual(isPackageManageUrl(""), false, "空串必须降级为 false");
  // 2. null。
  assert.strictEqual(
    isPackageManageUrl(null as unknown as string),
    false,
    "null 必须降级为 false",
  );
  // 3. undefined。
  assert.strictEqual(
    isPackageManageUrl(undefined as unknown as string),
    false,
    "undefined 必须降级为 false",
  );
  // 4. 数字。
  assert.strictEqual(
    isPackageManageUrl(123 as unknown as string),
    false,
    "数字必须降级为 false",
  );
  // 5. 对象（防止 `url.includes` 之类未护栏实现抛错）。
  assert.strictEqual(
    isPackageManageUrl({ url: "https://x" } as unknown as string),
    false,
    "对象输入必须降级为 false",
  );
  // 6. 数组。
  assert.strictEqual(
    isPackageManageUrl([] as unknown as string),
    false,
    "数组输入必须降级为 false",
  );
  // 7. 布尔值。
  assert.strictEqual(
    isPackageManageUrl(true as unknown as string),
    false,
    "布尔输入必须降级为 false",
  );
  // 8. 解析失败：纯字符串（不是 URL 形态）。
  assert.strictEqual(
    isPackageManageUrl("not a url"),
    false,
    "非 URL 形态字符串必须降级为 false",
  );
  // 9. 解析失败：连续冒号。
  assert.strictEqual(
    isPackageManageUrl("::::"),
    false,
    "解析失败的字符串必须降级为 false",
  );
  // 10. 解析失败：相对路径。
  assert.strictEqual(
    isPackageManageUrl("/ivbk/vendor/packageManage"),
    false,
    "相对路径必须降级为 false",
  );
});

test("稳定性：同一 URL 多次调用结果一致，无副作用", () => {
  // 防止「缓存第一次结果」之类的反例把后半段 query / 端口变化掩盖掉。
  const url =
    "https://vbooking.ctrip.com/ivbk/vendor/packageManage?productid=76906037&from=vbk";
  for (let i = 0; i < 5; i += 1) {
    assert.strictEqual(isPackageManageUrl(url), true);
  }
  for (let i = 0; i < 5; i += 1) {
    assert.strictEqual(
      isPackageManageUrl("https://example.com/ivbk/vendor/packageManage"),
      false,
    );
  }
});