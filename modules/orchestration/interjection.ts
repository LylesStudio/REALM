/**
 * M4 automatic interjection policy.
 *
 * Four gates in order, all must pass before an interjection Turn runs:
 *   1. DM judgment (strong silence bias: only a character explicitly
 *      addressed by name and left unactivated this Turn is eligible);
 *   2. character budget (at most one interjection per player Turn);
 *   3. cooldown (a character inside its cooldown window stays silent and is
 *      NOT queued);
 *   4. speaking lease (the Record TurnControlLease must be free).
 */

import type { ActivatedCharacter } from "./public.ts";
import type { TurnControl } from "../runtime/turn-control.ts";

export type InterjectionDecision =
  | { kind: "interject"; character: ActivatedCharacter; reason: string }
  | { kind: "silent"; reason: string };

export interface InterjectionPolicy {
  evaluate(input: {
    recordId: string;
    playerText: string;
    activatedCharacters: readonly ActivatedCharacter[];
    availableCharacters: readonly ActivatedCharacter[];
  }): InterjectionDecision;
}

export function createRuleBasedInterjectionPolicy(options: {
  turnControl: TurnControl;
  budget?: number;
}): InterjectionPolicy {
  const budget = options.budget ?? 1;
  return {
    evaluate(input) {
      if (budget < 1) {
        return { kind: "silent", reason: "interjection budget is zero" };
      }
      const activated = new Set(
        input.activatedCharacters.map((character) => character.characterInstanceId),
      );
      const addressed = input.availableCharacters.filter(
        (character) =>
          !activated.has(character.characterInstanceId)
          && character.displayName.trim().length > 0
          && input.playerText.includes(character.displayName),
      );
      if (addressed.length === 0) {
        // 强沉默偏置：未被明确点名的角色一律不插话。
        return { kind: "silent", reason: "no character was explicitly addressed" };
      }
      const eligible = addressed.find((character) =>
        options.turnControl.canInterject(character.characterInstanceId)
      );
      if (!eligible) {
        return { kind: "silent", reason: "addressed characters are cooling down" };
      }
      if (!options.turnControl.isFree(input.recordId)) {
        return { kind: "silent", reason: "speaking lease is held" };
      }
      return {
        kind: "interject",
        character: eligible,
        reason: `${eligible.displayName} was addressed but not activated`,
      };
    },
  };
}
