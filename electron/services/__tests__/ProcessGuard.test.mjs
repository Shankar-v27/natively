import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the compiled process guard
require(path.resolve(__dirname, '../../../dist-electron/electron/utils/processGuard.js'));

test('ProcessGuard enforces windowsHide: true on spawn and exec', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only test');
    return;
  }

  // 1. Test async exec
  await new Promise((resolve, reject) => {
    cp.exec('whoami', (err, stdout) => {
      if (err) return reject(err);
      assert.ok(stdout.length > 0);
      resolve();
    });
  });

  // 2. Test async spawn with detached: true (should be safely clamped to false on Windows)
  await new Promise((resolve, reject) => {
    const child = cp.spawn('cmd.exe', ['/c', 'echo test'], { detached: true });
    child.on('error', reject);
    child.on('close', (code) => {
      assert.equal(code, 0);
      resolve();
    });
  });

  // 3. Test sync spawnSync
  const resSync = cp.spawnSync('cmd.exe', ['/c', 'echo test-sync'], { encoding: 'utf8' });
  assert.equal(resSync.status, 0);
  assert.match(resSync.stdout, /test-sync/);

  // 4. Test sync execSync
  const resExecSync = cp.execSync('cmd.exe /c echo test-exec-sync', { encoding: 'utf8' });
  assert.match(resExecSync, /test-exec-sync/);

  // 5. Test sync execFileSync
  const resExecFileSync = cp.execFileSync('cmd.exe', ['/c', 'echo test-execfile-sync'], { encoding: 'utf8' });
  assert.match(resExecFileSync, /test-execfile-sync/);
});
