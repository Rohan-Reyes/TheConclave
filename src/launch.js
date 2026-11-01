import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { HOME } from './paths.js';
import { adapters } from './indexer.js';

// Open a new Windows Terminal tab running the tool. Falls back to cmd.exe.
export function openTerminal({ cwd, cmd, args = [] }) {
  const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  // wt treats ';' as a command separator, so escape it in every argument.
  const esc = s => String(s).replace(/;/g, '\\;');
  try {
    const child = spawn('wt.exe', ['-w', '0', 'nt', '-d', esc(dir), '--', esc(cmd), ...args.map(esc)], {
      detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.on('error', () => fallback(dir, cmd, args));
    child.unref();
  } catch { fallback(dir, cmd, args); }
  return { cwd: dir, cmd, args };
}

function fallback(dir, cmd, args) {
  const child = spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', cmd, ...args], { cwd: dir, detached: true, stdio: 'ignore' });
  child.unref();
}

export function resumeChat(chat) {
  return openTerminal(adapters[chat.tool].resumeCommand(chat));
}

export function newSession(tool, cwd) {
  if (!adapters[tool]) throw new Error('unknown tool');
  return openTerminal(adapters[tool].newCommand(cwd));
}
