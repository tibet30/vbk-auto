/**
 * 会话消息 + touch 工具：
 *   - addMessage / updateMessageStatus：写 / 更新 messages 表 + touch 产品 updated_at；
 *   - recoverUnansweredMessages：启动时清理"未答完"消息（role=user 且
 *     task_status=running/空、且之后没有 assistant 回复在下一条 user 之前）；
 *     把它们标记为 failed 并补一条"上一轮未获得 AI 回复"的说明。
 *   - touchProduct：内部 updated_at 维护。
 *
 * 调用方零改动：原 products.ts 通过 barrel 重导出。
 */

import type Database from "better-sqlite3";
import type { ConversationMessage, TaskStatus } from "../../../../../shared/contracts.js";
import { now } from "../types.js";
import { randomUUID } from "node:crypto";

/** 写入一条会话消息；并 touch 产品。 */
export function addMessage(
  db: Database.Database,
  localProductId: string,
  role: ConversationMessage["role"],
  content: string,
  taskStatus?: ConversationMessage["taskStatus"],
) {
  const id = randomUUID();
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?)").run(id, localProductId, role, content, taskStatus || null, now());
  touchProduct(db, localProductId);
  return id;
}

/** 更新一条消息的 task_status。 */
export function updateMessageStatus(db: Database.Database, localProductId: string, messageId: string, taskStatus: TaskStatus) {
  db.prepare("UPDATE messages SET task_status=? WHERE id=? AND local_product_id=?").run(taskStatus, messageId, localProductId);
  touchProduct(db, localProductId);
}

/**
 * 启动时清理"未答完"消息：role=user 且 task_status=running/空、且之后
 * 没有 assistant 回复（在下一条 user 之前）。把它们标记为 failed 并补一
 * 条"上一轮未获得 AI 回复"的说明。
 */
export function recoverUnansweredMessages(db: Database.Database): void {
  const unanswered = db.prepare(`
    SELECT message.id, message.local_product_id FROM messages AS message
    WHERE message.role='user' AND (message.task_status IS NULL OR message.task_status='running')
      AND NOT EXISTS (
        SELECT 1 FROM messages AS reply
        WHERE reply.local_product_id=message.local_product_id AND reply.role='assistant' AND reply.created_at > message.created_at
          AND reply.created_at < COALESCE((
            SELECT MIN(next_message.created_at) FROM messages AS next_message
            WHERE next_message.local_product_id=message.local_product_id AND next_message.role='user' AND next_message.created_at > message.created_at
          ), '9999-12-31T23:59:59.999Z')
      )
  `).all() as Array<{ id: string; local_product_id: string }>;
  for (const message of unanswered) {
    updateMessageStatus(db, message.local_product_id, message.id, "failed");
    addMessage(db, message.local_product_id, "assistant", "上一轮在应用关闭前没有完成，未获得 AI 回复。请重新发送这条消息。", "failed");
  }
}

/** touch 产品的 updated_at。 */
export function touchProduct(db: Database.Database, id: string) {
  db.prepare("UPDATE products SET updated_at=? WHERE id=?").run(now(), id);
}