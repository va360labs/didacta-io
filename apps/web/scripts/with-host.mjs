/**
 * Cross-platform host/port wrapper for the Next.js server scripts.
 *
 * Shell-default syntax (`${VAR:-default}`) inside package.json scripts is
 * bash-only and breaks on Windows (cmd.exe). This runner resolves WEB_HOST /
 * WEB_PORT with plain Node APIs instead and spawns the Next CLI directly
 * (no shell), so behavior is identical across npm/pnpm on POSIX and Windows.
 *
 * Usage: node scripts/with-host.mjs <dev|start> [extra next args...]
 * Env:   WEB_HOST (default 0.0.0.0 — Next's own default when no -H is given),
 *        WEB_PORT (default 3010 — the historical hard-coded value)
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const command = process.argv[2];
if (command !== 'dev' && command !== 'start') {
  console.error('usage: node scripts/with-host.mjs <dev|start> [next args...]');
  process.exit(1);
}

const host = process.env['WEB_HOST'] || '0.0.0.0';
const port = process.env['WEB_PORT'] || '3010';
const extra = process.argv.slice(3);

const require = createRequire(import.meta.url);
const nextCli = require.resolve('next/dist/bin/next');

const child = spawn(process.execPath, [nextCli, command, '-H', host, '-p', port, ...extra], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
