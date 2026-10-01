/**
 * 跨进程竞争子进程（session key 首写原子性回归）：完成模块加载后写入 ready
 * 标记，等待父进程确认全部参与者就绪，再统一释放 barrier；输出结构化结果
 * （密钥值只以 sha256 前缀哈希表示，绝不打印原值）。
 * 用法：node --experimental-strip-types tests/helpers/session-key-race-child.ts <dataHome> <barrierFile> <readyFile>
 */
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { ensureProvisionableSessionSecret } from "../../modules/identity/session-secret.ts";

const dataHome = process.argv[2];
const barrierFile = process.argv[3];
const readyFile = process.argv[4];
if (!dataHome || !barrierFile || !readyFile) {
  throw new Error("usage: <dataHome> <barrierFile> <readyFile>");
}
process.env.REALM_DATA_HOME = dataHome;
delete process.env.REALM_SESSION_SECRET;
writeFileSync(readyFile, "ready", { mode: 0o600 });

const deadline = Date.now() + 10_000;
while (!existsSync(barrierFile) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const result = ensureProvisionableSessionSecret();
process.stdout.write(`${JSON.stringify({
  ok: result !== null,
  source: result?.source ?? null,
  keyLength: result?.secret.length ?? 0,
  keyHash: result
    ? createHash("sha256").update(result.secret).digest("hex").slice(0, 16)
    : null,
})}\n`);
