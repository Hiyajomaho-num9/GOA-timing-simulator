// Self-contained test runner: compiles core + tests to a temp dir, then runs node:test.
// Mirrors the benchmark approach so we need no extra test framework dependency.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(tmpdir(), `goa-core-tests-${process.pid}`);
const outDir = path.join(tempRoot, 'dist');

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

try {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'package.json'), '{"type":"commonjs"}\n');
  symlinkSync(path.join(root, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir');

  const testFiles = walk(path.join(root, 'src/core/__tests__'));
  if (testFiles.length === 0) {
    console.error('No test files found under src/core/__tests__');
    process.exit(1);
  }

  const tsconfigPath = path.join(tempRoot, 'tsconfig.test.json');
  writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'CommonJS',
      moduleResolution: 'node10',
      ignoreDeprecations: '6.0',
      lib: ['ES2022'],
      types: ['node'],
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      strict: true,
      rootDir: path.join(root, 'src'),
      outDir,
    },
    include: [
      path.join(root, 'src/core/types.ts'),
      path.join(root, 'src/core/time.ts'),
      path.join(root, 'src/core/xlsxParser.ts'),
      path.join(root, 'src/core/simulator.ts'),
      ...testFiles,
    ],
  }, null, 2));

  execFileSync(
    path.join(root, 'node_modules/.bin/tsc'),
    ['--project', tsconfigPath],
    { cwd: root, stdio: 'pipe' },
  );

  // Map each test source to its compiled .js absolute path.
  const compiledTests = testFiles
    .map((file) => path.relative(path.join(root, 'src'), file).replace(/\.ts$/, '.js'))
    .map((rel) => path.join(outDir, rel));

  // Run node:test against the compiled test files. Forward stdio so TAP shows.
  const args = ['--test', '--test-reporter=spec', ...compiledTests];
  try {
    execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  } catch (err) {
    // node --test exits non-zero on any failing test; surface the status.
    process.exit(err.status ?? 1);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
