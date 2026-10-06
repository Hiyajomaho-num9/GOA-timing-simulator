import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function publishGitHubRelease({ root = projectRoot, env = process.env, run = execFileSync } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'neutralino.config.json'), 'utf8'));
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    throw new Error('Unsupported package version: ' + pkg.version);
  }
  const tag = 'v' + pkg.version;
  if (env.GITHUB_REF_TYPE !== 'tag' || env.GITHUB_REF_NAME !== tag) {
    throw new Error('Publication requires the application version tag: ' + tag);
  }
  if (config.version !== pkg.version || typeof config.cli?.binaryName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.cli.binaryName)) {
    throw new Error('Application version or executable name is invalid.');
  }
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) {
    throw new Error('GITHUB_REPOSITORY must identify the release repository.');
  }

  const releaseDir = path.join(root, 'release');
  const metadataBytes = fs.readFileSync(path.join(releaseDir, 'build-info.json'));
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  const filename = config.cli.binaryName + '-' + pkg.version + '-win-x64.exe';
  if (metadata.version !== pkg.version || metadata.tag !== tag || metadata.filename !== filename || metadata.platform !== 'windows-x64') {
    throw new Error('Build metadata does not match the tagged Windows release.');
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(metadata.commit ?? '')) {
    throw new Error('Build metadata commit is invalid.');
  }
  const git = args => run('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  if (git(['rev-parse', 'HEAD']) !== metadata.commit) throw new Error('Checkout HEAD does not match the build commit.');
  if (git(['rev-parse', '--verify', tag + '^{commit}']) !== metadata.commit) throw new Error('Tag does not point to the build commit.');
  if (env.GITHUB_SHA !== undefined && env.GITHUB_SHA !== metadata.commit) throw new Error('GITHUB_SHA does not match the build commit.');

  const exeBytes = fs.readFileSync(path.join(releaseDir, filename));
  if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0 || metadata.bytes !== exeBytes.length || metadata.sha256 !== hash(exeBytes)) {
    throw new Error('Executable size or SHA256 does not match the build metadata.');
  }
  const checksumBytes = fs.readFileSync(path.join(releaseDir, filename + '.sha256'));
  const checksum = /^([0-9a-f]{64})  ([^\r\n]+)\r?\n?$/.exec(checksumBytes.toString('utf8'));
  if (!checksum || checksum[1] !== metadata.sha256 || checksum[2] !== filename) {
    throw new Error('Checksum file does not match the executable.');
  }
  const files = [
    { name: filename, contents: exeBytes },
    { name: filename + '.sha256', contents: checksumBytes },
    { name: 'build-info.json', contents: metadataBytes },
  ].map(file => ({ ...file, file: path.join(releaseDir, file.name), size: file.contents.length, digest: 'sha256:' + hash(file.contents) }));
  const prerelease = pkg.version.includes('-');
  const endpoint = 'repos/' + repo + '/releases/tags/' + encodeURIComponent(tag);
  const gh = (args, input) => run('gh', args, { cwd: root, env, encoding: 'utf8', ...(input === undefined ? {} : { input }) });

  function api(route, { method = 'GET', body, allow404 = false } = {}) {
    const args = ['api', route, '--method', method, '--include', '--header', 'Accept: application/vnd.github+json', '--header', 'X-GitHub-Api-Version: 2022-11-28'];
    if (body !== undefined) args.push('--input', '-');
    let output;
    try {
      output = gh(args, body === undefined ? undefined : JSON.stringify(body));
    } catch (error) {
      const status = /^HTTP\/\S+\s+(\d{3})\b/.exec(String(error.stdout ?? ''))?.[1];
      if (allow404 && status === '404') return null;
      throw new Error('GitHub API request failed (' + method + ' ' + route + '): ' + (status ? 'HTTP ' + status : error.message));
    }
    const response = /^HTTP\/\S+\s+(\d{3})[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*)$/.exec(output);
    if (!response || Number(response[1]) < 200 || Number(response[1]) >= 300) {
      throw new Error('Unexpected GitHub API response for ' + route);
    }
    return JSON.parse(response[2]);
  }

  function findListedRelease() {
    let match = null;
    for (let page = 1; ; page++) {
      const releases = api('repos/' + repo + '/releases?per_page=100&page=' + page);
      if (!Array.isArray(releases)) throw new Error('GitHub release list is invalid.');
      for (const release of releases) {
        if (release.tag_name !== tag) continue;
        if (match) throw new Error('Multiple releases exist for the requested tag: ' + tag);
        match = release;
      }
      if (releases.length < 100) return match;
    }
  }

  function assetsFor(release) {
    if (release.tag_name !== tag || !Number.isSafeInteger(release.id) || release.id <= 0 || typeof release.draft !== 'boolean' || !Array.isArray(release.assets)) {
      throw new Error('GitHub release does not match the requested tag.');
    }
    return files.map(file => {
      const matches = release.assets.filter(asset => asset.name === file.name);
      if (matches.length !== 1 || matches[0].state !== 'uploaded') throw new Error('Release asset is missing or incomplete: ' + file.name);
      return matches[0];
    });
  }

  function verifyFiles(release, published) {
    const assets = assetsFor(release);
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const asset = assets[index];
      if (published && file.name === 'build-info.json') {
        if (!Number.isSafeInteger(asset.id) || asset.id <= 0) throw new Error('Build metadata asset ID is invalid.');
        const remoteBytes = Buffer.from(gh(['api', 'repos/' + repo + '/releases/assets/' + asset.id, '--method', 'GET', '--header', 'Accept: application/octet-stream', '--header', 'X-GitHub-Api-Version: 2022-11-28']), 'utf8');
        if (asset.size !== remoteBytes.length || asset.digest !== 'sha256:' + hash(remoteBytes)) throw new Error('Published build metadata size or SHA256 does not match its asset.');
        const remote = JSON.parse(remoteBytes.toString('utf8'));
        for (const field of ['version', 'tag', 'commit', 'platform', 'filename', 'bytes', 'sha256', 'embeddedFrontendFiles']) {
          if (remote[field] !== metadata[field]) throw new Error('Published build metadata differs: ' + field);
        }
      } else if (asset.size !== file.size || asset.digest !== file.digest) {
        throw new Error('Release asset size or SHA256 differs: ' + file.name);
      }
    }
  }

  // The tag endpoint only returns published releases; drafts require the list API.
  let release = api(endpoint, { allow404: true }) ?? findListedRelease();
  if (release && release.draft === false) {
    verifyFiles(release, true);
    if (release.prerelease !== prerelease) throw new Error('Published release prerelease status does not match its version.');
    return { status: 'already-published', tag, url: release.html_url };
  }
  if (!release) {
    const args = ['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', '--generate-notes', '--title', tag];
    if (prerelease) args.push('--prerelease');
    gh(args);
    release = findListedRelease();
  }
  if (!release || release.tag_name !== tag || release.draft !== true || !Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error('Release must be a draft before uploading assets.');
  }
  const releaseEndpoint = 'repos/' + repo + '/releases/' + release.id;
  gh(['release', 'upload', tag, ...files.map(file => file.file), '--repo', repo, '--clobber']);
  release = api(releaseEndpoint);
  if (release.draft !== true) throw new Error('Release stopped being a draft during upload.');
  verifyFiles(release, false);
  const published = api(releaseEndpoint, {
    method: 'PATCH',
    body: { draft: false, prerelease, make_latest: prerelease ? 'false' : 'legacy' },
  });
  if (published.tag_name !== tag || published.draft !== false || published.prerelease !== prerelease) {
    throw new Error('GitHub did not publish the requested release state.');
  }
  return { status: 'published', tag, url: published.html_url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = publishGitHubRelease();
    console.log('Release ' + result.tag + ': ' + result.status + (result.url ? ' (' + result.url + ')' : ''));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
