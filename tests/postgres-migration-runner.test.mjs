import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function readProjectFile(relativePath) {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const runner = readProjectFile("scripts/postgres-migrate.mjs");
const lifecycle = readProjectFile("scripts/local-postgres.mjs");
const runtimeContractMigration = readProjectFile(
  "database/postgres/migrations/0001_runtime_contract.sql",
);

const legacyPublicSnapshotCommentMigrations = {
  "0016_world_files.sql": {
    stored: "4d8bdd10b5f965fcd9d18fe263110a78edaf91d39a00f04f37af0a5ed8b07cf3",
    current: "be40c8821a57658377132407a7625e9b923b504c269076c1df314f7c9d83df41",
    historicalLf: "a0140a3ba2d4572f5bf13488f60d3a30a58d3c33fd59775cd5b497eff3a25b15",
  },
  "0017_account_last_opened.sql": {
    stored: "7d27d5410811590e8bc8883d678c0a4608a5d0519c141f347229b8dce76d6cb1",
    current: "f4411501cd31d9bd6e0eeffe30d23a5d81c01e352e05f365b113fcba15516233",
    historicalLf: "d76dd5b22fe9f495023cf4837e49a1502d7cef8a11a6ae62bd40b5fb6bdc03e0",
  },
  "0019_record_first_nights.sql": {
    stored: "339a0a87acdb44181de00c3b0afe8221adb83e8d9bc7688bdb20efad6f0552ef",
    current: "b5269f93fabce262ab25ba4f90cacd28a76643bf420068c30f065c8cc3ee0742",
    historicalLf: "5625e4a1cac9f8d2d75d25f910a6f42df68a70d7afa7af94dba8bf1b55d64850",
  },
  "0020_record_self_play_sessions.sql": {
    stored: "6442d0a079d6a8c563946991006494d5d4a9ff2056436231813274de8c741e98",
    current: "2f5dc0caeb16a9e414fd991b3b7e6ec26dbd79ad7942afcaf8ab067988cf93a3",
    historicalLf: "fb9aa4869828bb34592f6292f009e8ae10516e43eede2bf542c00c2a8f47c9cf",
  },
  "0021_world_admin.sql": {
    stored: "983169670dc587bb8eb20c722f43101b46bdbe671c67db70295803f1777776e5",
    current: "f649ee8195fc2308f8156d149dda60b71af0af568a22a3721276e28047f410dc",
    historicalLf: "f9f0264ab371c8e6b3e9afbb3cd37c42fc60157ba0b21c55a66cc2bf9a0167b2",
  },
  "0022_worldline_merge_grants.sql": {
    stored: "de36c3a3fe3c97b2df4ac98e1980827ea13719307d54a7c4e4f30b6c2f943b01",
    current: "60d237169f34a796aedad9004a08ec9ecb9fed9b17f300211bef507cd9297d9f",
    historicalLf: "48d615982c0bc2e08330e4910bc268d5040e5478eaf705bd4a676cbead3d81b0",
  },
  "0023_library_runtime_grants.sql": {
    stored: "ea905c5b54589cddd6da4b615697af94bfbfbcc49db4c511bc4a080bd639dab5",
    current: "871f4d45f39fb87569ec2a9129d5beb88e13c54af0fb946a45a116888354cc2a",
    historicalLf: "687326bdf27712acc2ccbbce4d9a39d40311a3601a476596b0ac1d7b63da28b4",
  },
  "0024_graph_invalidation_events.sql": {
    stored: "ff2f6a9a81e7b14dbee372cfbaa724211eac74f3cf0ca5c2145ed2189afd49a3",
    current: "3c25e8ce130ee20c8f8f23364752be9dcb4a041c03a69044dda58c8097139cbb",
    historicalLf: "60e47643812ff8f161de37edd01887eb8fc14f850a09e263f27e720c97446587",
  },
  "0025_propagation_topology_semantic_scope.sql": {
    stored: "b2639e3ffb3b28ccbdfd1711590536cd91ba91dca38ba7894f5e6924121cb68d",
    current: "fa5c88a163ccdfc419cb23cdef11b11b169021c7190055784b75354136e05119",
    historicalLf: "f9f849c75ab8aabc2859b982d1828cd0366dd7cbd28375596064f46ec665ac19",
  },
  "0026_canon_security_audience.sql": {
    stored: "bd529dfb2a2c1b4e0ca9663ee7309091e5945569f0d5ea64cac1a02d5ffacb33",
    current: "d28fa4bf367fe7100538831f5b9b7f88853301bfdc89979808e1cfce6a94795b",
    historicalLf: "6efbfc3c056b7ca7306f4787c22386ca72b54e54b7324264cf80c3dd61eb35d4",
  },
  "0039_scene_weather_snapshot.sql": {
    stored: "4cf5d99bd7d066e14b7d9b3f0e37ed8713ba0c2e8c114a595646cd5edacdb0f1",
    current: "68277ddeed43eb85a05f3b045b694d22543f8f04bd55dbcfe220d81a2a889a2f",
    historicalLf: "32ce7cf2d88bdbe99afb9593b60016eaab118d6a07146a0a6cce31c411df991e",
  },
  "0040_scene_display_time_snapshot.sql": {
    stored: "2d82ca8f4e8b5dd5cd3db934151e389b1c65c9017ea9a87e6d17e36c554ddc3e",
    current: "c4ea868de7a7fd6f0d87100d7c84d57739e8702487c5d4ef1313bbe2d2a45c50",
    historicalLf: "5867a446338bad55d71cd1498d0d32559172d2833fb2a12b5f7d87c92ec7285e",
  },
  "0045_lobby_rooms.sql": {
    stored: "14955ba1817d0a78487c13c4b7aecebbf4974b1ec4eb74d820dbd3d2aa7b4c6d",
    current: "739bd2a3b262b66d878b34d82300c3c4ce976d44a2c52b7ded929a2f0c745adc",
    historicalLf: "8ca04fff1dc20a0ea74d2a46779ba27d6c0edcc247bd9b9d685c878ad5500d07",
  },
  "0046_lobby_room_world_link.sql": {
    stored: "6178fc7078cda1322de257281fff0915919fa02e3bc692781938ad7eab066ae0",
    current: "67d11c044e50ea29a931153c34e2645818b065c27e3c68b0e399a91dfb83f1e1",
    historicalLf: "6b88da88188285d4dd430c007c9332bfdad61565fd899a30a861ebbdaf171aca",
  },
  "0047_lobby_host_lease.sql": {
    stored: "019957003d45d126fd56db511a74e75569fffef88e6dc43de61b2da7d8bf1771",
    current: "6bc8db5d17a0cc478931bc78adfc58eabcc300a0ae92686a2330ca5753e0d5bb",
    historicalLf: "e107deaeb5cc75c439ea13ee6a2e9fe16d4ee01f91c42af37d1a0ff20fe3280a",
  },
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("migration connections cannot override the validated loopback endpoint", () => {
  assert.match(runner, /databaseUrl\.searchParams/);
  assert.match(runner, /query parameters are disabled/);
  assert.match(runner, /host: hostname/);
  assert.match(runner, /ssl: false/);
  assert.doesNotMatch(runner, /new pg\.Client\(\{ connectionString \}\)/);
  assert.ok(
    runner.indexOf("inet_server_addr()") <
      runner.indexOf("CREATE TABLE IF NOT EXISTS realm_schema_migrations"),
  );
});

test("each migration and its ledger receipt share one locked transaction", () => {
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /await client\.query\("BEGIN"\)/);
  assert.match(runner, /await client\.query\(sql\)/);
  assert.match(runner, /INSERT INTO realm_schema_migrations/);
  assert.match(runner, /await client\.query\("COMMIT"\)/);
  assert.match(runner, /await client\.query\("ROLLBACK"\)/);
});

test("migration checksums are line-ending stable and historical exceptions stay narrow", () => {
  assert.match(runner, /LEGACY_MIGRATION_CHECKSUMS/);
  assert.match(runner, /normalizedSql\.replace\(\/\\n\/g, "\\r\\n"\)/);
  assert.match(runner, /acceptedLineEnding/);
  assert.match(runner, /acceptedHistorical/);
  assert.equal(
    sha256(runtimeContractMigration),
    "0f7245e65b776f54163f0e9cede44fe0f20df21cbb54108865f670f94265c679",
  );
  assert.equal(
    sha256(runtimeContractMigration.replace(/\n/g, "\r\n")),
    "62f4b0802be301f3fbc26c325a44564ca3298ecbb1111c616e65d1100e75d84e",
  );
  assert.match(runner, /0014_scene_crystallization_grants\.sql/);
  assert.match(
    runner,
    /d339e9d58db0e118a5361fa4c401367c7a5a4c95f349e95372962fdc5e754d46/,
  );
  assert.match(
    runner,
    /62cc7aadf1b5f8aa17cab96977436abfd9857421116bd3050c89d2341cd099e4/,
  );
  assert.match(runner, /reapply: true/);
  assert.match(runner, /ledger converged to current SQL/);
  assert.match(runner, /0015_account_ui_language\.sql/);
  assert.match(
    runner,
    /68d3786e29566d8bc3810ae498f9c31a81039808e1335823f1fdd7836c70e603/,
  );
  assert.match(
    runner,
    /a3f333e932ae7a69bf3dfa9ec9734b9892ad058eda876d40995bb7a5fdb13409/,
  );
  assert.match(runner, /0030_character_instance_state\.sql/);
  assert.match(
    runner,
    /a36800b96089a0742f47f1415fd2f202607d6e260f3f65ee11e5d9f0bc780837/,
  );
  assert.match(
    runner,
    /1d8cbb9a63de8f1570c20430604a02f45efb5b560a28e1f2e5784a2a9d5ec56c/,
  );
  assert.match(runner, /0035_keen_insight_concrete_discovery\.sql/);
  assert.match(
    runner,
    /89e694af2c732a27f3e31c7aafcebc8efc4586094c686a6cc0e4576c4deba361/,
  );
  assert.match(runner, /migration checksum inventory \(all unresolved mismatches\)/);
  assert.match(runner, /unresolvedMismatches/);
  assert.match(runner, /legacyLineEndingChecksum/);
  assert.match(runner, /Applied migration was modified/);
  assert.match(runner, /53e9f5a0b0eafca24659bf877f27c205912250ab/);
  assert.match(runner, /convergeLedger: true/);
  for (const [filename, checksums] of Object.entries(legacyPublicSnapshotCommentMigrations)) {
    assert.ok(runner.includes(filename));
    assert.ok(runner.includes(checksums.stored));
    assert.ok(runner.includes(checksums.historicalLf));
    assert.equal(
      sha256(readProjectFile(`database/postgres/migrations/${filename}`)),
      checksums.current,
    );
  }
});

test("local lifecycle checks both project ownership and socket readiness", () => {
  assert.match(lifecycle, /pg_ctl/);
  assert.match(lifecycle, /pg_isready/);
  assert.match(lifecycle, /127\.0\.0\.1/);
  assert.match(lifecycle, /outside this project cluster/);
});
