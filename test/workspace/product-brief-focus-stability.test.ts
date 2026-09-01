import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/app/views/products/index.tsx", "utf8");

test("后台任务刷新不应让新建产品表单参与无关重渲染", () => {
  assert.match(source, /const StableProductBriefForm = memo\(ProductBriefForm\)/);
  assert.match(source, /<StableProductBriefForm[\s\S]*onCancel=\{cancelCreation\}[\s\S]*onSubmit=\{submitCreation\}/);
});

test("稳定的提交回调始终调用最新 createProduct，避免提交旧草稿", () => {
  assert.match(source, /const createProductRef = useRef\(createProduct\)/);
  assert.match(source, /createProductRef\.current = createProduct/);
  assert.match(source, /const submitCreation = useCallback\(\(\) => \{[\s\S]*createProductRef\.current\(\)[\s\S]*\}, \[\]\)/);
});

test("中文组合输入期间不把每个拼音字母回写为受控 textarea value", () => {
  const form = readFileSync("src/renderer/app/helpers/components.tsx", "utf8");
  const ideaStart = form.indexOf("<textarea");
  const ideaEnd = form.indexOf("/>", ideaStart);
  const idea = form.slice(ideaStart, ideaEnd);

  assert.match(idea, /defaultValue=\{input\.userIdea \?\? ""\}/);
  assert.doesNotMatch(idea, /\bvalue=\{/);
  assert.match(idea, /onCompositionStart=/);
  assert.match(idea, /onCompositionEnd=/);
  assert.match(idea, /if \(ideaComposingRef\.current\) return;[\s\S]*setIdeaDraft\(userIdea\)/);
});
