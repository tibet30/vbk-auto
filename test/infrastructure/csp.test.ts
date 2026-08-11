import test from "node:test";
import assert from "node:assert/strict";
import { buildContentSecurityPolicy } from "../../src/main/infrastructure/csp.js";

function findDirective(policy: string, name: string): string {
  const directives = policy
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const match = directives.find((directive) => directive.startsWith(`${name} `));
  if (!match) throw new Error(`CSP 缺少 ${name} 指令：${policy}`);
  return match;
}

test("buildContentSecurityPolicy 的 img-src 必须以 data: 为主，用于手动上传封面 data URL 预览", () => {
  const policy = buildContentSecurityPolicy();
  const imgSrc = findDirective(policy, "img-src");
  const sources = imgSrc.split(/\s+/).slice(1);
  // 关键：cover.read 已经统一返回 data:${mime};base64,... 的预览，CSP 必须放行 data:；
  // 没有 data: 等于 renderer 一旦加载手动上传封面就立即被 CSP 拦截 → 破图。
  assert.ok(
    sources.includes("data:"),
    `img-src 必须包含 data: 以供 cover.read 返回的 data URL 预览，实际为：${imgSrc}`,
  );
  assert.ok(
    sources.includes("https:"),
    `img-src 应保留 https: 以供携程图库候选图像，实际为：${imgSrc}`,
  );
  // 'self' 也要保留（同源静态资源）。
  assert.ok(sources.includes("'self'"), `img-src 必须包含 'self'，实际为：${imgSrc}`);
  // file: 只是兜底（同源生产 file://），但**不能**成为主流；这里只断言它不在
  // script-src / connect-src / object-src 里被滥用。
});

test("buildContentSecurityPolicy 的 script-src 不放宽到 file:", () => {
  const policy = buildContentSecurityPolicy();
  const scriptSrc = findDirective(policy, "script-src");
  const sources = scriptSrc.split(/\s+/).slice(1);
  assert.ok(
    !sources.includes("file:"),
    `script-src 不应包含 file:，实际为：${scriptSrc}`,
  );
});

test("buildContentSecurityPolicy 的 connect-src 不放宽到 file:", () => {
  const policy = buildContentSecurityPolicy();
  const connectSrc = findDirective(policy, "connect-src");
  const sources = connectSrc.split(/\s+/).slice(1);
  assert.ok(
    !sources.includes("file:"),
    `connect-src 不应包含 file:，实际为：${connectSrc}`,
  );
});

test("buildContentSecurityPolicy 的 object-src 仍为 none（防止 file: 被滥用）", () => {
  const policy = buildContentSecurityPolicy();
  const objectSrc = findDirective(policy, "object-src");
  assert.equal(objectSrc, "object-src 'none'");
});