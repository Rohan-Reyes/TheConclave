// Inspect exactly the index that will be committed, without printing secrets.
import { execFileSync } from 'node:child_process';

const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
const entries = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
const issues = [];
const patterns = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['API key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential assignment', /(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[=:]\s*["'][^"'\s]{16,}["']/i],
  ['personal home path', /(?:[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b)[A-Za-z0-9_. -]+[\\/]|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/)/i],
];
for (const entry of entries) {
  const match = entry.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/);
  if (!match) { issues.push('Unrecognized index entry'); continue; }
  const [, mode, object, stage, file] = match;
  if (stage !== '0') issues.push(`${file}: unresolved merge`);
  if (!['100644', '100755'].includes(mode)) issues.push(`${file}: symlink or submodule requires review`);
  if (/^(?:data|backups|node_modules|artifacts)\//i.test(file) || /(?:^|\/)desktop\.ini$/i.test(file)
      || /\.(?:db|sqlite)(?:$|[-.])/i.test(file) || /\.log$/i.test(file)
      || /(?:^|\/)\.env(?:$|\.)/i.test(file) && !file.endsWith('.env.example')
      || /^scripts\/(?:probe-|debug-infer)/i.test(file)) issues.push(`${file}: local/private file`);
  const buf = execFileSync('git', ['cat-file', 'blob', object], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (buf.includes(0)) {
    if (!/\.(?:png|jpe?g|gif|webp|ico)$/i.test(file)) issues.push(`${file}: unexpected binary file`);
    continue;
  }
  const text = buf.toString('utf8');
  for (const [label, pattern] of patterns) if (pattern.test(text)) issues.push(`${file}: ${label}`);
}
if (!entries.length) issues.push('No staged source files');
if (issues.length) {
  console.error(`Staged scan failed:\n${issues.map(x => `- ${x}`).join('\n')}`);
  process.exitCode = 1;
} else console.log(`Staged scan passed: ${entries.length} files; no excluded data, recognized credentials, or personal home paths.`);
