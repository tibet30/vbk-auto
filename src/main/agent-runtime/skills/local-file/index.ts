/**
 * 本地文件 Skill：目录、读取、新建、修改、覆盖、移动、删除七类动作。
 *
 * 所有路径都经 `resolveScopedPath` 以任务授权目录的 realpath 为根校验；
 * 软链接、`..` 与绝对路径一律拒绝，写动作必须走审批与收据。
 */

import type { AgentSkill } from "../../types.js";
import { listAction, readAction } from "./read-actions.js";
import {
  createAction,
  deleteAction,
  modifyAction,
  moveAction,
  overwriteAction,
} from "./write-actions.js";

export const localFileSkill: AgentSkill = {
  id: "local-file",
  label: "本地文件",
  description: "在任务授权目录内读取、新建、修改、覆盖、移动与删除文件；写入必须经运营授权。",
  actions: [
    listAction,
    readAction,
    createAction,
    modifyAction,
    overwriteAction,
    moveAction,
    deleteAction,
  ],
};
