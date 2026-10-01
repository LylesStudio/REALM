/**
 * 会话签名密钥（server-only）：
 * 1. REALM_SESSION_SECRET 环境变量（显式优先）；
 * 2. 安装级稳定密钥文件 <settingsRoot>/secure/session-secret（0600 普通文件，
 *    0700 目录，一次性生成后复用——进程重启会话不失效）；
 * 3. 开发兜底常量（仅非 production 且文件系统不可写时，告警一次；
 *    production 下无可用来源一律 fail-closed 抛 SessionSecretUnavailableError，
 *    绝不返回/缓存兜底、不产生可用 cookie/signature）。
 * 绝不读取 REALM_ACCESS_TOKEN（已退役），密钥不进日志/响应。
 *
 * 文件安全（M5）：既有密钥只在「普通非符号链接文件 + owner-only 0600 +
 * secure 目录 0700（POSIX 平台）」时被接受；不安全文件 fail-closed——
 * 不静默消费、不 chmod、不覆盖、不轮换、不用于 provisioning。
 * 并发首写原子无替换（link() EEXIST 协议）：只有一个候选能首次落地；
 * 其余进程回读并随附同一 winner；winner 不合法则所有方 fail-closed。
 */
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

let cached: string | null = null;
let warned = false;

const DEV_FALLBACK_SECRET = "realm-local-development-only";
const MIN_PROVISIONING_SECRET_LENGTH = 32;

/** provisioning 级密钥判定：长度下限 + 拒绝公知开发兜底值（两个来源同规则）。 */
function isProvisioningGrade(secret: string): boolean {
  return secret.length >= MIN_PROVISIONING_SECRET_LENGTH
    && secret !== DEV_FALLBACK_SECRET;
}

function secretPathFor(settingsRoot: string): string {
  return resolve(settingsRoot, "secure", "session-secret");
}

/**
 * 既有密钥文件安全检查。返回安全文件内容；不安全/不存在返回 null。
 * POSIX：目录必须 0700、文件必须普通非符号链接 0600；win32 跳过 mode 检查
 * （无法表达 POSIX 权限）但仍要求普通非符号链接文件。
 */
