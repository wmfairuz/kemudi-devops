#!/usr/bin/env node
// pnpm release patch|minor|major|x.y.z [--dry-run]
//
// Bumps the version in package.json, src-tauri/tauri.conf.json and
// src-tauri/Cargo.toml (and Cargo.lock), adds a CHANGELOG.md section from the
// commits since the last tag, commits "Release vX.Y.Z", tags it and pushes.
// The tag starts .github/workflows/release.yml, which builds, signs,
// notarizes and publishes the GitHub release the updater reads.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const bump = args.find((a) => !a.startsWith("--"));
const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

if (!bump) die("say which: patch, minor, major or x.y.z");
if (git("status", "--porcelain")) die("commit or stash your changes first");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") die("release from main");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const current = pkg.version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!m) die(`package.json version ${current} isn't x.y.z`);
const [maj, min, pat] = m.slice(1).map(Number);
const next =
  bump === "major"
    ? `${maj + 1}.0.0`
    : bump === "minor"
      ? `${maj}.${min + 1}.0`
      : bump === "patch"
        ? `${maj}.${min}.${pat + 1}`
        : /^\d+\.\d+\.\d+$/.test(bump)
          ? bump
          : die(`not a version: ${bump}`);
const tag = `v${next}`;
if (git("tag", "--list", tag)) die(`${tag} already exists`);

// Commits since the last tag (all of them for the first release).
let last = "";
try {
  last = git("describe", "--tags", "--abbrev=0");
} catch {
  // No tags yet.
}
const subjects = git("log", "--no-merges", "--format=%s", ...(last ? [`${last}..HEAD`] : []))
  .split("\n")
  .filter((s) => s && !/^Release v\d/.test(s));
const date = new Date().toISOString().slice(0, 10);
const section = `## ${next} (${date})\n\n${last ? subjects.map((s) => `- ${s}`).join("\n") : "- First release."}\n`;

console.log(`${current} → ${next}\n\n${section}`);
if (dry) process.exit(0);

pkg.version = next;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

const replaceOnce = (file, re, to) => {
  const s = readFileSync(file, "utf8");
  if (!re.test(s)) die(`no version found in ${file}`);
  writeFileSync(file, s.replace(re, to));
};
replaceOnce("src-tauri/tauri.conf.json", /"version": "[^"]*"/, `"version": "${next}"`);
replaceOnce("src-tauri/Cargo.toml", /^version = "[^"]*"/m, `version = "${next}"`);
// Only the app's own entry in Cargo.lock; dependencies stay as they are.
execFileSync("cargo", ["update", "--workspace", "--manifest-path", "src-tauri/Cargo.toml"], { stdio: "inherit" });

const head = "# Changelog\n\n";
const old = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8").replace(/^# Changelog\n+/, "") : "";
writeFileSync("CHANGELOG.md", `${head}${section}\n${old}`.trimEnd() + "\n");

git("add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "CHANGELOG.md");
git("commit", "-m", `Release ${tag}`);
git("tag", "-a", tag, "-m", `Kemudi Devops ${next}`);
execFileSync("git", ["push", "origin", "main", tag], { stdio: "inherit" });
console.log(`\nPushed ${tag}. GitHub Actions is building it: https://github.com/wmfairuz/kemudi-devops/actions`);
