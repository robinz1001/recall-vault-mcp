/**
 * PostToolUse Hook — 工具执行后自动提醒 remember
 *
 * Trae 在工具调用完成后触发。
 * 检测 RunCommand 的输出，如果是 npm test / npm run build 成功，
 * 输出 additionalContext 建议 agent remember。
 */

process.stdin.setEncoding('utf-8');
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || '';
    const response = data.tool_response || '';

    if (toolName !== 'RunCommand' && toolName !== 'run_command') {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const responseStr = typeof response === 'string' ? response : JSON.stringify(response);

    const npmTestPass = responseStr.includes('Test Suites:') && responseStr.includes('passed');
    const buildPass = responseStr.includes('Compiled successfully') || responseStr.includes('compiled successfully');
    const exit0 = responseStr.includes('exit code: 0');

    if (npmTestPass || buildPass || exit0) {
      const hint = npmTestPass
        ? 'npm test 全部通过！请 remember 这次测试验证的内容：'
        : buildPass
        ? '构建/编译通过！请 remember 这次构建成功的变更：'
        : '命令执行成功！请判断是否值得 remember：';

      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `[RecallVault PostToolUse] ${hint}\n\n如果是 bug 修复或技术决策: remember({ memory_type: 'semantic', content: '根因 + 修复方案', tags: ['bugfix'], priority: 3 })\n如果是新增功能: remember({ memory_type: 'semantic', content: '做了什么 + 为什么这么做', tags: ['implementation'], priority: 2 })`,
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
