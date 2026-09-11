import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
for (const [cmd, args] of [['python', ['-m', 'venv', '.venv']], [python, ['-m', 'pip', 'install', '-r', 'server/requirements.txt']]]) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) { console.error(result.error?.message || 'JP2 setup failed.'); process.exit(1); }
}
console.log('JP2 decoder installed. Start the app with npm start.');
