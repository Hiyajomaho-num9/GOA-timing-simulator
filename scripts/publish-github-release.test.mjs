import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishGitHubRelease } from './publish-github-release.mjs';

const commit = 'a'.repeat(40);
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const response = (body, status = 200) => 'HTTP/2.0 ' + status + ' OK\r\nContent-Type: application/json\r\n\r\n' + (body === undefined ? '' : JSON.stringify(body));
const notFound = () => { throw Object.assign(new Error('not found'), { stdout: response({ message: 'Not Found' }, 404) }); };

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

function uploadAsset(f, args) {
  const url = new URL(args[1]);
  assert.equal(url.hostname, 'uploads.github.com');
  assert.equal(url.pathname, '/repos/owner/repository/releases/1/assets');
  assert.equal(args[args.indexOf('--method') + 1], 'POST');
  const name = url.searchParams.get('name');
  const asset = f.release.assets.find(asset => asset.name === name);
  assert.ok(asset);
  assert.equal(args[args.indexOf('--input') + 1], path.join(f.root, 'release', name));
  const bytes = fs.readFileSync(args[args.indexOf('--input') + 1]);
  assert.equal(digest(bytes), asset.digest);
  assert.ok(args.includes('Content-Type: application/octet-stream'));
  assert.ok(args.includes('Content-Length: ' + bytes.length));
  return { ...asset };
}

test('uses the REST create response ID while the draft tag stays 404 and the list stays empty', t => {
  const f = fixture(t);
  const assets = [];
  const mock = commandMock(f, (args, options) => {
    assert.equal(args[0], 'api');
    const method = args[args.indexOf('--method') + 1];
    if (args[0] === 'api' && args[1].includes('/releases/tags/')) return notFound();
    if (args[1].includes('/releases?')) return response([]);
    if (args[1] === 'repos/owner/repository/releases') {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(options.input), { tag_name: f.metadata.tag, name: f.metadata.tag, target_commitish: commit, draft: true, prerelease: false, generate_release_notes: true });
      return response({ ...f.release, assets: [] }, 201);
    }
    if (args[1].startsWith('https://uploads.github.com/')) {
      const asset = uploadAsset(f, args);
      assert.equal(options.input, undefined);
      assets.push(asset);
      return response(asset, 201);
    }
    assert.equal(args[1], 'repos/owner/repository/releases/1');
    if (method === 'GET') {
      assert.equal(assets.length, 3);
      return response({ ...f.release, assets });
    }
    assert.equal(method, 'PATCH');
    assert.deepEqual(JSON.parse(options.input), { draft: false, prerelease: false, make_latest: 'legacy' });
    assert.equal(args[args.indexOf('--input') + 1], '-');
    return response({ ...f.release, draft: false });
  });
  assert.equal(mock.publish().status, 'published');
  assert.deepEqual(assets.map(asset => asset.name), [f.name, f.name + '.sha256', 'build-info.json']);
  assert.equal(mock.calls.filter(call => call.args[1].includes('/releases/tags/')).length, 1);
  assert.equal(mock.calls.filter(call => call.args[1].includes('/releases?')).length, 1);
});

test('resumes an existing draft found on a later list page when the tag endpoint returns 404', t => {
  const f = fixture(t);
  const assets = [];
  const unrelated = Array.from({ length: 100 }, (_, index) => ({ id: index + 100, tag_name: 'v0.0.' + index, draft: false }));
  const mock = commandMock(f, (args, options) => {
    if (args[0] === 'api' && args[1].includes('/releases/tags/')) return notFound();
    if (args[0] === 'api' && args[1].includes('/releases?')) {
      return response(args[1].endsWith('page=1') ? unrelated : [{ ...f.release, assets: [] }]);
    }
    if (args[1].startsWith('https://uploads.github.com/')) {
      const asset = uploadAsset(f, args);
      assets.push(asset);
      return response(asset, 201);
    }
    if (args.includes('PATCH')) {
      assert.deepEqual(JSON.parse(options.input), { draft: false, prerelease: false, make_latest: 'legacy' });
      return response({ ...f.release, draft: false });
    }
    assert.equal(args[1], 'repos/owner/repository/releases/1');
    return response({ ...f.release, assets });
  });
  assert.equal(mock.publish().status, 'published');
  assert.ok(mock.calls.some(call => call.args[1] === 'repos/owner/repository/releases?per_page=100&page=2'));
  assert.ok(!mock.calls.some(call => call.args[1] === 'repos/owner/repository/releases'));
});

test('duplicate tag releases on different list pages fail before any mutation', t => {
  const f = fixture(t);
  const firstPage = [f.release, ...Array.from({ length: 99 }, (_, index) => ({ id: index + 100, tag_name: 'v0.0.' + index }))];
  const mock = commandMock(f, args => {
    if (args[1].includes('/releases/tags/')) return notFound();
    assert.ok(args[1].includes('/releases?'));
    return response(args[1].endsWith('page=1') ? firstPage : [{ ...f.release, id: 2 }]);
  });
  assert.throws(mock.publish, /Multiple releases exist/);
  assert.equal(mock.calls.length, 3);
  assert.ok(mock.calls.every(call => call.args[0] === 'api' && call.args.includes('GET')));
});