function readSecureKeyFile(
  secretPath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  try {
    const directory = dirname(secretPath);
    const directoryStats = statSync(directory);
    if (!directoryStats.isDirectory()) return null;
    const fileStats = lstatSync(secretPath);
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) return null;
    if (platform !== "win32") {
      if ((directoryStats.mode & 0o777) !== 0o700) return null;
      if ((fileStats.mode & 0o777) !== 0o600) return null;
    }
    const value = readFileSync(secretPath, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export class InsecureSessionKeyError extends Error {
  constructor() {
    super(
      "insecure session-secret file (expected a regular 0600 file in a 0700 directory); refusing to use or replace it",
    );
    this.name = "InsecureSessionKeyError";
  }
}

/**
 * production 下无任何可用会话密钥来源（未配置 env、安装级密钥不可用且
 * 创建失败）时抛出。消息稳定且不含 secret/路径/环境变量值/URI——
 * 绝不以开发兜底签发可用会话。
 */
export class SessionSecretUnavailableError extends Error {
  constructor() {
    super(
      "session secret unavailable: set REALM_SESSION_SECRET or provide a writable install data home (required in production)",
    );
    this.name = "SessionSecretUnavailableError";
  }
}

/** 是否存在（任何形态的）既有密钥文件/占位：决定「不安全即拒绝」与「可创建」的分界。 */
function keyFilePresent(secretPath: string): boolean {
  try {
    lstatSync(secretPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子无替换创建安装级密钥（跨平台 link() EEXIST 协议）：
 * 候选先写临时文件，再以 link() 落地——link 只在目标不存在时成功
 * （EEXIST = 对方已胜），因此并发进程只有一个候选首次落地；败方删除
 * 临时文件并回读 winner（合法则随附，非法则所有方 fail-closed）。
 * 临时文件崩溃残留为 .tmp（下轮清理），文件本体永远 0600、目录 0700。
 */
function createInstallKey(
  secretPath: string,
  platform: NodeJS.Platform = process.platform,
): { secret: string; source: "created" | "file" } | null {
  const settingsDirectory = dirname(secretPath);
  const generated = randomBytes(32).toString("hex");
  const temporaryPath = `${secretPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(settingsDirectory, { recursive: true, mode: 0o700 });
    if (platform !== "win32") chmodSync(settingsDirectory, 0o700);
    writeFileSync(temporaryPath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
    if (platform !== "win32") chmodSync(temporaryPath, 0o600);
    // 原子 no-replace：link() 在目标已存在时失败——绝不覆盖 winner。
    linkSync(temporaryPath, secretPath);
    if (platform !== "win32") chmodSync(secretPath, 0o600);
    return { secret: generated, source: "created" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") return null;
    // 对方已胜：回读并随附合法 winner；非法则所有方 fail-closed。
    const winner = readSecureKeyFile(secretPath, platform);
    if (winner && isProvisioningGrade(winner)) {
      return { secret: winner, source: "file" };
    }
    return null;
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // 临时文件已被消费/清理。
    }
  }
}

export function sessionSecret(): string {
  if (cached) return cached;
  const fromEnv = process.env.REALM_SESSION_SECRET?.trim();
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }
  const settingsRoot = process.env.REALM_DATA_HOME?.trim() || resolve(process.cwd(), ".local");
  const secretPath = secretPathFor(settingsRoot);
  if (keyFilePresent(secretPath)) {
    const existing = readSecureKeyFile(secretPath);
    if (!existing || !isProvisioningGrade(existing)) {
      throw new InsecureSessionKeyError();
    }
    cached = existing;
    return cached;
  }
  const created = createInstallKey(secretPath);
  if (created) {
    cached = created.secret;
    return cached;
  }
  // production fail-closed：无 env、无安全文件、安装级创建失败时绝不
  // 返回/缓存公知开发兜底（否则会签发任何人都可伪造的会话 cookie）。
  if (process.env.NODE_ENV === "production") {
    throw new SessionSecretUnavailableError();
  }
  if (!warned) {
    warned = true;
    console.warn("[realm] session secret file unavailable; using the development fallback (non-production only; sessions invalid across restarts)");
  }
  cached = DEV_FALLBACK_SECRET;
  return cached;
}

/** 测试隔离：清除模块级缓存（下个调用重读环境/文件）。 */
export function resetSessionSecretCache(): void {
  cached = null;
}

/**
 * Provisioning 专用：只接受真实来源（env / 安装级 0600 文件）的会话密钥；
 * 开发兜底常量（公知值）、过短值、不安全文件一律拒绝——用它 provisioning
 * 等于公开锚。返回值绝不允许打印/写日志；调用方失败时只报来源类别。
 */
export function sessionSecretForProvisioning():
  | { secret: string; source: "env" | "file" }
  | null {
  const fromEnv = process.env.REALM_SESSION_SECRET?.trim();
  if (fromEnv) {
    return isProvisioningGrade(fromEnv) ? { secret: fromEnv, source: "env" } : null;
  }
  const settingsRoot = process.env.REALM_DATA_HOME?.trim() || resolve(process.cwd(), ".local");
  const existing = readSecureKeyFile(secretPathFor(settingsRoot));
  if (existing && isProvisioningGrade(existing)) {
    return { secret: existing, source: "file" };
  }
  return null;
}

/**
 * 可信首写（安装级密钥创建）：env（合格）→ 0600 文件（合格）→ 原子创建
 * 安装级文件（目录 0700 / 文件 0600，随机 32B hex，并发回读收敛）。
 * 既有文件不安全时 fail-closed（不覆盖、不替换、不轮换）；任何创建/权限
 * 失败同样 fail-closed；绝不落回开发兜底常量。返回值绝不允许打印/写日志。
 */
export function ensureProvisionableSessionSecret():
  | { secret: string; source: "env" | "file" | "created" }
  | null {
  const existing = sessionSecretForProvisioning();
  if (existing) return existing;
  // env 存在但不合格（弱/兜底）时不创建文件覆盖语义——直接拒绝。
  if (process.env.REALM_SESSION_SECRET?.trim()) return null;
  const settingsRoot = process.env.REALM_DATA_HOME?.trim() || resolve(process.cwd(), ".local");
  const secretPath = secretPathFor(settingsRoot);
  // 既有文件：合法即随附，其余形态（不安全权限/符号链接/内容不合格）
  // 一律 fail-closed——绝不覆盖、不替换、不轮换。
  if (keyFilePresent(secretPath)) {
    const existing = readSecureKeyFile(secretPath);
    if (existing && isProvisioningGrade(existing)) {
      return { secret: existing, source: "file" };
    }
    return null;
  }
  return createInstallKey(secretPath);
}
