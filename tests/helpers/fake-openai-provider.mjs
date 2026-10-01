/**
 * 确定性离线 fake OpenAI-compatible provider（仅测试用途）。
 *
 * - 只绑 127.0.0.1、OS 分配临时端口；零外部网络依赖。
 * - 只实现 REALM 用到的两个端点：GET /v1/models、POST /v1/chat/completions
 *   （非流式 JSON + SSE delta 流，[DONE] 结束）。
 * - 结构化应用调用走阶段注册表：按 system 消息指纹分发固定 fixture；
 *   未知阶段 fail-closed 422（FAKE_STAGE_UNKNOWN），不静默兜底。
 * - 日志只写方法/路径/阶段 id/状态码；绝不记录 prompt、header、API key
 *   或响应正文。
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";

/** system 提示的安全指纹（sha256 前 12 位 hex）：只用于测试日志对齐阶段，不可逆推原文。 */
export function stageFingerprint(systemContent) {
  return createHash("sha256").update(systemContent).digest("hex").slice(0, 12);
}

export const FAKE_PROVIDER_MODEL = "realm/fake-deterministic-v0";

/**
 * REALM 回合/设置链路的内置阶段 fixture（指纹 = system 消息特征子串）。
 * 与 tests/fake-openai-provider.test.mjs 的契约一一对应；新增阶段必须先
 * 加测试再注册。
 */
