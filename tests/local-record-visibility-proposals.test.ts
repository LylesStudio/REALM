import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as proposalsModule from "../modules/application/local-record-visibility-proposals.ts";
import {
  LocalRecordServiceError,
  createMemoryVisibilityProposalRegistry,
} from "../modules/application/local-record-service.ts";
import type { WriteScope } from "../modules/application/local-record-read-model.ts";
import type { TurnVisibilityAssessment } from "../modules/orchestration/public.ts";

/**
 * Phase 2C：受限可见性提案 registry（issue/authorize/bind + TTL + 校验）
 * 已从 facade 拆入 modules/application/local-record-visibility-proposals.ts。
 * 本文件是拆分边界测试：
 * ① seam——facade 公开导出与新模块同一对象，facade 不再自带 registry
 *    实现，新模块不反向 import facade；
 * ② behavior——issue 的 restricted 提案字段、authorize 的
 *    scope/canonicalVersion/content/idempotency fail-closed、同 key 重放
 *    允许、跨 key 拒绝、TTL 过期、bind 后行为；错误类别与原文案逐字不变。
 */

const SCOPE: WriteScope = {
  workspaceId: "workspace-local",
  recordId: "record-local",
  principalId: "principal-local",
  characterInstanceId: "char_inst_player",
};

const RESTRICTED_ASSESSMENT: TurnVisibilityAssessment = {
  visibility: {
    kind: "restricted",
    domainId: "domain_private",
    audienceCharacterInstanceIds: ["char_inst_player", "char_inst_scout"],
  },
  reason: "密函内容只宜让在场者知晓。",
};

function createRegistry(options: {
  clock?: () => Date;
  randomToken?: () => string;
  ttlMs?: number;
} = {}) {
  return proposalsModule.createMemoryVisibilityProposalRegistry(options);
}

function issueDefault(
  registry: ReturnType<typeof createRegistry>,
  overrides: {
    scope?: WriteScope;
    canonicalVersion?: number;
    content?: string;
    assessment?: TurnVisibilityAssessment;
    audienceNames?: readonly string[];
  } = {},
) {
  return registry.issue({
    scope: overrides.scope ?? SCOPE,
    canonicalVersion: overrides.canonicalVersion ?? 7,
    content: overrides.content ?? "我悄悄拆开密函。",
    assessment: overrides.assessment ?? RESTRICTED_ASSESSMENT,
    ...(overrides.audienceNames ? { audienceNames: overrides.audienceNames } : {}),
  });
}

function expectInvalidVisibilityConfirmation(
  fn: () => unknown,
  message: string,
): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof LocalRecordServiceError,
    `expected LocalRecordServiceError, got ${String(caught)}`,
  );
  assert.equal(caught.code, "INVALID_VISIBILITY_CONFIRMATION");
  assert.equal(caught.message, message);
}

