// Run core, UI/export, and integration tests without platform-specific symlinks.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function testsIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? testsIn(file) : entry.name.endsWith('.test.ts') ? [file] : [];
  });
}
const files = testsIn(path.join(root, 'src')).sort();
if (!files.length) throw new Error('No test files found under src.');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=spec', ...files], {
  cwd: root, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
