import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { runPrerequisiteCommand } from '../electron/prerequisites.mjs';

test('prerequisite subprocess leaves the Electron event loop responsive', async () => {
  const started = performance.now();
  const pending = runPrerequisiteCommand('/usr/bin/sleep', ['0.3'], { timeout: 2000 });
  assert.ok(performance.now() - started < 150, 'starting a probe must not wait for the subprocess');
  const result = await pending;
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('prerequisite subprocess reports failures and timeouts as check results', async () => {
  const failure = await runPrerequisiteCommand('/usr/bin/ls', ['/definitely-missing-studio-probe'], { timeout: 2000 });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /definitely-missing-studio-probe/);
  const timeout = await runPrerequisiteCommand('/usr/bin/sleep', ['1'], { timeout: 30 });
  assert.notEqual(timeout.status, 0);
  assert.ok(timeout.error);
});
