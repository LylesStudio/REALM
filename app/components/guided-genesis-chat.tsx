import { useEffect, useRef, useState } from "react";
import { GenesisDraftFields } from "./genesis-draft-fields";
import { goalDraftsValid } from './record-goal-fields.tsx';
import {
  applyGenesisFieldEdits,
  diffEditedGenesisFields,
  mergeDraftPatch,
  type GenesisChatPhase,
  type GenesisChatTurn,
} from "../../modules/application/genesis-chat-contract.ts";
import {
  type WorldGenesisDraft,
} from "../../modules/application/world-genesis-contract.ts";
import { normalizeUiLanguage, uiText, type UiLanguage } from "../../modules/i18n/public.ts";

export interface GuidedGenesisChatProps {
  uiLanguage: UiLanguage;
  playerName: string;
  /** 创建结果无法确认时显示安全提示，不透传服务端原始错误。 */
  creationError?: string | null;
  /** 创建世界：走既有 POST /api/world/generate draft 分支（单事务原子）。 */
  onConfirm: (draft: WorldGenesisDraft) => Promise<string | null>;
  onOpenRecord: (recordId: string) => void;
  /** fail-closed 降级：转旧八步表单（携带对谈上下文，见 GenesisChatFallback）。 */
  onFallback: (payload: GenesisChatFallback) => void;
  onExit: () => void;
}

/**
 * 改用分步引导时随 overlay 移交的对谈上下文：已提交 turns（次序）、
 * 输入框中未发送文本（独立、不伪装成历史 turn）、当前完整草案。
 */
export interface GenesisChatFallback {
  turns: GenesisChatTurn[];
  input: string;
  draft: WorldGenesisDraft | null;
}

/**
 * 批次 S · AI 助手对话：LLM 引导创世。
 * 自由对话 → 世界提案卡（可就地编辑）→ 创建世界。
 * fail-closed：任何模型失败给出安全提示，可重试或改用分步引导，
 * 绝不阻塞创建。
 */
export function GuidedGenesisChat({
  uiLanguage,
  playerName,
  creationError = null,
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
  const busyRef = useRef(false);
  const confirmingRef = useRef(false);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const pendingMessage = useRef("");
  const threadRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<WorldGenesisDraft | null>(null);
  // 批次 B7：组件卸载（含切 fallback）后忽略迟到的响应，绝不污染新界面。
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
      busyRef.current = false;
      opened.current = false;
    };
  }, []);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  async function send(message: string) {
    if (busyRef.current || confirmingRef.current) return;
    busyRef.current = true;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setSilent(false);
    pendingMessage.current = message;
    // 批次 B7：记录请求发出时的草稿快照——响应回来时，用户在在途期间
    // 手改过的字段以用户值为准，模型 patch 只落在未冲突字段上。
    const sentDraft = draftRef.current;
    try {
      const response = await fetch("/api/world/genesis-chat", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          language: uiLanguage,
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
      if (!aliveRef.current || generation !== generationRef.current) return;
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

      // 批次 A1：opening 的 canonical 位置是 draftPatch.opening；顶层
      // opening 仅是兼容回显（服务端已并入 patch），这里按 patch 合并，
      // 不再用 truthy 顶层值覆盖草稿。
      const currentDraft = draftRef.current;
      if (payload.draftPatch !== null && payload.draftPatch !== undefined) {
        const merged = mergeDraftPatch(currentDraft, payload.draftPatch);
        if (merged && aliveRef.current) {
          const edited = diffEditedGenesisFields(sentDraft, currentDraft);
          const preserved = applyGenesisFieldEdits(merged, currentDraft, edited);
          // 批次 B12：界面语言稳定进入 canonical draft（模型未显式给时补）。
          const nextDraft = preserved.language
            ? preserved
            : { ...preserved, language: normalizeUiLanguage(uiLanguage) };
          draftRef.current = nextDraft;
          setDraft(nextDraft);
        }
      }
    } catch {
      if (aliveRef.current && generation === generationRef.current && !controller.signal.aborted) setSilent(true);
    } finally {
      if (aliveRef.current && generation === generationRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  // 开场：挂载即请 AI 助手发问（首轮 message 为空）。
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
    const current = draftRef.current;
    if (current && !confirmingRef.current) {
      const next = updater(current);
      draftRef.current = next;
      setDraft(next);
    }
  }

  async function confirm() {
    // 批次 B8：对话在途（busy）/提交在途（confirming）都不得创建——
    // 避免迟到响应覆盖刚提交的草稿快照。可创建规则与后端一致：草稿有效
    // （世界名非空）即可，proposing/ready 均可创建（phase 不是门控依据）。
    if (!draft || confirmingRef.current || busyRef.current) return;
    if (!draft.world.name.trim() || !goalDraftsValid(draft.recordGoals)) return;
    confirmingRef.current = true;
    setConfirming(true);
    try {
      const recordId = await onConfirm(draft);
      if (recordId && aliveRef.current) onOpenRecord(recordId);
    } finally {
      confirmingRef.current = false;
      if (aliveRef.current) setConfirming(false);
    }
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
                  <button onClick={() => onFallback({ turns, input, draft })} type="button">
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
              aria-label={uiText("ui.genesisChat.inputLabel", uiLanguage)}
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
            <GenesisDraftFields draft={draft} patchDraft={patchDraft} uiLanguage={uiLanguage} disabled={confirming} />

            <p className="genesis-proposal-hint">{uiText("ui.genesisChat.editHint", uiLanguage)}</p>
            {creationError ? (
              <div className="guided-suggest-error guided-create-error" role="alert">
                <p>{creationError}</p>
              </div>
            ) : null}
            <button
              className="genesis-proposal-confirm"
              disabled={confirming || busy || !draft.world.name.trim() || !goalDraftsValid(draft.recordGoals)}
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
