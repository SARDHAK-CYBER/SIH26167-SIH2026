import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of children) child.kill(); process.exitCode = code; }
for (const args of [['--watch', 'server/index.ts'], ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort']]) {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true }); children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 0); });
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
console.log('Starting SatQuery dashboard + API. Open http://127.0.0.1:5173. Ctrl+C stops both.');
