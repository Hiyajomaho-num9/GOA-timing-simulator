import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'neutralino.config.json'), 'utf8'));
if (!/^[0-9]+[.][0-9]+[.][0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('Unsupported package version: ' + pkg.version);
if (pkg.version !== config.version) throw new Error('package.json and neutralino.config.json versions differ.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== 'v' + pkg.version) {
  throw new Error('Tag must match the application version: v' + pkg.version);
}
if (process.argv.includes('--check-tag')) {
  console.log('Version validated: v' + pkg.version);
  process.exit(0);
}

const source = path.join(root, 'dist', config.cli.binaryName, config.cli.binaryName + '-win_x64.exe');
const bytes = fs.readFileSync(source);
if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Windows executable header is missing.');
const peOffset = bytes.readUInt32LE(0x3c);
if (peOffset + 24 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x4550 || bytes.readUInt16LE(peOffset + 4) !== 0x8664) {
  throw new Error('The artifact is not a Windows x64 PE executable.');
}

function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}
const frontend = filesIn(path.join(root, 'web-dist'));
if (!frontend.some(file => path.basename(file) === 'index.html')) throw new Error('Built frontend is missing index.html.');
for (const file of frontend) {
  const contents = fs.readFileSync(file);
  if (contents.length && !bytes.includes(contents)) throw new Error('Frontend resource was not embedded: ' + path.relative(root, file));
}

const output = path.join(root, 'release');
fs.mkdirSync(output, { recursive: true });
const filename = config.cli.binaryName + '-' + pkg.version + '-win-x64.exe';
fs.copyFileSync(source, path.join(output, filename));
const sha256 = createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(output, filename + '.sha256'), sha256 + '  ' + filename + '\n');
const metadata = {
  version: pkg.version,
  tag: process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  builtAt: new Date().toISOString(),
  platform: 'windows-x64',
  filename,
  bytes: bytes.length,
  sha256,
  embeddedFrontendFiles: frontend.length,
};
fs.writeFileSync(path.join(output, 'build-info.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify(metadata, null, 2));
