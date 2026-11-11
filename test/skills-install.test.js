import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SKILL_DIRS,
  previewInstall,
  installSkill,
} from '../src/config/skills.js';
const temp = fs.mkdtempSync(join(tmpdir(), 'conclave-install-'));
for (const [id, target] of Object.entries(SKILL_DIRS))
  target.dir = join(temp, id);
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const content =
  '---\nname: sample-skill\ndescription: Synthetic installation fixture\n---\nRead the local project.';
test('reviewed skills install for chosen tools without overwriting existing skills', () => {
  const input = { name: 'sample-skill', content, targets: ['codex', 'claude'] };
  const preview = previewInstall(input);
  assert.equal(preview.files[0].path, 'SKILL.md');
  assert.throws(() => installSkill(input), /reviewed/);
  installSkill({ ...input, digest: preview.digest });
  for (const target of input.targets)
    assert.equal(
      fs.readFileSync(
        join(SKILL_DIRS[target].dir, input.name, 'SKILL.md'),
        'utf8',
      ),
      content,
    );
  assert.throws(
    () => installSkill({ ...input, digest: preview.digest }),
    /already has/,
  );
});
test('source changes invalidate review, support files are retained, symlinks and unsafe names are rejected', () => {
  const source = join(temp, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(join(source, 'SKILL.md'), content);
  fs.mkdirSync(join(source, 'references'));
  fs.writeFileSync(join(source, 'references', 'guide.txt'), 'original');
  const input = { name: 'sample-skill', source, targets: ['antigravity-cli'] };
  const preview = previewInstall(input);
  assert.equal(preview.files.length, 2);
  fs.writeFileSync(join(source, 'references', 'guide.txt'), 'changed');
  assert.throws(
    () => installSkill({ ...input, digest: preview.digest }),
    /changed/,
  );
  const reviewed = previewInstall(input);
  installSkill({ ...input, digest: reviewed.digest });
  assert.equal(
    fs.readFileSync(
      join(
        SKILL_DIRS['antigravity-cli'].dir,
        'sample-skill',
        'references',
        'guide.txt',
      ),
      'utf8',
    ),
    'changed',
  );
  fs.symlinkSync(join(source, 'SKILL.md'), join(source, 'bad-link'));
  assert.throws(
    () => previewInstall({ ...input, targets: ['antigravity-ide'] }),
    /symlink/,
  );
  assert.throws(
    () => previewInstall({ name: '../bad', content, targets: ['codex'] }),
    /lowercase/,
  );
});
