/**
 * Claude Code ~/.claude/settings.json hooks 配置生成器
 *
 * Claude Code 事件名 vs Trae：
 *   Claude Code     → Trae
 *   SessionStart    → SessionStart   (无 matcher)
 *   Stop            → Stop           (无 matcher)
 *   PostToolUse     → PostToolUse    (带 matcher)
 *
 * 注意：Claude Code 的 `hook.json` schema 跟 Trae 几乎完全一致，
 * 但工具名可能不同（Claude Code 用 Bash，Trae 用 RunCommand）。
 */

export function generateClaudeCodeSettings(projectRoot) {
  const projectDir = projectRoot || process.cwd();

  // 使用 "$CLAUDE_PROJECT_DIR" 环境变量（Claude Code spawn hook 时注入）
  // 这样脚本路径是项目相对的，不依赖绝对路径
  // 但如果是全局用户级 settings，需要用绝对路径
  const useProjectRelative = true;
  const scriptPrefix = useProjectRelative ? '"$CLAUDE_PROJECT_DIR"' : projectRoot.replace(/\\/g, '/');

  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `node ${scriptPrefix}/scripts/hook-session-start.mjs`,
              timeout: 30,
            },
          ],
        },
      ],
      Stop: [
        {
          loop_limit: 3,
          hooks: [
            {
              type: 'command',
              command: `node ${scriptPrefix}/scripts/hook-stop.mjs`,
              timeout: 15,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          // Claude Code 工具名：Bash (不是 RunCommand), Write, Edit, Glob, Grep, Read, LS
          // 我们 hook-post-tool.mjs 已经做多工具兼容了
          matcher: 'Bash|RunCommand|run_command|Write|WriteFile|Edit|EditFile|Glob|Grep|Read|ReadFile|LS',
          hooks: [
            {
              type: 'command',
              command: `node ${scriptPrefix}/scripts/hook-post-tool.mjs`,
              timeout: 15,
            },
          ],
        },
      ],
    },
  };
}
