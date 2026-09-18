/**
 * Persistence-neutral world cursor shared type.
 *
 * Context safety contract: this module's
 * Ledger/Compiler/Manifest 实验管线零生产消费者（orphan，唯一引用者是已
 * 删除的 story-record compatibility adapter 与测试），已按「安全删除并
 * 删除对应 dead contracts/tests」收缩为类型单源。生产侧的时序/可见性
 * 过滤由 PG 查询层承担（record-scope / delivery-projection / memory）。
 */

export interface WorldCursor {
  tick: number;
  ordinal: number;
  calendarId: string;
  display: string;
}
