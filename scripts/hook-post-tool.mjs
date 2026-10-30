/**
 * PostToolUse Hook — 覆盖所有值得提醒的 IDE 工具
 *
 * 覆盖的工具类型：
 *   1. RunCommand / runCommand       → 检测 test_pass/build_pass/git_commit/install/deploy
 *   2. ReadFile / FileRead / read_file → 批量读 vault md → 建议 recall 替代
 *   3. Glob / SearchGlob / glob       → 手动搜 vault → 建议 list_memories
 *   4. WriteFile / FileWrite / write_file → 写 vault md → 警告绕过 remember
 *   5. Edit / EditFile / edit_file    → edit vault md → 提醒可能需要 update_memory
 *
 * marker 文件（供 Stop Hook 消费）：agent-state/activity.json
 */

import fs from 'node:fs';
import path from 'node:path';

const cwd = process.env.TRAE_PROJECT_DIR || process.env.CODEBUDDY_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.env.CODEX_PROJECT_DIR || process.env.WINDSURF_PROJECT_DIR || process.env.OPENCODE_PROJECT_DIR || process.cwd();
const stateDir = path.join(cwd, 'agent-state');
const markerFile = path.join(stateDir, 'activity.json');
const vaultMdPattern = /[\\/](projects|shared)[\\/].*\.md$/; // vault 内的 md 文件路径特征

function ensureStateDir() {
  if (!fs.existsSync(stateDir)) {
    try { fs.mkdirSync(stateDir, { recursive: true }); } catch { /* ignore */ }
  }
}

function loadMarker() {
  try {
    if (!fs.existsSync(markerFile)) return { activities: [], last_remember_ts: null };
    const raw = fs.readFileSync(markerFile, 'utf-8');
    return JSON.parse(raw);
  } catch { return { activities: [], last_remember_ts: null }; }
}

