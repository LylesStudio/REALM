export type LibraryCreateCommand =
  | { kind: "world"; name: string; era: string; summary: string }
  | { kind: "preset-world"; presetKey: string; language?: "zh-CN" | "en" | "ja" }
  | { kind: "story"; worldId: string; title: string; premise: string }
  | {
      kind: "record";
      storyId: string;
      title: string;
      retrospection?: boolean;
      mergeTargetRecordId?: string;
    }
  | {
      kind: "character";
      worldId: string;
      name: string;
      role: string;
      summary: string;
      /** 批次 S：非空时同事务把新角色装配进该记录阵容。 */
      attachRecordId?: string;
    }
  | {
      kind: "branch";
      worldId: string;
      label: string;
      /** 分叉来源 record（必填；空 worldline 幽灵路径已废弃）。 */
      sourceRecordId: string;
    }
  | { kind: "world-style"; worldId: string; style: string }
  /** 批次 S：切换本人在该世界的姿态（入局 / 观察者）。 */
  | { kind: "player-stance"; worldId: string; stance: "player" | "observer" }
  /** 批次 T6：把既有角色（含导入卡）挂入既有记录阵容。 */
  | { kind: "attach-character"; worldId: string; recordId: string; definitionId: string }
  /** Record 级角色席位可逆进退场；不删除 participant/instance。 */
  | {
      kind: "character-activity";
      worldId: string;
      recordId: string;
      definitionId: string;
      active: boolean;
    }
  /** 批次 T8：世界归档/恢复（owner-only，幂等）。 */
  | { kind: "world-archive"; worldId: string; archived: boolean }
  /** Record 级删除：owner-only；归档隐藏，不物理删除 append-only Events。 */
  | { kind: "delete-record"; worldId: string; recordId: string }
  /** 批次 T8：删除世界（owner-only，仅零事件世界）。 */
  | { kind: "delete-world"; worldId: string };

export interface LibraryCharacter {
  id: string;
  name: string;
  role: string;
  summary: string;
  status: string;
  /** 头像文件 id（/api/files/[id]）；无则为空串。 */
  avatarFileId: string;
  /** 批次 S：角色来源（native / tavern）。 */
  sourceFormat: string;
}

export interface LibraryWorldline {
  id: string;
  label: string;
  status: string;
  parentWorldlineId: string | null;
}

export interface LibraryRecord {
  id: string;
  title: string;
  status: string;
  timelineKind: "primary" | "retrospection" | "merged" | "branch";
  linkedRecordId: string | null;
}

export interface LibraryStory {
  id: string;
  title: string;
  status: string;
  /** 故事前提（T12 验收修正：故事视图按选中故事展示，缺省空串）。 */
  premise: string;
  records: LibraryRecord[];
}

export interface LibraryWorld {
  id: string;
  name: string;
  era: string;
  /** 世界文风 key（缺失时前端按 modern 处理）。 */
  style: string;
  summary: string;
  status: string;
  /** 批次 S：本人 membership.role（owner/player/observer），姿态开关依据。 */
  membershipRole: string;
  /** 批次 T8：世界卡信息密度（缺省 0/null fail-closed）。 */
  storyCount: number;
  /** v37 H.2：分支世界线数（template 导出可用性提示）。 */
  branchCount: number;
  recordCount: number;
  characterCount: number;
  lastActiveAt: string | null;
  characters: LibraryCharacter[];
  worldlines: LibraryWorldline[];
  stories: LibraryStory[];
}

export interface LibrarySnapshot {
  worlds: LibraryWorld[];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeLibrarySnapshot(value: unknown): LibrarySnapshot {
  if (value === null || typeof value !== "object") return { worlds: [] };
  const source = value as Record<string, unknown>;
  const worlds = Array.isArray(source.worlds) ? source.worlds : [];
  return {
    worlds: worlds.flatMap((world) => {
      if (world === null || typeof world !== "object") return [];
      const item = world as Record<string, unknown>;
      const stories = Array.isArray(item.stories) ? item.stories : [];
      return [{
        id: asString(item.id),
        name: asString(item.name),
        era: asString(item.era),
        style: asString(item.style),
        summary: asString(item.summary),
        status: asString(item.status),
        membershipRole: typeof item.membershipRole === "string"
          && (item.membershipRole === "owner"
            || item.membershipRole === "player"
            || item.membershipRole === "observer")
          ? item.membershipRole
          : "player",
        storyCount: typeof item.storyCount === "number" ? item.storyCount : 0,
        branchCount: typeof item.branchCount === "number" ? item.branchCount : 0,
        recordCount: typeof item.recordCount === "number" ? item.recordCount : 0,
        characterCount: typeof item.characterCount === "number"
          ? item.characterCount
          : 0,
        lastActiveAt: typeof item.lastActiveAt === "string" && item.lastActiveAt
          ? item.lastActiveAt
          : null,
        characters: Array.isArray(item.characters)
          ? item.characters.flatMap((character) => {
              if (character === null || typeof character !== "object") return [];
              const characterItem = character as Record<string, unknown>;
              return [{
                id: asString(characterItem.id),
                name: asString(characterItem.name),
                role: asString(characterItem.role),
                summary: asString(characterItem.summary),
                status: asString(characterItem.status),
                avatarFileId: asString(characterItem.avatarFileId),
                sourceFormat: asString(characterItem.sourceFormat),
              }];
            })
          : [],
        worldlines: Array.isArray(item.worldlines)
          ? item.worldlines.flatMap((worldline) => {
              if (worldline === null || typeof worldline !== "object") return [];
              const worldlineItem = worldline as Record<string, unknown>;
              return [{
                id: asString(worldlineItem.id),
                label: asString(worldlineItem.label),
                status: asString(worldlineItem.status),
                parentWorldlineId: typeof worldlineItem.parentWorldlineId === "string"
                  ? worldlineItem.parentWorldlineId
                  : null,
              }];
            })
          : [],
        stories: stories.flatMap((story) => {
          if (story === null || typeof story !== "object") return [];
          const storyItem = story as Record<string, unknown>;
          const records = Array.isArray(storyItem.records) ? storyItem.records : [];
          return [{
            id: asString(storyItem.id),
            title: asString(storyItem.title),
            status: asString(storyItem.status),
            premise: asString(storyItem.premise),
            records: records.flatMap((record) => {
              if (record === null || typeof record !== "object") return [];
              const recordItem = record as Record<string, unknown>;
              return [{
                id: asString(recordItem.id),
                title: asString(recordItem.title),
                status: asString(recordItem.status),
                timelineKind: recordItem.timelineKind === "retrospection"
                  || recordItem.timelineKind === "merged"
                  || recordItem.timelineKind === "branch"
                  ? recordItem.timelineKind
                  : "primary",
                linkedRecordId: typeof recordItem.linkedRecordId === "string"
                  ? recordItem.linkedRecordId
                  : null,
              }];
            }),
          }];
        }),
      }];
    }),
  };
}
