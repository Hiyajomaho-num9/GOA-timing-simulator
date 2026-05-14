import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultWorkbook = path.join(root, 'EPL_MT9216_Cus_V430HJ2-P01(B1)_250819.xlsx');
const workbookPath = path.resolve(process.argv[2] ?? defaultWorkbook);
const frameRate = Number(process.argv[3] ?? 60);

if (!existsSync(workbookPath)) {
  console.error(`XLSX not found: ${workbookPath}`);
  process.exit(1);
}

const tempRoot = path.join(tmpdir(), `goa-engine-benchmark-${process.pid}`);
const outDir = path.join(tempRoot, 'dist');

try {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'package.json'), '{"type":"commonjs"}\n');
  symlinkSync(path.join(root, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir');
  const tsconfigPath = path.join(tempRoot, 'tsconfig.benchmark.json');
  writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'CommonJS',
      moduleResolution: 'node10',
      ignoreDeprecations: '6.0',
      lib: ['ES2022', 'DOM'],
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
    ],
  }, null, 2));

  execFileSync(
    path.join(root, 'node_modules/.bin/tsc'),
    ['--project', tsconfigPath],
    { cwd: root, stdio: 'pipe' },
  );

  const XLSXModule = await import('xlsx');
  const XLSX = XLSXModule.default ?? XLSXModule;
  const types = await import(pathToFileURL(path.join(outDir, 'core/types.js')).href);
  const parser = await import(pathToFileURL(path.join(outDir, 'core/xlsxParser.js')).href);
  const simulator = await import(pathToFileURL(path.join(outDir, 'core/simulator.js')).href);

  const workbook = XLSX.readFile(workbookPath, { cellDates: false });
  const timing = parser.parseTiming(workbook, frameRate);
  const gpioRows = parser.parseRows(workbook, 'GPIO', 10);
  const gpos = parser.buildGpos(gpioRows);
  const project = {
    timing,
    gpos,
    levelShifter: types.defaultLevelShifterConfig(),
    measurements: [],
    patches: [],
    dirty: false,
  };

  const sim = measure('simulateProject / 1 frame', () => simulator.simulateProject(project));
  const oneFrameSegments = sim.signals.reduce((sum, signal) => sum + signal.segments.length, 0);
  const oneFrameEdges = sim.signals.reduce((sum, signal) => sum + signal.edges.length, 0);

  const selected = selectBenchmarkGpos(gpos);
  const rows = [];
  const totalStart = performance.now();
  for (const gpo of selected) {
    const result = measureSilent(() => simulator.simulateGpoOutWindow(gpo, gpos, timing, false, 120));
    rows.push({
      gpo: gpo.group,
      repeat: gpo.repeatMode === 0 ? 'line' : 'frame',
      combin: gpo.combinType,
      segments: result.value.length,
      edges: countEdges(result.value),
      ms: result.ms,
    });
  }
  const total120Ms = performance.now() - totalStart;

  console.log('');
  console.log(`workbook: ${workbookPath}`);
  console.log(`timebase: Htotal=${timing.htotal} Vtotal=${timing.vtotal} FPS=${frameRate}`);
  console.log(`unit: 1pcnt=${(timing.pcntSeconds * 1e9).toFixed(3)}ns 1lcnt=${(timing.lcntSeconds * 1e6).toFixed(3)}us 1frame=${(timing.frameSeconds * 1e3).toFixed(3)}ms`);
  console.log(`1frame display signals: segments=${oneFrameSegments} edges=${oneFrameEdges}`);
  console.log('');
  console.log('120frame selected GPO out generation:');
  printTable(rows);
  console.log('');
  console.log(`120frame selected total: ${total120Ms.toFixed(2)}ms, segments=${rows.reduce((sum, row) => sum + row.segments, 0)}, edges=${rows.reduce((sum, row) => sum + row.edges, 0)}`);
  console.log('');
  console.log('说明：这个 benchmark 只测当前计算层的数据生成量，不包含 canvas draw、DOM 更新和鼠标 hit-test。');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function measure(name, fn) {
  const result = measureSilent(fn);
  console.log(`${name}: ${result.ms.toFixed(2)}ms`);
  return result.value;
}

function measureSilent(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function selectBenchmarkGpos(gpos) {
  const wanted = /stv|cpv|cvp|tp|pol|lc|ck|rst/i;
  const selected = gpos.filter((gpo) => wanted.test(`${gpo.group} ${gpo.label}`));
  return selected.length > 0 ? selected : gpos.slice(0, 12);
}

function countEdges(segments) {
  let count = 0;
  let prev = 0;
  for (const segment of segments) {
    if (segment.start > 0 && segment.level !== prev) count += 1;
    prev = segment.level;
  }
  return count;
}

function printTable(rows) {
  const headers = ['gpo', 'repeat', 'combin', 'segments', 'edges', 'ms'];
  const values = rows.map((row) => ({
    gpo: row.gpo,
    repeat: row.repeat,
    combin: String(row.combin),
    segments: String(row.segments),
    edges: String(row.edges),
    ms: row.ms.toFixed(2),
  }));
  const widths = Object.fromEntries(headers.map((header) => [header, Math.max(header.length, ...values.map((row) => row[header].length))]));
  console.log(headers.map((header) => header.padEnd(widths[header])).join('  '));
  console.log(headers.map((header) => '-'.repeat(widths[header])).join('  '));
  for (const row of values) {
    console.log(headers.map((header) => row[header].padEnd(widths[header])).join('  '));
  }
}
