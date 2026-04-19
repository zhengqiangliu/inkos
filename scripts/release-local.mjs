#!/usr/bin/env node

import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function printHelpAndExit(code = 0) {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/release-local.mjs [version] [--skip-build] [--skip-tests] [--allow-dirty]",
      "",
      "Description:",
      "  Local-only release/install without publishing to npm registry.",
      "  It packs core/studio/cli into tgz files, then installs all of them globally in one command.",
      "",
      "Examples:",
      "  node scripts/release-local.mjs",
      "  node scripts/release-local.mjs 1.3.6",
      "  node scripts/release-local.mjs 1.3.6 --skip-tests",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv) {
  const parsed = {
    version: undefined,
    skipBuild: false,
    skipTests: false,
    allowDirty: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("-") && !parsed.version) {
      parsed.version = token;
      continue;
    }
    if (token === "--skip-build") {
      parsed.skipBuild = true;
      continue;
    }
    if (token === "--skip-tests") {
      parsed.skipTests = true;
      continue;
    }
    if (token === "--allow-dirty") {
      parsed.allowDirty = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      printHelpAndExit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (parsed.version && !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(parsed.version)) {
    throw new Error(`Invalid semver version: ${parsed.version}`);
  }
  return parsed;
}

function getCmd(name) {
  if (process.platform === "win32") {
    if (name === "npm") return "npm.cmd";
    if (name === "pnpm") return "pnpm.cmd";
  }
  return name;
}

function resolvePnpmInvocation() {
  const execPath = process.env.npm_execpath;
  if (execPath && /pnpm(?:\.c?js)?$/i.test(execPath.replace(/\\/g, "/"))) {
    return { command: process.execPath, argsPrefix: [execPath] };
  }
  return { command: getCmd("pnpm"), argsPrefix: [] };
}

function shouldUseShell(command) {
  if (process.platform !== "win32") return false;
  return /(^|[\\/])(npm|pnpm)(\.cmd)?$/i.test(command);
}

function runOrThrow(command, args, options = {}) {
  const printable = `${command} ${args.join(" ")}`;
  process.stdout.write(`\n> ${printable}\n`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: shouldUseShell(command),
    ...options,
  });
  if (result.error) {
    throw new Error(`Failed to spawn command: ${printable}\n${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`Command terminated by signal (${result.signal}): ${printable}`);
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? "unknown"}): ${printable}`);
  }
}

function captureOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    shell: shouldUseShell(command),
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0) {
    throw new Error((result.stderr ?? "").trim() || `Command failed: ${command} ${args.join(" ")}`);
  }
  return (result.stdout ?? "").trim();
}

async function assertWorkspaceRoot(root) {
  const raw = await readFile(join(root, "package.json"), "utf-8").catch(() => null);
  if (!raw) {
    throw new Error("package.json not found at current directory.");
  }
  const pkg = JSON.parse(raw);
  if (pkg.name !== "inkos") {
    throw new Error(`This script must run at workspace root. Current package name: ${pkg.name ?? "(unknown)"}`);
  }
}

function assertGitClean(root) {
  const output = captureOrThrow("git", ["status", "--porcelain"], { cwd: root });
  if (output.length > 0) {
    throw new Error("Git worktree is not clean. Commit/stash your changes or rerun with --allow-dirty.");
  }
}

async function packAndGetTgzPath(npmCmd, packageDir, outDir) {
  const before = new Set((await readdir(outDir)).filter((name) => name.endsWith(".tgz")));
  runOrThrow(npmCmd, ["pack", "--pack-destination", outDir], { cwd: packageDir });
  const after = (await readdir(outDir)).filter((name) => name.endsWith(".tgz"));
  const created = after.filter((name) => !before.has(name));
  if (created.length !== 1) {
    throw new Error(`Expected exactly one new tarball from ${packageDir}, got ${created.length}.`);
  }
  return join(outDir, created[0]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(process.cwd());
  const npm = getCmd("npm");
  const pnpm = resolvePnpmInvocation();

  await assertWorkspaceRoot(root);
  if (!args.allowDirty) {
    assertGitClean(root);
  }

  if (args.version) {
    runOrThrow("node", ["scripts/set-package-versions.mjs", args.version, "--root", root], { cwd: root });
  }

  runOrThrow("node", ["scripts/verify-no-workspace-protocol.mjs", "packages/core", "packages/cli", "packages/studio"], { cwd: root });

  if (!args.skipBuild) {
    runOrThrow(pnpm.command, [...pnpm.argsPrefix, "build"], { cwd: root });
  }
  if (!args.skipTests) {
    runOrThrow(pnpm.command, [...pnpm.argsPrefix, "test"], { cwd: root });
  }

  const outDir = join(root, ".local-release", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(outDir, { recursive: true });
  process.stdout.write(`\nPacking tarballs to: ${outDir}\n`);

  const coreTgz = await packAndGetTgzPath(npm, join(root, "packages", "core"), outDir);
  const studioTgz = await packAndGetTgzPath(npm, join(root, "packages", "studio"), outDir);
  const cliTgz = await packAndGetTgzPath(npm, join(root, "packages", "cli"), outDir);

  runOrThrow(npm, ["i", "-g", "--force", coreTgz, studioTgz, cliTgz], { cwd: root });

  process.stdout.write(
    "\nLocal upgrade completed.\n" +
    `Tarballs: \n- ${coreTgz}\n- ${studioTgz}\n- ${cliTgz}\n` +
    "Verify with: inkos --version\n",
  );
}

main().catch((error) => {
  process.stderr.write(`[release-local] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