function saveMarker(marker) {
  ensureStateDir();
  try {
    fs.writeFileSync(markerFile, JSON.stringify(marker, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

/** 判断路径是否指向 vault 内的 md 文件（兼容绝对/相对路径、跨平台斜杠） */
function isVaultMd(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^[A-Za-z]:\//, '');
  return /(^|\/)(projects|shared)\/.+\.md$/i.test(norm);
}

/** 从 args 里提取文件路径（兼容不同 IDE 工具的参数名） */
function extractFilePath(args) {
  if (!args) return null;
  if (typeof args === 'string') return args;
  // 常见参数名
  const candidates = ['file_path', 'filePath', 'path', 'file', 'target', 'target_path'];
  for (const c of candidates) {
    if (args[c] && typeof args[c] === 'string') return args[c];
  }
  return null;
}

/** 从 args 里提取 glob/search pattern */
function extractPattern(args) {
  if (!args) return null;
  if (typeof args === 'string') return args;
  const candidates = ['pattern', 'glob', 'query', 'search'];
  for (const c of candidates) {
    if (args[c] && typeof args[c] === 'string') return args[c];
  }
  return null;
}

/**
 * 主入口：根据 tool_name + args + response 判断事件类型
 *
 * 返回 null 表示继续正常流程；返回 { activity, hint } 表示需要写 marker + additionalContext
 */
function detectEvent(toolName, argsObj, responseStr) {
  const name = (toolName || '').toLowerCase();

  // ============ 1. RunCommand — 检测值得 remember 的产出 ============
  if (name.includes('runcommand') || name.includes('run_command')) {
    const lower = responseStr.toLowerCase();
    const truncated = responseStr.slice(0, 500);

    // test pass
    const testPass = (
      (lower.includes('test suites:') && lower.includes('passed') && !lower.includes('failed')) ||
      (lower.includes('tests passed') && !lower.includes('tests failed')) ||
      lower.includes('passed all tests') ||
      lower.includes('all tests passed')
    );
    if (testPass) {
      return {
        activity: {
          type: 'test_pass',
          priority: 3,
          tags: ['verification', 'test'],
          suggested_content: '测试全部通过，确认了本次改动的正确性。',
          detail: truncated,
        },
        hint: '🎉 测试全部通过！请 remember 这次测试验证的修复方案或新功能：',
      };
    }

    // build pass — priority=2，静默写 marker 不打扰（agent 自己判断要不要 remember）
    const buildPass = (
      lower.includes('compiled successfully') ||
      lower.includes('build succeeded') ||
      lower.includes('build complete') ||
      lower.includes('webpack compiled') ||
      lower.includes('vite ready') ||
      lower.includes('build done')
    );
    if (buildPass) {
      return {
        activity: {
          type: 'build_pass',
          priority: 2,
          tags: ['build'],
          suggested_content: null,
          detail: truncated,
        },
        hint: null, // 静默
      };
    }

    // git commit — 默认 priority=1，配对 test_pass/build_pass 时升级到 3 并推 hint
    if (lower.includes('[main') || lower.includes('[master') || (lower.includes('committed') && lower.includes('hash')) || lower.includes('commit ')) {
      return {
        activity: {
          type: 'git_commit',
          priority: 1,
          tags: ['commit'],
          suggested_content: null,
          detail: truncated,
        },
        hint: null,
      };
    }

    // 依赖安装 — priority=2，静默
    if ((lower.includes('added') || lower.includes('installed')) && lower.includes('package')) {
      return {
        activity: {
          type: 'install',
          priority: 2,
          tags: ['dependency'],
          suggested_content: null,
          detail: truncated,
        },
        hint: null,
      };
    }

    // deploy/publish — priority=2，静默
    if (lower.includes('deployed') || lower.includes('published') || lower.includes('deploy success') || lower.includes('deployed to')) {
      return {
        activity: {
          type: 'deploy',
          priority: 2,
          tags: ['deploy'],
          suggested_content: null,
          detail: truncated,
        },
        hint: null,
      };
    }

    return null;
  }

  // ============ 2. Glob / SearchGlob — 手动搜 vault ============
  if (name.includes('glob') || name.includes('search')) {
    const pattern = extractPattern(argsObj);
    // 搜 vault projects/ 或 shared/ 下的 md
    if (pattern && (pattern.includes('vault') || pattern.includes('projects') || pattern.includes('shared') || pattern.includes('**/*.md'))) {
      return {
        activity: null, // 不写 marker（不是产出事件）
        hint: `💡 手动 glob 搜索记忆中... 建议用 recall({ query: "关键词", include_shared: true, compact: true }) 或 list_memories({ compact: true }) 更高效。`,
      };
    }
    return null;
  }

  // ============ 3. ReadFile / FileRead — 批量读 vault md ============
  if (name.includes('readfile') || name.includes('file_read') || name.includes('read_file')) {
    const fp = extractFilePath(argsObj);
    if (fp && isVaultMd(fp)) {
      return {
        activity: null, // 不写 marker
        hint: `💡 手动读取 vault 记忆文件。下次可以先用 recall({ query: "关键词", compact: true }) 搜索，找到目标后再精读。`,
      };
    }
    return null;
  }

  // ============ 4. WriteFile — 写 vault md（绕过 remember）===========
  if (name.includes('writefile') || name.includes('file_write') || name.includes('write_file') || name.includes('createfile')) {
    const fp = extractFilePath(argsObj);
    if (fp && isVaultMd(fp)) {
      return {
        activity: null,
        hint: `⚠️ 检测到直接写入 vault 记忆文件（绕过 remember MCP）。下次请用 remember({ memory_type: 'semantic', scope: 'project' }) 自动生成正确 frontmatter 并同步 flexsearch 索引。`,
      };
    }
    return null;
  }

  // ============ 5. Edit / EditFile — edit vault md（绕过 update_memory）===========
  if (name.includes('edit') && !name.includes('editmemory') && !name.includes('setmemory') && !name.includes('update')) {
    // 注意：update_memory 也带 edit，要排除
    const fp = extractFilePath(argsObj);
    if (fp && isVaultMd(fp)) {
      return {
        activity: null,
        hint: `⚠️ 检测到直接编辑 vault 记忆文件（绕过 update_memory MCP）。下次请用 update_memory({ memory_id: '...', content: '...' }) 保持 frontmatter 和索引同步。`,
      };
    }
    return null;
  }

  return null;
}

// ============ 主流程 ============
process.stdin.setEncoding('utf-8');
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || data.toolName || '';
    const args = data.tool_args || data.args || {};
    const response = data.tool_response || data.response || '';
    const responseStr = typeof response === 'string' ? response : JSON.stringify(response);

    const result = detectEvent(toolName, args, responseStr);
    if (!result) {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    // 写 marker（只有产出事件才写，ReadFile/WriteFile/Edit 等不写）
    if (result.activity) {
      const marker = loadMarker();
      // 升级 git_commit：如果已有 test_pass/build_pass 在 marker 里 → 说明是有意义的提交
      if (result.activity.type === 'git_commit' && result.activity.priority <= 1) {
        const hasValidation = marker.activities.some(
          (a) => a.type === 'test_pass' || a.type === 'build_pass',
        );
        if (hasValidation) {
          result.activity.priority = 3; // 有验证的提交 → 值得 remember
          result.activity.suggested_content = '本次提交有测试/构建验证通过，包含实质性改动。';
          result.hint = '📦 有验证的代码提交！请 remember 本次变更的核心决策：';
        }
      }
      marker.activities.push({
        ...result.activity,
        ts: new Date().toISOString(),
      });
      // 只保留最近 20 条
      if (marker.activities.length > 20) {
        marker.activities = marker.activities.slice(-20);
      }
      saveMarker(marker);
    }

    // 输出 additionalContext（hint=null 表示静默写 marker，不打扰 agent）
    if (result.hint) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `[RecallVault PostToolUse] ${result.hint}`,
          },
        }),
      );
    } else {
      process.stdout.write(JSON.stringify({ continue: true }));
    }
  } catch {
    process.stdout.write(JSON.stringify({ continue: true }));
  }
});
