import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishGitHubRelease } from './publish-github-release.mjs';

const commit = 'a'.repeat(40);
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const response = (body, status = 200) => 'HTTP/2.0 ' + status + ' OK\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(body);

function fixture(t, version = '1.2.3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goa-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'release'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, 'neutralino.config.json'), JSON.stringify({ version, cli: { binaryName: 'GOA-Timing-Simulator' } }));
  const name = 'GOA-Timing-Simulator-' + version + '-win-x64.exe';
  const exe = Buffer.from('MZ fixture executable');
  const metadata = { version, tag: 'v' + version, commit, builtAt: '2026-10-06T00:00:00.000Z', platform: 'windows-x64', filename: name, bytes: exe.length, sha256: digest(exe).slice(7), embeddedFrontendFiles: 4 };
  fs.writeFileSync(path.join(root, 'release', name), exe);
  fs.writeFileSync(path.join(root, 'release', name + '.sha256'), metadata.sha256 + '  ' + name + '\n');
  fs.writeFileSync(path.join(root, 'release', 'build-info.json'), JSON.stringify(metadata, null, 2) + '\n');
  const env = { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: metadata.tag, GITHUB_SHA: commit, GITHUB_REPOSITORY: 'owner/repository' };
  const assets = [name, name + '.sha256', 'build-info.json'].map((filename, index) => {
    const bytes = fs.readFileSync(path.join(root, 'release', filename));
    return { id: index + 10, name: filename, size: bytes.length, digest: digest(bytes), state: 'uploaded' };
  });
  const release = { id: 1, tag_name: metadata.tag, draft: true, prerelease: version.includes('-'), assets, html_url: 'https://github.com/owner/repository/releases/tag/' + metadata.tag };
  return { root, env, metadata, release, name };
}

function commandMock(f, handle) {
  const calls = [];
  const run = (command, args, options) => {
    if (command === 'git') return commit + '\n';
    assert.equal(command, 'gh');
    calls.push({ args, options });
    return handle(args, options, calls);
  };
  return { calls, publish: () => publishGitHubRelease({ root: f.root, env: f.env, run }) };
}

test('creates a draft, verifies uploaded assets, and publishes a stable version with semver Latest selection', t => {
  const f = fixture(t);
  let lookups = 0;
  const mock = commandMock(f, (args, options) => {
    if (args[0] === 'api' && args[1].includes('/releases/tags/')) {
      if (lookups++ === 0) throw Object.assign(new Error('not found'), { stdout: response({ message: 'Not Found' }, 404) });
      return response(f.release);
    }
    if (args[0] === 'release') return '';
    assert.equal(args[args.indexOf('--method') + 1], 'PATCH');
    assert.deepEqual(JSON.parse(options.input), { draft: false, prerelease: false, make_latest: 'legacy' });
    assert.equal(args[args.indexOf('--input') + 1], '-');
    return response({ ...f.release, draft: false });
  });
  assert.equal(mock.publish().status, 'published');
  const create = mock.calls.find(call => call.args[1] === 'create').args;
  for (const flag of ['--draft', '--verify-tag', '--generate-notes']) assert.ok(create.includes(flag));
  assert.equal(create[create.indexOf('--title') + 1], f.metadata.tag);
  const upload = mock.calls.find(call => call.args[1] === 'upload').args;
  assert.deepEqual(upload.slice(3, 6), [f.name, f.name + '.sha256', 'build-info.json'].map(name => path.join(f.root, 'release', name)));
  assert.ok(upload.includes('--clobber'));
  assert.equal(mock.calls.at(-1).args[0], 'api');
});

test('upload failure leaves the existing draft unpublished', t => {
  const f = fixture(t);
  const mock = commandMock(f, args => {
    if (args[0] === 'api') return response(f.release);
    assert.equal(args[1], 'upload');
    throw new Error('upload failed');
  });
  assert.throws(mock.publish, /upload failed/);
  assert.ok(!mock.calls.some(call => call.args.includes('PATCH') || call.args[1] === 'create'));
});

test('uploaded asset digest mismatch leaves the draft unpublished', t => {
  const f = fixture(t);
  f.release.assets[0].digest = 'sha256:' + '0'.repeat(64);
  const mock = commandMock(f, args => args[0] === 'api' ? response(f.release) : '');
  assert.throws(mock.publish, /Release asset size or SHA256 differs/);
  assert.ok(!mock.calls.some(call => call.args.includes('PATCH')));
});

test('published rerun verifies all required assets, allowing a different build timestamp, without mutations', t => {
  const f = fixture(t);
  const remoteMetadata = JSON.stringify({ ...f.metadata, builtAt: '2026-10-05T01:02:03.000Z' }, null, 2) + '\n';
  f.release.draft = false;
  f.release.assets[2].size = Buffer.byteLength(remoteMetadata);
  f.release.assets[2].digest = digest(remoteMetadata);
  const mock = commandMock(f, args => args[1].includes('/releases/assets/') ? remoteMetadata : response(f.release));
  assert.equal(mock.publish().status, 'already-published');
  assert.equal(mock.calls.length, 2);
  assert.ok(mock.calls.every(call => call.args[0] === 'api' && call.args[call.args.indexOf('--method') + 1] === 'GET'));
});

