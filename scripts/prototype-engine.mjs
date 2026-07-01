// Runs the throwaway Phase 1 waveform-engine prototype under Node.
// Mirrors scripts/benchmark-engine.mjs: compile core + prototype to a temp
// CommonJS dir, import the compiled prototype entry, then clean up.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(tmpdir(), `goa-prototype-engine-${process.pid}`);
const outDir = path.join(tempRoot, 'dist');

try {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'package.json'), '{"type":"commonjs"}\n');
  symlinkSync(path.join(root, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir');

  const tsconfigPath = path.join(tempRoot, 'tsconfig.prototype.json');
  writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'CommonJS',
      moduleResolution: 'node10',
      ignoreDeprecations: '6.0',
      lib: ['ES2022', 'DOM'],
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
      path.join(root, 'src/core/waveformEngine.ts'),
      path.join(root, 'src/prototypes/waveform-engine/prototype.ts'),
    ],
  }, null, 2));

  execFileSync(
    path.join(root, 'node_modules/.bin/tsc'),
    ['--project', tsconfigPath],
    { cwd: root, stdio: 'pipe' },
  );

  const entry = pathToFileURL(path.join(outDir, 'prototypes/waveform-engine/prototype.js')).href;
  // Hand the sample workbook path to the prototype so it doesn't need import.meta.
  const sampleXlsx = path.join(root, 'EPL_MT9216_Cus_V430HJ2-P01(B1)_250819.xlsx');
  if (!existsSync(sampleXlsx)) {
    console.error(`Sample xlsx not found: ${sampleXlsx}`);
    process.exit(1);
  }
  process.env.GOA_SAMPLE_XLSX = sampleXlsx;
  await import(entry);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