test('failure after one successful asset upload leaves the existing draft unpublished', t => {
  const f = fixture(t);
  let uploads = 0;
  const mock = commandMock(f, args => {
    if (args[0] === 'api' && args[1].includes('/releases/tags/')) return notFound();
    if (args[1].includes('/releases?')) return response([{ ...f.release, assets: [] }]);
    if (!args[1].startsWith('https://uploads.github.com/')) return response({ ...f.release, assets: [] });
    if (++uploads === 1) return response(uploadAsset(f, args), 201);
    throw new Error('upload failed');
  });
  assert.throws(mock.publish, /upload failed/);
  assert.equal(uploads, 2);
  assert.ok(!mock.calls.some(call => call.args.includes('PATCH') || call.args[1] === 'repos/owner/repository/releases'));
});

test('uploaded asset digest mismatch leaves the draft unpublished', t => {
  const f = fixture(t);
  let uploads = 0;
  const mock = commandMock(f, args => {
    if (args[0] === 'api' && args[1].includes('/releases/tags/')) return notFound();
    if (args[1].includes('/releases?')) return response([{ ...f.release, assets: [] }]);
    if (args[1].startsWith('https://uploads.github.com/')) {
      uploads++;
      return response(uploadAsset(f, args), 201);
    }
    const assets = f.release.assets.map((asset, index) => index === 0 ? { ...asset, digest: 'sha256:' + '0'.repeat(64) } : asset);
    return response({ ...f.release, assets: uploads ? assets : [] });
  });
  assert.throws(mock.publish, /Release asset size or SHA256 differs/);
  assert.ok(!mock.calls.some(call => call.args.includes('PATCH')));
});

test('resumes a partial draft by keeping matching assets and replacing mismatches by asset ID', t => {
  const f = fixture(t);
  const assets = [{ ...f.release.assets[0] }, { ...f.release.assets[1], id: 111, digest: 'sha256:' + '0'.repeat(64) }];
  const mock = commandMock(f, args => {
    if (args[1].includes('/releases/tags/')) return notFound();
    if (args[1].includes('/releases?')) return response([{ ...f.release, assets }]);
    if (args.includes('DELETE')) {
      assert.equal(args[1], 'repos/owner/repository/releases/assets/111');
      assets.splice(1, 1);
      return response(undefined, 204);
    }
    if (args[1].startsWith('https://uploads.github.com/')) {
      const asset = uploadAsset(f, args);
      assets.push(asset);
      return response(asset, 201);
    }
    return response({ ...f.release, assets, draft: !args.includes('PATCH') });
  });
  assert.equal(mock.publish().status, 'published');
  assert.equal(mock.calls.filter(call => call.args.includes('DELETE')).length, 1);
  assert.deepEqual(mock.calls.filter(call => call.args[1].startsWith('https://uploads.github.com/')).map(call => new URL(call.args[1]).searchParams.get('name')), [f.name + '.sha256', 'build-info.json']);
});

test('does not replace assets if the existing draft was published before its ID is checked', t => {
  const f = fixture(t);
  const mock = commandMock(f, args => {
    if (args[1].includes('/releases/tags/')) return notFound();
    if (args[1].includes('/releases?')) return response([f.release]);
    assert.equal(args[1], 'repos/owner/repository/releases/1');
    return response({ ...f.release, draft: false });
  });
  assert.throws(mock.publish, /must remain a draft/);
  assert.ok(mock.calls.every(call => call.args.includes('GET')));
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
  const assets = [];
  const mock = commandMock(f, (args, options) => {
    if (args[0] === 'api' && args[1].includes('/releases/tags/')) return notFound();
    if (args[1].includes('/releases?')) return response([]);
    if (args[1] === 'repos/owner/repository/releases') {
      assert.equal(JSON.parse(options.input).prerelease, true);
      return response({ ...f.release, assets: [] }, 201);
    }
    if (args[1].startsWith('https://uploads.github.com/')) {
      const asset = uploadAsset(f, args);
      assets.push(asset);
      return response(asset, 201);
    }
    if (args.includes('PATCH')) {
      assert.deepEqual(JSON.parse(options.input), { draft: false, prerelease: true, make_latest: 'false' });
      return response({ ...f.release, draft: false });
    }
    return response({ ...f.release, assets });
  });
  assert.equal(mock.publish().status, 'published');
  assert.ok(mock.calls.some(call => call.args[1] === 'repos/owner/repository/releases'));
});

for (const status of [401, 403, 500]) {
  test('HTTP ' + status + ' does not trigger release creation', t => {
    const f = fixture(t);
    const mock = commandMock(f, () => { throw Object.assign(new Error('request failed'), { stdout: response({ message: 'Failure' }, status) }); });
    assert.throws(mock.publish, new RegExp('HTTP ' + status));
    assert.equal(mock.calls.length, 1);
  });
  test('HTTP ' + status + ' when listing drafts does not trigger release creation', t => {
    const f = fixture(t);
    const mock = commandMock(f, args => {
      if (args[1].includes('/releases/tags/')) return notFound();
      throw Object.assign(new Error('request failed'), { stdout: response({ message: 'Failure' }, status) });
    });
    assert.throws(mock.publish, new RegExp('HTTP ' + status));
    assert.equal(mock.calls.length, 2);
    assert.ok(mock.calls.every(call => call.args[0] === 'api' && call.args.includes('GET')));
  });
}

test('an unstructured Not Found error does not trigger release creation', t => {
  const f = fixture(t);
  const mock = commandMock(f, () => { throw new Error('Not Found (HTTP 404)'); });
  assert.throws(mock.publish, /GitHub API request failed/);
  assert.equal(mock.calls.length, 1);
});
