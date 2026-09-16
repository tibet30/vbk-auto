import type { AppUpdateErrorCode, AppUpdateState } from "../../../shared/contracts";

/** 更新状态在界面上的色调，决定圆点/角标/图标的取色。 */
export type UpdateTone = "idle" | "busy" | "ready" | "error" | "muted";

export type UpdatePrimaryAction = "check" | "download" | "open_installer" | null;

export interface UpdatePresentation {
  tone: UpdateTone;
  /** 角标文案，例如「可更新」「检查失败」。 */
  badge: string;
  /** 状态栏与卡片的主标题。 */
  headline: string;
  /** 一句话说明，回答「现在什么情况」。 */
  summary: string;
  /** 弹窗里的操作步骤，回答「接下来要怎么做」。 */
  steps: string[];
  /** 失败时的修复建议。 */
  advice?: string;
  /** 折叠区里的原因分类。 */
  reason?: string;
  primaryAction: UpdatePrimaryAction;
  /** 下载进度；非下载态为 undefined。 */
  progress?: number;
  /** 是否值得在状态栏上显示角标，吸引用户注意。 */
  attention: boolean;
}

const ERROR_CODES: Record<AppUpdateErrorCode, { reason: string; advice: string }> = {
  unsupported: {
    reason: "运行环境不支持",
    advice: "只有打包后的 macOS 或 Windows 安装版能检查更新：开发模式（未打包）会在应用目录里找不到更新产物。请用安装版验证。",
  },
  feed_missing: {
    reason: "更新源缺少更新文件",
    advice: "服务器上还没有当前平台的更新清单与安装包。如果你是发布方，请先上传更新文件再回来检查。",
  },
  feed_unreachable: {
    reason: "更新源不可达",
    advice: "请确认本机网络或代理可以访问更新源，然后重新检查。",
  },
  manifest_invalid: {
    reason: "更新清单异常",
    advice: "更新清单缺少有效版本号，请让维护人员重新上传更新清单。",
  },
  installer_missing: {
    reason: "清单里没有安装包",
    advice: "更新清单与安装包不一致，请让维护人员重新打包并上传。",
  },
  download_failed: {
    reason: "安装包下载失败",
    advice: "下载过程被中断，请检查网络后重新下载。",
  },
  unknown: {
    reason: "未归类的失败",
    advice: "请稍后重试；若持续失败，请把下方诊断信息发给维护人员。",
  },
};

const DOWNLOAD_STEPS = [
  "点击「下载新版」，安装包会保存到「下载」文件夹。",
  "下载完成后点击「打开安装包」。",
  "按安装包提示覆盖旧版本，再重新打开应用。",
];

const INSTALL_STEPS = [
  "点击「打开安装包」启动安装程序。",
  "按安装包提示覆盖旧版本。",
  "重新打开应用，在设置里确认版本号已经更新。",
];

export function presentUpdate(state: AppUpdateState | null, loading = false): UpdatePresentation {
  if (!state) {
    return loading
      ? base("busy", "读取中", "正在读取更新状态", "正在向主进程查询当前版本与更新源。")
      : base("muted", "不可用", "更新状态不可读", "应用接口尚未就绪，请重启桌面客户端。");
  }
  if (!state.supported) {
    return {
      ...base(
        "muted",
        "不可用",
        "当前运行方式无法在线更新",
        "在线更新只在安装版里启用；开发模式读取的版本号与更新产物都不完整。",
      ),
      advice: ERROR_CODES.unsupported.advice,
      reason: ERROR_CODES.unsupported.reason,
    };
  }

  const latest = state.availableVersion ? `v${state.availableVersion}` : "";

  if (state.status === "checking") {
    return base("busy", "检查中", "正在检查新版本", "正在连接更新服务器读取版本清单。");
  }
  if (state.status === "downloading") {
    const percent = state.progress?.percent ?? 0;
    return {
      ...base("busy", `下载中 ${percent}%`, `正在下载 ${latest || "新版本"}`, describeProgress(state, percent)),
      progress: percent,
    };
  }
  if (state.status === "downloaded") {
    return {
      ...base("ready", "待安装", `${latest || "新版本"} 已下载`, "安装包已经就绪，按下面三步完成覆盖安装。"),
      steps: INSTALL_STEPS,
      primaryAction: "open_installer",
      attention: true,
    };
  }
  if (state.status === "available") {
    return {
      ...base("ready", "可更新", `发现新版本 ${latest}`, "确认后再下载，安装包不会自动替换当前版本。"),
      steps: DOWNLOAD_STEPS,
      primaryAction: "download",
      attention: true,
    };
  }
  if (state.status === "error") {
    const mapped = state.errorCode ? ERROR_CODES[state.errorCode] : ERROR_CODES.unknown;
    return {
      ...base("error", "更新失败", "更新检查失败", state.errorMessage || mapped.advice),
      advice: mapped.advice,
      reason: mapped.reason,
      primaryAction: "check",
      attention: true,
    };
  }
  if (state.status === "not_available") {
    return base("idle", "已是最新", "已是最新版本", `当前版本 v${state.currentVersion} 与更新源一致。`);
  }
  return {
    ...base("idle", "待检查", "尚未检查更新", `当前版本 v${state.currentVersion}，可以手动检查服务器上的新版本。`),
    primaryAction: "check",
  };
}

function base(tone: UpdateTone, badge: string, headline: string, summary: string): UpdatePresentation {
  return { tone, badge, headline, summary, steps: [], primaryAction: null, attention: false };
}

function describeProgress(state: AppUpdateState, percent: number): string {
  const transferred = state.progress?.transferred ?? 0;
  const total = state.progress?.total ?? 0;
  if (!total) return `已下载 ${percent}%，请保持网络连接。`;
  return `已下载 ${formatBytes(transferred)} / ${formatBytes(total)}（${percent}%）。`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

export function formatCheckedAt(iso?: string): string {
  if (!iso) return "尚未检查";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 「更新说明」弹窗的标题：按状态切换，失败时不要伪装成「发现新版本」。 */
export function dialogTitle(presentation: UpdatePresentation): string {
  if (presentation.tone === "error") return "更新没有完成";
  if (presentation.tone === "ready") return presentation.headline;
  if (presentation.tone === "busy") return presentation.headline;
  return "软件更新";
}

/** 折叠区里的诊断文本，方便用户直接复制给维护人员。 */
export function diagnosticText(state: AppUpdateState | null): string {
  if (!state) return "更新状态尚不可读。";
  const lines = [
    `当前版本：v${state.currentVersion}`,
    `平台：${state.platform}`,
    `支持在线更新：${state.supported ? "是" : "否"}`,
    `状态：${state.status}`,
    `更新源：${state.feedUrl}`,
    `最近检查：${formatCheckedAt(state.checkedAt)}`,
  ];
  if (state.availableVersion) lines.push(`可用版本：v${state.availableVersion}`);
  if (state.errorCode) lines.push(`失败原因：${state.errorCode}`);
  if (state.errorMessage) lines.push(`说明：${state.errorMessage}`);
  if (state.errorDetail) lines.push(`技术细节：${state.errorDetail}`);
  if (state.installerPath) lines.push(`安装包：${state.installerPath}`);
  return lines.join("\n");
}

/**
 * Electron 把 IPC 拒绝包装成 `Error invoking remote method 'x': Error: ...`，
 * 直接把这段展示给用户没有意义，这里剥掉前缀。
 */
export function cleanErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^Error:\s*/, "")
    .trim();
}
