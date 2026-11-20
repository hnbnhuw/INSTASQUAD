// Chạy backend (cổng 4000, tự reload) + frontend Vite (cổng 5173) cùng lúc. Không cần thư viện ngoài.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const procs = [
  ['api', path.join(root, 'server'), ['run', 'dev']],
  ['web', path.join(root, 'client'), ['run', 'dev']],
].map(([name, cwd, args]) => {
  const p = spawn(npm, args, { cwd, shell: process.platform === 'win32', env: process.env });
  const tag = (s) => s.toString().split(/\r?\n/).filter(Boolean).map((l) => `[${name}] ${l}`).join('\n');
  p.stdout.on('data', (d) => console.log(tag(d)));
  p.stderr.on('data', (d) => console.error(tag(d)));
  p.on('exit', (code) => {
    console.log(`[${name}] đã dừng (code ${code})`);
    for (const q of procs) if (q !== p) q.kill();
    process.exit(code ?? 0);
  });
  return p;
});
console.log('INSTASQUAD dev: mở http://localhost:5173 (API: http://localhost:4000/api/health)');
process.on('SIGINT', () => procs.forEach((p) => p.kill()));
