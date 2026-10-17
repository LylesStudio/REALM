"use client";
import { GenesisGoalFields } from './record-goal-fields.tsx';

import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import { WORLD_STYLE_KEYS, worldStyleText, type WorldStyle } from "../../modules/style/world-style.ts";
import { GENESIS_LIMITS, GENESIS_LANGUAGES, type WorldGenesisDraft } from "../../modules/application/world-genesis-contract.ts";

const EMPTY_COMPANION = { name: "", role: "", summary: "" };

export function GenesisDraftFields({ draft, patchDraft, uiLanguage, disabled = false }: {
  draft: WorldGenesisDraft;
  patchDraft: (update: (current: WorldGenesisDraft) => WorldGenesisDraft) => void;
  uiLanguage: UiLanguage;
  disabled?: boolean;
}) {
  return <fieldset disabled={disabled} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <div className="genesis-proposal-fields">
              <label>
                <span>{uiText("ui.genesisChat.field.language", uiLanguage)}</span>
                <select value={draft.language ?? uiLanguage} onChange={(event) => patchDraft((current) => ({ ...current, language: event.target.value as WorldGenesisDraft["language"] }))}>
                  {GENESIS_LANGUAGES.map((language) => <option key={language} value={language}>{language}</option>)}
                </select>
              </label>

              <label>
                <span>{uiText("ui.genesisChat.field.worldName", uiLanguage)}</span>
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
                <span>{uiText("ui.genesisChat.field.era", uiLanguage)}</span>
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
                <span>{uiText("ui.genesisChat.field.summary", uiLanguage)}</span>
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
                <span>{uiText("ui.genesisChat.field.style", uiLanguage)}</span>
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
                <span>{uiText("ui.genesisChat.field.storyTitle", uiLanguage)}</span>
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
                <span>{uiText("ui.genesisChat.field.recordTitle", uiLanguage)}</span>
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
                <span>{uiText("ui.genesisChat.field.storyPremise", uiLanguage)}</span>
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
                <span>{uiText("ui.genesisChat.field.playerRole", uiLanguage)}</span>
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
                <span>{uiText("ui.genesisChat.field.companions", uiLanguage)}</span>
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
                      placeholder={uiText("ui.genesisChat.ph.name", uiLanguage)}
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
                      placeholder={uiText("ui.genesisChat.ph.role", uiLanguage)}
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
                      placeholder={uiText("ui.genesisChat.ph.sketch", uiLanguage)}
                      value={companion.summary}
                    />
                    <button
                      aria-label={uiText("ui.genesisChat.removeCompanion", uiLanguage)}
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
                    ＋ {uiText("ui.genesisChat.addCompanion", uiLanguage)}
                  </button>
                ) : null}
              </div>

              <div className="is-wide">
                <span>{uiText("ui.genesisChat.field.scene", uiLanguage)}</span>
                <div className="scene-grid">
                  <input
                    maxLength={GENESIS_LIMITS.sceneTitle}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        scene: { ...current.scene, title: event.target.value },
                      }))}
                    placeholder={uiText("ui.genesisChat.ph.sceneTitle", uiLanguage)}
                    value={draft.scene.title ?? ""}
                  />
                  <input
                    maxLength={60}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        scene: { ...current.scene, location: event.target.value },
                      }))}
                    placeholder={uiText("ui.genesisChat.ph.location", uiLanguage)}
                    value={draft.scene.location}
                  />
                  <input
                    maxLength={60}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        scene: { ...current.scene, weather: event.target.value },
                      }))}
                    placeholder={uiText("ui.genesisChat.ph.weather", uiLanguage)}
                    value={draft.scene.weather}
                  />
                  <input
                    maxLength={60}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        scene: { ...current.scene, tension: event.target.value },
                      }))}
                    placeholder={uiText("ui.genesisChat.ph.tension", uiLanguage)}
                    value={draft.scene.tension}
                  />
                  <input
                    maxLength={GENESIS_LIMITS.displayTime}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        scene: { ...current.scene, displayTime: event.target.value },
                      }))}
                    placeholder={uiText("ui.genesisChat.ph.displayTime", uiLanguage)}
                    value={draft.scene.displayTime ?? ""}
                  />
                  <input
                    maxLength={120}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        scene: { ...current.scene, objective: event.target.value },
                      }))}
                    placeholder={uiText("ui.genesisChat.ph.objective", uiLanguage)}
                    value={draft.scene.objective}
                  />
                </div>
              </div>

              <GenesisGoalFields goals={draft.recordGoals ?? []} uiLanguage={uiLanguage}
                onChange={recordGoals=>patchDraft(current=>({...current,recordGoals}))}/>
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
  </fieldset>;
}