test("seam：facade 的 visibility proposal 公开导出与新模块是同一对象", () => {
  assert.equal(typeof proposalsModule.createMemoryVisibilityProposalRegistry, "function");
  // facade re-export 不得复制第二份实现。
  assert.equal(
    createMemoryVisibilityProposalRegistry,
    proposalsModule.createMemoryVisibilityProposalRegistry,
  );

  const facadeSource = readFileSync(
    new URL("../modules/application/local-record-service.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    facadeSource.includes('from "./local-record-visibility-proposals.ts"'),
    "facade 必须 import local-record-visibility-proposals.ts",
  );
  assert.ok(
    !/function createMemoryVisibilityProposalRegistry/.test(facadeSource),
    "facade 不得再自行定义 createMemoryVisibilityProposalRegistry",
  );
  assert.ok(
    !/interface VisibilityProposalRegistry/.test(facadeSource),
    "facade 不得再自行定义 VisibilityProposalRegistry",
  );
  assert.ok(
    !/interface VisibilityProposalEntry/.test(facadeSource),
    "facade 不得再自行定义 VisibilityProposalEntry",
  );
  assert.ok(
    !/VISIBILITY_PROPOSAL_TTL_MS/.test(facadeSource),
    "facade 不得再持有 proposal TTL 常量",
  );

  const moduleSource = readFileSync(
    new URL("../modules/application/local-record-visibility-proposals.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/from\s+["'][^"']*local-record-service/.test(moduleSource)
      && !/import\(\s*["'][^"']*local-record-service/.test(moduleSource),
    "新模块不得反向 import local-record-service",
  );
});

test("issue：restricted 提案字段完整（id/audience/names/reason）", () => {
  const registry = createRegistry({ randomToken: () => "proposal-1" });
  const proposal = issueDefault(registry, {
    audienceNames: ["洛川", "塞娜"],
  });
  assert.deepEqual(proposal, {
    proposalId: "proposal-1",
    kind: "restricted",
    audienceCharacterInstanceIds: ["char_inst_player", "char_inst_scout"],
    audienceNames: ["洛川", "塞娜"],
    reason: "密函内容只宜让在场者知晓。",
  });
});

test("issue：audienceNames 缺省回退 demo 名册，未知角色显示占位名", () => {
  const registry = createRegistry({ randomToken: () => "proposal-2" });
  const proposal = issueDefault(registry, {
    assessment: {
      visibility: {
        kind: "restricted",
        domainId: "domain_private",
        audienceCharacterInstanceIds: ["char_inst_player", "char_inst_unknown"],
      },
      reason: "密函内容只宜让在场者知晓。",
    },
  });
  assert.deepEqual(proposal.audienceNames, ["洛川", "未知角色"]);
});

test("issue：非 restricted 评估 fail-closed", () => {
  const registry = createRegistry();
  expectInvalidVisibilityConfirmation(
    () =>
      issueDefault(registry, {
        assessment: {
          visibility: { kind: "public" },
          reason: "",
        },
      }),
    "Only a restricted visibility assessment can be confirmed.",
  );
});

test("authorize：合法确认返回完整 entry（assessment/reason/版本/内容）", () => {
  const registry = createRegistry({ randomToken: () => "proposal-3" });
  const proposal = issueDefault(registry);
  const entry = registry.authorize({
    proposalId: proposal.proposalId,
    scope: SCOPE,
    canonicalVersion: 7,
    content: "我悄悄拆开密函。",
    idempotencyKey: "cmd-1",
  });
  assert.deepEqual(entry.assessment, RESTRICTED_ASSESSMENT.visibility);
  assert.equal(entry.reason, RESTRICTED_ASSESSMENT.reason);
  assert.equal(entry.canonicalVersion, 7);
  assert.equal(entry.content, "我悄悄拆开密函。");
});

test("authorize：未知 proposalId fail-closed（missing/expired/mismatch 文案）", () => {
  const registry = createRegistry();
  expectInvalidVisibilityConfirmation(
    () =>
      registry.authorize({
        proposalId: "missing",
        scope: SCOPE,
        canonicalVersion: 7,
        content: "我悄悄拆开密函。",
        idempotencyKey: "cmd-1",
      }),
    "The visibility confirmation is missing, expired, or no longer matches this draft.",
  );
});

test("authorize：scope/canonicalVersion/content 任一不符均 fail-closed", () => {
  const registry = createRegistry({ randomToken: () => "proposal-4" });
  const proposal = issueDefault(registry);
  const base = {
    proposalId: proposal.proposalId,
    scope: SCOPE,
    canonicalVersion: 7,
    content: "我悄悄拆开密函。",
    idempotencyKey: "cmd-1",
  };
  const message =
    "The visibility confirmation is missing, expired, or no longer matches this draft.";
  expectInvalidVisibilityConfirmation(
    () => registry.authorize({ ...base, scope: { ...SCOPE, recordId: "record-other" } }),
    message,
  );
  expectInvalidVisibilityConfirmation(
    () => registry.authorize({ ...base, canonicalVersion: 8 }),
    message,
  );
  expectInvalidVisibilityConfirmation(
    () => registry.authorize({ ...base, content: "我当众拆开密函。" }),
    message,
  );
});

test("bind 后：同 key 重放允许，跨 key authorize/bind 拒绝", () => {
  const registry = createRegistry({ randomToken: () => "proposal-5" });
  const proposal = issueDefault(registry);
  registry.bind(proposal.proposalId, "cmd-1");
  // 同 key 重复 bind 幂等。
  registry.bind(proposal.proposalId, "cmd-1");
  // 同 key authorize（重放）允许。
  const entry = registry.authorize({
    proposalId: proposal.proposalId,
    scope: SCOPE,
    canonicalVersion: 7,
    content: "我悄悄拆开密函。",
    idempotencyKey: "cmd-1",
  });
  assert.equal(entry.canonicalVersion, 7);

  const alreadyUsed = "The visibility confirmation was already used by another Command.";
  expectInvalidVisibilityConfirmation(
    () =>
      registry.authorize({
        proposalId: proposal.proposalId,
        scope: SCOPE,
        canonicalVersion: 7,
        content: "我悄悄拆开密函。",
        idempotencyKey: "cmd-2",
      }),
    alreadyUsed,
  );
  expectInvalidVisibilityConfirmation(
    () => registry.bind(proposal.proposalId, "cmd-2"),
    alreadyUsed,
  );
});

test("bind：未知或过期 proposalId fail-closed（missing/expired 文案）", () => {
  const registry = createRegistry();
  expectInvalidVisibilityConfirmation(
    () => registry.bind("missing", "cmd-1"),
    "The visibility confirmation is missing or expired.",
  );
});

test("TTL：过期后 authorize 与 bind 均 fail-closed", () => {
  let now = 1_000;
  const registry = createRegistry({
    clock: () => new Date(now),
    randomToken: () => "proposal-6",
    ttlMs: 60_000,
  });
  const proposal = issueDefault(registry);
  now += 61_000;
  expectInvalidVisibilityConfirmation(
    () =>
      registry.authorize({
        proposalId: proposal.proposalId,
        scope: SCOPE,
        canonicalVersion: 7,
        content: "我悄悄拆开密函。",
        idempotencyKey: "cmd-1",
      }),
    "The visibility confirmation is missing, expired, or no longer matches this draft.",
  );
  expectInvalidVisibilityConfirmation(
    () => registry.bind(proposal.proposalId, "cmd-1"),
    "The visibility confirmation is missing or expired.",
  );
});
