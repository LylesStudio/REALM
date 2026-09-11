import { useEffect, useRef, useState } from "react";
import {
  mergeDraftPatch,
  type GenesisChatPhase,
  type GenesisChatTurn,
} from "../../modules/application/genesis-chat-contract.ts";
import type { WorldGenesisDraft } from "../../modules/application/world-genesis-contract.ts";
import {
  WORLD_STYLE_KEYS,
  worldStyleText,
  type WorldStyle,
} from "../../modules/style/world-style.ts";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";

export interface GuidedGenesisChatProps {
  uiLanguage: UiLanguage;
  playerName: string;
  /** 落笔入界：走既有 POST /api/world/generate draft 分支（单事务原子）。 */
  onConfirm: (draft: WorldGenesisDraft) => Promise<string | null>;
  onOpenRecord: (recordId: string) => void;
  /** fail-closed 降级：转旧八步表单。 */
  onFallback: () => void;
  onExit: () => void;
}

const EMPTY_COMPANION = { name: "", role: "", summary: "" };

/**
 * 批次 S · 司卷对谈：LLM 引导创世。
 * 自由对话 → 世界提案卡（可就地编辑）→ 落笔入界。
 * fail-closed：任何模型失败提示「司卷暂时沉默」，可重试或转旧表单，
 * 绝不阻塞创建。
 */
