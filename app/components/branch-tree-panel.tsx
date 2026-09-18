import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import {
  normalizeBranchTree,
  type BranchTree,
  type BranchTreeCursor,
  type BranchTreeRecord,
  type BranchTreeStory,
  type BranchTreeWorldline,
} from "./branch-tree-types.ts";

/**
 * World 级分支树浏览器（BRANCH-TREE-RESEARCH §三 P0 只读视图）。
 *
 * - 树骨架 = worldline 谱系（parent_worldline_id + fork 游标）；record 作
 *   为 worldline 盒内的可进入节点；linked_record_id / worldline_merges 仅
 *   以徽标与「合并审计」列表标注（overlay，不污染骨架）。
 * - 三重编码：形状（盒/条目）+ 颜色 + 文本徽标；当前记录/原初/分支/回溯/
 *   合并/归档/不可进入均有文本，不只靠颜色。
 * - 桌面为可折叠树（正交连接线，纯 CSS，无图布局依赖）；≤720px 同一 DOM
 *   自然退化为缩进列表。键盘：方向键移动、→ 展开、← 收起、Enter 选中。
 */

interface BranchTreePanelProps {
  worldId: string;
  worldName: string;
  currentRecordId: string;
  uiLanguage: UiLanguage;
  onOpenRecord: (recordId: string) => void;
  onClose: () => void;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; tree: BranchTree };

interface Selection {
  worldlineId: string;
  recordId: string | null;
}

function formatCursor(cursor: BranchTreeCursor): string {
  return `${cursor.tick}:${cursor.ordinal}`;
}

function isPlayableRecord(record: BranchTreeRecord): boolean {
  return record.status !== "archived" && record.timelineKind !== "merged";
}

