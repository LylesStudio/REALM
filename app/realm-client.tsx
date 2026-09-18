"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { EventTimeline } from "./components/event-timeline";
import { BranchTreePanel } from "./components/branch-tree-panel";
import { LobbyPanel } from "./components/lobby-panel";
import { LanguageMenu } from "./components/language-menu.tsx";
import {
  DEMO_IDS,
  demoAffordanceText,
  demoEventText,
  localizeDemoLibrary,
  demoRecordTitle,
  demoSceneText,
  demoStoryText,
  demoWorldText,
} from "./demo-content.ts";
import { ThemeToggle } from "./components/theme-toggle.tsx";
import { KnowledgeGraphPanel } from "./components/knowledge-graph-panel";
import { createMemoryRefreshScheduler } from "./memory-refresh";
import { LibraryPanel } from "./components/library-panel";
import {
  normalizeLibrarySnapshot,
  type LibraryCreateCommand,
  type LibrarySnapshot,
} from "./components/library-types";
import { MessageComposer } from "./components/message-composer";
import { PendingSubmission } from "./components/pending-submission";
import { PreviewCards } from "./components/preview-cards";
import type { WorldGenesisDraft } from "../modules/application/world-genesis-contract.ts";
import type {
  GenesisSuggestions,
  GuidedGenesisStep,
} from "../modules/application/genesis-suggestions.ts";
import { GuidedGenesis } from "./components/guided-genesis";
import { GuidedGenesisChat } from "./components/guided-genesis-chat";
import { WorldOnboarding } from "./components/world-onboarding";
import { normalizeWorldStyle } from "../modules/style/world-style.ts";
import {
  normalizeUiLanguage,
  uiText,
  type UiLanguage,
} from "../modules/i18n/public.ts";
import {
  readUiLanguage,
  subscribeUiLanguage,
} from "./ui-language.ts";
import {
  createOptimisticEvent,
  lastCommittedOrdinal,
  normalizeCommittedEventPayload,
  normalizeRecordEnvelope,
  normalizeVisibilityProposal,
  recordEnvelopesEqual,
  upsertCommittedEvent,
  type RecordEnvelope,
  type RecordProjection,
  type VisibilityProposal,
} from "./components/record-types";
import { SceneInspector } from "./components/scene-inspector";
import { StoryView } from "./components/story-view";
import { WorldNavigation } from "./components/world-navigation";
import { WorldView } from "./components/world-view";

type LoadState = "loading" | "ready" | "error" | "onboarding";
type StreamState = "connecting" | "live" | "reconnecting";
/** 批次 T12-C：主区页面级视图（记录 / 世界 / 故事）。 */
type MainView = "record" | "world" | "story";

function normalizeMainView(value: unknown): MainView {
  return value === "world" || value === "story" ? value : "record";
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  return response.json();
}

function errorMessage(payload: unknown, fallback: string): string {
  let message: string | null = null;
  let diagnostic: Record<string, unknown> | null = null;
  if (typeof payload === "string" && payload.trim()) {
    message = payload.trim();
  } else if (typeof payload === "object" && payload !== null) {
    const value = payload as Record<string, unknown>;
    const directMessage = value.message;
    const directError = value.error;
    if (typeof directMessage === "string" && directMessage.trim()) {
      message = directMessage.trim();
    } else if (typeof directError === "string" && directError.trim()) {
      message = directError.trim();
    } else if (typeof directError === "object" && directError !== null) {
      const nested = directError as Record<string, unknown>;
      if (typeof nested.message === "string" && nested.message.trim()) {
        message = nested.message.trim();
      }
      if (typeof nested.diagnostic === "object" && nested.diagnostic !== null) {
        diagnostic = nested.diagnostic as Record<string, unknown>;
      }
    }
    if (typeof value.diagnostic === "object" && value.diagnostic !== null) {
      diagnostic = value.diagnostic as Record<string, unknown>;
    }
  }
  if (!diagnostic) return message ?? fallback;
  const stageLabels: Record<string, string> = {
    visibility: "可见性判断",
    planning: "回合规划",
    drafting: "内容生成",
    validating: "结构化验证",
    releasing: "写入提交",
  };
  const stage = typeof diagnostic.stage === "string"
    ? stageLabels[diagnostic.stage] ?? diagnostic.stage
    : "未知阶段";
  const code = typeof diagnostic.code === "string" ? diagnostic.code : "UNKNOWN";
  const detail = `诊断：${stage} / ${code}`;
  if (message && message.includes(code) && message.includes(stage)) return message;
  return message ? `${message}（${detail}）` : `${fallback}（${detail}）`;
}

