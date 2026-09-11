import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionValue,
  isAccessGateEnabled,
  principalFromRequest,
  principalIdForDisplayName,
  sessionCookieHeader,
  verifyAccessToken,
  verifySessionValue,
} from "../modules/identity/auth.ts";

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

test("access gate follows REALM_ACCESS_TOKEN and token compare is strict", () => {
  const saved = process.env.REALM_ACCESS_TOKEN;
  try {
    delete process.env.REALM_ACCESS_TOKEN;
    assert.equal(isAccessGateEnabled(), false);
    assert.equal(verifyAccessToken("anything"), false);

    process.env.REALM_ACCESS_TOKEN = "test-gate-token";
    assert.equal(isAccessGateEnabled(), true);
    assert.equal(verifyAccessToken("test-gate-token"), true);
    assert.equal(verifyAccessToken("test-gate-tokfn"), false);
    assert.equal(verifyAccessToken(""), false);

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
    if (saved === undefined) delete process.env.REALM_ACCESS_TOKEN;
    else process.env.REALM_ACCESS_TOKEN = saved;
  }
});
