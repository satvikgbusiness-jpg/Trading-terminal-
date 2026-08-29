#!/usr/bin/env node
/**
 * `pnpm dev` -- runs the web app and the background worker together.
 *
 * The worker refreshes news, expires lapsed approvals and prunes the cache. The
 * app is fully usable without it (routes fetch on demand), but the news pane
 * fills in faster and approvals expire on time with it running.
 */
import { spawn } from 'node:child_process';

const children = [];
let shuttingDown = false;

function run(name, command, args, color) {
  const child = spawn(command, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
    shell: process.platform === 'win32',
  });

  const prefix = `\x1b[${color}m[${name}]\x1b[0m`;
  const forward = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix} ${line}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    // If the web server dies the whole dev session is over; a worker crash is
    // survivable and should not take the app down with it.
    if (name === 'web') {
      console.error(`${prefix} exited (${signal ?? code}); shutting down.`);
      shutdown(code ?? 1);
    } else {
      console.error(`${prefix} exited (${signal ?? code}). The app keeps running.`);
    }
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 200);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

run('web', 'next', ['dev'], '36');
run('worker', 'tsx', ['--require', './scripts/_bootstrap.cjs', 'scripts/worker.ts'], '35');
