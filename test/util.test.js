import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectFromCwd } from '../src/util.js';

// The same session logs can be read on Windows, Linux or macOS, so the answer must not depend on the host OS.
const cases = [
  ['C:\\Projects\\alpha', undefined, 'alpha'],
  ['C:\\Projects\\alpha\\', undefined, 'alpha'],
  ['C:/Projects/alpha', undefined, 'alpha'],
  ['C:\\Users\\Someone\\Work Ünï', undefined, 'Work Ünï'],
  ['\\\\server\\share\\project', undefined, 'project'],
  ['/home/me/project', undefined, 'project'],
  ['/home/me/project/', undefined, 'project'],
  ['/home/me/a%20b', undefined, 'a b'],
  ['C:\\', undefined, 'Unattributed'],
  ['/', undefined, 'Unattributed'],
  ['', undefined, 'Unattributed'],
  [null, undefined, 'Unattributed'],
  [42, undefined, 'Unattributed'],
  ['C:\\Users\\me\\.codex\\worktree', 'C:\\Users\\me\\.codex', 'Workspace'],
  ['/home/me/.codex/worktree', '/home/me/.codex', 'Workspace'],
  ['/home/me/.codex/', '/home/me/.codex', 'Workspace'],
  ['/home/me/.codex-old/project', '/home/me/.codex', 'project'],
  ['C:\\Users\\me\\.codex-old\\project', 'C:\\Users\\me\\.codex', 'project'],
  ['c:\\users\\ME\\.CODEX\\worktree', 'C:\\Users\\me\\.codex\\', 'Workspace'],
];

for (const [cwd, root, expected] of cases) {
  test(`projectFromCwd(${JSON.stringify(cwd)}, ${JSON.stringify(root)}) is ${expected}`, () => {
    assert.equal(projectFromCwd(cwd, root), expected);
  });
}

test('projectFromCwd keeps a malformed percent sequence instead of throwing', () => {
  assert.equal(projectFromCwd('/home/me/100%', undefined), '100%');
});