export const REALM_FAKE_STAGE_FIXTURES = [
  {
    id: "settings-probe",
    match: "model connectivity probe",
    body: { ok: true },
  },
  {
    // D 组密谋分支（须在通用 visibility 之前）：玩家明确私下/低声对特定
    // 角色说话 → restricted + 真实 demo 受众实例（塞娜=scout / 弥洛=scholar）。
    id: "visibility-secret-scout",
    match: "judge the information visibility of this player input",
    userContentMatch: "悄悄",
    body: {
      visibility: "restricted",
      audienceCharacterInstanceIds: ["char_inst_scout"],
      reason: "玩家明确私下对塞娜说话。",
    },
  },
  {
    id: "visibility-secret-scholar",
    match: "judge the information visibility of this player input",
    userContentMatch: "低声只告诉",
    body: {
      visibility: "restricted",
      audienceCharacterInstanceIds: ["char_inst_scholar"],
      reason: "玩家明确只告诉弥洛。",
    },
  },
  {
    id: "visibility",
    match: "judge the information visibility of this player input",
    body: {
      visibility: "public",
      audienceCharacterInstanceIds: [],
      reason: "玩家输入是公开内容。",
    },
  },
  {
    // T3 在场分支（须在通用 presence-gate 之前）：玩家对场景变化做实质
    // 观察 → 应声一次（triggerKind=environment）。characterInstanceId 必须从
    // 请求的 [Candidate characters] 名单取（新记录的实例 id 是运行时分配
    // 的，写死 demo 实例 id 会被生产的越候选双保险正确拒绝）。
    id: "presence-gate-speak",
    match: "presence gate",
    userContentMatch: "潮声忽然停了一拍",
    derive: (_systemContent, messages) => {
      const user = latestUserText(messages);
      const block = extractContextBlock(user, "Candidate characters");
      let first = null;
      try {
        const candidates = JSON.parse(block);
        if (Array.isArray(candidates)) {
          first = candidates.find(
            (entry) => typeof entry?.characterInstanceId === "string" && entry.characterInstanceId.length > 0,
          ) ?? null;
        }
      } catch {
        first = null;
      }
      if (!first) return undefined;
      return {
        shouldSpeak: true,
        characterInstanceId: first.characterInstanceId,
        triggerKind: "environment",
        reason: "玩家对雾气与灯塔做了实质观察，值得一次应声。",
      };
    },
  },
  {
    id: "presence-gate",
    match: "presence gate",
    body: {
      shouldSpeak: false,
      characterInstanceId: null,
      triggerKind: null,
      reason: "没有角色需要插话。",
    },
  },
  {
    id: "dm-plan",
    match: "choose which characters to activate this turn",
    body: {
      goal: "玩家环顾四周，场面安静推进。",
      activatedCharacterInstanceIds: [],
      narratorEnabled: true,
    },
  },
  {
    id: "dm-review",
    match: "DM output reviewer",
    body: { accepted: true, goalSatisfied: true, worldCompatible: true },
  },
  {
    // T3 在场旅程：特定观察输入 → 独特环境文案（供 presence-gate 分支识别）。
    id: "narrator-t3-presence",
    match: "independent Narrator",
    userMatch: "我沿着防波堤慢慢走",
    body: {
      environment: "潮声忽然停了一拍，雾里的灯塔光柱转了半格。",
      storyBeat: "港口的钟声远远传来，第三下之后归于安静。",
      suggestions: ["我停下脚步听潮声。", "我望向灯塔的光柱。", "我继续前行。"],
    },
  },
  {
    id: "narrator",
    match: "independent Narrator",
    body: {
      environment: "冷雾贴着防波堤缓缓移动，远处灯塔的光暗了一瞬。",
      storyBeat: "港口的钟声远远传来，第三下之后归于安静。",
      suggestions: [
        "我沿着防波堤继续往前走。",
        "我停下来，仔细听钟声的方向。",
        "我回头看来时的路。",
      ],
    },
  },
  {
    id: "character-draft",
    match: "thinking only as the character",
    body: {
      action: "微微颔首，没有说话。",
      dialogue: "……",
      recipientId: null,
    },
  },
  {
    id: "character-react",
    match: "You speak only as the character identified",
    body: {
      action: "微微颔首，没有说话。",
      dialogue: "……",
      recipientId: null,
    },
  },
  {
    id: "scene-extraction-m1",
    match: "You are REALM's setting extractor",
    userMatch: "灯塔值房避雪",
    body: { location: "山脚下的灯塔值房", weather: "大雪" },
  },
  {
    id: "scene-extraction-m2-anchor",
    match: "You are REALM's setting extractor",
    userMatch: "新历40年3月2日的正午",
    body: { displayTime: "新历40年3月2日正午" },
  },
  {
    id: "scene-extraction-m2-regression",
    match: "You are REALM's setting extractor",
    userMatch: "新历40年3月1日的清晨",
    body: { displayTime: "新历40年3月1日清晨" },
  },
  {
    id: "scene-extraction",
    match: "You are REALM's setting extractor",
    body: {},
  },
  {
    id: "scene-adjudication-m2-reject",
    match: "You are REALM's logical-consistency adjudicator",
    userMatch: "新历40年3月1日的清晨",
    body: {
      approved: false,
      reason: "时间不能倒退到先前日期。",
      adjusted: null,
    },
  },
  {
    id: "scene-adjudication",
    match: "You are REALM's logical-consistency adjudicator",
    body: {
      approved: true,
      reason: "No conflicting scene change.",
      adjusted: null,
    },
  },
  {
    id: "actor-tool-call-contract",
    match: "actor tool-call fixture test",
    body: {},
    toolCalls: [{
      id: "call-fake-act",
      name: "act",
      arguments: {
        intent: "look toward the lighthouse",
        targetId: null,
        approach: "careful",
      },
    }],
  },
  {
    // 故障注入（创世 fallback 旅程）：user 内容含精确 marker 的请求返回
    // 确定的 provider 失败；必须置于 genesis-chat 成功 fixture 之前。
    // 只影响该请求；日志/响应只含阶段 id 与状态码（不含 marker/正文）。
    id: "genesis-chat-fail",
    match: "guiding a player through free-form conversation",
    userContentMatch: "GUI故障注入-改用分步引导",
    fail: { status: 503, code: "FAKE_PROVIDER_DOWN" },
  },
  {
    // 司卷对谈（T1 onboarding 旅程）：每轮直接给出可定稿完整提案——
    // 确定性 fixture，草案字段全部在 genesis-chat-contract 的 sanitize 上限内。
    id: "genesis-chat",
    match: "guiding a player through free-form conversation",
    body: {
      reply: "我把这座世界先记成这样一版，你再改哪一笔都行。",
      phase: "ready",
      draftPatch: {
        language: "zh-CN",
        world: {
          name: "雾钟湖城",
          era: "钟鸣纪",
          summary: "旧钟楼沉在湖底，钟声仍能穿水而行，听者以钟声辨认方向。",
        },
        story: {
          title: "水下钟声",
          premise: "听得见静默的旅人来到湖边，正赶上钟声第一次中断。",
        },
        record: { title: "钟声初断之夜" },
        playerRole: "听得见静默的旅人",
        playerStance: "player",
        companions: [
          { name: "阿汐", role: "湖岸灯塔的值夜人", summary: "熟悉水路与钟声的回音，寡言却可靠。" },
        ],
        scene: {
          location: "湖岸旧码头",
          weather: "浓雾",
          tension: "远处钟声忽断",
          objective: "弄清钟声为何中断",
        },
        opening: "浓雾压着湖面，旧钟楼的影子在水下轻轻晃动。你抵达旧码头时，第三声钟响刚刚散去。",
      },
      opening: "浓雾压着湖面，旧钟楼的影子在水下轻轻晃动。你抵达旧码头时，第三声钟响刚刚散去。",
    },
  },
  {
    // 创世手稿（l-genesis 灵感→手稿等一键创世路径）：完整合法草稿，
    // 字段全部在 world-genesis-contract 的 GENESIS_LIMITS 内。
    id: "world-genesis",
    match: "You are REALM's genesis scribe.",
    body: {
      language: "zh-CN",
      world: {
        name: "雾钟湖城",
        era: "钟鸣纪",
        summary: "旧钟楼沉在湖底，钟声仍能穿水而行，听者以钟声辨认方向。",
      },
      story: {
        title: "水下钟声",
        premise: "听得见静默的旅人来到湖边，正赶上钟声第一次中断。",
      },
      record: { title: "钟声初断之夜" },
      playerRole: "听得见静默的旅人",
      companions: [
        { name: "阿汐", role: "湖岸灯塔的值夜人", summary: "熟悉水路与钟声的回音，寡言却可靠。" },
      ],
      scene: {
        location: "湖岸旧码头",
        weather: "浓雾",
        tension: "远处钟声忽断",
        objective: "弄清钟声为何中断",
      },
    },
  },
  {
    // 分步代笔（N3 等引导创建旅程）：按生产 user 消息的
    // [Task for this step] 指令文本识别七个 step，返回各 step 的有效
    // payload（经 normalizeGenesisSuggestions 验证）；未知/缺失任务
    // 返回 undefined → 与未知阶段同规 fail-closed 422，绝不宽泛兜底。
    id: "genesis-suggestions",
    match: "writing a new world with the player one guided step at a time",
    derive: (_systemContent, messages) => {
      const task = extractContextBlock(latestUserText(messages), "Task for this step");
      if (!task) return undefined;
      if (task.startsWith("Offer 3 world-name candidates")) {
        return { suggestions: ["雾钟湖城", "沉钟旧港", "听澜城"] };
      }
      if (task.startsWith("Offer 3 era or epoch-mood candidates")) {
        return { suggestions: ["钟鸣纪", "潮落之年", "灯塔余晖"] };
      }
      if (task.startsWith("Offer 3 one-sentence world-essence candidates")) {
        return {
          suggestions: [
            "旧钟楼沉在湖底，钟声仍能穿水而行。",
            "雾里灯影为迷途的航船记账。",
            "渡口夜市以秘密换一碗热面。",
          ],
        };
      }
      if (task.startsWith("Offer 3 opening-story candidates")) {
        return {
          suggestions: [
            { title: "水下钟声", premise: "听得见静默的旅人来到湖边，正赶上钟声第一次中断。" },
            { title: "渡口夜面", premise: "夜行人用一段秘密换一碗面，今晚的秘密格外沉重。" },
          ],
        };
      }
      if (task.startsWith("Offer 3 player-role candidates")) {
        return { suggestions: ["听得见静默的旅人", "替灯塔守夜的外乡人", "渡口面馆的熟客"] };
      }
      if (task.startsWith("Offer 1–2 original companion characters")) {
        return {
          suggestions: [
            { name: "阿汐", role: "湖岸灯塔的值夜人", summary: "熟悉水路与钟声的回音，寡言却可靠。" },
          ],
        };
      }
      if (task.startsWith("Offer an initial-scene candidate")) {
        return {
          suggestions: [{
            location: ["湖岸旧码头"],
            weather: ["浓雾"],
            tension: ["远处钟声忽断"],
            objective: ["弄清钟声为何中断"],
          }],
        };
      }
      return undefined;
    },
  },
  {
    // 初夜包（T1 落笔后异步触发）：characters 必须逐一来自请求上下文中的
    // 同行者名单（生产要求 name 精确匹配），因此用 derive 从请求数据确定，
    // 绝不虚构名字；场景/钩子为固定 fixture（符合 first-night schema）。
    id: "first-night",
    match: "You are REALM's first-night writer.",
    derive: (_systemContent, messages) => {
      const companions = firstNightCompanionNames(messages);
      return {
        scene: {
          environment: "雾气贴着水面停在码头木桩之间，灯影只照亮脚前三步。",
          story: "远处的钟声没有按时响起，湖面上只剩下水拍石岸的声音。",
          fact: "值夜的灯还亮着，说明守灯的人刚刚离开不久。",
        },
        characters: companions.map((name) => ({
          name,
          utterance: "钟声是在你进门前一刻停的，我听得真切。",
          action: "抬手按住灯座，目光越过你望向黑下来的湖面。",
        })),
        hook: {
          content: "今晚第一班渡船没有靠岸，码头登记簿上却多了一行陌生名字。",
          suggestions: [
            "我去码头登记簿前查清那行陌生名字。",
            "我向守灯人打听钟声中断前听到的动静。",
            "我沿湖岸走向钟声最后传来的方向。",
          ],
        },
      };
    },
  },
];

