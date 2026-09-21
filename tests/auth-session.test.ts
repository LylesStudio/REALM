import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionValue,
  isAccessGateEnabled,
  principalFromRequest,
  principalIdForDisplayName,
  sessionCookieHeader,
  verifySessionValue,
} from "../modules/identity/auth.ts";
import {
  hashAccountPassword,
  verifyAccountPassword,
} from "../modules/identity/password.ts";

test("session value round-trips and rejects tampering and expiry", () => {
  const value = createSessionValue("principal_abc123", 1000);
  assert.equal(verifySessionValue(value, 2000), "principal_abc123");

  // 篡改签名/主体被拒绝。
  const tampered = value.replace("principal_abc123", "principal_evil99");
  assert.equal(verifySessionValue(tampered, 2000), null);
  assert.equal(verifySessionValue(`${value}ff`, 2000), null);
  assert.equal(verifySessionValue("garbage", 2000), null);

  // 过期被拒绝。
  const expired = createSessionValue("principal_abc123", 0);
  assert.equal(verifySessionValue(expired, Date.now() + 1), null);
  // 非 principal 前缀被拒绝。
  assert.equal(verifySessionValue("x.1.z"), null);
});

test("cookie header is httpOnly with 30-day persistence", () => {
  const header = sessionCookieHeader("principal_abc123");
  assert.match(header, /HttpOnly/);
  assert.match(header, /Max-Age=2592000/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /realm_session=principal_abc123\./);
});

test("principal derivation is deterministic and contains no credential material", () => {
  const first = principalIdForDisplayName("洛川");
  const second = principalIdForDisplayName("洛川");
  assert.equal(first, second);
  assert.match(first, /^principal_[a-f0-9]{18}$/);
  assert.notEqual(principalIdForDisplayName("弥洛"), first);
});

test("access gate follows runtime DB presence; retired token is ignored", () => {
  const savedDb = process.env.REALM_RUNTIME_DATABASE_URL;
  const savedToken = process.env.REALM_ACCESS_TOKEN;
  try {
    delete process.env.REALM_RUNTIME_DATABASE_URL;
    delete process.env.REALM_ACCESS_TOKEN;
    assert.equal(isAccessGateEnabled(), false);

    process.env.REALM_RUNTIME_DATABASE_URL = "postgresql://realm_runtime@127.0.0.1:5432/realm";
    assert.equal(isAccessGateEnabled(), true, "runtime DB 存在即要求账户登录");

    // 退役 token 存在与否不再影响门禁语义。
    process.env.REALM_ACCESS_TOKEN = "legacy-token";
    assert.equal(isAccessGateEnabled(), true);

    delete process.env.REALM_RUNTIME_DATABASE_URL;
    assert.equal(isAccessGateEnabled(), false);

    // 请求级解析：cookie 中的有效会话被接受。
    const value = createSessionValue("principal_demo_player");
    const request = new Request("http://localhost/", {
      headers: { cookie: `other=1; realm_session=${value}` },
    });
    assert.equal(principalFromRequest(request), "principal_demo_player");
    assert.equal(
      principalFromRequest(new Request("http://localhost/")),
      null,
    );
  } finally {
    if (savedDb === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
    else process.env.REALM_RUNTIME_DATABASE_URL = savedDb;
    if (savedToken === undefined) delete process.env.REALM_ACCESS_TOKEN;
    else process.env.REALM_ACCESS_TOKEN = savedToken;
  }
});

test("password hash: scrypt round-trip, salt per account, strict verify", () => {
  const first = hashAccountPassword("灯塔口令");
  const second = hashAccountPassword("灯塔口令");
  assert.match(first, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.notEqual(first, second, "每账户随机 salt");
  assert.equal(verifyAccountPassword("灯塔口令", first), true);
  assert.equal(verifyAccountPassword("灯塔口另", first), false);
  assert.equal(verifyAccountPassword("灯塔口令", null), false);
  assert.equal(verifyAccountPassword("灯塔口令", "garbage"), false);
  assert.equal(verifyAccountPassword("", first), false);
  assert.equal(verifyAccountPassword("灯塔口令", "scrypt$999999999$8$1$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"), false);
  assert.equal(verifyAccountPassword("x".repeat(129), first), false);
  assert.ok(!first.includes("灯塔口令"), "hash 不含明文");
});
