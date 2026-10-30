/**
 * Windsurf .windsurf/hooks.json 配置生成器
 *
 * Windsurf 独特之处：
 *   - 只有 pre_user_prompt / post_user_prompt（**没有 SessionStart 事件**）
 *   - 所以 session-start 逻辑移到 pre_user_prompt，每轮 prompt 前都注入 vault 摘要
 *   - 命令可以用数组形式 ["bash", "/path/to/script"]
 *
 * 项目级配置：.windsurf/hooks.json
 */

export function generateWindsurfHooks(projectRoot) {
  const projectDir = projectRoot || process.cwd();
  const scriptsDir = projectDir.replace(/\\/g, '/');

  return {
    hooks: {
      // 每轮 prompt 前注入 vault 摘要（替代缺失的 SessionStart）
      pre_user_prompt: [
        {
          command: ['node', `${scriptsDir}/scripts/hook-session-start.mjs`],
          timeout: 15,
        },
      ],
    },
  };
}
