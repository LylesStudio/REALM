import {
  uiText,
  type UiLanguage,
} from "../../modules/i18n/public.ts";
import type { LibraryWorld } from "./library-types";

/**
 * 批次 T12-C：页面级世界视图。
 * 数据全部来自服务端 Library snapshot（世界卡）与当前 Record envelope
 * （摘要等动态字段）；不硬编码世界名/记录 id，不写 Demo 假内容。
 */
export function WorldView({
  world,
  worldSummary,
  currentRecordId,
  uiLanguage,
  onOpenRecord,
  onOpenStory,
  onManage,
  onOpenGraph,
  onOpenBranchTree,
}: {
  world: LibraryWorld | null;
  /** 当前 envelope 携带的世界摘要（动态知识门禁后的值）。 */
  worldSummary: string;
  currentRecordId: string;
  uiLanguage: UiLanguage;
  onOpenRecord: (recordId: string) => void;
  /** 打开指定故事的页面级视图（必须携带被选 story 自身 id）。 */
  onOpenStory: (storyId: string) => void;
  /** 打开世界库 overlay（创世/导入/归档等临时操作留在 overlay）。 */
  onManage: () => void;
  onOpenGraph: (worldId: string, worldName: string) => void;
  onOpenBranchTree: (worldId: string, worldName: string) => void;
}) {
  if (!world) {
    return (
      <main className="record-main view-panel" data-view="world">
        <p className="eyebrow">{uiText("ui.worldView.eyebrow", uiLanguage)}</p>
        <p className="view-panel-empty" role="status">
          {uiText("ui.worldView.missing", uiLanguage)}
        </p>
      </main>
    );
  }

  const statusText = world.status === "archived"
    ? uiText("ui.worldView.statusArchived", uiLanguage)
    : uiText("ui.worldView.statusActive", uiLanguage);

  return (
    <main className="record-main view-panel" data-view="world">
      <header className="record-heading">
        <div>
          <p className="eyebrow">{uiText("ui.worldView.eyebrow", uiLanguage)}</p>
          <h1>{world.name}</h1>
          <p className="record-subtitle">
            {[world.era, statusText].filter((part) => part.trim().length > 0).join(" · ")}
          </p>
        </div>
        <div className="record-heading-actions">
          {currentRecordId.trim() ? (
            <button
              className="record-action-button is-primary"
              onClick={() => onOpenRecord(currentRecordId)}
              type="button"
            >
              {uiText("ui.worldView.openRecord", uiLanguage)}
            </button>
          ) : null}
          <button
            className="record-action-button"
            onClick={() => onOpenGraph(world.id, world.name)}
            type="button"
          >
            {uiText("ui.library.graph", uiLanguage)}
          </button>
          <button
            className="record-action-button"
            onClick={() => onOpenBranchTree(world.id, world.name)}
            type="button"
          >
            {uiText("ui.branchTree.title", uiLanguage)}
          </button>
          <button
            className="record-action-button"
            onClick={onManage}
            type="button"
          >
            {uiText("ui.worldView.manage", uiLanguage)}
          </button>
        </div>
      </header>

      <div className="view-panel-scroll">
        <section className="view-section" aria-label={uiText("ui.worldView.summary", uiLanguage)}>
          <h2>{uiText("ui.worldView.summary", uiLanguage)}</h2>
          {worldSummary.trim() ? <p>{worldSummary}</p> : null}
          <dl className="view-facts">
            <div>
              <dt>{uiText("ui.worldView.status", uiLanguage)}</dt>
              <dd>{statusText}</dd>
            </div>
            <div>
              <dt>{uiText("ui.worldView.membership", uiLanguage)}</dt>
              <dd>{world.membershipRole}</dd>
            </div>
            <div>
              <dt>{uiText("ui.worldView.lastActive", uiLanguage)}</dt>
              <dd>
                {world.lastActiveAt
                  ? new Date(world.lastActiveAt).toLocaleString()
                  : uiText("ui.worldView.lastActiveNever", uiLanguage)}
              </dd>
            </div>
          </dl>
          <p className="view-stats">
            {uiText("ui.worldView.stats", uiLanguage, {
              stories: String(world.storyCount),
              records: String(world.recordCount),
              characters: String(world.characterCount),
            })}
          </p>
        </section>

        <section className="view-section" aria-label={uiText("ui.worldView.stories", uiLanguage)}>
          <h2>{uiText("ui.worldView.stories", uiLanguage)}</h2>
          {world.stories.length === 0 ? (
            <p className="view-panel-empty">
              {uiText("ui.worldView.emptyStories", uiLanguage)}
            </p>
          ) : (
            <ul className="view-record-list">
              {world.stories.map((story) => (
                <li key={story.id}>
                  <div className="view-story-block">
                    <button
                      className="view-link"
                      data-story-id={story.id}
                      onClick={() => onOpenStory(story.id)}
                      type="button"
                    >
                      {story.title}
                    </button>
                    <ul className="view-record-list is-nested">
                      {story.records.map((record) => (
                        <li key={record.id}>
                          <button
                            className={`view-link${
                              record.id === currentRecordId ? " is-current" : ""
                            }`}
                            onClick={() => onOpenRecord(record.id)}
                            type="button"
                          >
                            {record.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="view-section" aria-label={uiText("ui.worldView.characters", uiLanguage)}>
          <h2>{uiText("ui.worldView.characters", uiLanguage)}</h2>
          {world.characters.length === 0 ? (
            <p className="view-panel-empty">
              {uiText("ui.worldView.emptyCharacters", uiLanguage)}
            </p>
          ) : (
            <ul className="view-record-list">
              {world.characters.map((character) => (
                <li key={character.id}>
                  <span className="view-static">
                    {character.name}
                    {character.role ? ` · ${character.role}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="view-section" aria-label={uiText("ui.worldView.worldlines", uiLanguage)}>
          <h2>{uiText("ui.worldView.worldlines", uiLanguage)}</h2>
          <ul className="view-record-list">
            {world.worldlines.map((worldline) => (
              <li key={worldline.id}>
                <span className="view-static">
                  {worldline.label}
                  {worldline.status ? ` · ${worldline.status}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
