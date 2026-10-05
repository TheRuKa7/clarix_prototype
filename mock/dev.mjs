// `npm run start:local`: the mock backends plus `ng serve` with the local proxy, stopped together.
// Open http://localhost:4310/__local/signin once to sign in; the session lasts 30 days.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (!args.includes('--port')) args.push('--port', '4310');
if (!args.includes('--proxy-config')) args.push('--proxy-config', 'mock/proxy.local.json');

const kids = [
  spawn(process.execPath, ['mock/server.mjs'], { cwd: root, stdio: 'inherit' }),
  // NG_CLI_ANALYTICS off: the first-run analytics question would otherwise hang
  // a non-interactive launch forever.
  spawn(process.execPath, ['node_modules/@angular/cli/bin/ng.js', 'serve', ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, NG_CLI_ANALYTICS: 'false' } }),
];
const stop = () => { for (const k of kids) if (!k.killed) k.kill(); process.exit(); };
for (const k of kids) k.on('exit', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
