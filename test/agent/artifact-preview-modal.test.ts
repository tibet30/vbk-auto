import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactPreviewModal } from "../../src/renderer/app/views/agent/ArtifactPreviewModal.js";

const noop = () => {};

test("预览浮层用 sandbox iframe 承载，不给脚本与同源权限", () => {
  const html = renderToStaticMarkup(createElement(ArtifactPreviewModal, {
    title: "index.html",
    html: "<html><body>hi</body></html>",
    loading: false,
    onClose: noop,
  }));
  assert.match(html, /role="dialog"/u);
  assert.match(html, /sandbox=""/u, "必须是无特权的 sandbox iframe");
  assert.doesNotMatch(html, /sandbox="allow-scripts"/u);
  assert.doesNotMatch(html, /allow-same-origin/u);
});

test("加载中、错误与截断都有明确文案，缺内容时不渲染 iframe", () => {
  const loading = renderToStaticMarkup(createElement(ArtifactPreviewModal, {
    title: "index.html", loading: true, onClose: noop,
  }));
  assert.match(loading, /正在读取产物/u);
  assert.doesNotMatch(loading, /<iframe/u);

  const error = renderToStaticMarkup(createElement(ArtifactPreviewModal, {
    title: "index.html", loading: false, error: "只有目录型产物（网页工程）支持应用内预览", onClose: noop,
  }));
  assert.match(error, /只有目录型产物/u);
  assert.doesNotMatch(error, /<iframe/u);

  const truncated = renderToStaticMarkup(createElement(ArtifactPreviewModal, {
    title: "index.html", html: "<p>x</p>", loading: false, truncated: true, onClose: noop,
  }));
  assert.match(truncated, /内容过大，已截断显示/u);
});
