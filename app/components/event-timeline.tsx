"use client";

import { useEffect, useState } from "react";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import { worldStyleText, type WorldStyle } from "../../modules/style/world-style.ts";
import {
  createDiceRevealTracker,
  resolveDiceRevealPhase,
} from "./dice-reveal.ts";
import { describeVisibility, type TimelineEvent } from "./record-types";
import { SemanticEventContent } from "./semantic-event-content";

interface EventTimelineProps {
  events: TimelineEvent[];
  /** 世界文风：卷首意象措辞随风格分流（缺省 modern）。 */
  style?: WorldStyle;
  /** 界面语言（缺省 zh-CN）。 */
  uiLanguage?: UiLanguage;
}

function roleLabel(role: TimelineEvent["role"], uiLanguage: UiLanguage): string {
  switch (role) {
    case "narrator":
      return uiText("ui.timeline.narrator", uiLanguage);
    case "player":
      return uiText("ui.timeline.player", uiLanguage);
    case "system":
      return uiText("ui.timeline.system", uiLanguage);
    default:
      return uiText("ui.timeline.character", uiLanguage);
  }
}

function signedModifier(modifier: number): string {
  if (modifier > 0) return `+${modifier}`;
  if (modifier < 0) return `${modifier}`;
  return "";
}

/**
 * 批次 T5：骰点明细一行文案（只渲染投影值，前端不模拟骰点）。
 * d20 14+2=16 ≥ 12 · 成功；2d6 [3+5]+1=9 ≥ 8；d100 42 ≤ 50+5；
 * pool [6,3,5] → 2 ≥ 1；draw「牌」· 剩余 7。
 */
function describeDice(dice: NonNullable<TimelineEvent["dice"]>, uiLanguage: UiLanguage): string {
  const outcome = uiText(dice.success ? "ui.dice.success" : "ui.dice.failure", uiLanguage);
  const mark = dice.critical
    ? ` · ${uiText("ui.dice.critical", uiLanguage)}`
    : dice.fumble
      ? ` · ${uiText("ui.dice.fumble", uiLanguage)}`
      : "";
  const modifier = signedModifier(dice.modifier);
  switch (dice.system) {
    case "d20":
      return `🎲 d20 ${dice.rolls[0]}${modifier} = ${dice.total} ≥ ${dice.target} · ${outcome}${mark}`;
    case "2d6":
      return `🎲 2d6 [${dice.rolls.join("+")}]${modifier} = ${dice.total} ≥ ${dice.target} · ${outcome}${mark}`;
    case "percentile":
      return `🎲 d100 ${dice.rolls[0]} ≤ ${dice.target}${modifier} · ${outcome}${mark}`;
    case "pool":
      return `🎲 pool [${dice.rolls.join(",")}]${modifier} → ${dice.total} ≥ ${dice.target} · ${outcome}${mark}`;
    case "draw":
      return `🎲 ${uiText("ui.dice.draw", uiLanguage)}「${dice.drawnCard ?? "?"}」 · ${outcome} · ${uiText("ui.dice.deckRemaining", uiLanguage)} ${dice.deckRemaining ?? 0}`;
  }
}

/**
 * 批次 L：骰点结果揭示（一次性）。滚动态只展示动态字符画占位，
 * 随后揭示服务端已给出的真实 rolls/total/target/outcome——前端绝不
 * 随机、绝不重算；同一稳定 event id 只揭示一次（SSE 重放/轮询/重挂载
 * 不重播）；reduced-motion 直接显示结果。
 */
const diceRevealTracker = createDiceRevealTracker();
const DICE_ROLLING_MS = 900;

function DiceLine({
  dice,
  eventId,
  committed,
  uiLanguage,
}: {
  dice: NonNullable<TimelineEvent["dice"]>;
  eventId: string;
  committed: boolean;
  uiLanguage: UiLanguage;
}) {
  const [phase, setPhase] = useState<"rolling" | "revealed">(() =>
    resolveDiceRevealPhase({
      tracker: diceRevealTracker,
      eventId,
      committed,
      reducedMotion:
        typeof window !== "undefined"
          && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    }),
  );
  useEffect(() => {
    if (phase === "revealed") return;
    const timer = window.setTimeout(() => setPhase("revealed"), DICE_ROLLING_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const outcomeClass = dice.success ? "success" : "failure";
  if (phase === "rolling") {
    return (
      <p
        className="event-dice is-rolling"
        data-dice-outcome={outcomeClass}
        data-dice-system={dice.system}
      >
        <span aria-hidden="true" className="dice-ticker">
          <i>▖</i><i>▗</i><i>▞</i><i>▘</i>
        </span>
        {uiText("ui.dice.rolling", uiLanguage)}
      </p>
    );
  }
  return (
    <p
      className={`event-dice is-${outcomeClass}${dice.critical ? " is-critical" : ""}${dice.fumble ? " is-fumble" : ""}`}
      data-dice-outcome={outcomeClass}
      data-dice-system={dice.system}
      role="status"
    >
      {describeDice(dice, uiLanguage)}
    </p>
  );
}

export function EventTimeline({ events, style, uiLanguage = "zh-CN" }: EventTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="timeline-empty">
        <span aria-hidden="true">◇</span>
        <h2>{worldStyleText("timeline.empty.title", style ?? "modern", undefined, uiLanguage)}</h2>
        <p>{worldStyleText("timeline.empty.hint", style ?? "modern", undefined, uiLanguage)}</p>
      </div>
    );
  }

  return (
    <ol className="event-timeline" aria-label="场景事件时间线">
      {events.map((event, index) => {
        const visibility = describeVisibility(event.visibility, uiLanguage);
        const displayOrdinal = event.ordinal > 0 ? event.ordinal : index + 1;
        return (
          <li
            className={`event-card event-${event.role} is-${event.status}${
              visibility.isOutOfCharacter ? " is-ooc" : ""
            }`}
            id={`event-${event.id}`}
            key={event.id}
            {...(event.presence
              ? { "data-presence": event.presence.triggerKind }
              : {})}
            {...(event.selfPlay
              ? { "data-self-play": String(event.selfPlay.beat) }
              : {})}
          >
            <div className="event-axis" aria-hidden="true">
              <span>{String(displayOrdinal).padStart(2, "0")}</span>
            </div>
            <article>
              <header className="event-meta">
                <div className="speaker-block">
                  <span className="speaker-initial" aria-hidden="true">
                    {event.speaker.slice(0, 1)}
                  </span>
                  <div>
                    <h3>{event.speaker}</h3>
                    <p>{roleLabel(event.role, uiLanguage)}</p>
                  </div>
                </div>
                <div className="event-stamps">
                  {visibility.label ? (
                    <span className={visibility.isOutOfCharacter ? "visibility-ooc" : undefined}>
                      {visibility.label}
                    </span>
                  ) : null}
                  {event.worldTime ? <time>{event.worldTime}</time> : null}
                </div>
              </header>
              <SemanticEventContent
                reveal={event.status === "committed" && index === events.length - 1}
                segments={event.segments}
              />
              {event.dice ? (
                <DiceLine
                  committed={event.status === "committed"}
                  dice={event.dice}
                  eventId={event.id}
                  uiLanguage={uiLanguage}
                />
              ) : null}
              {event.status !== "committed" ? (
                <p className={`delivery-state delivery-${event.status}`} role="status">
                  {event.status === "pending"
                    ? "正在等待世界回应…"
                    : "发送失败，内容尚未写入记录"}
                </p>
              ) : null}
            </article>
          </li>
        );
      })}
    </ol>
  );
}
