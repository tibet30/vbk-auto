import React from "react";
import { ArrowUp, FolderOpen, Paperclip, WandSparkles } from "lucide-react";
import { useState } from "react";
import type { AgentCapabilities } from "../../../../shared/contracts-agent-runtime.js";
import type { AppModel } from "../../app.main.model";
import styles from "./workspace.module.less";

/**
 * 推荐入口必须与真实安装的 Skill 对应：**没有对应 Skill 的入口显示"尚未接入"并禁用**，
 * 不让界面替还不存在的后台能力承诺可用。
 */
const STARTERS: Array<{ label: string; prompt: string; skill?: string }> = [
  { label: "规划旅游产品", prompt: "帮我规划一个旅游产品，先问我缺哪些信息", skill: "product-read" },
  { label: "制作 PPT", prompt: "做一份汇报 PPT，先给我大纲再生成", skill: "deck" },
  { label: "制作网页", prompt: "做一个静态网页，先给我内容结构", skill: "web" },
  { label: "整理文件", prompt: "整理工作目录里的文件，写操作先问我", skill: "local-file" },
  { label: "查我的订单", prompt: "用三人同游平台查一下我的客户订单，按状态和金额列出来", skill: "tibet" },
  { label: "查 VBK 绑定", prompt: "查一下三人同游平台里保存的 VBK 账号绑定，标出当前用的是哪个", skill: "tibet" },
  { label: "操作后台", prompt: "登录 VBK 后台处理任务" },
];

interface AgentHomeProps {
  model: AppModel;
  busy: boolean;
  capabilities?: AgentCapabilities;
  onStart(prompt: string): void;
}

function starterState(starter: { skill?: string }, capabilities?: AgentCapabilities): "ready" | "missing" | "loading" {
  if (!capabilities) return "loading";
  if (!starter.skill) return "missing";
  return capabilities.skills.some((skill) => skill.id === starter.skill) ? "ready" : "missing";
}

export function AgentHome({ model, busy, capabilities, onStart }: AgentHomeProps) {
  const [prompt, setPrompt] = useState("");
  const submit = () => {
    const value = prompt.trim();
    if (!value || busy) return;
    onStart(value);
  };
  return (
    <section className={styles.home} aria-labelledby="agent-home-title">
      <div className={styles.homeInner}>
        <p className={styles.kicker}>三人同游智能体</p>
        <h1 id="agent-home-title">今天想完成什么？</h1>
        <div className={styles.composer} data-busy={busy || undefined}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
            }}
            placeholder="描述目标。可以先创建任务，再为它选择文件夹或关联产品。"
            aria-label="新任务内容"
          />
          <div className={styles.composerTools}>
            <button type="button" disabled title="创建任务后可添加附件"><Paperclip size={15} />附件</button>
            <button type="button" disabled title="创建任务后可选择工作目录"><FolderOpen size={15} />工作目录</button>
            <span><WandSparkles size={14} />自动选择 Skill</span>
            <button type="button" className={styles.send} onClick={submit} disabled={!prompt.trim() || busy} aria-label="开始任务">
              <ArrowUp size={16} />
            </button>
          </div>
        </div>
        <p className={styles.sectionLabel}>推荐开始</p>
        <div className={styles.starters}>
          {STARTERS.map((starter) => {
            const state = starterState(starter, capabilities);
            return (
              <button
                type="button"
                key={starter.label}
                data-state={state}
                disabled={state !== "ready"}
                title={state === "missing" ? (starter.skill ? "对应 Skill 未安装" : "该能力尚未接入") : undefined}
                onClick={() => setPrompt(starter.prompt)}
              >
                {starter.label}
                {state === "missing" && <span className={styles.starterTag}>{starter.skill ? "未安装" : "尚未接入"}</span>}
              </button>
            );
          })}
        </div>
        <nav className={styles.quick} aria-label="快速跳转">
          <strong>快速跳转</strong>
          <button type="button" onClick={model.startCreateProduct}>新建产品</button>
          <button type="button" onClick={model.openProductList}>产品列表</button>
          <button type="button" onClick={model.openLogin}>登录后台</button>
          <button type="button" onClick={() => model.setView("tasks")}>自动化运行</button>
          <button type="button" onClick={() => model.setView("settings")}>设置</button>
        </nav>
      </div>
    </section>
  );
}