for (const failure of ['missing asset', 'wrong size', 'wrong digest', 'missing digest', 'wrong metadata']) {
  test('published rerun rejects ' + failure + ' without changing the release', t => {
    const f = fixture(t);
    f.release.draft = false;
    if (failure === 'missing asset') f.release.assets.pop();
    if (failure === 'wrong size') f.release.assets[0].size++;
    if (failure === 'wrong digest') f.release.assets[1].digest = 'sha256:' + '0'.repeat(64);
    if (failure === 'missing digest') delete f.release.assets[0].digest;
    const remoteMetadata = JSON.stringify({ ...f.metadata, commit: 'b'.repeat(40) });
    if (failure === 'wrong metadata') {
      f.release.assets[2].size = Buffer.byteLength(remoteMetadata);
      f.release.assets[2].digest = digest(remoteMetadata);
    }
    const mock = commandMock(f, args => args[1].includes('/releases/assets/') ? remoteMetadata : response(f.release));
    assert.throws(mock.publish, /Release asset|Published build metadata/);
    assert.ok(mock.calls.every(call => call.args[0] === 'api' && call.args[call.args.indexOf('--method') + 1] === 'GET'));
  });
}

for (const failure of ['wrong tag', 'branch ref', 'wrong executable hash', 'wrong checksum name', 'wrong build commit', 'wrong GitHub commit']) {
  test('local validation rejects ' + failure + ' before calling GitHub', t => {
    const f = fixture(t);
    if (failure === 'wrong tag') f.env.GITHUB_REF_NAME = 'v9.9.9';
    if (failure === 'branch ref') f.env.GITHUB_REF_TYPE = 'branch';
    if (failure === 'wrong executable hash') fs.appendFileSync(path.join(f.root, 'release', f.name), 'corrupt');
    if (failure === 'wrong checksum name') fs.writeFileSync(path.join(f.root, 'release', f.name + '.sha256'), f.metadata.sha256 + '  wrong.exe\n');
    if (failure === 'wrong build commit') fs.writeFileSync(path.join(f.root, 'release', 'build-info.json'), JSON.stringify({ ...f.metadata, commit: 'b'.repeat(40) }));
    if (failure === 'wrong GitHub commit') f.env.GITHUB_SHA = 'b'.repeat(40);
    const mock = commandMock(f, () => { throw new Error('GitHub must not be called'); });
    assert.throws(mock.publish, /version tag|size or SHA256|Checksum file|build commit/);
    assert.equal(mock.calls.length, 0);
  });
}

test('tag commit mismatch is rejected before calling GitHub', t => {
  const f = fixture(t);
  const run = (command, args) => {
    assert.equal(command, 'git');
    return args.includes('--verify') ? 'b'.repeat(40) : commit;
  };
  assert.throws(() => publishGitHubRelease({ root: f.root, env: f.env, run }), /Tag does not point to the build commit/);
});

test('prerelease publication explicitly excludes Latest', t => {
  const f = fixture(t, '1.2.3-rc.1');
  let lookups = 0;
  const mock = commandMock(f, (args, options) => {
    if (args[0] === 'api' && args[1].includes('/releases/tags/') && lookups++ === 0) {
      throw Object.assign(new Error('not found'), { stdout: response({ message: 'Not Found' }, 404) });
    }
    if (args[1] === 'create') assert.ok(args.includes('--prerelease'));
    if (args.includes('PATCH')) {
      assert.deepEqual(JSON.parse(options.input), { draft: false, prerelease: true, make_latest: 'false' });
      return response({ ...f.release, draft: false });
    }
    return args[0] === 'api' ? response(f.release) : '';
  });
  assert.equal(mock.publish().status, 'published');
  assert.ok(mock.calls.some(call => call.args[1] === 'create'));
});

for (const status of [401, 403, 500]) {
  test('HTTP ' + status + ' does not trigger release creation', t => {
    const f = fixture(t);
    const mock = commandMock(f, () => { throw Object.assign(new Error('request failed'), { stdout: response({ message: 'Failure' }, status) }); });
    assert.throws(mock.publish, new RegExp('HTTP ' + status));
    assert.equal(mock.calls.length, 1);
  });
}

test('an unstructured Not Found error does not trigger release creation', t => {
  const f = fixture(t);
  const mock = commandMock(f, () => { throw new Error('Not Found (HTTP 404)'); });
  assert.throws(mock.publish, /GitHub API request failed/);
  assert.equal(mock.calls.length, 1);
});
