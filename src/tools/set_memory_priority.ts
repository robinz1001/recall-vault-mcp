/**
 * set_memory_priority — 快速设置 priority（1/2/3）
 *
 * 其实是 update_memory 的简化版本，单独做工具是为了：
 * 1. Agent 不需要记住 update_memory 的完整签名
 * 2. 语义更清晰（"提升这个记忆的优先级" vs "修改字段"）
 */

import { updateMemory, type UpdateArgs } from './update_memory.js';

export interface SetPriorityArgs {
  memory_id: string;
  priority: 1 | 2 | 3;
  scope?: 'project' | 'shared';
  project_id?: string;
}

export interface SetPriorityResult {
  memory_id: string;
  path: string;
  priority: number;
}

export async function setPriority(args: SetPriorityArgs): Promise<SetPriorityResult> {
  const result = await updateMemory({
    memory_id: args.memory_id,
    scope: args.scope,
    project_id: args.project_id,
    priority: args.priority,
  } as UpdateArgs);

  return { memory_id: result.memory_id, path: result.path, priority: args.priority };
}