export function BranchTreePanel({
  worldId,
  worldName,
  currentRecordId,
  uiLanguage,
  onOpenRecord,
  onClose,
}: BranchTreePanelProps) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focusId, setFocusId] = useState<string>("");
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const t = useCallback(
    (key: string) => uiText(key, uiLanguage),
    [uiLanguage],
  );

  const load = useCallback(async () => {
    // 初始加载的 loading 态由 useState 初值承担；重试在事件处理器里置
    // loading——不在 effect 同步 setState（react-hooks 规则）。
    try {
      const params = new URLSearchParams({ worldId });
      if (currentRecordId.trim()) params.set("recordId", currentRecordId.trim());
      const response = await fetch(`/api/world/branch-tree?${params}`, {
        cache: "no-store",
      });
      const tree = response.ok ? normalizeBranchTree(await response.json()) : null;
      if (!tree) {
        setState({ phase: "error" });
        return;
      }
      setState({ phase: "ready", tree });
      // 默认展开：根 + 当前 worldline 的全部祖先链。
      const byId = new Map(tree.worldlines.map((line) => [line.id, line]));
      const initial = new Set<string>();
      const roots = tree.worldlines.filter((line) => line.parentWorldlineId === null);
      for (const root of roots) initial.add(root.id);
      let cursorId = tree.currentWorldlineId;
      while (cursorId) {
        initial.add(cursorId);
        cursorId = byId.get(cursorId)?.parentWorldlineId ?? null;
      }
      setExpanded(initial);
      setSelection(
        tree.currentWorldlineId
          ? { worldlineId: tree.currentWorldlineId, recordId: tree.currentRecordId }
          : (roots[0] ? { worldlineId: roots[0].id, recordId: null } : null),
      );
    } catch {
      setState({ phase: "error" });
    }
  }, [worldId, currentRecordId]);

  useEffect(() => {
    // 与 knowledge-graph-panel 同形：setTimeout 推迟首载，避免在 effect
    // 中同步 setState（react-hooks/set-state-in-effect）。
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const tree = state.phase === "ready" ? state.tree : null;

  // 可见 treeitem 序列（键盘 roving focus）。
  const visibleIds = useMemo(() => {
    if (!tree) return [];
    const byParent = new Map<string | null, BranchTreeWorldline[]>();
    for (const line of tree.worldlines) {
      const list = byParent.get(line.parentWorldlineId) ?? [];
      list.push(line);
      byParent.set(line.parentWorldlineId, list);
    }
    const out: string[] = [];
    const walk = (parentId: string | null) => {
      for (const line of byParent.get(parentId) ?? []) {
        out.push(line.id);
        if (expanded.has(line.id)) walk(line.id);
      }
    };
    walk(null);
    return out;
  }, [tree, expanded]);

  // 键盘 roving focus：焦点 id 失效（树刷新/折叠后）时回落到第一个可见项，
  // 不在 effect 中 setState。
  const activeFocusId = visibleIds.includes(focusId)
    ? focusId
    : (visibleIds[0] ?? "");

  const handleKeyDown = (event: React.KeyboardEvent, lineId: string) => {
    const index = visibleIds.indexOf(lineId);
    if (event.key === "ArrowDown" && index < visibleIds.length - 1) {
      event.preventDefault();
      const next = visibleIds[index + 1]!;
      setFocusId(next);
      itemRefs.current.get(next)?.focus();
    } else if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      const next = visibleIds[index - 1]!;
      setFocusId(next);
      itemRefs.current.get(next)?.focus();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setExpanded((prev) => new Set(prev).add(lineId));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(lineId);
        return next;
      });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelection({ worldlineId: lineId, recordId: null });
    }
  };

  const selectedWorldline = tree && selection
    ? tree.worldlines.find((line) => line.id === selection.worldlineId) ?? null
    : null;
  const selectedRecord = selectedWorldline && selection?.recordId
    ? selectedWorldline.records.find((record) => record.id === selection.recordId) ?? null
    : null;
  const sourceRecordOf = (record: BranchTreeRecord): BranchTreeRecord | null => {
    if (!tree || !record.linkedRecordId) return null;
    for (const line of tree.worldlines) {
      const found = line.records.find((candidate) => candidate.id === record.linkedRecordId);
      if (found) return found;
    }
    return null;
  };

  const recordBadge = (record: BranchTreeRecord): string => {
    if (record.timelineKind === "retrospection") return t("ui.record.retroBadge");
    if (record.timelineKind === "branch") return t("ui.record.branchBadge");
    if (record.timelineKind === "merged") return t("ui.storyView.mergedBadge");
    return "";
  };

  const renderRecord = (lineId: string, record: BranchTreeRecord) => {
    const badge = recordBadge(record);
    const playable = isPlayableRecord(record);
    const isCurrentRecord = tree!.currentRecordId === record.id;
    const recordSelected = selection?.worldlineId === lineId
      && selection.recordId === record.id;
    return (
      <li key={record.id}>
        <button
          className={`branch-record${record.timelineKind === "retrospection" ? " is-retro" : ""}${record.timelineKind === "branch" ? " is-branch" : ""}${record.timelineKind === "merged" ? " is-merged" : ""}${record.status === "archived" ? " is-archived" : ""}${isCurrentRecord ? " is-current" : ""}${recordSelected ? " is-selected" : ""}`}
          disabled={!playable && record.timelineKind === "merged"}
          onClick={() => setSelection({ worldlineId: lineId, recordId: record.id })}
          type="button"
        >
          <span className="branch-record-title">{record.title}</span>
          {badge ? <em className="branch-badge">{badge}</em> : null}
          {record.status === "archived" ? (
            <em className="branch-badge is-archived">{t("ui.branchTree.archived")}</em>
          ) : null}
          {isCurrentRecord ? (
            <em className="branch-badge is-current">{t("ui.branchTree.current")}</em>
          ) : null}
          {!playable ? (
            <em className="branch-badge is-archived">{t("ui.branchTree.unplayable")}</em>
          ) : null}
        </button>
      </li>
    );
  };

  const renderStory = (line: BranchTreeWorldline, story: BranchTreeStory) => {
    const records = line.records.filter((record) => record.storyId === story.id);
    return (
      <li className="branch-story" key={story.id}>
        <div className="branch-story-heading">
          <span className="branch-story-kind">{t("ui.branchTree.story")}</span>
          <strong className="branch-story-title">{story.title}</strong>
          <em className="branch-badge">{story.status}</em>
        </div>
        {records.length > 0 ? (
          <ul className="branch-records" aria-label={`${story.title} · ${t("ui.branchTree.records")}`}>
            {records.map((record) => renderRecord(line.id, record))}
          </ul>
        ) : (
          <p className="branch-story-empty">{t("ui.branchTree.emptyRecords")}</p>
        )}
      </li>
    );
  };

  const renderWorldline = (line: BranchTreeWorldline, level: number) => {
    const childLines = tree!.worldlines.filter(
      (candidate) => candidate.parentWorldlineId === line.id,
    );
    const assignedRecordIds = new Set(line.stories.flatMap((story) =>
      line.records.filter((record) => record.storyId === story.id).map((record) => record.id),
    ));
    const unassignedRecords = line.records.filter((record) => !assignedRecordIds.has(record.id));
    const isExpanded = expanded.has(line.id);
    const isCurrentLine = tree!.currentWorldlineId === line.id;
    const isSelected = selection?.worldlineId === line.id && selection.recordId === null;
    return (
      <li key={line.id} role="none" className="branch-item">
        <div
          className={`branch-node${line.parentWorldlineId === null ? " is-origin" : ""}${isCurrentLine ? " is-current" : ""}${isSelected ? " is-selected" : ""}`}
        >
          <button
            aria-expanded={childLines.length > 0 ? isExpanded : undefined}
            aria-level={level}
            aria-selected={isSelected}
            className="branch-node-button"
            onClick={() => {
              setSelection({ worldlineId: line.id, recordId: null });
              if (childLines.length > 0 && !isExpanded) {
                setExpanded((prev) => new Set(prev).add(line.id));
              }
            }}
            onKeyDown={(event) => handleKeyDown(event, line.id)}
            ref={(node) => {
              if (node) itemRefs.current.set(line.id, node);
              else itemRefs.current.delete(line.id);
            }}
            role="treeitem"
            tabIndex={activeFocusId === line.id ? 0 : -1}
            type="button"
          >
            <span className="branch-node-label">{line.label}</span>
            <span className="branch-node-badges">
              {line.parentWorldlineId === null ? (
                <em className="branch-badge is-origin">{t("ui.branchTree.origin")}</em>
              ) : (
                <em className="branch-badge is-branch">{t("ui.record.branchBadge")}</em>
              )}
              {line.status !== "active" ? (
                <em className="branch-badge is-archived">{line.status}</em>
              ) : null}
              {isCurrentLine ? (
                <em className="branch-badge is-current">{t("ui.branchTree.current")}</em>
              ) : null}
              {childLines.length > 0 ? (
                <em className="branch-badge is-count">
                  {isExpanded ? t("ui.branchTree.collapse") : t("ui.branchTree.expand")}
                  {` · ${childLines.length}`}
                </em>
              ) : null}
            </span>
          </button>
          {line.stories.length > 0 ? (
            <ul className="branch-stories" aria-label={t("ui.branchTree.stories")}>
              {line.stories.map((story) => renderStory(line, story))}
              {unassignedRecords.length > 0 ? (
                <li className="branch-story branch-story-unassigned">
                  <div className="branch-story-heading">
                    <span className="branch-story-kind">{t("ui.branchTree.records")}</span>
                    <strong className="branch-story-title">{t("ui.branchTree.unassigned")}</strong>
                  </div>
                  <ul className="branch-records" aria-label={t("ui.branchTree.records")}>
                    {unassignedRecords.map((record) => renderRecord(line.id, record))}
                  </ul>
                </li>
              ) : null}
            </ul>
          ) : line.records.length > 0 ? (
            <ul className="branch-records" aria-label={t("ui.branchTree.records")}>
              {line.records.map((record) => renderRecord(line.id, record))}
            </ul>
          ) : null}
        </div>
        {childLines.length > 0 && isExpanded ? (
          <ul className="branch-children" role="group">
            {childLines.map((child) => renderWorldline(child, level + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="branch-tree-panel" data-testid="branch-tree-panel">
      <header className="branch-tree-header">
        <div>
          <p className="eyebrow">{t("ui.branchTree.title")}</p>
          <h2>{worldName}</h2>
        </div>
        <button
          aria-label={t("ui.branchTree.close")}
          className="branch-tree-close"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </header>

      {state.phase === "loading" ? (
        <p className="branch-tree-state" role="status">{t("ui.branchTree.loading")}</p>
      ) : null}
      {state.phase === "error" ? (
        <div className="branch-tree-state" role="alert">
          <p>{t("ui.branchTree.error")}</p>
          <button
            onClick={() => {
              setState({ phase: "loading" });
              void load();
            }}
            type="button"
          >
            {t("ui.branchTree.retry")}
          </button>
        </div>
      ) : null}

      {tree ? (
        <div className="branch-tree-body">
          <div className="branch-tree-scroll">
            {tree.worldlines.filter((line) => line.parentWorldlineId !== null).length === 0 ? (
              <p className="branch-tree-state">{t("ui.branchTree.empty")}</p>
            ) : null}
            <ul aria-label={t("ui.branchTree.title")} className="branch-tree" role="tree">
              {tree.worldlines
                .filter((line) => line.parentWorldlineId === null)
                .map((line) => renderWorldline(line, 1))}
            </ul>
            {tree.merges.length > 0 ? (
              <section className="branch-merges" aria-label={t("ui.branchTree.merges")}>
                <h3>{t("ui.branchTree.merges")}</h3>
                <ul>
                  {tree.merges.map((merge) => (
                    <li key={merge.id}>
                      <span>{merge.sourceWorldlineA}</span>
                      {" + "}
                      <span>{merge.sourceWorldlineB}</span>
                      {" → "}
                      <span>{merge.mergedWorldlineId ?? merge.status}</span>
                      <em className="branch-badge is-merged">{merge.status}</em>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <aside className="branch-detail" aria-label={t("ui.branchTree.detail")}>
            <h3>{t("ui.branchTree.detail")}</h3>
            {selectedWorldline ? (
              <dl>
                <dt>{t("ui.branchTree.title")}</dt>
                <dd>{selectedWorldline.label}</dd>
                {selectedWorldline.parentWorldlineId ? (
                  <>
                    <dt>{t("ui.branchTree.parentWorldline")}</dt>
                    <dd>
                      {tree!.worldlines.find((line) => line.id === selectedWorldline.parentWorldlineId)?.label
                        ?? selectedWorldline.parentWorldlineId}
                    </dd>
                    <dt>{t("ui.branchTree.fork")}</dt>
                    <dd>{selectedWorldline.fork ? formatCursor(selectedWorldline.fork) : "—"}</dd>
                  </>
                ) : null}
                <dt>{t("ui.branchTree.head")}</dt>
                <dd>{formatCursor(selectedWorldline.head)}</dd>
                <dt>{t("ui.branchTree.stories")}</dt>
                <dd>{selectedWorldline.stories.map((story) => story.title).join("、") || "—"}</dd>
              </dl>
            ) : null}
            {selectedRecord ? (
              <div className="branch-detail-record">
                <dl>
                  <dt>{t("ui.branchTree.records")}</dt>
                  <dd>{selectedRecord.title}</dd>
                  {sourceRecordOf(selectedRecord) ? (
                    <>
                      <dt>{t("ui.branchTree.sourceRecord")}</dt>
                      <dd>
                        <button
                          className="branch-source-link"
                          onClick={() => {
                            const source = sourceRecordOf(selectedRecord);
                            if (!source || !tree) return;
                            const owner = tree.worldlines.find((line) =>
                              line.records.some((record) => record.id === source.id));
                            if (owner) {
                              setExpanded((prev) => new Set(prev).add(owner.id));
                              setSelection({ worldlineId: owner.id, recordId: source.id });
                            }
                          }}
                          type="button"
                        >
                          {sourceRecordOf(selectedRecord)!.title}
                        </button>
                      </dd>
                    </>
                  ) : null}
                  <dt>{t("ui.branchTree.fork")}</dt>
                  <dd>{formatCursor(selectedRecord.start)}</dd>
                  <dt>{t("ui.branchTree.head")}</dt>
                  <dd>{formatCursor(selectedRecord.head)}</dd>
                </dl>
                {isPlayableRecord(selectedRecord) ? (
                  <button
                    className="record-action-button is-primary"
                    onClick={() => onOpenRecord(selectedRecord.id)}
                    type="button"
                  >
                    {t("ui.branchTree.enter")}
                  </button>
                ) : (
                  <p className="branch-tree-state">{t("ui.branchTree.unplayable")}</p>
                )}
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
