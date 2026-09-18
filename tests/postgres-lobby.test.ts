/**
 * LAN 游戏大厅服务 PG 集成测试（tests/postgres-lobby.test.ts）。
 *
 * scratch 库全链迁移（0001–0047）：覆盖创建/列表白名单/密码 scrypt 校验
 * （对错/无明文）/重复加入幂等/容量拒绝/关闭后拒绝加入/非房主关闭拒绝/
 * 离开与回归/viewerRole/错误码。不读 .env.local，不碰共享库。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { seedPostgresDemo } from "../database/postgres/public.ts";
import {
  createLobbyService,
  hashRoomPassword,
  LobbyError,
  verifyRoomPassword,
} from "../modules/application/lobby-service.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";

const adminConnectionString = process.env.DATABASE_URL;

const WS = "ws_demo";
const HOST = "principal_lobby_host";
const GUEST = "principal_lobby_guest";
const THIRD = "principal_lobby_third";

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

test(
  "lobby: create/list/join/leave/close with password, capacity and permission boundaries",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_lobby_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    let cleanupPool = ownerPool;
    t.after(async () => {
      await cleanupPool.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);
    // 两个玩家身份（昵称即身份）。
    for (const [principal, name] of [
      [HOST, "大厅房主"],
      [GUEST, "大厅客人"],
      [THIRD, "大厅第三人"],
    ] as const) {
      await ownerPool.query(
        `INSERT INTO accounts (workspace_id, principal_id, display_name)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [WS, principal, name],
      );
    }

    const lobby = createLobbyService(ownerPool);
    const asHost = { workspaceId: WS, principalId: HOST };
    const asGuest = { workspaceId: WS, principalId: GUEST };
    const asThird = { workspaceId: WS, principalId: THIRD };

    // ---- 创建：公开房 + 密码房；创建者即房主 ----
    const open = await lobby.createRoom(asHost, { name: "周五夜桌", capacity: 3 });
    const locked = await lobby.createRoom(asHost, {
      name: "密语包间",
      password: "猎户座密码",
      capacity: 2,
    });

    // 密码哈希：非明文、scrypt 格式、可校验、错误密码拒绝。
    const stored = await ownerPool.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM lobby_rooms WHERE workspace_id = $1 AND id = $2`,
      [WS, locked.roomId],
    );
    const hash = stored.rows[0]!.password_hash!;
    assert.match(hash, /^scrypt:16384:8:1:/);
    assert.ok(!hash.includes("猎户座密码"), "密码明文绝不入库");
    assert.equal(await verifyRoomPassword("猎户座密码", hash), true);
    assert.equal(await verifyRoomPassword("错误密码", hash), false);
    assert.equal(await verifyRoomPassword("x", "not-a-hash"), false);
    assert.equal(await verifyRoomPassword("x", null), false);
    assert.match(await hashRoomPassword("p"), /^scrypt:/);

    // ---- 列表：白名单字段 + 房主显示名 + viewerRole ----
    const hostView = await lobby.listRooms(asHost);
    assert.equal(hostView.length, 2);
    const lockedSummary = hostView.find((room) => room.id === locked.roomId)!;
    assert.equal(lockedSummary.name, "密语包间");
    assert.equal(lockedSummary.hostDisplayName, "大厅房主");
    assert.equal(lockedSummary.hasPassword, true);
    assert.equal(lockedSummary.status, "open");
    assert.equal(lockedSummary.memberCount, 1);
    assert.equal(lockedSummary.viewerRole, "host");
    // 白名单：summary 不含任何 hash/principal 字段（worldId/worldName 是
    // 显式共享语义，属于白名单）。
    assert.deepEqual(Object.keys(lockedSummary).sort(), [
      "capacity",
      "hasPassword",
      "hostDisplayName",
      "id",
      "memberCount",
      "name",
      "status",
      "viewerRole",
      "worldId",
      "worldName",
    ]);
    const guestView = await lobby.listRooms(asGuest);
    assert.equal(guestView.find((room) => room.id === locked.roomId)!.viewerRole, null);
    await assert.rejects(
      lobby.listMembers(asGuest, locked.roomId),
      (error: unknown) => error instanceof LobbyError && error.code === "NOT_MEMBER",
    );

    // ---- 加入：错误密码 → BAD_PASSWORD；正确密码 → 成员 ----
    await assert.rejects(
      lobby.joinRoom(asGuest, { roomId: locked.roomId, password: "错" }),
      (error: unknown) => error instanceof LobbyError && error.code === "BAD_PASSWORD",
    );
    await lobby.joinRoom(asGuest, { roomId: locked.roomId, password: "猎户座密码" });
    // 重复加入幂等（网络重试安全）。
    await lobby.joinRoom(asGuest, { roomId: locked.roomId, password: "猎户座密码" });
    let members = await lobby.listMembers(asHost, locked.roomId);
    assert.equal(members.length, 2, "重复加入不得重复计员");
    assert.deepEqual(
      members.map((member) => [member.displayName, member.role, member.isViewer]),
      [["大厅房主", "host", true], ["大厅客人", "player", false]],
    );

    // ---- 容量：密语包间 cap=2，第三人加入被拒 ----
    await assert.rejects(
      lobby.joinRoom(asThird, { roomId: locked.roomId, password: "猎户座密码" }),
      (error: unknown) => error instanceof LobbyError && error.code === "ROOM_FULL",
    );
    // 空位校验在密码校验之后：满员时正确密码也拒绝。
    // （顺序无关泄漏面：两种拒绝文案不同但都不暴露密码正确性以外信息。）

    // ---- 非房主关闭被拒；房主关闭后加入被拒 ----
    await assert.rejects(
      lobby.closeRoom(asGuest, open.roomId),
      (error: unknown) => error instanceof LobbyError && error.code === "NOT_HOST",
    );
    await lobby.closeRoom(asHost, open.roomId);
    await lobby.closeRoom(asHost, open.roomId); // 幂等
    await assert.rejects(
      lobby.joinRoom(asGuest, { roomId: open.roomId }),
      (error: unknown) => error instanceof LobbyError && error.code === "ROOM_CLOSED",
    );
    const afterClose = await lobby.listRooms(asHost);
    assert.equal(
      afterClose.find((room) => room.id === open.roomId)!.status,
      "closed",
    );

    // ---- 离开与回归：left_at 软离开，成员计数同步 ----
    await lobby.leaveRoom(asGuest, locked.roomId);
    members = await lobby.listMembers(asHost, locked.roomId);
    assert.equal(members.length, 1);
    assert.equal(
      (await lobby.listRooms(asGuest)).find((room) => room.id === locked.roomId)!
        .viewerRole,
      null,
    );
    // 回归（密码仍需正确）。
    await lobby.joinRoom(asGuest, { roomId: locked.roomId, password: "猎户座密码" });
    members = await lobby.listMembers(asHost, locked.roomId);
    assert.equal(members.length, 2);

    // ---- 边界：不存在房间 / 非法输入 ----
    await assert.rejects(
      lobby.joinRoom(asGuest, { roomId: "lobby_nope" }),
      (error: unknown) => error instanceof LobbyError && error.code === "ROOM_NOT_FOUND",
    );
    await assert.rejects(
      lobby.createRoom(asHost, { name: "" }),
      (error: unknown) => error instanceof LobbyError && error.code === "INVALID_COMMAND",
    );
    await assert.rejects(
      lobby.createRoom(asHost, { name: "x", capacity: 99 }),
      (error: unknown) => error instanceof LobbyError && error.code === "INVALID_COMMAND",
    );
    await assert.rejects(
      lobby.createRoom(asHost, { name: "x", password: "x".repeat(81) }),
      (error: unknown) => error instanceof LobbyError && error.code === "INVALID_COMMAND",
    );
    await assert.rejects(
      lobby.closeRoom(asHost, "lobby_nope"),
      (error: unknown) => error instanceof LobbyError && error.code === "ROOM_NOT_FOUND",
    );

    // ---- 重启策略：关闭旧连接池，再用新连接池读回长期状态行 ----
    await ownerPool.end();
    const reopenedPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    cleanupPool = reopenedPool;
    const restartedLobby = createLobbyService(reopenedPool);
    const persisted = await restartedLobby.listRooms(asHost);
    assert.equal(persisted.length, 2);
  },
);

test(
  "lobby world binding: owner-only attach, join grants world membership",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_lobby_world_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    t.after(async () => {
      await ownerPool.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);
    for (const [principal, name] of [
      [HOST, "大厅房主"],
      [GUEST, "大厅客人"],
    ] as const) {
      await ownerPool.query(
        `INSERT INTO accounts (workspace_id, principal_id, display_name)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [WS, principal, name],
      );
    }
    const lobby = createLobbyService(ownerPool);
    const asHost = { workspaceId: WS, principalId: HOST };
    const asGuest = { workspaceId: WS, principalId: GUEST };

    // 房主自己的世界（创建者即 owner）。
    const library = createPostgresLibraryService(ownerPool);
    await library.create(asHost, {
      kind: "world",
      name: "共享试验场",
      era: "并流纪元",
      summary: "房间绑定测试世界。",
    });
    const sharedWorld = (await library.list(asHost)).worlds
      .find((world) => world.name === "共享试验场")!;

    // 非 owner 绑定他人世界 → fail-closed（demo 世界 HOST 非 owner）。
    await assert.rejects(
      lobby.createRoom(asHost, { name: "越权绑定", worldId: "world_ember_coast" }),
      (error: unknown) =>
        error instanceof LobbyError && error.code === "NOT_WORLD_OWNER",
    );

    // owner 绑定自己的世界；列表透出世界名。
    const room = await lobby.createRoom(asHost, {
      name: "共享局",
      worldId: sharedWorld.id,
    });
    const summary = (await lobby.listRooms(asGuest))
      .find((entry) => entry.id === room.roomId)!;
    assert.equal(summary.worldId, sharedWorld.id);
    assert.equal(summary.worldName, "共享试验场");

    // 客人加入绑定房间 → 同事务获得世界 player 成员关系。
    await lobby.joinRoom(asGuest, { roomId: room.roomId });
    const membership = await ownerPool.query<{ role: string }>(
      `SELECT role FROM player_world_memberships
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
      [WS, sharedWorld.id, GUEST],
    );
    assert.equal(membership.rows[0]?.role, "player", "加入绑定房间必须授予世界成员关系");
    // 幂等：重复加入不重复写、不报错。
    await lobby.joinRoom(asGuest, { roomId: room.roomId });
    const membershipCount = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM player_world_memberships
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
      [WS, sharedWorld.id, GUEST],
    );
    assert.equal(membershipCount.rows[0]!.count, "1");
    // 客人的世界库可见该世界（membership 生效的读侧证据）。
    const guestLibrary = await library.list(asGuest);
    assert.ok(
      guestLibrary.worlds.some((world) => world.id === sharedWorld.id),
      "加入后客人的世界库必须出现共享世界",
    );

    // 未绑定房间的加入不写 membership（负面对照）。
    const plain = await lobby.createRoom(asHost, { name: "纯约局" });
    await lobby.joinRoom(asGuest, { roomId: plain.roomId });
    const strayMembership = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM player_world_memberships
       WHERE workspace_id = $1 AND principal_id = $2`,
      [WS, GUEST],
    );
    assert.equal(
      strayMembership.rows[0]!.count,
      "1",
      "未绑定房间不得产生额外世界成员关系",
    );
  },
);

test(
  "lobby concurrency: parallel joins never oversell capacity; parallel creates stay distinct",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_lobby_conc_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 8 });
    t.after(async () => {
      await ownerPool.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);
    const lobby = createLobbyService(ownerPool);
    const asHost = { workspaceId: WS, principalId: HOST };
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, '大厅房主') ON CONFLICT DO NOTHING`,
      [WS, HOST],
    );

    // cap=2（房主占一席），5 个并发加入 → 恰 1 成功、4 个 ROOM_FULL。
    const room = await lobby.createRoom(asHost, { name: "并发桌", capacity: 2 });
    const contenders = ["c1", "c2", "c3", "c4", "c5"];
    const results = await Promise.allSettled(
      contenders.map((suffix) =>
        lobby.joinRoom(
          { workspaceId: WS, principalId: `principal_conc_${suffix}` },
          { roomId: room.roomId },
        )),
    );
    const joined = results.filter((result) => result.status === "fulfilled");
    const full = results.filter(
      (result) =>
        result.status === "rejected"
        && result.reason instanceof LobbyError
        && result.reason.code === "ROOM_FULL",
    );
    assert.equal(joined.length, 1, "容量 2 的房间恰允许 1 个并发加入成功");
    assert.equal(full.length, 4);
    const summary = (await lobby.listRooms(asHost))
      .find((entry) => entry.id === room.roomId)!;
    assert.equal(summary.memberCount, 2, "成员计数不得超卖");

    // 10 个并发创建 → 全部成功且 id 互异。
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        lobby.createRoom(asHost, { name: `并发创建${index}` })),
    );
    assert.equal(new Set(created.map((entry) => entry.roomId)).size, 10);

    // 并发 leave/close 幂等交错：不报错、终态一致。
    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    assert.notEqual(winnerIndex, -1, "并发加入必须有一个成功者");
    const winner = results[winnerIndex] as PromiseFulfilledResult<{ roomId: string }>;
    const winnerPrincipal = `principal_conc_${contenders[winnerIndex]}`;
    await Promise.allSettled([
      lobby.leaveRoom({ workspaceId: WS, principalId: winnerPrincipal }, winner.value.roomId),
      lobby.closeRoom(asHost, winner.value.roomId),
      lobby.closeRoom(asHost, winner.value.roomId),
    ]);
    const closed = (await lobby.listRooms(asHost))
      .find((entry) => entry.id === winner.value.roomId)!;
    assert.equal(closed.status, "closed");
    assert.equal((await lobby.listMembers(asHost, winner.value.roomId)).length, 1);
  },
);

test(
  "lobby host lease: renewal, lazy reap, expiry fail-closed, restart persistence, concurrency",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_lobby_lease_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 8 });
    let cleanupPool = ownerPool;
    t.after(async () => {
      await cleanupPool.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);
    for (const [principal, name] of [
      [HOST, "大厅房主"],
      [GUEST, "大厅客人"],
    ] as const) {
      await ownerPool.query(
        `INSERT INTO accounts (workspace_id, principal_id, display_name)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [WS, principal, name],
      );
    }
    // 短租约服务实例（确定性测试，不靠长 sleep；过期用 SQL 回拨）。
    const lobby = createLobbyService(ownerPool, { leaseTtlMs: 1500 });
    const asHost = { workspaceId: WS, principalId: HOST };
    const asGuest = { workspaceId: WS, principalId: GUEST };
    const leaseOf = async (roomId: string) => {
      const row = await ownerPool.query<{ lease: Date | null }>(
        `SELECT lease_expires_at AS lease FROM lobby_rooms
         WHERE workspace_id = $1 AND id = $2`,
        [WS, roomId],
      );
      return row.rows[0]?.lease ?? null;
    };

    // 创建即带租约（服务端时钟，未来时点）。
    const room = await lobby.createRoom(asHost, { name: "租约桌" });
    const initialLease = await leaseOf(room.roomId);
    assert.ok(initialLease && initialLease.getTime() > Date.now(), "创建必须带未来租约");

    // 房主心跳续租（lease 前移）；客人心跳对房主房间无效。
    const beforeBeat = await leaseOf(room.roomId);
    const hostBeat = await lobby.heartbeat(asHost);
    assert.equal(hostBeat.renewed, 1);
    const afterBeat = await leaseOf(room.roomId);
    assert.ok(
      afterBeat!.getTime() >= beforeBeat!.getTime(),
      "心跳必须续租",
    );
    const guestBeat = await lobby.heartbeat(asGuest);
    assert.equal(guestBeat.renewed, 0, "客人/他人心跳不得续租");
    const afterGuestBeat = await leaseOf(room.roomId);
    assert.equal(
      afterGuestBeat!.getTime(),
      afterBeat!.getTime(),
      "他人心跳不得改动房主房间租约",
    );

    // 过期（SQL 回拨，确定性）→ 权威读 lazy reap → closed；不复活。
    await ownerPool.query(
      `UPDATE lobby_rooms SET lease_expires_at = CURRENT_TIMESTAMP - interval '1 second'
       WHERE workspace_id = $1 AND id = $2`,
      [WS, room.roomId],
    );
    const staleBeat = await lobby.heartbeat(asHost);
    assert.equal(staleBeat.renewed, 0, "过期房间不得被心跳复活");
    assert.equal(staleBeat.expiredHosted, 1, "过期房间被心跳路径回收");
    // 已回收后再 list：保持 closed（幂等，不反复通知）。
    const list = await lobby.listRooms(asGuest);
    assert.equal(
      list.find((entry) => entry.id === room.roomId)!.status,
      "closed",
    );
    // 过期/已关闭房间拒绝加入。
    await assert.rejects(
      lobby.joinRoom(asGuest, { roomId: room.roomId }),
      (error: unknown) => error instanceof LobbyError && error.code === "ROOM_CLOSED",
    );

    // 并发 heartbeat × reap：幂等且终态一致（closed）。
    const room2 = await lobby.createRoom(asHost, { name: "并发租约桌" });
    await ownerPool.query(
      `UPDATE lobby_rooms SET lease_expires_at = CURRENT_TIMESTAMP - interval '1 second'
       WHERE workspace_id = $1 AND id = $2`,
      [WS, room2.roomId],
    );
    const concurrentResults = await Promise.allSettled([
      lobby.heartbeat(asHost),
      lobby.reapExpired(asHost),
      lobby.listRooms(asGuest),
      lobby.heartbeat(asHost),
    ]);
    assert.ok(
      concurrentResults.every((result) => result.status === "fulfilled"),
      "heartbeat/reap 并发操作不得静默失败",
    );
    const final = await lobby.listRooms(asHost);
    assert.equal(
      final.find((entry) => entry.id === room2.roomId)!.status,
      "closed",
    );

    // 遗留房间（lease NULL，0046 前语义）永不自动过期。
    const legacy = await lobby.createRoom(asHost, { name: "遗留桌" });
    await ownerPool.query(
      `UPDATE lobby_rooms SET lease_expires_at = NULL
       WHERE workspace_id = $1 AND id = $2`,
      [WS, legacy.roomId],
    );
    await lobby.listRooms(asHost);
    assert.equal(
      (await lobby.listRooms(asGuest)).find((entry) => entry.id === legacy.roomId)!.status,
      "open",
      "lease=NULL 的遗留房间不自动关闭",
    );

    // 世界 membership 不因房间过期被回收（v1 语义保持）。
    const library = createPostgresLibraryService(ownerPool);
    await library.create(asHost, {
      kind: "world",
      name: "租约试验场",
      era: "纪元",
      summary: "租约测试世界。",
    });
    const world = (await library.list(asHost)).worlds
      .find((entry) => entry.name === "租约试验场")!;
    const bound = await lobby.createRoom(asHost, { name: "绑定租约桌", worldId: world.id });
    await lobby.joinRoom(asGuest, { roomId: bound.roomId });
    await ownerPool.query(
      `UPDATE lobby_rooms SET lease_expires_at = CURRENT_TIMESTAMP - interval '1 second'
       WHERE workspace_id = $1 AND id = $2`,
      [WS, bound.roomId],
    );
    await lobby.listRooms(asHost);
    const membership = await ownerPool.query<{ role: string }>(
      `SELECT role FROM player_world_memberships
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
      [WS, world.id, GUEST],
    );
    assert.equal(membership.rows[0]?.role, "player", "房间过期不得回收已获得的世界成员关系");

    // 真正重启：保留一间「过期但仍 open」的房间，关闭旧连接池，再用新连接池
    // 读回并触发 lazy reap，证明持久化绝对租约不会在重启后复活。
    const restartRoom = await lobby.createRoom(asHost, { name: "重启租约桌" });
    await ownerPool.query(
      `UPDATE lobby_rooms SET lease_expires_at = CURRENT_TIMESTAMP - interval '1 second'
       WHERE workspace_id = $1 AND id = $2`,
      [WS, restartRoom.roomId],
    );
    await ownerPool.end();
    const reopenedPool = new pg.Pool({ connectionString: ownerUrl.href, max: 8 });
    cleanupPool = reopenedPool;
    const restarted = createLobbyService(reopenedPool, { leaseTtlMs: 1500 });
    const afterRestart = await restarted.listRooms(asHost);
    assert.equal(
      afterRestart.find((entry) => entry.id === restartRoom.roomId)!.status,
      "closed",
      "重启后过期房间不得复活",
    );
  },
);
