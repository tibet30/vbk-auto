/**
 * 三人同游服务令牌的本地存储（仅主进程）。
 *
 * 用户明确要求「令牌存到本机」，因此这里沿用仓库既有本地密钥约定：
 * `app.getPath('userData')` 下一个 0600 的 JSON 文件，写入走「同级临时文件 + rename」，
 * 每次写完强制 chmod 0600。与 `ai-secrets.json`、`app-auth-session.json` 同一套语义，
 * 不引入 Electron Keychain（历史坑：keychain 项缺失时静默失败，配置直接卡死）。
 *
 * 安全契约：
 *   - 文件里只有令牌本身与保存时间，不写任何调用日志；
 *   - renderer 永远拿不到明文：对外只暴露 `stk_xxxxxxxx…` 掩码前缀；
 *   - 环境变量 `TIBET_SERVICE_TOKEN` 优先于本地文件，便于开发/CI 临时覆盖，
 *     且这种覆盖不会污染文件（保存或清除都只作用于文件）。
 *   - 令牌格式不合法（缺 `stk_` 前缀或长度不足）直接拒绝写入，避免把垃圾写进磁盘。
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 稳定文件名；路径里不出现任何令牌内容。 */
export const LOCAL_TIBET_SERVICE_TOKEN_FILE_NAME = "tibet-service-token.json";

/** 令牌环境变量：优先级高于本地文件。 */
export const TIBET_SERVICE_TOKEN_ENV = "TIBET_SERVICE_TOKEN";

const FILE_MODE = 0o600;
const SCHEMA_VERSION = 1;
/** `stk_` + 秘密部分；服务端签发的是 `stk_` + 64 位 hex，这里只做宽松下限校验。 */
const TOKEN_PATTERN = /^stk_[0-9a-zA-Z]{16,}$/u;
const MASK_PREFIX_LENGTH = 12;

interface StoredTokenFile {
  version: number;
  token: string;
  savedAt: string;
}

export interface TibetServiceTokenState {
  configured: boolean;
  source: "env" | "file" | null;
  maskedToken: string | null;
  savedAt: string | null;
}

export interface TibetServiceTokenStore {
  /** 解析后的明文令牌；环境变量优先，其次本地文件。没有则 null。 */
  get(): string | null;
  state(): TibetServiceTokenState;
  /** 保存令牌；格式不合法直接抛错且不落盘。 */
  save(token: string): TibetServiceTokenState;
  clear(): TibetServiceTokenState;
  filePath(): string;
}

export function isValidTibetServiceToken(raw: unknown): raw is string {
  return typeof raw === "string" && TOKEN_PATTERN.test(raw.trim());
}

/** 掩码：只保留可识别前缀，秘密部分一律用省略号替代。 */
export function maskTibetServiceToken(token: string): string {
  const trimmed = token.trim();
  return trimmed.length <= MASK_PREFIX_LENGTH
    ? `${trimmed.slice(0, 6)}…`
    : `${trimmed.slice(0, MASK_PREFIX_LENGTH)}…`;
}

function readStored(filePath: string): StoredTokenFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== SCHEMA_VERSION) return null;
    if (!isValidTibetServiceToken(parsed.token)) return null;
    return {
      version: SCHEMA_VERSION,
      token: String(parsed.token).trim(),
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
    };
  } catch {
    return null;
  }
}

function chmodOwnerOnly(filePath: string): void {
  try { fs.chmodSync(filePath, FILE_MODE); } catch { /* Windows 上尽力而为 */ }
}

export function createTibetServiceTokenStoreIn(userDataDir: string, options: { env?: NodeJS.ProcessEnv } = {}): TibetServiceTokenStore {
  return createTibetServiceTokenStore(path.join(userDataDir, LOCAL_TIBET_SERVICE_TOKEN_FILE_NAME), options);
}

export function createTibetServiceTokenStore(
  filePath: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): TibetServiceTokenStore {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const env = options.env ?? process.env;
  let cached = readStored(filePath);

  const write = (state: StoredTokenFile) => {
    const tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      fs.writeFileSync(tempPath, JSON.stringify(state), { encoding: "utf8", flag: "wx", mode: FILE_MODE });
      chmodOwnerOnly(tempPath);
      fs.renameSync(tempPath, filePath);
      chmodOwnerOnly(filePath);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch { /* no-op */ }
      throw error;
    }
  };

  const envToken = () => {
    const candidate = env[TIBET_SERVICE_TOKEN_ENV]?.trim() ?? "";
    return isValidTibetServiceToken(candidate) ? candidate : "";
  };

  const state = (): TibetServiceTokenState => {
    const fromEnv = envToken();
    if (fromEnv) {
      return { configured: true, source: "env", maskedToken: maskTibetServiceToken(fromEnv), savedAt: null };
    }
    if (!cached) return { configured: false, source: null, maskedToken: null, savedAt: null };
    return {
      configured: true,
      source: "file",
      maskedToken: maskTibetServiceToken(cached.token),
      savedAt: cached.savedAt || null,
    };
  };

  return {
    get() {
      const fromEnv = envToken();
      return fromEnv || cached?.token || null;
    },
    state,
    save(token) {
      const trimmed = typeof token === "string" ? token.trim() : "";
      if (!isValidTibetServiceToken(trimmed)) {
        throw new Error("服务令牌格式不正确：应以 stk_ 开头并包含完整秘密部分。");
      }
      const next: StoredTokenFile = { version: SCHEMA_VERSION, token: trimmed, savedAt: new Date().toISOString() };
      write(next);
      cached = next;
      return state();
    },
    clear() {
      cached = null;
      try { fs.unlinkSync(filePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return state();
    },
    filePath: () => filePath,
  };
}
