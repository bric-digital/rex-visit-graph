#!/usr/bin/env node

// Tag a release of this module.
//
//   npm run release:tag -- 1.0.0
//
// A module is not published to a registry: consumers install it straight from
// GitHub. So a release IS the tag, and pinning is what a consumer does with it:
//
//   "@bric/rex-visit-graph": "github:bric-digital/rex-visit-graph#v1.0.0"
//
// That is the whole point of tagging. A bare `github:bric-digital/rex-visit-graph`
// floats on the default branch, so two installs a week apart can resolve to
// different code with the same lockfile entry never looking wrong.
//
// The version in package.json is the source of truth. This script refuses to tag
// unless package.json already says the version being released, then bumps to the
// next patch so the branch is immediately back on development. Mirrors
// AI-Extension's scripts/tag-release.mjs, which does the same against
// manifest.json.

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawVersion = process.argv[2];

/**
 * The next development version, marked `-dev`.
 *
 * A bare `1.0.1` sitting in package.json between releases claims to be a release
 * that was never cut, and anyone reading the repo believes it. `1.0.1-dev` says
 * plainly: past 1.0.0, not yet 1.0.1.
 */
function nextDevelopmentVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    throw new Error(`Cannot derive next version from ${version}.`);
  }
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}-dev`;
}

const git = (args, opts = {}) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...opts });

if (!rawVersion) {
  throw new Error('Usage: npm run release:tag -- <version>');
}

const version = rawVersion.startsWith('v') ? rawVersion.slice(1) : rawVersion;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Invalid version: ${rawVersion}. A release is X.Y.Z, without a -dev suffix.`);
}

const tagName = `v${version}`;
const packagePath = path.join(repoRoot, 'package.json');
const pkg = JSON.parse(await readFile(packagePath, 'utf8'));

if (pkg.version !== version) {
  throw new Error(
    `package.json version is ${pkg.version}, but release:tag expects ${version}. `
    + 'Update package.json to the version you intend to release.',
  );
}

if (git(['status', '--porcelain']).trim().length > 0) {
  throw new Error('Release tagging requires a clean git working tree.');
}

// `git tag --list` prints nothing rather than failing, so an existing tag is a
// non-empty line rather than a thrown error.
if (git(['tag', '--list', tagName]).trim().length > 0) {
  throw new Error(`Git tag ${tagName} already exists.`);
}

const branchName = git(['branch', '--show-current']).trim();

git(['tag', '-a', tagName, '-m', `Release ${tagName}`], { stdio: 'inherit' });

pkg.version = nextDevelopmentVersion(version);
await writeFile(packagePath, `${JSON.stringify(pkg, null, 4)}\n`);

git(['add', 'package.json'], { stdio: 'inherit' });
git(['commit', '-m', `start v${pkg.version} development`], { stdio: 'inherit' });

console.log(`\nCreated tag ${tagName}.`);
console.log(`Bumped package.json to ${pkg.version} — marked -dev so the repo never `
  + 'names a release that was not cut.');
console.log(`Push with: git push origin ${branchName || 'main'} --follow-tags`);
console.log(`Consumers pin with: "github:bric-digital/rex-visit-graph#${tagName}"`);
