/**
 * fake OpenAI-compatible provider 契约测试（纯本机，零外部调用）。
 *
 * 钉住：loopback-only 绑定、OS 分配临时端口、/v1/models 与
 * /v1/chat/completions（stream + non-stream）、阶段注册表指纹分发、
 * 未知路由/未知阶段 fail-closed、非法请求 4xx、日志零泄漏（prompt/
 * header/key/body 一律不记）、stop() 释放端口。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakeOpenAiProvider,
  FAKE_PROVIDER_MODEL,
  REALM_FAKE_STAGE_FIXTURES,
} from "./helpers/fake-openai-provider.mjs";

test("fake provider: 只绑 loopback 临时端口；/v1/models 返回确定模型清单", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  assert.equal(new URL(provider.baseUrl).hostname, "127.0.0.1");
  assert.ok(Number(provider.port) > 0);
  assert.ok(provider.baseUrl.endsWith("/v1"));

  const response = await fetch(`${provider.baseUrl}/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "list");
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((model) => model.id === FAKE_PROVIDER_MODEL));
});

test("fake provider: non-stream chat 返回 OpenAI 形状 JSON（探针阶段）", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: FAKE_PROVIDER_MODEL,
      messages: [
        { role: "system", content: "You are REALM's model connectivity probe." },
        { role: "user", content: "Check the connection. Respond with the JSON object only." },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, FAKE_PROVIDER_MODEL);
  const content = body.choices?.[0]?.message?.content;
  assert.equal(typeof content, "string");
  assert.deepEqual(JSON.parse(content), { ok: true });
});

test("fake provider: stream=true 返回 SSE delta 序列并以 [DONE] 结束", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: FAKE_PROVIDER_MODEL,
      stream: true,
      messages: [
        { role: "system", content: "You are REALM's model connectivity probe." },
        { role: "user", content: "probe" },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const raw = await response.text();
  const frames = raw.split("\n\n").map((chunk) => chunk.trim()).filter(Boolean);
  assert.equal(frames.at(-1), "data: [DONE]");
  let joined = "";
  for (const frame of frames.slice(0, -1)) {
    assert.ok(frame.startsWith("data: "), `SSE 帧必须以 data: 开头: ${frame.slice(0, 40)}`);
    const payload = JSON.parse(frame.slice(6));
    joined += payload.choices?.[0]?.delta?.content ?? "";
  }
  assert.deepEqual(JSON.parse(joined), { ok: true });
});

test("fake provider: 阶段注册表按 system 指纹分发确定 fixture", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const chat = async (system) => {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: FAKE_PROVIDER_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: "ignored context" },
        ],
      }),
    });
    assert.equal(response.status, 200);
    return JSON.parse((await response.json()).choices[0].message.content);
  };
  const visibility = await chat("You are REALM's DM Controller; your only job here is to judge the information visibility of this player input.");
  assert.equal(visibility.visibility, "public");
  const plan = await chat("You are REALM's DM Controller; your only job is to choose which characters to activate this turn and to define the goal.");
  assert.equal(typeof plan.goal, "string");
  assert.deepEqual(plan.activatedCharacterInstanceIds, []);
  const review = await chat("You are REALM's DM output reviewer; you do not write prose.");
  assert.equal(review.accepted, true);
  const narrator = await chat("You are the independent Narrator: you narrate only the public environment, public action outcomes, and light story movement.");
  assert.equal(typeof narrator.environment, "string");
  assert.ok(Array.isArray(narrator.suggestions));
  const character = await chat("You are thinking only as the character identified in the [Character] context block — no one else.");
  assert.equal(typeof character.dialogue, "string");
  const characterReact = await chat("You speak only as the character identified in the [Character] context block — no one else.");
  assert.equal(typeof characterReact.action, "string");
  const presence = await chat("You are REALM's presence gate: after a player turn is submitted, you only decide whether any character who has not yet spoken deserves a brief spontaneous reaction.");
  assert.equal(presence.shouldSpeak, false);
  // 注册表条目与内置 fixture 同源（消费方不得另造一份）。
  assert.ok(REALM_FAKE_STAGE_FIXTURES.length >= 8);
});

test("fake provider: 场景结晶的抽取与裁决阶段可确定性接线", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const chat = async (system) => {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: FAKE_PROVIDER_MODEL,
        messages: [{ role: "system", content: system }],
      }),
    });
    assert.equal(response.status, 200);
    return JSON.parse((await response.json()).choices[0].message.content);
  };
  assert.deepEqual(await chat("You are REALM's setting extractor."), {});
  const verdict = await chat("You are REALM's logical-consistency adjudicator.");
  assert.equal(verdict.approved, true);
  assert.equal(typeof verdict.reason, "string");
});

test("fake provider: 未知阶段 fail-closed 422；日志不泄漏 prompt/header/key/body", async (t) => {
  const logLines = [];
  const provider = await createFakeOpenAiProvider({
    logger: (line) => logLines.push(line),
  });
  t.after(() => provider.stop());
  const canary = "CANARY-SECRET-PROMPT-7f3a";
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fixture-test-token",
    },
    body: JSON.stringify({
      model: FAKE_PROVIDER_MODEL,
      messages: [
        { role: "system", content: `You are an unregistered stage. ${canary}` },
        { role: "user", content: canary },
      ],
    }),
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error?.code, "FAKE_STAGE_UNKNOWN");
  assert.ok(!JSON.stringify(body).includes(canary), "错误响应不得回显请求内容");
  const joined = logLines.join("\n");
  assert.ok(!joined.includes(canary), "日志不得出现 prompt 原文");
  assert.ok(!/«redacted:api-key»/i.test(joined), "日志不得出现 API key");
  assert.ok(!/authorization/i.test(joined), "日志不得出现 header 名值");
});

test("fake provider: 未知路由 404 / 错误方法 405 / 未知模型 400 / 非法 JSON 400", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const unknownRoute = await fetch(`${provider.baseUrl}/engines`);
  assert.equal(unknownRoute.status, 404);
  const wrongMethod = await fetch(`${provider.baseUrl}/chat/completions`);
  assert.equal(wrongMethod.status, 405);
  const postModels = await fetch(`${provider.baseUrl}/models`, { method: "POST" });
  assert.equal(postModels.status, 405);
  const unknownModel = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "someone/else",
      messages: [{ role: "system", content: "You are REALM's model connectivity probe." }],
    }),
  });
  assert.equal(unknownModel.status, 400);
  const malformed = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(malformed.status, 400);
});

test("fake provider: 对已声明 Actor Tool 返回标准 OpenAI tool_calls 结构", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: FAKE_PROVIDER_MODEL,
      tools: [{
        type: "function",
        function: { name: "act", description: "act", parameters: { type: "object" } },
      }],
      messages: [{ role: "system", content: "You are REALM's actor tool-call fixture test." }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  const call = body.choices[0].message.tool_calls?.[0];
  assert.equal(call?.type, "function");
  assert.equal(call?.function?.name, "act");
  assert.deepEqual(JSON.parse(call.function.arguments), {
    intent: "look toward the lighthouse",
    targetId: null,
    approach: "careful",
  });
});

test("fake provider: 场景结晶按当前玩家输入选择确定 delta", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const extract = async (userContent) => {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: FAKE_PROVIDER_MODEL,
        messages: [
          { role: "system", content: "You are REALM's setting extractor." },
          { role: "user", content: userContent },
        ],
      }),
    });
    assert.equal(response.status, 200);
    return JSON.parse((await response.json()).choices[0].message.content);
  };
  assert.deepEqual(await extract("[Player's exact words]\n我们离开空地，赶到山脚下的灯塔值房避雪，外面的雪越下越大。"), {
    location: "山脚下的灯塔值房",
    weather: "大雪",
  });
  assert.deepEqual(await extract("[Player's exact words]\n这里好安静。"), {});
  assert.deepEqual(await extract("[Player's exact words]\n现在是新历40年3月2日的正午，我们在营地清点行囊，准备出发。"), {
    displayTime: "新历40年3月2日正午",
  });
  assert.deepEqual(await extract("[Player's exact words]\n时间倒流回新历40年3月1日的清晨，太阳重新升起来了。"), {
    displayTime: "新历40年3月1日清晨",
  });
  const historicalContext = [
    '[Current scene state]\n{"displayTime":"新历40年3月2日正午"}',
    "[Player's exact words]\n时间倒流回新历40年3月1日的清晨，太阳重新升起来了。",
    "[Recent public dialogue]\n上一回合确认了新历40年3月2日的正午。",
  ].join("\n\n");
  assert.deepEqual(await extract(historicalContext), {
    displayTime: "新历40年3月1日清晨",
  });
});

test("fake provider: M2 对倒退到先前日期的候选场景作拒绝裁决", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: FAKE_PROVIDER_MODEL,
      messages: [
        { role: "system", content: "You are REALM's logical-consistency adjudicator." },
        {
          role: "user",
          content: [
            '[Current scene state]\n{"displayTime":"新历40年3月2日正午"}',
            '[Candidate delta]\n{"displayTime":"新历40年3月1日清晨"}',
            "[Player's exact words]\n时间倒流回新历40年3月1日的清晨，太阳重新升起来了。",
            "[This turn's narration]\n太阳重新升起来了。",
          ].join("\n\n"),
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse((await response.json()).choices[0].message.content), {
    approved: false,
    reason: "时间不能倒退到先前日期。",
    adjusted: null,
  });
});

test("fake provider: 并发请求互不影响；stop() 释放端口", async () => {
  const provider = await createFakeOpenAiProvider();
  const probe = () => fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: FAKE_PROVIDER_MODEL,
      messages: [{ role: "system", content: "You are REALM's model connectivity probe." }],
    }),
  });
  const [a, b] = await Promise.all([probe(), probe()]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const port = provider.port;
  await provider.stop();
  await assert.rejects(fetch(`${provider.baseUrl}/models`), "停止后端口必须关闭");
  assert.ok(port > 0);
});

test("fake provider: genesis-chat 阶段返回合法司卷应答（reply/phase/draftPatch/opening）", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: FAKE_PROVIDER_MODEL,
      messages: [
        {
          role: "system",
          content: "You are REALM's Scribe, guiding a player through free-form conversation to write a new world into being.",
        },
        { role: "user", content: "[Player's exact words]\n我想写一座沉在湖底的旧钟楼。" },
      ],
    }),
  });
  assert.equal(response.status, 200, "genesis-chat 阶段必须已注册（T1 onboarding 旅程依赖）");
  const body = await response.json();
  const reply = JSON.parse(body.choices?.[0]?.message?.content ?? "null");
  assert.equal(typeof reply.reply, "string");
  assert.ok(reply.reply.trim().length > 0, "reply 非空");
  assert.equal(reply.phase, "ready", "fixture 必须直接给出可定稿提案");
  assert.equal(typeof reply.draftPatch?.world?.name, "string");
  assert.ok(reply.draftPatch.world.name.length > 0 && reply.draftPatch.world.name.length <= 40);
  assert.ok(Array.isArray(reply.draftPatch.companions) && reply.draftPatch.companions.length >= 1);
  assert.equal(typeof reply.draftPatch.scene?.location, "string");
  assert.equal(typeof reply.opening, "string");
  assert.ok(reply.opening.trim().length > 0, "phase=ready 必须带 opening");
});

test("fake provider: first-night 阶段角色名单从请求确定（derive），场景/钩子符合生产 schema", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const call = async (companionsBlock) => {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: FAKE_PROVIDER_MODEL,
        messages: [
          {
            role: "system",
            content: "You are REALM's first-night writer. A world has just been written into being; write the first frozen frame of its opening scene.",
          },
          {
            role: "user",
            content: `[World proposal]\n{"world":"雾钟湖城"}\n\n[Companions]\n${companionsBlock}`,
          },
        ],
      }),
    });
    assert.equal(response.status, 200, "first-night 阶段必须已注册（T1 初夜旅程依赖）");
    const body = await response.json();
    return JSON.parse(body.choices?.[0]?.message?.content ?? "null");
  };
  const withCompanion = await call(JSON.stringify([{ name: "灶娘甲乙", role: "面馆掌勺", summary: "听得懂夜行人没说出口的话。" }]));
  assert.ok(withCompanion.scene?.environment?.trim(), "scene.environment 非空");
  assert.ok(withCompanion.scene?.story?.trim(), "scene.story 非空");
  assert.ok(withCompanion.scene?.fact?.trim(), "scene.fact 非空");
  assert.deepEqual(
    withCompanion.characters?.map((entry) => entry.name),
    ["灶娘甲乙"],
    "characters 必须逐一来自请求的同行者名单（不得虚构名字）",
  );
  assert.ok(withCompanion.characters[0].utterance?.trim(), "utterance 非空");
  assert.ok(withCompanion.hook?.content?.trim(), "hook.content 非空");
  assert.ok(Array.isArray(withCompanion.hook.suggestions) && withCompanion.hook.suggestions.length >= 2,
    "hook.suggestions ≥2");
  for (const suggestion of withCompanion.hook.suggestions) {
    assert.ok(suggestion.length <= 60, "suggestion ≤60 字");
  }

  const solo = await call(JSON.stringify("none — the player travels alone"));
  assert.deepEqual(solo.characters, [], "无同行者时 characters 必须为空数组");
});

test("fake provider: genesis-chat 故障注入——marker 请求确定失败、正常请求仍成功、日志零 marker", async (t) => {
  const logLines = [];
  const provider = await createFakeOpenAiProvider({ logger: (line) => logLines.push(line) });
  t.after(() => provider.stop());
  const system = "You are REALM's Scribe, guiding a player through free-form conversation to write a new world into being.";
  const call = (userText) => fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: FAKE_PROVIDER_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `[Transcript]\n[]\n\n[Player message]\n${userText}` },
      ],
    }),
  });
  // marker 请求：确定的 provider 失败（创世 fallback 旅程的故障注入）。
  const failed = await call("GUI故障注入-改用分步引导");
  assert.equal(failed.status, 503, "marker 请求必须确定的 503");
  const failedBody = await failed.json();
  assert.equal(failedBody.error?.code, "FAKE_PROVIDER_DOWN");
  assert.ok(!JSON.stringify(failedBody).includes("GUI故障注入"), "错误响应不得回显 marker");
  // 无 marker 请求：正常 genesis-chat fixture 仍成功。
  const ok = await call("随便聊聊灯塔");
  assert.equal(ok.status, 200, "正常 genesis-chat 请求不受故障 fixture 影响");
  const okBody = await ok.json();
  const reply = JSON.parse(okBody.choices?.[0]?.message?.content ?? "null");
  assert.equal(reply.phase, "ready");
  // 日志只含方法/路径/阶段/状态码，绝不含 marker/请求正文。
  assert.ok(logLines.some((line) => line.includes("genesis-chat-fail")));
  for (const line of logLines) {
    assert.ok(!line.includes("GUI故障注入"), "日志不得含 marker");
    assert.ok(!line.includes("随便聊聊"), "日志不得含请求正文");
  }
});

test("fake provider: visibility 密谋分支——悄悄/低声输入返回 restricted，普通输入仍 public", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const call = (playerText) => fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: FAKE_PROVIDER_MODEL,
      messages: [
        { role: "system", content: "You are REALM's DM Controller; your only job here is to judge the information visibility of this player input." },
        { role: "user", content: `[Player input]\n${playerText}` },
      ],
    }),
  });
  // D 组密谋文本：restricted + 真实 demo 受众实例。
  const secret = await call("我悄悄对塞娜说：不要让其他人听到，密函先由我来保管。");
  assert.equal(secret.status, 200);
  const secretBody = JSON.parse((await secret.json()).choices[0].message.content);
  assert.equal(secretBody.visibility, "restricted", "密谋输入必须判定 restricted（驱动 428 提案）");
  assert.deepEqual(secretBody.audienceCharacterInstanceIds, ["char_inst_scout"]);
  const whisper = await call("我低声只告诉弥洛：信函上的铭文不要声张。");
  const whisperBody = JSON.parse((await whisper.json()).choices[0].message.content);
  assert.equal(whisperBody.visibility, "restricted");
  assert.deepEqual(whisperBody.audienceCharacterInstanceIds, ["char_inst_scholar"]);
  // 普通输入不触发密谋分支。
  const open = await call("这里好安静。");
  const openBody = JSON.parse((await open.json()).choices[0].message.content);
  assert.equal(openBody.visibility, "public");
});

test("fake provider: presence-gate 在场分支——T3 观察输入触发一次应声，普通输入仍沉默", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const call = (peerText) => fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: FAKE_PROVIDER_MODEL,
      messages: [
        { role: "system", content: "You are REALM's presence gate: after a player turn is submitted, you only decide whether any character who has not yet spoken deserves a brief spontaneous reaction." },
        { role: "user", content: `[Peer words and deeds]\n${peerText}\n\n[Candidate characters]\n[{"characterInstanceId":"char_inst_scout","displayName":"塞娜"}]` },
      ],
    }),
  });
  const speak = await call("[Environment and story material]\n潮声忽然停了一拍，雾里的灯塔光柱转了半格。");
  assert.equal(speak.status, 200);
  const speakBody = JSON.parse((await speak.json()).choices[0].message.content);
  assert.equal(speakBody.shouldSpeak, true, "T3 观察输入必须触发一次在场应声");
  assert.equal(speakBody.characterInstanceId, "char_inst_scout");
  assert.equal(speakBody.triggerKind, "environment");
  const silent = await call("这里好安静。");
  const silentBody = JSON.parse((await silent.json()).choices[0].message.content);
  assert.equal(silentBody.shouldSpeak, false, "普通输入不得触发在场应声");
});
