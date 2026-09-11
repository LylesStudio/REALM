import type { WorldCursor } from "../context/public.ts";

export type ConflictClass = "none" | "bridgeable" | "hard" | "high-risk";

export type BranchRecommendation = {
  conflict: ConflictClass;
  reason: string;
  shouldBranch: boolean;
};

export function classifyWorldlineConflict(input: {
  pastChange: WorldCursor;
  existingFuture: WorldCursor;
  hardCausalAnchors?: readonly string[];
  softContinuityAnchors?: readonly string[];
}): BranchRecommendation {
  const past = input.pastChange;
  const future = input.existingFuture;
  if (compareCursor(past, future) > 0) {
    return {
      conflict: "none",
      reason: "变更晚于现有未来记录，不构成回溯冲突。",
      shouldBranch: false,
    };
  }
  if (input.hardCausalAnchors && input.hardCausalAnchors.length > 0) {
    return {
      conflict: "hard",
      reason: "过去变更触及未来记录依赖的硬因果锚点。",
      shouldBranch: true,
    };
  }
  if (input.softContinuityAnchors && input.softContinuityAnchors.length > 0) {
    return {
      conflict: "bridgeable",
      reason: "过去变更影响软连续性锚点，可桥接或分支。",
      shouldBranch: true,
    };
  }
  return {
    conflict: "high-risk",
    reason: "变更早于现有未来记录，但尚无结构化锚点证明无冲突。",
    shouldBranch: true,
  };
}

function compareCursor(left: WorldCursor, right: WorldCursor): number {
  if (left.tick !== right.tick) return left.tick - right.tick;
  return left.ordinal - right.ordinal;
}
