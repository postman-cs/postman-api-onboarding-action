/* global console, process */
import { fileURLToPath } from 'node:url';

const MAJOR_ALIAS = /^v(\d+)$/;
const IMMUTABLE_FULL = /^v(\d+)\.(\d+)\.(\d+)$/;
const IMMUTABLE_MINOR = /^v(\d+)\.(\d+)$/;

/**
 * @param {string} version
 * @returns {[number, number, number]}
 */
export function parseSemverParts(version) {
  const raw = String(version).replace(/^v/, '');
  const parts = raw.split('.').map((part) => Number(part));
  if (parts.length === 2) parts.push(0);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || Number.isNaN(n))) {
    throw new Error(`invalid semver: ${version}`);
  }
  return /** @type {[number, number, number]} */ (parts);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  const left = parseSemverParts(a);
  const right = parseSemverParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * @param {string} text
 * @returns {Map<string, { object: string | null, peeled: string | null }>}
 */
export function parseLsRemoteLines(text) {
  /** @type {Map<string, { object: string | null, peeled: string | null }>} */
  const tags = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([0-9a-f]{40})\trefs\/tags\/(.+)$/);
    if (!match) continue;
    const sha = match[1];
    const rawName = match[2];
    const peeled = rawName.endsWith('^{}');
    const name = peeled ? rawName.slice(0, -3) : rawName;
    const entry = tags.get(name) ?? { object: null, peeled: null };
    if (peeled) entry.peeled = sha;
    else entry.object = sha;
    tags.set(name, entry);
  }
  return tags;
}

/**
 * Resolve lightweight (`object`) or annotated (`peeled`) tag targets.
 * @param {Map<string, { object: string | null, peeled: string | null }>} tags
 * @param {string} name
 * @returns {string | null}
 */
export function resolveTagCommit(tags, name) {
  const entry = tags.get(name);
  if (!entry) return null;
  return entry.peeled ?? entry.object;
}

/**
 * @param {string} tagName
 * @param {number} majorNum
 */
export function isSameMajorImmutableTag(tagName, majorNum) {
  const full = tagName.match(IMMUTABLE_FULL);
  if (full) return Number(full[1]) === majorNum;
  const minor = tagName.match(IMMUTABLE_MINOR);
  if (!minor || MAJOR_ALIAS.test(tagName)) return false;
  return Number(minor[1]) === majorNum;
}

/**
 * @param {string} tagName
 * @returns {string}
 */
export function versionFromImmutableTag(tagName) {
  const full = tagName.match(IMMUTABLE_FULL);
  if (full) return `${full[1]}.${full[2]}.${full[3]}`;
  const minor = tagName.match(IMMUTABLE_MINOR);
  if (minor && !MAJOR_ALIAS.test(tagName)) return `${minor[1]}.${minor[2]}.0`;
  throw new Error(`not an immutable tag: ${tagName}`);
}

/**
 * @param {string} majorAlias
 * @param {string} candidateTag
 * @returns {{ majorNum: number, candidateVersion: string }}
 */
export function parseAliasArgs(majorAlias, candidateTag) {
  const majorMatch = String(majorAlias ?? '').match(MAJOR_ALIAS);
  if (!majorMatch) throw new Error(`malformed major alias: ${majorAlias}`);
  const majorNum = Number(majorMatch[1]);
  const full = String(candidateTag ?? '').match(IMMUTABLE_FULL);
  if (full) {
    if (Number(full[1]) !== majorNum) throw new Error(`mismatched major: ${candidateTag} vs ${majorAlias}`);
    return { majorNum, candidateVersion: `${full[1]}.${full[2]}.${full[3]}` };
  }
  const minor = String(candidateTag ?? '').match(IMMUTABLE_MINOR);
  if (minor && !MAJOR_ALIAS.test(candidateTag)) {
    if (Number(minor[1]) !== majorNum) throw new Error(`mismatched major: ${candidateTag} vs ${majorAlias}`);
    return { majorNum, candidateVersion: `${minor[1]}.${minor[2]}.0` };
  }
  throw new Error(`malformed candidate immutable tag: ${candidateTag}`);
}

/**
 * @param {{ majorAlias: string, candidateTag: string, lsRemoteText: string }} input
 * @returns {{ status: number, reason: string, currentVersion?: string }}
 */
export function decideAliasAdvance({ majorAlias, candidateTag, lsRemoteText }) {
  const { majorNum, candidateVersion } = parseAliasArgs(majorAlias, candidateTag);
  const tags = parseLsRemoteLines(lsRemoteText);
  const aliasCommit = resolveTagCommit(tags, majorAlias);
  if (!aliasCommit) return { status: 0, reason: 'absent' };

  /** @type {string[]} */
  const versions = [];
  for (const name of tags.keys()) {
    if (!isSameMajorImmutableTag(name, majorNum)) continue;
    if (resolveTagCommit(tags, name) !== aliasCommit) continue;
    versions.push(versionFromImmutableTag(name));
  }
  const unique = [...new Set(versions)];
  if (unique.length === 0) {
    throw new Error(`existing alias ${majorAlias} cannot be safely resolved to a same-major immutable tag`);
  }
  unique.sort(compareSemver);
  const currentVersion = unique[unique.length - 1];
  if (compareSemver(currentVersion, candidateVersion) > 0) {
    return { status: 10, reason: 'newer', currentVersion };
  }
  return { status: 0, reason: compareSemver(currentVersion, candidateVersion) === 0 ? 'same' : 'older', currentVersion };
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [majorAlias, candidateTag] = process.argv.slice(2);
  if (!majorAlias || !candidateTag) {
    console.error('usage: node scripts/check-release-alias.mjs <majorAlias> <candidateImmutableTag>');
    process.exit(2);
  }
  try {
    const lsRemoteText = await readStdin();
    const result = decideAliasAdvance({ majorAlias, candidateTag, lsRemoteText });
    if (result.status === 10 && result.currentVersion) process.stdout.write(result.currentVersion);
    process.exit(result.status);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
