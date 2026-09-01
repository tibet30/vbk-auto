import test from "node:test";
import assert from "node:assert/strict";
import {
  formatProductFeaturesHtml,
  productFeaturesPlainText,
} from "../../src/main/domain/product/features-rich-text.js";

test("产品特色纯文本自动转换为 UEditor 段落", () => {
  assert.equal(
    formatProductFeaturesHtml("【古建巡礼】游览晋祠\n【私享出行】独立成团"),
    "<p>【古建巡礼】游览晋祠</p><p>【私享出行】独立成团</p>",
  );
});

test("产品特色移除包裹整个内容的双引号，但保留正文引号", () => {
  assert.equal(
    formatProductFeaturesHtml('"<p><strong>在地体验：</strong>感受“春城”生活气息。</p>"'),
    "<p><strong>在地体验：</strong>感受“春城”生活气息。</p>",
  );
  assert.equal(
    formatProductFeaturesHtml("“<p><strong>舒适出行：</strong>专车衔接景点。</p>”"),
    "<p><strong>舒适出行：</strong>专车衔接景点。</p>",
  );
  assert.equal(
    formatProductFeaturesHtml("&quot;<p>保留正文的\"专车\"说明。</p>&quot;"),
    "<p>保留正文的&quot;专车&quot;说明。</p>",
  );
});

test("产品特色保留安全结构并清理属性、链接、图片与脚本", () => {
  const actual = formatProductFeaturesHtml(
    '<p class="hero"><strong>古建巡礼：</strong>游览晋祠<a href="https://x">详情</a></p>' +
    '<img src="x"><script>alert(1)</script><ul><li>专车衔接</li></ul>',
  );
  assert.equal(actual, "<p><strong>古建巡礼：</strong>游览晋祠详情</p><ul><li>专车衔接</li></ul>");
  assert.doesNotMatch(actual, /class=|href=|img|script|alert/);
});

test("产品特色 HTML 可转换为普通输入框与回读比较使用的文本", () => {
  assert.equal(
    productFeaturesPlainText("<p><strong>古建巡礼：</strong>游览晋祠</p><p>专车衔接</p>"),
    "古建巡礼：游览晋祠\n专车衔接",
  );
});
