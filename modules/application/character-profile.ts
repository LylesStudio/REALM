export interface CharacterProfileUpdate {
  readonly [key: string]: string;
  characterInstanceId: string;
  identity: string;
  profileSummary: string;
  evidence: string;
}

const MAX_IDENTITY_LENGTH = 32;
const MAX_EVIDENCE_LENGTH = 160;

/**
 * 从玩家明确的身份自述中提取当前 Record 角色简介更新。
 * 只接受肯定句，不把“想成为/不是/不再是”等愿望或否定当作事实。
 */
export function extractExplicitCharacterProfileUpdate(
  text: string,
  character: { characterInstanceId: string },
): CharacterProfileUpdate | null {
  const evidence = text.trim();
  if (!character.characterInstanceId || !evidence) return null;
  if (/(?:我|本人|私).*(?:不是|并非|不再是|想成为|想当|将成为)/i.test(evidence)
    || /(?:I am|I'm|my role is|my identity is)\s+(?:not|no longer|going to become)/i.test(evidence)
  ) {
    return null;
  }

  const identity = extractIdentity(evidence);
  if (!identity) return null;
  return {
    characterInstanceId: character.characterInstanceId,
    identity,
    profileSummary: `当前身份：${identity}`,
    evidence: evidence.slice(0, MAX_EVIDENCE_LENGTH),
  };
}

function extractIdentity(text: string): string | null {
  const chinese = text.match(
    /(?:我(?:就是|现在是|是)|我的身份是|本人是|作为)\s*(?:一名|一个|这艘船的|本船的)?([^，。！？；,.!?;\n]{1,32})/,
  )?.[1];
  const english = text.match(
    /(?:I am|I'm|my role is|my identity is)\s+(?:a|an|the)?\s*([A-Za-z][A-Za-z -]{1,31})/i,
  )?.[1];
  const japanese = text.match(
    /(?:私は|私の身分は)\s*(?:一人の)?([^、。！？\n]{1,32})(?:です|だ)?/,
  )?.[1];
  const value = (chinese ?? english ?? japanese ?? "")
    .trim()
    .replace(/["“”「」『』]+/g, "")
    .replace(/[，。！？；,.!?;]+$/g, "")
    .trim()
    .slice(0, MAX_IDENTITY_LENGTH);
  return value || null;
}
