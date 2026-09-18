"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import { isLoopbackOrigin } from "../../modules/application/advertised-origin.ts";

/**
 * LAN 游戏大厅面板（LAN-GAME-LOBBY-PLAN §五）。
 * 房间 = 约局元数据：未绑定房间的创建/加入/离开/关闭只动大厅表；绑定世界
 * 的加入会按服务端事务授予既有 World 的 player membership，不创建或修改
 * Story/Record——UI 明确标注「约局大厅」阶段。
 * 同步：/api/lobby/events SSE 失效唤醒 + 权威重读；断线由 EventSource
 * 自动重连（重连即拿新 snapshot），另给克制的断开提示。
 */

interface LobbyRoom {
  id: string;
  name: string;
  hostDisplayName: string;
  memberCount: number;
  capacity: number;
  hasPassword: boolean;
  status: "open" | "closed";
  viewerRole: "host" | "player" | null;
  worldId: string | null;
  worldName: string | null;
}

interface LobbyMember {
  displayName: string;
  role: "host" | "player";
  isViewer: boolean;
}

type LoadState = "loading" | "ready" | "error";

export function LobbyPanel({
  uiLanguage,
  inviteRoomId = null,
  ownWorlds,
  onEnterWorld,
  onClose,
}: {
  uiLanguage: UiLanguage;
  /** 邀请深链目标房间（?lobby=）：只定位/高亮，不自动加入。 */
  inviteRoomId?: string | null;
  /** 当前账号拥有的世界（创建房间时可绑定共享世界）。 */
  ownWorlds: readonly { id: string; name: string }[];
  /** 进入房间绑定的世界（在册成员可见）。 */
  onEnterWorld: (worldId: string) => void;
  onClose: () => void;
}) {
  const t = useCallback((key: string) => uiText(key, uiLanguage), [uiLanguage]);
  const [rooms, setRooms] = useState<LobbyRoom[]>([]);
  const [leaseTtlMs, setLeaseTtlMs] = useState<number | null>(null);
  // 显式 LAN 分享来源（服务端 meta；null=未配置；invalid=配置了但非法）。
  const [advertisedOrigin, setAdvertisedOrigin] = useState<string | null>(null);
  const [advertisedInvalid, setAdvertisedInvalid] = useState(false);
  const [members, setMembers] = useState<Record<string, LobbyMember[]>>({});
  const [state, setState] = useState<LoadState>("loading");
  const [sseOffline, setSseOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [capacity, setCapacity] = useState(4);
  const [worldId, setWorldId] = useState("");
  const [joinPassword, setJoinPassword] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  // 邀请落地状态纯派生（不在 effect 里 setState）：pending=加载中，
  // found=命中并定位，missing=不存在/已失效（稳定提示，不泄露成员详情）。
  const inviteState = !inviteRoomId
    ? null
    : state !== "ready"
      ? "pending"
      : rooms.some((room) => room.id === inviteRoomId)
        ? "found"
        : "missing";
  // 分享反馈（每房间独立）：success/fallback/失败文案。
  const [shareFeedback, setShareFeedback] = useState<Record<string, string>>({});
  const [manualShare, setManualShare] = useState<string | null>(null);
  const [inviteDismissed, setInviteDismissed] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async (roomId?: string) => {
    try {
      const params = roomId ? `?roomId=${encodeURIComponent(roomId)}` : "";
      const response = await fetch(`/api/lobby${params}`, { cache: "no-store" });
      const payload = await response.json() as {
        ok: boolean;
        rooms?: LobbyRoom[];
        members?: LobbyMember[];
        meta?: {
          leaseTtlMs?: unknown;
          advertisedOrigin?: unknown;
          advertisedOriginInvalid?: unknown;
        };
      };
      if (!mountedRef.current) return;
      if (!response.ok || payload.ok !== true || !Array.isArray(payload.rooms)) {
        setState("error");
        return;
      }
      setRooms(payload.rooms);
      const ttl = payload.meta?.leaseTtlMs;
      if (typeof ttl === "number" && Number.isSafeInteger(ttl)) setLeaseTtlMs(ttl);
      const advertised = payload.meta?.advertisedOrigin;
      setAdvertisedOrigin(
        typeof advertised === "string" && advertised.trim() ? advertised : null,
      );
      setAdvertisedInvalid(payload.meta?.advertisedOriginInvalid === true);
      if (roomId && Array.isArray(payload.members)) {
        setMembers((current) => ({ ...current, [roomId]: payload.members! }));
      }
      setState("ready");
    } catch {
      if (mountedRef.current) setState("error");
    }
  }, []);

  // 命中后滚动到目标房间（纯 DOM 副作用）。
  useEffect(() => {
    if (!inviteRoomId || inviteState !== "found") return;
    const frame = window.requestAnimationFrame(() => {
      const target = Array.from(
        document.querySelectorAll<HTMLElement>("[data-room-id]"),
      ).find((element) => element.dataset.roomId === inviteRoomId);
      target?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inviteRoomId, inviteState]);

  // expanded 经 ref 读取：展开/收起成员只是 UI 状态变化，不拆建
  // EventSource（此前 effect 依赖 expanded，每次展开都重连 + 重复
  // GET/LISTEN）。连接生命周期内仍用最新展开状态做权威重读。
  const expandedRef = useRef<string | null>(expanded);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    mountedRef.current = true;
    const timer = window.setTimeout(() => void load(), 0);
    const source = new EventSource("/api/lobby/events");
    source.addEventListener("snapshot", () => {
      setSseOffline(false);
      void load(expandedRef.current ?? undefined);
    });
    source.addEventListener("changed", () => {
      setSseOffline(false);
      void load(expandedRef.current ?? undefined);
    });
    source.onerror = () => setSseOffline(true);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timer);
      source.close();
    };
  }, [load]);

  async function send(body: Record<string, unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/lobby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as {
        ok: boolean;
        error?: { code?: string; message?: string };
      };
      if (!response.ok || payload.ok !== true) {
        const code = payload.error?.code ?? "";
        setError(
          code === "BAD_PASSWORD"
            ? t("ui.lobby.errPassword")
            : code === "ROOM_FULL"
              ? t("ui.lobby.errFull")
              : code === "ROOM_CLOSED"
                ? t("ui.lobby.errClosed")
                : t("ui.lobby.errGeneric"),
        );
        return false;
      }
      // 离开后不再请求该房间的成员详情，否则已失去成员资格会让列表读变成 NOT_MEMBER。
      const refreshRoomId = body.kind === "leave-room" ? undefined : expanded ?? undefined;
      if (body.kind === "leave-room" && body.roomId === expanded) setExpanded(null);
      void load(refreshRoomId);
      return true;
    } catch {
      setError(t("ui.lobby.errGeneric"));
      return false;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  /** 邀请链接：显式 LAN advertised origin（优先）或当前浏览器 origin +
   *  不透明 roomId；绝不含密码/凭据。信任边界见 advertised-origin.ts。 */
  function shareOrigin(): string {
    return advertisedOrigin ?? window.location.origin;
  }

  function inviteLink(roomId: string): string {
    const url = new URL(shareOrigin());
    url.searchParams.set("lobby", roomId);
    return url.toString();
  }

  async function shareRoom(room: LobbyRoom) {
    const link = inviteLink(room.id);
    // 优先 Web Share；用户取消（AbortError）视为无操作，不当失败。
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: room.name, url: link });
        if (mountedRef.current) {
          setShareFeedback((current) => ({ ...current, [room.id]: t("ui.lobby.shareDone") }));
        }
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // 其它失败继续走 clipboard fallback。
      }
    }
    // clipboard fallback（非安全上下文/权限拒绝落手动复制）。
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(link);
      if (mountedRef.current) {
        setShareFeedback((current) => ({ ...current, [room.id]: t("ui.lobby.shareCopied") }));
      }
    } catch {
      if (mountedRef.current) {
        setManualShare(room.id);
        setShareFeedback((current) => ({ ...current, [room.id]: t("ui.lobby.shareManual") }));
      }
    }
  }

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    const ok = await send({
      kind: "create-room",
      name,
      ...(password ? { password } : {}),
      capacity,
      ...(worldId ? { worldId } : {}),
    });
    if (ok) {
      setName("");
      setPassword("");
      setCapacity(4);
      setWorldId("");
    }
  }

  return (
    <div className="lobby-panel" data-testid="lobby-panel">
      <header className="lobby-heading">
        <div>
          <p className="eyebrow">{t("ui.lobby.eyebrow")}</p>
          <h2>{t("ui.lobby.title")}</h2>
        </div>
        <button
          aria-label={t("ui.lobby.close")}
          className="branch-tree-close"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </header>
      <p className="lobby-stage-note">{t("ui.lobby.stageNote")}</p>
      {state === "ready" ? (
        <p className="lobby-origin-note" role="status">
          {t("ui.lobby.originLabel").replace("{origin}", shareOrigin())}
        </p>
      ) : null}
      {state === "ready" && advertisedInvalid ? (
        <p className="lobby-origin-warning" role="alert">
          {t("ui.lobby.originInvalid")}
        </p>
      ) : null}
      {state === "ready" && !advertisedOrigin && !advertisedInvalid && isLoopbackOrigin(window.location.origin) ? (
        <p className="lobby-origin-warning" role="status">
          {t("ui.lobby.originLoopback")}
        </p>
      ) : null}
      {sseOffline ? (
        <p className="lobby-offline" role="status">{t("ui.lobby.offline")}</p>
      ) : null}

      <form className="lobby-create" onSubmit={(event) => void submitCreate(event)}>
        <label>
          {t("ui.lobby.name")}
          <input
            aria-label={t("ui.lobby.name")}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </label>
        <label>
          {t("ui.lobby.password")}
          <input
            aria-label={t("ui.lobby.password")}
            autoComplete="off"
            maxLength={80}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </label>
        <label>
          {t("ui.lobby.capacity")}
          <input
            aria-label={t("ui.lobby.capacity")}
            max={8}
            min={2}
            onChange={(event) => setCapacity(Number(event.target.value))}
            type="number"
            value={capacity}
          />
        </label>
        <label>
          {t("ui.lobby.world")}
          <select
            aria-label={t("ui.lobby.world")}
            onChange={(event) => setWorldId(event.target.value)}
            value={worldId}
          >
            <option value="">{t("ui.lobby.noWorld")}</option>
            {ownWorlds.map((world) => (
              <option key={world.id} value={world.id}>{world.name}</option>
            ))}
          </select>
        </label>
        <button className="is-primary" disabled={busy || !name.trim()} type="submit">
          {busy ? t("ui.lobby.busy") : t("ui.lobby.create")}
        </button>
      </form>

      {inviteRoomId && inviteState === "missing" && !inviteDismissed ? (
        <p className="lobby-invite-note" role="status">
          {t("ui.lobby.inviteMissing")}
          <button
            onClick={() => setInviteDismissed(true)}
            type="button"
          >
            {t("ui.lobby.inviteDismiss")}
          </button>
        </p>
      ) : null}
      {error ? <p className="lobby-error" role="alert">{error}</p> : null}
      {state === "loading" ? (
        <p className="lobby-state" role="status">{t("ui.lobby.loading")}</p>
      ) : null}
      {state === "error" ? (
        <div className="lobby-state" role="alert">
          <p>{t("ui.lobby.loadFailed")}</p>
          <button onClick={() => void load()} type="button">{t("ui.lobby.retry")}</button>
        </div>
      ) : null}
      {state === "ready" && rooms.length === 0 ? (
        <p className="lobby-state">{t("ui.lobby.empty")}</p>
      ) : null}

      <ul className="lobby-list">
        {rooms.map((room) => (
          <li
            className={`lobby-room${inviteRoomId === room.id && inviteState === "found" ? " is-invite-target" : ""}`}
            data-room-id={room.id}
            data-status={room.status}
            key={room.id}
          >
            <div className="lobby-room-main">
              <strong>{room.name}</strong>
              <small>
                {room.hostDisplayName}
                {` · ${room.memberCount}/${room.capacity}`}
                {room.hasPassword ? ` · ${t("ui.lobby.locked")}` : ""}
                {room.status === "closed" ? ` · ${t("ui.lobby.closed")}` : ""}
                {room.worldName ? ` · ${t("ui.lobby.worldBadge")}${room.worldName}` : ""}
              </small>
            </div>
            <div className="lobby-room-actions">
              {room.status === "open" && room.viewerRole === null ? (
                <>
                  {room.hasPassword ? (
                    <input
                      aria-label={t("ui.lobby.joinPassword")}
                      autoComplete="off"
                      onChange={(event) =>
                        setJoinPassword((current) => ({
                          ...current,
                          [room.id]: event.target.value,
                        }))}
                      placeholder={t("ui.lobby.joinPassword")}
                      type="password"
                      value={joinPassword[room.id] ?? ""}
                    />
                  ) : null}
                  <button
                    disabled={busy || room.memberCount >= room.capacity}
                    onClick={() =>
                      void send({
                        kind: "join-room",
                        roomId: room.id,
                        password: joinPassword[room.id] ?? "",
                      })}
                    type="button"
                  >
                    {room.memberCount >= room.capacity
                      ? t("ui.lobby.full")
                      : t("ui.lobby.join")}
                  </button>
                </>
              ) : null}
              {room.viewerRole !== null ? (
                <button
                  disabled={busy}
                  onClick={() => {
                    const next = expanded === room.id ? null : room.id;
                    setExpanded(next);
                    // 展开时显式权威重读该房间成员（数据流不依赖 SSE 重建）。
                    if (next) void load(next);
                  }}
                  type="button"
                >
                  {t("ui.lobby.members")}
                </button>
              ) : null}
              {room.viewerRole !== null ? (
                <button
                  disabled={busy}
                  onClick={() => void shareRoom(room)}
                  type="button"
                >
                  {t("ui.lobby.share")}
                </button>
              ) : null}
              {room.viewerRole === "host" && room.status === "open" ? (
                <small className="lobby-lease-note">
                  {leaseTtlMs
                    ? t("ui.lobby.leaseNote").replace(
                        "{seconds}",
                        String(Math.round(leaseTtlMs / 1000)),
                      )
                    : t("ui.lobby.leaseNoteShort")}
                </small>
              ) : null}
              {room.viewerRole !== null && room.worldId ? (
                <button
                  className="is-primary"
                  disabled={busy}
                  onClick={() => onEnterWorld(room.worldId!)}
                  type="button"
                >
                  {t("ui.lobby.enterWorld")}
                </button>
              ) : null}
              {room.viewerRole === "player" ? (
                <button
                  disabled={busy}
                  onClick={() => void send({ kind: "leave-room", roomId: room.id })}
                  type="button"
                >
                  {t("ui.lobby.leave")}
                </button>
              ) : null}
              {room.viewerRole === "host" && room.status === "open" ? (
                <button
                  disabled={busy}
                  onClick={() => void send({ kind: "close-room", roomId: room.id })}
                  type="button"
                >
                  {t("ui.lobby.closeRoom")}
                </button>
              ) : null}
            </div>
            {shareFeedback[room.id] ? (
              <p className="lobby-share-feedback" role="status">{shareFeedback[room.id]}</p>
            ) : null}
            {manualShare === room.id ? (
              <label className="lobby-share-manual">
                {t("ui.lobby.shareManualLabel")}
                <input
                  aria-label={t("ui.lobby.shareManualLabel")}
                  onFocus={(event) => event.target.select()}
                  readOnly
                  value={inviteLink(room.id)}
                />
              </label>
            ) : null}
            {expanded === room.id && members[room.id] ? (
              <ul className="lobby-members">
                {members[room.id].map((member) => (
                  <li key={`${room.id}-${member.displayName}-${member.role}`}>
                    {member.displayName}
                    {member.role === "host" ? ` · ${t("ui.lobby.hostBadge")}` : ""}
                    {member.isViewer ? ` · ${t("ui.lobby.youBadge")}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