function currentPlayerInput(messages) {
  const content = latestUserText(messages);
  const marker = "[Player's exact words]\n";
  const start = content.lastIndexOf(marker);
  if (start < 0) return content;
  const bodyStart = start + marker.length;
  const nextBlock = content.indexOf("\n\n[", bodyStart);
  return content.slice(bodyStart, nextBlock < 0 ? undefined : nextBlock).trim();
}

function latestUserText(messages) {
  const latestUserContent = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  return typeof latestUserContent?.content === "string"
    ? latestUserContent.content
    : "";
}

/** 提取 `[Label]` context block 的正文（生产 prompt-kit 同构格式）。 */
function extractContextBlock(text, label) {
  const marker = `[${label}]\n`;
  const start = text.indexOf(marker);
  if (start < 0) return "";
  const bodyStart = start + marker.length;
  const nextBlock = text.indexOf("\n\n[", bodyStart);
  return text.slice(bodyStart, nextBlock < 0 ? undefined : nextBlock).trim();
}

/**
 * first-night 请求上下文中的同行者名单（`[Companions]` context block 为
 * JSON 数组；`"none — the player travels alone"` 等形态 => 空）。
 * 只取合法字符串名字（截断到生产 sanitize 上限 24 字符）。
 */
function firstNightCompanionNames(messages) {
  const user = latestUserText(messages);
  const marker = "[Companions]\n";
  const start = user.indexOf(marker);
  if (start < 0) return [];
  const bodyStart = start + marker.length;
  const nextBlock = user.indexOf("\n\n[", bodyStart);
  const raw = user.slice(bodyStart, nextBlock < 0 ? undefined : nextBlock).trim();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => (typeof entry?.name === "string" ? entry.name.trim() : ""))
      .filter((name) => name.length > 0)
      .map((name) => name.slice(0, 24))
      .slice(0, 2);
  } catch {
    return [];
  }
}