export function RealmClient() {
  const [envelope, setEnvelope] = useState<RecordEnvelope | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  // 批次 L：生成中暂存位内容（null=无在途提交）。
  const [pendingSubmission, setPendingSubmission] = useState<{
    id: string;
    content: string;
  } | null>(null);
  const [selfPlayBusy, setSelfPlayBusy] = useState(false);
  const [recordActionBusy, setRecordActionBusy] = useState(false);
  const [retrospectionConfirm, setRetrospectionConfirm] = useState(false);
  const [visibilityProposal, setVisibilityProposal] =
    useState<VisibilityProposal | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  // 批次 T12-C：主区视图状态；初始恒为 record（SSR/hydration 安全），
  // 挂载后从 ?view= 同步，切换时写回 URL（刷新/深链不丢视图）。
  const [mainView, setMainViewState] = useState<MainView>("record");
  // 批次 T12 验收修正：故事视图按选中的 story 渲染；null=跟随当前 Record
  // 的故事。深链 ?view=story&storyId= 恢复。
  const [selectedStoryId, setSelectedStoryId] = useState<string | null>(null);
  // 创世 overlay 共享状态模型：onboarding 与世界库（library）两种来源
  // 共用同一套「AI 助手对话（主）/ 分步引导（次）」流程。kind=chat 是
  // 主入口（GuidedGenesisChat），kind=guided 是分步次入口（GuidedGenesis，
  // 同时是 AI 失败的 fallback）；source 决定退出后回到哪个上下文。
  const [creationOverlay, setCreationOverlay] = useState<{
    kind: "chat" | "guided";
    source: "onboarding" | "library";
  } | null>(null);
  /** 游戏大厅 overlay（LAN 约局；与创世 overlay 互斥——打开大厅即收创世）。 */
  const [lobbyOpen, setLobbyOpen] = useState(false);
  /** 邀请深链目标房间（?lobby=<roomId>）；只作导航提示，不作授权依据。 */
  const [lobbyInvite, setLobbyInvite] = useState<string | null>(null);
  // 大厅房主心跳（host lease）：应用打开期间按服务端 meta 告知的频率续租
  // 本人 open 房间；卸载清理 timer；失败静默（大厅面板有独立状态提示；
  // 权威状态永远在服务端）。
  const [lobbyHeartbeatMs, setLobbyHeartbeatMs] = useState(30_000);
  useEffect(() => {
    let cancelled = false;
    const beat = () => {
      void fetch("/api/lobby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "heartbeat" }),
      }).catch(() => undefined);
    };
    const timer = window.setInterval(beat, lobbyHeartbeatMs);
    void fetch("/api/lobby", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const ms = (payload as { meta?: { heartbeatIntervalMs?: unknown } } | null)
          ?.meta?.heartbeatIntervalMs;
        if (!cancelled
          && typeof ms === "number" && Number.isSafeInteger(ms) && ms >= 500
          && ms !== lobbyHeartbeatMs) {
          setLobbyHeartbeatMs(ms);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [lobbyHeartbeatMs]);
  const [playerDisplayName, setPlayerDisplayName] = useState("");
  // 初始恒为默认语言：SSR 与首次客户端渲染必须一致（hydration 安全），
  // 本机语言选择在挂载后的 effect 中同步。
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>("zh-CN");
  const [graphWorld, setGraphWorld] = useState<{ id: string; name: string } | null>(null);
  // 分支树 overlay（world 级只读谱系视图）与「创建分支」对话框状态。
  const [branchWorld, setBranchWorld] = useState<{ id: string; name: string } | null>(null);
  const [branchDialog, setBranchDialog] = useState<{
    idempotencyKey: string;
    forkEventId: string;
    label: string;
    recordTitle: string;
    useEventFork: boolean;
  } | null>(null);
  const [branchError, setBranchError] = useState("");
  const branchHeadRadioRef = useRef<HTMLInputElement | null>(null);
  const branchDialogKey = branchDialog?.idempotencyKey ?? null;
  const [library, setLibrary] = useState<LibrarySnapshot>({ worlds: [] });
  const [cancelKey, setCancelKey] = useState<string | null>(null);
  const [memoryRepresentation, setMemoryRepresentation] = useState("");
  const [memoryRelationships, setMemoryRelationships] = useState("");
  const [isSummarizingMemory, setIsSummarizingMemory] = useState(false);
  const [memoryDepth, setMemoryDepth] =
    useState<"simple" | "balanced" | "immersive">("balanced");
  const [memoryVersion, setMemoryVersion] = useState(0);
  // SSE 只携带新事件，不携带新的 writeToken；事件抵达后合并刷新完整 envelope。
  const recordRefreshTimer = useRef<number | null>(null);
  const memoryRefreshRef = useRef<ReturnType<typeof createMemoryRefreshScheduler> | null>(null);
  const mounted = useRef(true);
  const envelopeRef = useRef<RecordEnvelope | null>(null);

  const projection = envelope?.record ?? null;
  const currentRecordMeta = projection
    ? library.worlds
        .flatMap((world) => world.stories.flatMap((story) => story.records))
        .find((record) => record.id === projection.record.id) ?? null
    : null;
  // 批次 T12-C：当前世界/故事在 Library snapshot 中的条目（世界/故事视图数据源）。
  // 演示世界条目为固定模板内容，随界面语言本地化（仅显示层，回写仍用原文 id 语义）。
  const displayLibrary = localizeDemoLibrary(library, uiLanguage);
  const currentLibraryWorld = projection
    ? displayLibrary.worlds.find((world) => world.id === projection.world.id) ?? null
    : null;
  // 批次 T12 验收修正：故事视图按显式选择渲染，缺省跟随当前 Record 的故事。
  const effectiveStoryId = selectedStoryId ?? projection?.story.id ?? "";
  const selectedLibraryStory = currentLibraryWorld && effectiveStoryId
    ? currentLibraryWorld.stories.find((story) => story.id === effectiveStoryId) ?? null
    : null;
  // 第二层（世界内系统文本）语言跟随当前世界：owners 界面语言的众数，
  // 由交付投影携带；缺省跟随本机界面语言。
  const worldLanguage = normalizeUiLanguage(projection?.world.language)
    ?? uiLanguage;
  // 演示世界例外：固定模板内容随界面语言（三层边界内模板层，契约测试锚定）。
  const timelineLanguage = projection?.world.id === DEMO_IDS.world
    ? uiLanguage
    : worldLanguage;

  const loadLibrary = useCallback(async () => {
    try {
      const response = await fetch("/api/library", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const payload = await readJson(response);
      if (response.ok) setLibrary(normalizeLibrarySnapshot(payload));
    } catch {
      // Library navigation is auxiliary to the active Record.
    }
  }, []);

  async function createLibraryItem(command: LibraryCreateCommand): Promise<boolean> {
    try {
      const response = await fetch("/api/library", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        // 批次 T8：管理命令错误码映射为本地语言提示（其余沿用服务端文案）。
        const code = (payload as { error?: { code?: unknown } } | null)?.error
          ?.code;
        const key = code === "WORLD_ARCHIVED"
          ? "ui.library.errArchived"
          : code === "WORLD_NOT_EMPTY"
            ? "ui.library.errNotEmpty"
            : code === "WORLD_NOT_OWNED"
              ? "ui.library.errNotOwner"
              : code === "WORLD_SELF_PLAY_ACTIVE"
                ? "ui.library.errSelfPlayActive"
                : code === "WORLD_READ_ONLY"
                  ? "ui.library.errReadOnly"
                  : code === "RECORD_SELF_PLAY_ACTIVE"
                  ? "ui.library.errRecordSelfPlay"
                  : code === "RECORD_TURN_ACTIVE"
                    ? "ui.library.errRecordTurnActive"
                    : code === "RECORD_NOT_FOUND"
                      ? "ui.library.errRecordNotFound"
                      : null;
        setNotice(
          key
            ? uiText(key, uiLanguage)
            : errorMessage(payload, "创建失败，请重试。"),
        );
        return false;
      }
      await loadLibrary();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建失败，请重试。");
      return false;
    }
  }

  const loadRecord = useCallback(async (
    recordId = "",
    options: { silent?: boolean } = {},
  ) => {
    if (!options.silent) {
      setLoadState("loading");
      setNotice(null);
    }

    try {
      const query = recordId ? `?recordId=${encodeURIComponent(recordId)}` : "";
      const response = await fetch(`/api/record${query}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(errorMessage(payload, `记录读取失败（${response.status}）`));
      }
      // 批次 S：默认入口无「最近打开」记忆 → onboarding 信号，渲染引导屏。
      if (
        payload !== null
        && typeof payload === "object"
        && (payload as Record<string, unknown>).onboarding === true
      ) {
        if (!mounted.current) return false;
        setEnvelope(null);
        setLoadState("onboarding");
        return false;
      }
      const nextEnvelope = normalizeRecordEnvelope(payload, envelopeRef.current?.record);
      if (!nextEnvelope.writeToken) {
        throw new Error("记录读取成功，但写入授权缺失。请重新进入。");
      }
      if (!mounted.current) return false;
      if (options.silent && recordEnvelopesEqual(nextEnvelope, envelopeRef.current)) {
        return true;
      }
      if (!options.silent) setStreamState("connecting");
      setEnvelope(nextEnvelope);
      setLoadState("ready");
      return true;
    } catch (error) {
      if (!mounted.current) return false;
      if (options.silent) return false;
      setNotice(error instanceof Error ? error.message : "暂时无法读取这段记录。");
      setLoadState("error");
      return false;
    }
  }, []);

  // 批次 T12-C：切换主区视图并写回 URL（保留既有 query，如 recordId）。
  // 批次 T12 验收修正：storyId 随视图状态写回/清除，深链可恢复被选故事。
  function syncViewUrl(next: MainView, storyId: string | null) {
    const url = new URL(window.location.href);
    if (next === "record") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    if (next === "story" && storyId) url.searchParams.set("storyId", storyId);
    else url.searchParams.delete("storyId");
    window.history.replaceState(null, "", url);
  }

  function setMainView(next: MainView) {
    // 顶栏面包屑的故事入口始终指向当前 Record 的故事（清除显式选择）。
    setSelectedStoryId(null);
    setMainViewState(next);
    syncViewUrl(next, null);
  }

  // 批次 T12 验收修正：打开指定故事的页面级视图（世界视图/左栏导航入口）。
  function openStory(storyId: string) {
    setSelectedStoryId(storyId);
    setMainViewState("story");
    syncViewUrl("story", storyId);
  }

  async function openRecord(recordId: string) {
    setLibraryOpen(false);
    setLobbyOpen(false);
    setLobbyInvite(null);
    // 切换 Record 后，面包屑故事入口跟随新 Record 的故事。
    setSelectedStoryId(null);
    setMainViewState("record");
    syncViewUrl("record", null);
    await loadRecord(recordId);
  }

  /** 大厅与世界库是互斥临时面板，避免键盘/辅助技术看到两个 dialog。 */
  function openLibrary() {
    setLobbyOpen(false);
    setLobbyInvite(null);
    setLibraryOpen(true);
  }

  function openLobby() {
    setLibraryOpen(false);
    setLobbyInvite(null);
    setLobbyOpen(true);
  }

  async function duplicateCurrentRecord() {
    if (!projection || recordActionBusy) return;
    setRecordActionBusy(true);
    try {
      const response = await fetch("/api/record/duplicate", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: projection.record.id }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        setNotice(errorMessage(payload, uiText("ui.record.duplicateFailed", uiLanguage)));
        return;
      }
      const recordId = (payload as { recordId?: unknown } | null)?.recordId;
      if (typeof recordId !== "string" || !recordId) {
        setNotice(uiText("ui.record.duplicateFailed", uiLanguage));
        return;
      }
      await loadLibrary();
      await openRecord(recordId);
    } catch (error) {
      setNotice(error instanceof Error
        ? error.message
        : uiText("ui.record.duplicateFailed", uiLanguage));
    } finally {
      setRecordActionBusy(false);
    }
  }

  function openBranchDialog() {
    if (!projection || recordActionBusy) return;
    setBranchError("");
    setBranchDialog({
      // 每次打开对话框生成新幂等键；失败后保留同键重试（重放安全）。
      idempotencyKey: crypto.randomUUID(),
      forkEventId: "",
      label: "",
      recordTitle: "",
      useEventFork: false,
    });
  }

  async function createBranch() {
    if (!projection || !branchDialog || recordActionBusy) return;
    setRecordActionBusy(true);
    setBranchError("");
    try {
      const fork = branchDialog.useEventFork && branchDialog.forkEventId
        ? { eventId: branchDialog.forkEventId }
        : undefined;
      const response = await fetch("/api/record/branch", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          recordId: projection.record.id,
          ...(fork ? { fork } : {}),
          ...(branchDialog.label.trim() ? { label: branchDialog.label.trim() } : {}),
          ...(branchDialog.recordTitle.trim()
            ? { recordTitle: branchDialog.recordTitle.trim() }
            : {}),
          idempotencyKey: branchDialog.idempotencyKey,
        }),
      });
      const payload = await readJson(response);
      const recordId = (payload as { recordId?: unknown } | null)?.recordId;
      if (!response.ok || typeof recordId !== "string" || !recordId) {
        // 失败保留对话框与同幂等键，用户可原样重试。
        setBranchError(uiText("ui.branchDialog.failed", uiLanguage));
        return;
      }
      setBranchDialog(null);
      await loadLibrary();
      await openRecord(recordId);
    } catch {
      setBranchError(uiText("ui.branchDialog.failed", uiLanguage));
    } finally {
      setRecordActionBusy(false);
    }
  }

  useEffect(() => {
    if (!branchDialogKey) return;
    const timer = window.setTimeout(() => branchHeadRadioRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [branchDialogKey]);

  async function commitRetrospection() {
    if (!projection || recordActionBusy || currentRecordMeta?.timelineKind !== "retrospection") return;
    setRecordActionBusy(true);
    try {
      const response = await fetch("/api/record/retrospection/commit", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          recordId: projection.record.id,
          worldId: projection.world.id,
          confirm: true,
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        setNotice(errorMessage(payload, uiText("ui.record.canonizeFailed", uiLanguage)));
        return;
      }
      setRetrospectionConfirm(false);
      setNotice(uiText("ui.record.canonizeDone", uiLanguage));
      await loadLibrary();
      await loadRecord(projection.record.id, { silent: true });
    } catch (error) {
      setNotice(error instanceof Error
        ? error.message
        : uiText("ui.record.canonizeFailed", uiLanguage));
    } finally {
      setRecordActionBusy(false);
    }
  }

  async function confirmWorldGenesis(
    draft: WorldGenesisDraft,
  ): Promise<string | null> {
    try {
      const response = await fetch("/api/world/generate", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ draft }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        setNotice(errorMessage(payload, "创建失败，请重试。"));
        return null;
      }
      await loadLibrary();
      const recordId = (payload as { recordId?: unknown } | null)?.recordId;
      return typeof recordId === "string" && recordId ? recordId : null;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建失败，请重试。");
      return null;
    }
  }

  /** 打开创世 overlay；library 来源先收起世界库（避免双 overlay）。 */
  function openCreation(kind: "chat" | "guided", source: "onboarding" | "library") {
    if (source === "library") setLibraryOpen(false);
    setCreationOverlay({ kind, source });
  }

  /** 退出创世 overlay：回到来源上下文（library 来源重回世界库）。 */
  function closeCreation() {
    const source = creationOverlay?.source;
    setCreationOverlay(null);
    if (source === "library") openLibrary();
  }

  /** 创建成功统一收尾：关闭 overlay；新 record 由组件经 onOpenRecord 打开。 */
  async function confirmCreation(draft: WorldGenesisDraft): Promise<string | null> {
    const recordId = await confirmWorldGenesis(draft);
    if (recordId) setCreationOverlay(null);
    return recordId;
  }

  /** 大厅 overlay（onboarding 与主 session 共用同一渲染）。 */
  function renderLobbyOverlay() {
    if (!lobbyOpen) return null;
    return (
      <div
        aria-label={uiText("ui.lobby.title", uiLanguage)}
        aria-modal="true"
        className="library-overlay"
        role="dialog"
      >
        <LobbyPanel
          uiLanguage={uiLanguage}
          inviteRoomId={lobbyInvite}
          ownWorlds={displayLibrary.worlds
            .filter((world) => world.membershipRole === "owner")
            .map((world) => ({ id: world.id, name: world.name }))}
          onEnterWorld={(worldId) => {
            // 进入房间绑定的共享世界：打开该世界最近的记录；无记录则
            // 打开世界库让用户选（世界库按 membership 已可见）。
            setLobbyOpen(false);
            setLobbyInvite(null);
            const world = library.worlds.find((entry) => entry.id === worldId);
            const records = world?.stories.flatMap((story) => story.records) ?? [];
            const active = records.filter((record) => record.status === "active");
            const target = (active.length > 0 ? active : records).at(-1);
            if (target) {
              void openRecord(target.id);
            } else {
              setLibraryOpen(true);
            }
          }}
          onClose={() => {
            setLobbyOpen(false);
            setLobbyInvite(null);
          }}
        />
      </div>
    );
  }

  /** 两种来源共用的创世 overlay 渲染（chat 主入口 / guided 次入口）。 */
  function renderCreationOverlay() {
    if (!creationOverlay) return null;
    if (creationOverlay.kind === "chat") {
      return (
        <div
          aria-label={uiText("ui.genesisChat.title", uiLanguage)}
          aria-modal="true"
          className="guided-overlay"
          role="dialog"
        >
          <GuidedGenesisChat
            uiLanguage={uiLanguage}
            playerName={playerDisplayName || "旅人"}
            onConfirm={confirmCreation}
            onOpenRecord={openRecord}
            onFallback={() =>
              setCreationOverlay({ kind: "guided", source: creationOverlay.source })}
            onExit={closeCreation}
          />
        </div>
      );
    }
    return (
      <div
        aria-label={uiText("ui.guided.eyebrow", uiLanguage)}
        aria-modal="true"
        className="guided-overlay"
        role="dialog"
      >
        <GuidedGenesis
          uiLanguage={uiLanguage}
          onConfirm={confirmCreation}
          onExit={closeCreation}
          onOpenRecord={openRecord}
          onSuggest={suggestGenesis}
          playerName={playerDisplayName || "旅人"}
        />
      </div>
    );
  }

  /**
   * AI 引导创建 · AI 代写：区分 HTTP 错误 / ok:false / malformed payload，
   * 向上传递安全提示（绝不含 key/URL/连接串/原文）；成功才返回候选。
   */
  async function suggestGenesis(input: {
    step: GuidedGenesisStep;
    intent: string;
    context: Partial<WorldGenesisDraft>;
  }): Promise<{
    suggestions: GenesisSuggestions | null;
    errorMessage: string | null;
  }> {
    const SAFE_MESSAGE = "AI 建议暂时不可用，请检查模型设置或稍后重试。";
    try {
      const response = await fetch("/api/world/suggest", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      const payload = await readJson(response);
      if (!response.ok || !payload || typeof payload !== "object") {
        return { suggestions: null, errorMessage: SAFE_MESSAGE };
      }
      const body = payload as {
        ok?: unknown;
        suggestions?: unknown;
        error?: unknown;
      };
      if (body.ok !== true) {
        return { suggestions: null, errorMessage: SAFE_MESSAGE };
      }
      if (body.suggestions === undefined || body.suggestions === null) {
        return { suggestions: null, errorMessage: SAFE_MESSAGE };
      }
      return { suggestions: body.suggestions as GenesisSuggestions, errorMessage: null };
    } catch {
      return { suggestions: null, errorMessage: SAFE_MESSAGE };
    }
  }

  useEffect(() => {
    mounted.current = true;
    // 批次 S：深链 ?recordId= 直接打开指定记录（引导回跳、测试与分享）。
    // 批次 T12-C：深链 ?view=world|story 恢复页面级视图。
    const searchParams = new URLSearchParams(window.location.search);
    const linkedRecordId = searchParams.get("recordId") ?? "";
    const linkedView = normalizeMainView(searchParams.get("view"));
    const linkedStoryId = searchParams.get("storyId") ?? "";
    // 大厅邀请深链：?lobby=<不透明 roomId> → 打开大厅并定位目标房间；
    // 参数只作导航提示，绝不携带/参与授权。读取后从 URL 剥离（重复打开
    // 链接行为一致；刷新不残留）。
    const inviteRoomId = searchParams.get("lobby") ?? "";
    // effect 已经发生在 hydration 之后；独立请求直接并行启动，避免额外的
    // setTimeout(0) 调度层让首屏多等一个 task。
    // hydration 后把 URL 深链投影到交互状态；服务端首帧仍固定 record。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe URL sync
    setMainViewState(linkedView);
    if (linkedView === "story" && linkedStoryId) {
      setSelectedStoryId(linkedStoryId);
    }
    if (inviteRoomId) {
      setLobbyInvite(inviteRoomId);
      setLobbyOpen(true);
      const cleaned = new URL(window.location.href);
      cleaned.searchParams.delete("lobby");
      window.history.replaceState(null, "", cleaned);
    }
    void loadRecord(linkedRecordId);
    void loadLibrary();
    // 登录昵称仅用于引导展示；门禁未启用时回落为空，由服务端在落库时解析。
    void fetch("/api/auth/me", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (!mounted.current || !payload || typeof payload !== "object") return;
        const name = (payload as Record<string, unknown>).displayName;
        if (typeof name === "string" && name.trim()) setPlayerDisplayName(name.trim());
      })
      .catch(() => {});
    // 首访按浏览器/系统语言检测（readUiLanguage 内部惰性持久化）。
    setUiLanguage(readUiLanguage());
    return () => {
      mounted.current = false;
    };
  }, [loadLibrary, loadRecord]);

  // 语言切换同步：header 菜单 / 设置页 / 登录页写同一存储并广播事件。
  useEffect(() => subscribeUiLanguage(() => setUiLanguage(readUiLanguage())), []);

  useEffect(() => {
    envelopeRef.current = envelope;
  }, [envelope]);

  // 批次 T1：初夜 pending 期间轻量轮询（每 2.5s，最长 90s），静默重载；
  // 首屏已有确定性开场旁白保底，轮询只负责让初夜事件与提案渐显。
  const firstNightPending = envelope?.firstNight?.state === "pending";
  const firstNightRecordId = envelope?.record.record.id ?? "";
  useEffect(() => {
    if (!firstNightPending || !firstNightRecordId) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > 90_000) {
        window.clearInterval(timer);
        return;
      }
      void loadRecord(firstNightRecordId, { silent: true });
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [firstNightPending, firstNightRecordId, loadRecord]);

  // 批次 T7：自演 running/stopping 期间轻量轮询信封（每 2.5s）刷新状态卡；
  // 自演事件内容本身走既有 SSE 实时渐显，不自造推送。
  const selfPlayActive = envelope?.selfPlay?.state === "running"
    || envelope?.selfPlay?.state === "stopping";
  const selfPlayRecordId = envelope?.record.record.id ?? "";
  useEffect(() => {
    if (!selfPlayActive || !selfPlayRecordId) return;
    const timer = window.setInterval(() => {
      void loadRecord(selfPlayRecordId, { silent: true });
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [selfPlayActive, selfPlayRecordId, loadRecord]);

  const streamRecordId = envelope?.record.record.id ?? "";
  const streamDynamicKnowledge = envelope?.viewer.dynamicKnowledgeVisible ?? false;

  useEffect(() => {
    if (!streamRecordId || !streamDynamicKnowledge) {
      const clearMemory = window.setTimeout(() => {
        if (mounted.current) setMemoryRepresentation("");
      }, 0);
      return () => window.clearTimeout(clearMemory);
    }
    let cancelled = false;
    const params = new URLSearchParams({
      recordId: streamRecordId,
      depth: memoryDepth,
    });
    void fetch(`/api/memory?${params.toString()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    }).then((response) => response.json()).then((payload: unknown) => {
      if (cancelled) return;
      if (
        typeof payload === "object"
        && payload !== null
        && typeof (payload as Record<string, unknown>).representation === "string"
      ) {
        setMemoryRepresentation(
          (payload as Record<string, unknown>).representation as string,
        );
        setMemoryRelationships(
          typeof (payload as Record<string, unknown>).relationships === "string"
            ? (payload as Record<string, unknown>).relationships as string
            : "",
        );
      }
    }).catch(() => {
      if (!cancelled) setMemoryRepresentation("");
    });
    return () => {
      cancelled = true;
    };
  }, [memoryDepth, memoryVersion, streamDynamicKnowledge, streamRecordId]);

  useEffect(() => {
    const memoryRefreshScheduler = createMemoryRefreshScheduler({
      isEnabled: () => mounted.current && Boolean(streamRecordId) && streamDynamicKnowledge,
      invalidate: () => {
        if (mounted.current) setMemoryVersion((current) => current + 1);
      },
    });
    memoryRefreshRef.current = memoryRefreshScheduler;
    return () => {
      memoryRefreshScheduler.dispose();
      if (memoryRefreshRef.current === memoryRefreshScheduler) {
        memoryRefreshRef.current = null;
      }
    };
  }, [streamDynamicKnowledge, streamRecordId]);

  async function summarizeMemory() {
    if (!streamRecordId || isSummarizingMemory) return;
    setIsSummarizingMemory(true);
    try {
      await fetch(`/api/memory?recordId=${encodeURIComponent(streamRecordId)}`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
    } finally {
      setIsSummarizingMemory(false);
      setMemoryVersion((current) => current + 1);
    }
  }

  useEffect(() => {
    if (!streamRecordId) return;

    const currentEnvelope = envelopeRef.current;
    const params = new URLSearchParams({
      recordId: streamRecordId,
      afterOrdinal: String(
        lastCommittedOrdinal(currentEnvelope?.record.events ?? []),
      ),
    });
    const source = new EventSource(`/api/record/events?${params.toString()}`);

    source.onopen = () => {
      if (mounted.current) setStreamState("live");
    };
    source.onerror = () => {
      if (mounted.current) setStreamState("reconnecting");
      // EventSource performs its own backoff and reconnects with the same
      // viewer-local cursor. Replays are harmless because Events are upserted.
    };

    function scheduleRecordEnvelopeRefresh() {
      if (recordRefreshTimer.current !== null) {
        window.clearTimeout(recordRefreshTimer.current);
      }
      // 一个 Turn 会连续发出 player/action/narration/character 多个事件；
      // 合并这一小段事件洪峰，只读取一次带新 writeToken 的完整 envelope。
      recordRefreshTimer.current = window.setTimeout(() => {
        recordRefreshTimer.current = null;
        void loadRecord(streamRecordId, { silent: true });
      }, 120);
    }

    function acceptCommittedEvent(rawEvent: Event) {
      const message = rawEvent as MessageEvent<string>;
      try {
        const event = normalizeCommittedEventPayload(JSON.parse(message.data));
        if (!event) return;
        setEnvelope((current) =>
          current
            ? { ...current, record: upsertCommittedEvent(current.record, event) }
            : current,
        );
        // SSE 事件本身没有 writeToken；否则时间线已更新而授权仍停在旧版本，
        // 用户下一次提交会无谓地先撞一次 WRITE_CONFLICT。
        scheduleRecordEnvelopeRefresh();
        memoryRefreshRef.current?.schedule();
      } catch {
        // Malformed or non-committed stream payloads fail closed.
      }
    }

    source.addEventListener("committed", acceptCommittedEvent);
    return () => {
      source.removeEventListener("committed", acceptCommittedEvent);
      source.close();
      if (recordRefreshTimer.current !== null) {
        window.clearTimeout(recordRefreshTimer.current);
        recordRefreshTimer.current = null;
      }
    };
  }, [
    loadRecord,
    streamRecordId,
  ]);

  const latestEvent = projection?.events.at(-1);
  const latestEventId = latestEvent?.id ?? "";
  const latestEventStatus = latestEvent?.status ?? "";

  useEffect(() => {
    if (!latestEventId) return;
    window.requestAnimationFrame(() => {
      document.getElementById(`event-${latestEventId}`)?.scrollIntoView({
        block: "nearest",
        behavior: latestEventStatus === "pending" ? "smooth" : "auto",
      });
    });
  }, [latestEventId, latestEventStatus]);

  async function sendMessage(
    content: string,
    actionSelection?: { affordanceId: string },
    visibilityConfirmation?: {
      proposalId: string;
      decision: "public" | "restricted";
    },
  ) {
    if (!envelope || !projection || !envelope.writeToken || isSending) return false;

    const clientMessageId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCancelKey(clientMessageId);
    const showOptimisticDraft = visibilityConfirmation !== undefined;
    const optimisticProjection: RecordProjection = showOptimisticDraft
      ? {
          ...projection,
          events: [
            ...projection.events,
            createOptimisticEvent(
              content,
              clientMessageId,
              projection.scene.worldTime,
            ),
          ],
        }
      : projection;

    if (showOptimisticDraft) {
      setEnvelope((current) =>
        current ? { ...current, record: optimisticProjection } : current,
      );
    }
    setIsSending(true);
    // 批次 L：生成中暂存位——用户原文立刻进入独立临时卡片（非时间线事件）。
    setPendingSubmission({ id: clientMessageId, content });
    setNotice(null);
    setVisibilityProposal(null);

    try {
      const response = await fetch("/api/record/messages", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": clientMessageId,
        },
        body: JSON.stringify({
          content,
          recordId: projection.record.id,
          clientMessageId,
          writeToken: envelope.writeToken,
          ...(actionSelection ? { actionSelection } : {}),
          ...(visibilityConfirmation ? { visibilityConfirmation } : {}),
        }),
      });
      const payload = await readJson(response);
      if (response.status === 428) {
        const proposal = normalizeVisibilityProposal(
          (payload as { visibilityProposal?: unknown } | null)
            ?.visibilityProposal,
        );
        if (proposal) {
          if (showOptimisticDraft) {
            setEnvelope((current) =>
              current
                ? {
                    ...current,
                    record: {
                      ...current.record,
                      events: current.record.events.filter(
                        (event) => event.id !== clientMessageId,
                      ),
                    },
                  }
                : current,
            );
          }
          setVisibilityProposal(proposal);
          setNotice(`可见性判断：${proposal.reason}`);
          return false;
        }
      }
      if (response.status === 409) {
        const conflictedRecordId = projection.record.id;
        setEnvelope((current) =>
          current
            ? {
                ...current,
                writeToken: "",
                record: {
                  ...current.record,
                  events: current.record.events.filter(
                    (event) => event.id !== clientMessageId,
                  ),
                },
              }
            : current,
        );
        const reloaded = await loadRecord(conflictedRecordId);
        if (mounted.current) {
          setNotice(
            reloaded
              ? "记录刚刚发生了变化。你的行动没有提交，已放回输入框，请确认后重试。"
              : "写入授权已失效，刷新暂未成功。你的行动已保留，请重新进入后重试。",
          );
        }
        return false;
      }
      if (!response.ok) {
        throw new Error(errorMessage(payload, `行动提交失败（${response.status}）`));
      }
      if (!mounted.current) return false;

      const nextEnvelope = normalizeRecordEnvelope(payload, optimisticProjection);
      if (!nextEnvelope.writeToken) {
        throw new Error("行动已处理，但新的写入授权缺失。请重新载入记录。");
      }
      setStreamState("connecting");
      setEnvelope(nextEnvelope);
      setVisibilityProposal(null);
      return true;
    } catch (error) {
      if (!mounted.current) return false;
      if (showOptimisticDraft) {
        setEnvelope((current) =>
          current
            ? {
                ...current,
                record: {
                  ...current.record,
                  events: current.record.events.filter(
                    (event) => event.id !== clientMessageId,
                  ),
                },
              }
            : current,
        );
      }
      setNotice(error instanceof Error ? error.message : "这次行动没有成功写入记录。");
      return false;
    } finally {
      if (mounted.current) setIsSending(false);
      if (mounted.current) setCancelKey(null);
      // 批次 L：暂存位在所有出口消失——成功由正式事件/SSE 接管，
      // 428/409/失败由 composer 恢复原文（暂存位不残留、不重复）。
      if (mounted.current) setPendingSubmission(null);
    }
  }

  async function interruptTurn() {
    if (!projection || !cancelKey) return;
    try {
      await fetch("/api/record/messages/cancel", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recordId: projection.record.id,
          clientMessageId: cancelKey,
        }),
      });
    } catch {
      // 打断失败时回合结果仍会经由原提交路径返回。
    }
  }

  /**
   * 批次 T7：世界自演开关。start/stop 均幂等（服务端活动会话重入返回现状）；
   * 成功后静默重载信封，状态卡与拍数随之刷新。
   */
  async function toggleSelfPlay() {
    const recordId = envelopeRef.current?.record.record.id;
    if (!recordId || selfPlayBusy) return;
    const action = envelopeRef.current?.selfPlay?.state === "running"
      ? "stop"
      : "start";
    setSelfPlayBusy(true);
    try {
      const response = await fetch("/api/record/self-play", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ recordId, action }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        setNotice(errorMessage(payload, uiText("ui.library.stanceFailed", uiLanguage)));
        return;
      }
      await loadRecord(recordId, { silent: true });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : null);
    } finally {
      if (mounted.current) setSelfPlayBusy(false);
    }
  }

  if (loadState === "onboarding") {
    return (
      <>
        <WorldOnboarding
          uiLanguage={uiLanguage}
          library={displayLibrary}
          onOpenChat={() => openCreation("chat", "onboarding")}
          onOpenGuided={() => openCreation("guided", "onboarding")}
          onOpenLobby={() => setLobbyOpen(true)}
          onOpenRecord={openRecord}
        />
        {renderCreationOverlay()}
        {renderLobbyOverlay()}
      </>
    );
  }

  if (loadState === "loading" && !projection) {
    return (
      <main className="state-screen" aria-busy="true">
        <div className="state-mark" aria-hidden="true">
          界
        </div>
        <p className="eyebrow">{uiText("ui.login.title", uiLanguage)} / REALM</p>
        <h1>{uiText("ui.record.loading", uiLanguage)}</h1>
        <div className="loading-rule" aria-hidden="true">
          <span />
        </div>
      </main>
    );
  }

  if (!projection || !envelope) {
    return (
      <main className="state-screen state-error">
        <div className="state-mark" aria-hidden="true">
          断
        </div>
        <p className="eyebrow">{uiText("ui.record.connectionLost", uiLanguage)}</p>
        <h1>{uiText("ui.record.errorTitle", uiLanguage)}</h1>
        <p>{notice ?? uiText("ui.record.errorHint", uiLanguage)}</p>
        <button onClick={() => void loadRecord()} type="button">
          {uiText("ui.record.retry", uiLanguage)}
        </button>
      </main>
    );
  }

  return (
    <div className="realm-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-seal" aria-hidden="true">
            界
          </span>
          <div>
            <strong>界核</strong>
            <span>REALM</span>
          </div>
        </div>
        <nav className="breadcrumb" aria-label="当前位置">
          <button
            aria-current={mainView === "world" ? "page" : undefined}
            aria-label={uiText("ui.breadcrumb.worldAria", uiLanguage)}
            className={`breadcrumb-crumb${mainView === "world" ? " is-active" : ""}`}
            onClick={() => setMainView("world")}
            type="button"
          >
            {demoWorldText(projection.world, uiLanguage).name}
          </button>
          <i aria-hidden="true">/</i>
          <button
            aria-current={mainView === "story" ? "page" : undefined}
            aria-label={uiText("ui.breadcrumb.storyAria", uiLanguage)}
            className={`breadcrumb-crumb${mainView === "story" ? " is-active" : ""}`}
            onClick={() => setMainView("story")}
            type="button"
          >
            {demoStoryText(projection.story, uiLanguage).title}
          </button>
          <i aria-hidden="true">/</i>
          <button
            aria-current={mainView === "record" ? "page" : undefined}
            aria-label={uiText("ui.breadcrumb.recordAria", uiLanguage)}
            className={`breadcrumb-crumb is-record${mainView === "record" ? " is-active" : ""}`}
            onClick={() => setMainView("record")}
            type="button"
          >
            {demoRecordTitle(projection.record.id, projection.record.title, uiLanguage)}
          </button>
        </nav>
        <div className="header-status">
          <button
            aria-haspopup="dialog"
            className="header-settings-link"
            onClick={openLobby}
            type="button"
          >
            {uiText("ui.header.lobby", uiLanguage)}
          </button>
          <button
            aria-haspopup="dialog"
            className="header-settings-link"
            onClick={openLibrary}
            type="button"
          >
            {uiText("ui.header.library", uiLanguage)}
          </button>
          <Link className="header-settings-link" href="/settings" aria-label={uiText("ui.header.settingsAria", uiLanguage)}>
            {uiText("ui.header.settings", uiLanguage)}
          </Link>
          <LanguageMenu uiLanguage={uiLanguage} />
          <ThemeToggle uiLanguage={uiLanguage} />
          {envelope.viewer.membershipRole === "observer" ? (
            <span className="view-mode is-narrator">
              {uiText("ui.header.narrator", uiLanguage)}
            </span>
          ) : null}
          <span
            className={`view-mode${
              envelope.viewer.perspective === "omniscient" ? " is-omniscient" : ""
            }`}
          >
            {envelope.viewer.perspective === "omniscient"
              ? uiText("ui.header.omniscient", uiLanguage)
              : uiText("ui.header.character", uiLanguage)}
          </span>
          <span className={`sync-state is-${streamState}`}>
            <i aria-hidden="true" />
            {streamState === "live"
              ? uiText("ui.header.live", uiLanguage)
              : streamState === "reconnecting"
                ? uiText("ui.header.reconnecting", uiLanguage)
                : uiText("ui.header.connecting", uiLanguage)}
          </span>
        </div>
      </header>

      <div className="realm-grid">
        <WorldNavigation
          projection={projection}
          uiLanguage={uiLanguage}
          onOpenStory={openStory}
          onOpenRecord={openRecord}
        />

        {mainView === "world" ? (
          <WorldView
            world={currentLibraryWorld}
            worldSummary={demoWorldText(projection.world, uiLanguage).summary ?? ""}
            currentRecordId={projection.record.id}
            uiLanguage={uiLanguage}
            onOpenRecord={openRecord}
            onOpenStory={openStory}
            onManage={openLibrary}
            onOpenGraph={(id, name) => setGraphWorld({ id, name })}
            onOpenBranchTree={(id, name) => setBranchWorld({ id, name })}
          />
        ) : mainView === "story" ? (
          <StoryView
            story={selectedLibraryStory}
            worldName={demoWorldText(projection.world, uiLanguage).name}
            currentRecordId={projection.record.id}
            uiLanguage={uiLanguage}
            onOpenRecord={openRecord}
          />
        ) : (
        <>
        <main className="record-main">
          <header className="record-heading">
            <div>
              <p className="eyebrow">{uiText("ui.record.eyebrow", uiLanguage)}</p>
              <h1>{demoRecordTitle(projection.record.id, projection.record.title, uiLanguage)}</h1>
              {(() => {
                if (!envelope.viewer.dynamicKnowledgeVisible) {
                  return <p className="record-subtitle">{uiText("ui.record.hiddenScene", uiLanguage)}</p>;
                }
                const subtitleScene = demoSceneText(projection.scene, projection.world.id, uiLanguage);
                const subtitle = [subtitleScene.location, subtitleScene.worldTime]
                  .filter((part) => part.trim().length > 0)
                  .join(" · ");
                return subtitle
                  ? <p className="record-subtitle">{subtitle}</p>
                  : null;
              })()}
            </div>
            <div className="record-heading-actions">
              {currentRecordMeta?.timelineKind === "retrospection" ? (
                <span className="record-timeline-badge">
                  {uiText("ui.record.retroBadge", uiLanguage)}
                </span>
              ) : null}
              {currentRecordMeta?.timelineKind === "branch" ? (
                <span className="record-timeline-badge">
                  {uiText("ui.record.branchBadge", uiLanguage)}
                </span>
              ) : null}
              <button
                className="record-action-button"
                disabled={recordActionBusy}
                onClick={() => void duplicateCurrentRecord()}
                type="button"
              >
                {recordActionBusy
                  ? uiText("ui.record.duplicateBusy", uiLanguage)
                  : uiText("ui.record.duplicate", uiLanguage)}
              </button>
              <button
                className="record-action-button"
                disabled={recordActionBusy}
                onClick={() => openBranchDialog()}
                type="button"
              >
                {uiText("ui.record.branch", uiLanguage)}
              </button>
              {currentRecordMeta?.timelineKind === "retrospection" ? (
                <button
                  className="record-action-button is-canon"
                  disabled={recordActionBusy}
                  onClick={() => setRetrospectionConfirm(true)}
                  type="button"
                >
                  {uiText("ui.record.canonize", uiLanguage)}
                </button>
              ) : null}
            </div>
          </header>

          {retrospectionConfirm && currentRecordMeta?.timelineKind === "retrospection" ? (
            <section className="retrospection-confirm" role="alertdialog" aria-label={uiText("ui.record.canonize", uiLanguage)}>
              <strong>{uiText("ui.record.canonizeWarning", uiLanguage)}</strong>
              <p>{uiText("ui.record.canonizeSecondWarning", uiLanguage)}</p>
              <div className="retrospection-confirm-actions">
                <button
                  disabled={recordActionBusy}
                  onClick={() => setRetrospectionConfirm(false)}
                  type="button"
                >
                  {uiText("ui.record.canonizeCancel", uiLanguage)}
                </button>
                <button
                  disabled={recordActionBusy}
                  onClick={() => void commitRetrospection()}
                  type="button"
                >
                  {recordActionBusy
                    ? uiText("ui.record.canonizeBusy", uiLanguage)
                    : uiText("ui.record.canonizeConfirm", uiLanguage)}
                </button>
              </div>
            </section>
          ) : null}

          {notice ? (
            <div className="notice-bar" role="alert">
              <span>{notice}</span>
              <button onClick={() => setNotice(null)} type="button" aria-label={uiText("ui.record.dismissNotice", uiLanguage)}>
                ×
              </button>
            </div>
          ) : null}

          {envelope.firstNight?.state === "pending" ? (
            <div className="first-night-status" role="status">
              <i aria-hidden="true" />
              {uiText("ui.firstNight.pending", uiLanguage)}
            </div>
          ) : null}

          {/* 批次 T7：世界自演——显式触发 + 状态卡 + 停止入口；状态是记录级的，
              观察者与成员同卡同态。 */}
          {(() => {
            const selfPlay = envelope.selfPlay;
            const running = selfPlay?.state === "running";
            const stopping = selfPlay?.state === "stopping";
            const statusText = !selfPlay
              ? uiText("ui.selfPlay.idle", uiLanguage)
              : running
                ? uiText("ui.selfPlay.running", uiLanguage, {
                    done: String(selfPlay.beatsCompleted),
                    budget: String(selfPlay.beatBudget),
                  })
                : stopping
                  ? uiText("ui.selfPlay.stopping", uiLanguage)
                  : selfPlay.state === "completed"
                    ? uiText("ui.selfPlay.completed", uiLanguage, {
                        done: String(selfPlay.beatsCompleted),
                      })
                    : selfPlay.state === "cancelled"
                      ? uiText("ui.selfPlay.cancelled", uiLanguage, {
                          done: String(selfPlay.beatsCompleted),
                        })
                      : uiText("ui.selfPlay.failed", uiLanguage, {
                          error: selfPlay.lastError ?? "?",
                        });
            const buttonText = selfPlayBusy
              ? uiText("ui.selfPlay.busy", uiLanguage)
              : running || stopping
                ? uiText("ui.selfPlay.stop", uiLanguage)
                : !selfPlay
                  ? uiText("ui.selfPlay.start", uiLanguage)
                  : uiText("ui.selfPlay.again", uiLanguage);
            return (
              <div className="self-play-panel" data-self-play-panel="">
                <div className="self-play-status">
                  <strong>{uiText("ui.selfPlay.title", uiLanguage)}</strong>
                  <span className={running ? "is-live" : undefined}>{statusText}</span>
                </div>
                <button
                  disabled={selfPlayBusy || stopping}
                  onClick={() => void toggleSelfPlay()}
                  type="button"
                >
                  {buttonText}
                </button>
              </div>
            );
          })()}

          <div className="timeline-scroll">
            <EventTimeline
              events={projection.events.map((event) => demoEventText(event, uiLanguage))}
              style={normalizeWorldStyle(projection.world.style)}
              uiLanguage={timelineLanguage}
            />
            <PreviewCards
              key={streamRecordId}
              recordId={streamRecordId}
              uiLanguage={uiLanguage}
            />
          </div>

          {pendingSubmission ? (
            <PendingSubmission
              content={pendingSubmission.content}
              uiLanguage={uiLanguage}
            />
          ) : null}

          <MessageComposer
            affordances={envelope.affordances.map((affordance) => demoAffordanceText(affordance, uiLanguage))}
            disabled={isSending || !envelope.writeToken}
            suggestions={
              envelope.suggestions.length > 0
                ? envelope.suggestions
                : envelope.firstNight?.openingSuggestions ?? []
            }
            uiLanguage={uiLanguage}
            interrupt={
              isSending && cancelKey
                ? { active: true, onClick: () => void interruptTurn() }
                : undefined
            }
            visibilityProposal={visibilityProposal}
            onSubmit={sendMessage}
            onVisibilityCancel={() => setVisibilityProposal(null)}
          />
        </main>

        <SceneInspector
          projection={projection}
          uiLanguage={uiLanguage}
          viewer={envelope.viewer}
          firstNightHook={envelope.firstNight?.hookContent ?? ""}
          memoryRepresentation={memoryRepresentation}
          memoryDepth={memoryDepth}
          onMemoryDepthChange={setMemoryDepth}
          memoryRelationships={memoryRelationships}
          isSummarizingMemory={isSummarizingMemory}
          onSummarizeMemory={summarizeMemory}
        />
        </>
        )}
      </div>
      {libraryOpen ? (
        <div
          aria-label={uiText("ui.header.library", uiLanguage)}
          aria-modal="true"
          className="library-overlay"
          role="dialog"
        >
          <LibraryPanel
            snapshot={displayLibrary}
            uiLanguage={uiLanguage}
            onRefresh={loadLibrary}
            onCreate={createLibraryItem}
            onOpenChat={() => openCreation("chat", "library")}
            onOpenGuided={() => openCreation("guided", "library")}
            onOpenRecord={openRecord}
            onOpenGraph={(id, name) => setGraphWorld({ id, name })}
            onOpenBranchTree={(id, name) => setBranchWorld({ id, name })}
            currentWorldId={projection.world.id}
            currentRecordId={projection.record.id}
            castDefinitionIds={projection.cast.map((member) => member.id)}
            castActivity={projection.cast.map((member) => ({
              definitionId: member.id,
              isActive: member.isActive,
            }))}
            onRecordReload={async () => {
              await loadRecord(projection.record.id);
            }}
            onRecordDeleted={async () => {
              setLibraryOpen(false);
              await loadRecord("");
            }}
            onWorldDeleted={async () => {
              // 批次 T8：当前打开世界被删除 → 走默认入口（last_opened 已由
              // 服务端复位，无记忆时回落 onboarding 引导屏）。
              setLibraryOpen(false);
              await loadRecord("");
            }}
            onClose={() => setLibraryOpen(false)}
          />
        </div>
      ) : null}
      {renderLobbyOverlay()}
      {renderCreationOverlay()}
      {graphWorld ? (
        <div className="library-overlay graph-overlay">
          <KnowledgeGraphPanel
            uiLanguage={uiLanguage}
            worldId={graphWorld.id}
            worldName={graphWorld.name}
            onClose={() => setGraphWorld(null)}
          />
        </div>
      ) : null}
      {branchWorld ? (
        <div
          aria-label={uiText("ui.branchTree.title", uiLanguage)}
          aria-modal="true"
          className="library-overlay graph-overlay branch-tree-overlay"
          role="dialog"
        >
          <BranchTreePanel
            currentRecordId={projection.record.id}
            onClose={() => setBranchWorld(null)}
            onOpenRecord={(recordId) => {
              setBranchWorld(null);
              void openRecord(recordId);
            }}
            uiLanguage={uiLanguage}
            worldId={branchWorld.id}
            worldName={branchWorld.name}
          />
        </div>
      ) : null}
      {branchDialog ? (
        <div
            aria-label={uiText("ui.branchDialog.title", uiLanguage)}
            aria-modal="true"
            aria-describedby="branch-dialog-note"
            aria-labelledby="branch-dialog-title"
            className="library-overlay branch-dialog-overlay"
            role="dialog"
          >
            <div className="branch-dialog" data-testid="branch-dialog">
            <h2 id="branch-dialog-title">{uiText("ui.branchDialog.title", uiLanguage)}</h2>
            <p className="branch-dialog-note" id="branch-dialog-note">{uiText("ui.branchDialog.note", uiLanguage)}</p>
            <fieldset className="branch-dialog-fork">
              <legend>{uiText("ui.branchDialog.forkLegend", uiLanguage)}</legend>
              <label>
                <input
                  checked={!branchDialog.useEventFork}
                  onChange={() => setBranchDialog({ ...branchDialog, useEventFork: false })}
                  ref={branchHeadRadioRef}
                  type="radio"
                />
                {uiText("ui.branchDialog.forkHead", uiLanguage)}
              </label>
              <label>
                <input
                  checked={branchDialog.useEventFork}
                  onChange={() => setBranchDialog({ ...branchDialog, useEventFork: true })}
                  type="radio"
                />
                {uiText("ui.branchDialog.forkEvent", uiLanguage)}
              </label>
              {branchDialog.useEventFork ? (
                <select
                  aria-label={uiText("ui.branchDialog.event", uiLanguage)}
                  onChange={(event) => setBranchDialog({
                    ...branchDialog,
                    forkEventId: event.target.value,
                  })}
                  value={branchDialog.forkEventId}
                >
                  <option value="">{uiText("ui.branchDialog.event", uiLanguage)}</option>
                  {projection.events.map((event) => (
                    <option key={event.id} value={event.id}>
                      {`#${event.ordinal} ${event.speaker}：${event.content.slice(0, 40)}`}
                    </option>
                  ))}
                </select>
              ) : null}
            </fieldset>
            <label className="branch-dialog-field">
              {uiText("ui.branchDialog.label", uiLanguage)}
              <input
                maxLength={80}
                onChange={(event) => setBranchDialog({ ...branchDialog, label: event.target.value })}
                value={branchDialog.label}
              />
            </label>
            <label className="branch-dialog-field">
              {uiText("ui.branchDialog.recordTitle", uiLanguage)}
              <input
                maxLength={80}
                onChange={(event) => setBranchDialog({ ...branchDialog, recordTitle: event.target.value })}
                value={branchDialog.recordTitle}
              />
            </label>
            {branchError ? (
              <p className="branch-dialog-error" role="alert">{branchError}</p>
            ) : null}
            <div className="branch-dialog-actions">
              <button
                disabled={recordActionBusy}
                onClick={() => setBranchDialog(null)}
                type="button"
              >
                {uiText("ui.branchDialog.cancel", uiLanguage)}
              </button>
              <button
                className="is-primary"
                disabled={recordActionBusy
                  || (branchDialog.useEventFork && !branchDialog.forkEventId)}
                onClick={() => void createBranch()}
                type="button"
              >
                {recordActionBusy
                  ? uiText("ui.branchDialog.confirmBusy", uiLanguage)
                  : uiText("ui.branchDialog.confirm", uiLanguage)}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
