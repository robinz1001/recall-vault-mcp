/**
 * 共享类型定义
 */

export type MemoryType = 'episodic' | 'semantic';
export type MemoryScope = 'project' | 'shared';
export type MemoryAgent = 'claude-code' | 'codex' | 'codebuddy' | 'trae' | 'manual' | 'import';
export type MemoryPriority = 1 | 2 | 3;

/** 一个记忆的完整元数据（对应 frontmatter 字段） */
export interface MemoryMeta {
  /** 全局唯一：mem_YYYYMMDD_序号 */
  id: string;
  scope: MemoryScope;
  /** scope=shared 时为 "shared"，否则是项目目录名 */
  project_id: string;
  memory_type: MemoryType;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  archived: boolean;
  priority: MemoryPriority;

  agent: MemoryAgent;
  session_id?: string;
  reviewed?: boolean;

  tags: string[];
  related_files: string[];

  // === 双时钟 frontmatter（Phase 2）===
  /** 事实生效起始时间，默认 = created_at */
  valid_from?: string;
  /** 事实失效时间，null/undefined = 当前仍有效。replaces 时自动设为 now */
  valid_to?: string;
  /** 这条记忆取代了谁（旧记忆的 memory_id） */
  supersedes?: string;
  /** 这条记忆被谁取代了（新记忆的 memory_id） */
  superseded_by?: string;
}

/** vault 内一个记忆文件的完整表示 */
export interface MemoryEntry {
  /** vault 根目录相对路径 */
  path: string;
  meta: MemoryMeta;
  /** frontmatter 之后的正文 */
  body: string;
}