function stageFor(systemContent, messages) {
  const playerInput = currentPlayerInput(messages);
  const userText = latestUserText(messages);
  return REALM_FAKE_STAGE_FIXTURES.find((stage) =>
    systemContent.includes(stage.match)
    && (!stage.userMatch || playerInput.includes(stage.userMatch))
    && (!stage.userContentMatch || userText.includes(stage.userContentMatch))
  );
}

function sseFrames(content, model) {
  // 切成几个 delta 块，模拟真实增量流。
  const chunks = [];
  const step = Math.max(8, Math.ceil(content.length / 4));
  for (let index = 0; index < content.length; index += step) {
    chunks.push(content.slice(index, index + step));
  }
  const lines = chunks.map((chunk) =>
    `data: ${JSON.stringify({
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content: chunk } }],
    })}\n\n`
  );
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

/**
 * 启动 fake provider。
 * @param {{ logger?: (line: string) => void }} [options]
 * @returns {Promise<{ baseUrl: string, port: number, stop: () => Promise<void> }>}
 */
export async function createFakeOpenAiProvider(options = {}) {
  const log = options.logger ?? (() => {});
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const finish = (status, payload, stageId = "-") => {
      // 日志只含方法/路径/阶段 id/状态码——绝不写 prompt/header/key/body。
      log(`${request.method} ${url.pathname} stage=${stageId} -> ${status}`);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (url.pathname === "/v1/models") {
      if (request.method !== "GET") {
        finish(405, { error: { code: "METHOD_NOT_ALLOWED" } });
        return;
      }
      finish(200, {
        object: "list",
        data: [{
          id: FAKE_PROVIDER_MODEL,
          object: "model",
          created: 0,
          owned_by: "realm-fake",
        }],
      }, "models");
      return;
    }
    if (url.pathname !== "/v1/chat/completions") {
      finish(404, { error: { code: "UNKNOWN_ROUTE" } });
      return;
    }
    if (request.method !== "POST") {
      finish(405, { error: { code: "METHOD_NOT_ALLOWED" } });
      return;
    }
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        finish(400, { error: { code: "INVALID_JSON" } });
        return;
      }
      if (body?.model !== FAKE_PROVIDER_MODEL) {
        finish(400, { error: { code: "UNKNOWN_MODEL" } });
        return;
      }
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const systemContent = messages
        .filter((message) => message?.role === "system")
        .map((message) => String(message.content ?? ""))
        .join("\n\n");
      const stage = stageFor(systemContent, messages);
      if (!stage) {
        // 未知阶段：日志/响应只带不可逆指纹，便于测试对齐注册表（不回显原文）。
        finish(422, { error: { code: "FAKE_STAGE_UNKNOWN", stageHash: stageFingerprint(systemContent) } }, `unknown-fp-${stageFingerprint(systemContent)}`);
        return;
      }
      if (stage.fail) {
        // 故障注入 fixture：确定的失败响应（不含请求内容）。
        finish(stage.fail.status, { error: { code: stage.fail.code } }, stage.id);
        return;
      }
      const fixtureToolCalls = Array.isArray(stage.toolCalls) ? stage.toolCalls : [];
      const requestedToolNames = new Set(
        (Array.isArray(body?.tools) ? body.tools : [])
          .map((tool) => tool?.function?.name)
          .filter((name) => typeof name === "string"),
      );
      if (fixtureToolCalls.some((call) => !requestedToolNames.has(call.name))) {
        finish(422, { error: { code: "FAKE_TOOL_NOT_REQUESTED" } }, stage.id);
        return;
      }
      if (body.stream === true && fixtureToolCalls.length > 0) {
        finish(400, { error: { code: "FAKE_TOOL_STREAM_UNSUPPORTED" } }, stage.id);
        return;
      }
      const resolvedBody = stage.derive
        ? stage.derive(systemContent, messages)
        : stage.body;
      if (resolvedBody === undefined) {
        // derive fail-closed（如未识别的分步任务）：与未知阶段同规 422。
        finish(422, { error: { code: "FAKE_STAGE_UNKNOWN", stageHash: stageFingerprint(systemContent) } }, `unknown-fp-${stageFingerprint(systemContent)}`);
        return;
      }
      const content = fixtureToolCalls.length > 0
        ? null
        : JSON.stringify(resolvedBody);
      if (body.stream === true) {
        log(`${request.method} ${url.pathname} stage=${stage.id} -> 200 (stream)`);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.end(sseFrames(content ?? "", FAKE_PROVIDER_MODEL));
        return;
      }
      const message = { role: "assistant", content };
      if (fixtureToolCalls.length > 0) {
        message.tool_calls = fixtureToolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        }));
      }
      finish(200, {
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 0,
        model: FAKE_PROVIDER_MODEL,
        choices: [{
          index: 0,
          message,
          finish_reason: fixtureToolCalls.length > 0 ? "tool_calls" : "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }, stage.id);
    });
    request.on("error", () => {
      response.destroy();
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) {
    server.close();
    throw new Error("fake provider failed to acquire an ephemeral port");
  }
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    stop: () =>
      new Promise((resolveStop) => {
        server.close(() => resolveStop());
        server.closeIdleConnections?.();
      }),
  };
}
