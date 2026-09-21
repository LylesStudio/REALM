/**
 * 项目 prompt 预算测量（一次性脚本，不入测试门）。
 *
 * 用既有 fake-gateway 形态驱动真实 model-powered 回合链（plan→draft→
 * validate），记录每次模型调用的 system/user 字符数、整回合总量、以及
 * 单次调用内的重复长段（≥120 字符的完全相同片段）。不调用真实 provider，
 * 不记录正文内容（只记录长度与重复计数）。
 *
 * 用法：node --experimental-strip-types scripts/prompt-budget-baseline.mjs
 */
import { createModelPoweredM2TurnOrchestrator } from "../modules/orchestration/model-powered.ts";
import { createDeterministicActionResolver } from "../modules/actions/public.ts";

const calls = [];
const jsonResponse = (payload) => ({
  model: "fake-model",
  content: JSON.stringify(payload),
  toolCalls: [],
  finishReason: "stop",
  usage: null,
});

let narratorAttempts = 0;
const fakeGateway = {
  async discoverModels() {
    return [];
  },
  async chat(request) {
    const system = request.messages[0]?.content ?? "";
    const user = request.messages.slice(1).map((message) => message.content ?? "").join("\n\n");
    // 单次调用内的重复块检测（空行分隔的 [Label] 块粒度）。
    const blocks = user.split("\n\n").filter((block) => block.length >= 120);
    const seen = new Set();
    let dupBlocks = 0;
    for (const block of blocks) {
      if (seen.has(block)) dupBlocks += 1;
      seen.add(block);
    }
    calls.push({
      tools: request.tools?.length ?? 0,
      systemChars: system.length,
      userChars: user.length,
      dupBlocks,
    });
    if (system.includes("DM Controller")) {
      return jsonResponse({
        goal: "呈现玩家观察密函的公开结果",
        activatedCharacterInstanceIds: ["scout-instance"],
        narratorEnabled: true,
      });
    }
    if (system.includes("independent Narrator")) {
      narratorAttempts += 1;
      return jsonResponse({
        environment: narratorAttempts === 1 ? "谨慎的斥候将密函递向灯光。" : "冷雾沿石阶向上漫开。",
        storyBeat: "evidence_deepens_suspicion",
      });
    }
    if (system.includes("thinking only as the character")) {
      // propose 阶段：无工具调用 = 无状态变化动作。
      return jsonResponse({});
    }
    if (system.includes("You speak only as the character")) {
      return jsonResponse({ action: "塞娜收回触碰蜡封的手。", dialogue: "“这封蜡不对劲。”", recipientId: null });
    }
    if (system.includes("DM output reviewer")) {
      return jsonResponse({ accepted: true, goalSatisfied: true, worldCompatible: true });
    }
    throw new Error(`Unexpected model call: ${system.slice(0, 120).replaceAll("\n", " ⏎ ")}`);
  },
};

const orchestrator = createModelPoweredM2TurnOrchestrator({
  characters: [{
    characterInstanceId: "scout-instance",
    participantId: "scout-participant",
    displayName: "塞娜",
  }],
  getGateway: async () => fakeGateway,
  recallMemory: async () => "- 塞娜此前见过完好的蜡封。",
  characterSkillProvider: {
    async listSkills() {
      return [{
        skillKey: "careful_observation",
        title: "细致观察",
        description: "在不破坏目标的前提下辨认细微痕迹。",
      }];
    },
  },
  actionResolver: createDeterministicActionResolver({ allowStatefulReceipts: true }),
});

const input = { turnId: "turn-budget", playerText: "请塞娜看看蜡封。" };
const plan = await orchestrator.plan(input);
const candidate = await orchestrator.draft({ ...input, plan });
await orchestrator.validate({ plan, candidate });

let totalSystem = 0;
let totalUser = 0;
for (const [index, call] of calls.entries()) {
  totalSystem += call.systemChars;
  totalUser += call.userChars;
  console.log(`call#${index + 1}: system=${call.systemChars}ch user=${call.userChars}ch tools=${call.tools} dupBlocks=${call.dupBlocks}`);
}
console.log(`turn total: ${calls.length} calls, system=${totalSystem}ch, user=${totalUser}ch, sum=${totalSystem + totalUser}ch`);
