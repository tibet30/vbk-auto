import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

/**
 * 交接文档是接手者的唯一入口：里面声明的路径、迁移 id、IPC 通道与 Skill 目录
 * 一旦与代码脱节，就会把后来的人带沟里。这里把它们变成可执行的断言。
 */

const root = process.cwd();
const docs = [
  "docs/general-agent-implementation-handoff.md",
  "docs/general-agent-current-implementation.md",
];

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

/** 文档里的工作区清单会用 glob（`**`、`*`、`{a,b}`）；校验到第一个通配符前的目录即可。 */
function globBase(value: string): string {
  const cut = value.search(/[*{]/u);
  if (cut === -1) return value;
  const head = value.slice(0, cut);
  const slash = head.lastIndexOf("/");
  return slash === -1 ? "." : head.slice(0, slash).replace(/\/$/u, "");
}

function uniqueMatches(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))];
}

const sources = docs.map((doc) => ({ doc, text: read(doc) }));

test("文档里引用的本地文档与源码路径都真实存在", () => {
  const missing: string[] = [];
  for (const { doc, text } of sources) {
    const absoluteLinks = uniqueMatches(text, /\]\((\/Users\/[^)#]+)\)/gu);
    for (const link of absoluteLinks) {
      if (!fs.existsSync(link)) missing.push(`${doc} → ${link}`);
    }
    const sourcePaths = uniqueMatches(text, /`(src\/[^`\s]+)`/gu);
    for (const relative of sourcePaths) {
      if (!fs.existsSync(path.join(root, globBase(relative)))) missing.push(`${doc} → ${relative}`);
    }
  }
  assert.deepEqual(missing, [], `文档引用了不存在的路径：\n${missing.join("\n")}`);
});

test("文档声明的迁移 id 都能在代码里找到", () => {
  const partsDir = path.join(root, "src/main/infrastructure/database/parts");
  const migrationSource = fs.readdirSync(partsDir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => read(path.join("src/main/infrastructure/database/parts", file)))
    .join("\n");
  const missing: string[] = [];
  for (const { doc, text } of sources) {
    for (const id of uniqueMatches(text, /\b(\d{4}_[a-z0-9_]+)\b/gu)) {
      if (!migrationSource.includes(`id: "${id}"`)) missing.push(`${doc} → ${id}`);
    }
  }
  assert.deepEqual(missing, [], `文档声明了代码里没有的迁移：\n${missing.join("\n")}`);
});

test("文档声明的 IPC 通道都已注册且在 preload 里绑定", () => {
  const registrar = read("src/main/ipc/agent-workspace-ipc.ts");
  const preload = read("src/main/preload.cts");
  const missing: string[] = [];
  for (const { doc, text } of sources) {
    for (const channel of uniqueMatches(text, /\b(agentWorkspace:[A-Za-z]+)\b/gu)) {
      if (!registrar.includes(`"${channel}"`)) missing.push(`${doc} → ${channel}（未注册）`);
      if (!preload.includes(`"${channel}"`)) missing.push(`${doc} → ${channel}（preload 未绑定）`);
    }
  }
  assert.deepEqual(missing, [], `文档提到的通道与实现不一致：\n${missing.join("\n")}`);
});

test("文档列出的 Skill 目录都存在于 agent-runtime/skills", () => {
  const skillsDir = path.join(root, "src/main/agent-runtime/skills");
  const present = fs.readdirSync(skillsDir);
  const missing: string[] = [];
  for (const { doc, text } of sources) {
    for (const name of uniqueMatches(text, /`?skills\/([a-z-]+)\//gu)) {
      if (!present.includes(name)) missing.push(`${doc} → skills/${name}/`);
    }
  }
  assert.deepEqual(missing, [], `文档列了不存在的 Skill 目录：\n${missing.join("\n")}`);
});