export function GuidedGenesisChat({
  uiLanguage,
  playerName,
  onConfirm,
  onOpenRecord,
  onFallback,
  onExit,
}: GuidedGenesisChatProps) {
  const [turns, setTurns] = useState<GenesisChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [silent, setSilent] = useState(false);
  const [draft, setDraft] = useState<WorldGenesisDraft | null>(null);
  const [, setPhase] = useState<GenesisChatPhase>("exploring");
  const [confirming, setConfirming] = useState(false);
  const opened = useRef(false);
  const pendingMessage = useRef("");
  const threadRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<WorldGenesisDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  async function send(message: string) {
    if (busy || confirming) return;
    setBusy(true);
    setSilent(false);
    pendingMessage.current = message;
    try {
      const response = await fetch("/api/world/genesis-chat", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          transcript: turns,
          draft: draftRef.current,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            reply?: unknown;
            draftPatch?: unknown;
            phase?: unknown;
            opening?: unknown;
          }
        | null;
      if (!response.ok || !payload || payload.ok !== true || typeof payload.reply !== "string") {
        throw new Error("scribe silent");
      }
      const nextTurns: GenesisChatTurn[] = [...turns];
      const trimmed = message.trim();
      if (trimmed) nextTurns.push({ role: "user", content: trimmed.slice(0, 500) });
      nextTurns.push({ role: "scribe", content: payload.reply.slice(0, 1000) });
      setTurns(nextTurns);
      setInput("");
      pendingMessage.current = "";

      const nextPhase: GenesisChatPhase =
        payload.phase === "proposing" || payload.phase === "ready"
          ? payload.phase
          : "exploring";
      setPhase(nextPhase);

      if (payload.draftPatch !== null && payload.draftPatch !== undefined) {
        const merged = mergeDraftPatch(draftRef.current, payload.draftPatch);
        if (merged) {
          const opening = typeof payload.opening === "string"
            ? payload.opening.trim().slice(0, 300)
            : "";
          setDraft(opening ? { ...merged, opening } : merged);
        }
      } else if (typeof payload.opening === "string" && payload.opening.trim()) {
        const opening = payload.opening.trim().slice(0, 300);
        setDraft((current) => (current ? { ...current, opening } : current));
      }
    } catch {
      setSilent(true);
    } finally {
      setBusy(false);
    }
  }

  // 开场：挂载即请司卷发问（首轮 message 为空）。
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void send("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [turns, busy, silent]);

  function patchDraft(updater: (current: WorldGenesisDraft) => WorldGenesisDraft) {
    setDraft((current) => (current ? updater(current) : current));
  }

  async function confirm() {
    if (!draft || confirming) return;
    if (!draft.world.name.trim()) return;
    setConfirming(true);
    const recordId = await onConfirm(draft);
    if (recordId) {
      onOpenRecord(recordId);
      return;
    }
    setConfirming(false);
  }

  const scribeName = uiText("ui.genesisChat.scribe", uiLanguage);
  const youName = playerName.trim() || uiText("ui.genesisChat.you", uiLanguage);

  return (
    <div className="guided-genesis-chat">
      <header className="guided-heading">
        <div>
          <p className="eyebrow">{uiText("ui.genesisChat.eyebrow", uiLanguage)}</p>
          <h2>{uiText("ui.genesisChat.title", uiLanguage)}</h2>
        </div>
        <button onClick={onExit} type="button">
          {uiText("ui.genesisChat.close", uiLanguage)}
        </button>
      </header>

      <div className="genesis-chat-body">
        <section className="genesis-chat-thread" aria-label={uiText("ui.genesisChat.title", uiLanguage)}>
          <div className="genesis-chat-scroll" ref={threadRef}>
            {turns.map((turn, index) => (
              <div
                className={`chat-turn ${turn.role === "user" ? "is-user" : "is-scribe"}`}
                key={`${turn.role}-${index}`}
              >
                <strong>{turn.role === "user" ? youName : scribeName}</strong>
                <p>{turn.content}</p>
              </div>
            ))}
            {busy ? (
              <div className="chat-turn is-thinking" role="status">
                <strong>{scribeName}</strong>
                <p>{uiText("ui.genesisChat.sending", uiLanguage)}</p>
              </div>
            ) : null}
            {silent ? (
              <div className="genesis-chat-silent" role="alert">
                <p>{uiText("ui.genesisChat.silent", uiLanguage)}</p>
                <div>
                  <button onClick={() => void send(pendingMessage.current)} type="button">
                    {uiText("ui.genesisChat.retry", uiLanguage)}
                  </button>
                  <button onClick={onFallback} type="button">
                    {uiText("ui.genesisChat.fallback", uiLanguage)}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <form
            className="genesis-chat-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (input.trim()) void send(input);
            }}
          >
            <input
              onChange={(event) => setInput(event.target.value)}
              disabled={busy || confirming}
              maxLength={500}
              placeholder={uiText("ui.genesisChat.placeholder", uiLanguage)}
              type="text"
              value={input}
            />
            <button disabled={busy || confirming || !input.trim()} type="submit">
              {busy
                ? uiText("ui.genesisChat.sending", uiLanguage)
                : uiText("ui.genesisChat.send", uiLanguage)}
            </button>
          </form>
        </section>

        {draft ? (
          <section className="genesis-proposal-card" aria-label={uiText("ui.genesisChat.proposalEyebrow", uiLanguage)}>
            <p className="eyebrow">{uiText("ui.genesisChat.proposalEyebrow", uiLanguage)}</p>
            <div className="genesis-proposal-fields">
              <label>
                <span>世界之名</span>
                <input
                  maxLength={40}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      world: { ...current.world, name: event.target.value },
                    }))}
                  value={draft.world.name}
                />
              </label>
              <label>
                <span>纪元基调</span>
                <input
                  maxLength={40}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      world: { ...current.world, era: event.target.value },
                    }))}
                  value={draft.world.era}
                />
              </label>
              <label className="is-wide">
                <span>世界底色</span>
                <textarea
                  maxLength={300}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      world: { ...current.world, summary: event.target.value },
                    }))}
                  rows={2}
                  value={draft.world.summary}
                />
              </label>
              <div className="is-wide">
                <span>文风</span>
                <div className="guided-style-options" role="group">
                  {WORLD_STYLE_KEYS.map((key) => (
                    <button
                      className={draft.style === key ? "guided-style-option is-active" : "guided-style-option"}
                      key={key}
                      onClick={() =>
                        patchDraft((current) => ({ ...current, style: key as WorldStyle }))}
                      type="button"
                    >
                      {worldStyleText(`guided.style.${key}`, key as WorldStyle, undefined, uiLanguage)}
                    </button>
                  ))}
                </div>
              </div>
              <label>
                <span>开篇故事</span>
                <input
                  maxLength={60}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      story: { ...current.story, title: event.target.value },
                    }))}
                  value={draft.story.title}
                />
              </label>
              <label>
                <span>记录之名</span>
                <input
                  maxLength={60}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      record: { title: event.target.value },
                    }))}
                  value={draft.record.title}
                />
              </label>
              <label className="is-wide">
                <span>故事缘起</span>
                <textarea
                  maxLength={300}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      story: { ...current.story, premise: event.target.value },
                    }))}
                  rows={2}
                  value={draft.story.premise}
                />
              </label>
              <label className="is-wide">
                <span>你的定位</span>
                <input
                  maxLength={60}
                  onChange={(event) =>
                    patchDraft((current) => ({ ...current, playerRole: event.target.value }))}
                  value={draft.playerRole}
                />
              </label>

              <div className="is-wide" role="group" aria-label={uiText("ui.stance.label", uiLanguage)}>
                <span>{uiText("ui.stance.label", uiLanguage)}</span>
                <div className="stance-options">
                  <button
                    className={draft.playerStance !== "observer" ? "stance-option is-active" : "stance-option"}
                    onClick={() => patchDraft((current) => ({ ...current, playerStance: "player" }))}
                    type="button"
                  >
                    <strong>{uiText("ui.stance.player", uiLanguage)}</strong>
                    <small>{uiText("ui.stance.playerHint", uiLanguage)}</small>
                  </button>
                  <button
                    className={draft.playerStance === "observer" ? "stance-option is-active" : "stance-option"}
                    onClick={() => patchDraft((current) => ({ ...current, playerStance: "observer" }))}
                    type="button"
                  >
                    <strong>{uiText("ui.stance.observer", uiLanguage)}</strong>
                    <small>{uiText("ui.stance.observerHint", uiLanguage)}</small>
                  </button>
                </div>
              </div>

              <div className="is-wide">
                <span>同行之人（≤2）</span>
                {draft.companions.map((companion, index) => (
                  <div className="companion-row" key={`companion-${index}`}>
                    <input
                      maxLength={24}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          companions: current.companions.map((item, i) =>
                            i === index ? { ...item, name: event.target.value } : item),
                        }))}
                      placeholder="名字"
                      value={companion.name}
                    />
                    <input
                      maxLength={40}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          companions: current.companions.map((item, i) =>
                            i === index ? { ...item, role: event.target.value } : item),
                        }))}
                      placeholder="定位"
                      value={companion.role}
                    />
                    <input
                      maxLength={120}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          companions: current.companions.map((item, i) =>
                            i === index ? { ...item, summary: event.target.value } : item),
                        }))}
                      placeholder="一句话侧写"
                      value={companion.summary}
                    />
                    <button
                      aria-label="移除同行者"
                      onClick={() =>
                        patchDraft((current) => ({
                          ...current,
                          companions: current.companions.filter((_, i) => i !== index),
                        }))}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {draft.companions.length < 2 ? (
                  <button
                    className="companion-add"
                    onClick={() =>
                      patchDraft((current) => ({
                        ...current,
                        companions: [...current.companions, { ...EMPTY_COMPANION }],
                      }))}
                    type="button"
                  >
                    ＋ 添一名同行者
                  </button>
                ) : null}
              </div>

              <div className="is-wide">
                <span>初始场景</span>
                <div className="scene-grid">
                  <input
                    maxLength={60}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        scene: { ...current.scene, location: event.target.value },
                      }))}
                    placeholder="地点"
                    value={draft.scene.location}
                  />
                  <input
                    maxLength={60}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        scene: { ...current.scene, weather: event.target.value },
                      }))}
                    placeholder="天气"
                    value={draft.scene.weather}
                  />
                  <input
                    maxLength={60}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        scene: { ...current.scene, tension: event.target.value },
                      }))}
                    placeholder="局势"
                    value={draft.scene.tension}
                  />
                  <input
                    maxLength={120}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        scene: { ...current.scene, objective: event.target.value },
                      }))}
                    placeholder="目标"
                    value={draft.scene.objective}
                  />
                </div>
              </div>

              <label className="is-wide">
                <span>{uiText("ui.genesisChat.openingEyebrow", uiLanguage)}</span>
                <textarea
                  maxLength={300}
                  onChange={(event) =>
                    patchDraft((current) => ({ ...current, opening: event.target.value }))}
                  rows={3}
                  value={draft.opening}
                />
              </label>
            </div>

            <p className="genesis-proposal-hint">{uiText("ui.genesisChat.editHint", uiLanguage)}</p>
            <button
              className="genesis-proposal-confirm"
              disabled={confirming || !draft.world.name.trim()}
              onClick={() => void confirm()}
              type="button"
            >
              {confirming
                ? uiText("ui.genesisChat.confirming", uiLanguage)
                : uiText("ui.genesisChat.confirm", uiLanguage)}
            </button>
          </section>
        ) : null}
      </div>
    </div>
  );
}
