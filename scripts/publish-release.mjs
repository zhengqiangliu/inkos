#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = {
    version: "",
    tag: "latest",
    skipTests: false,
    skipBuild: false,
    allowDirty: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("-") && !args.version) {
      args.version = token;
      continue;
    }
    if (token === "--tag") {
      args.tag = argv[i + 1] ?? "latest";
      i += 1;
      continue;
    }
    if (token === "--skip-tests") {
      args.skipTests = true;
      continue;
    }
    if (token === "--skip-build") {
      args.skipBuild = true;
      continue;
    }
    if (token === "--allow-dirty") {
      args.allowDirty = true;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "-h" || token === "--help") {
      printHelpAndExit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.version) {
    throw new Error("Missing version argument.");
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(args.version)) {
    throw new Error(`Invalid semver version: ${args.version}`);
  }
  return args;
}

function printHelpAndExit(code = 0) {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/publish-release.mjs <version> [--tag <dist-tag>] [--dry-run]",
      "",
      "Options:",
      "  --tag <dist-tag>   npm dist-tag, default: latest",
      "  --skip-build       Skip `pnpm build`",
      "  --skip-tests       Skip `pnpm test`",
      "  --allow-dirty      Allow git dirty worktree",
      "  --dry-run          Run validations/build/test/versioning, but do not npm publish",
      "",
      "Examples:",
      "  node scripts/publish-release.mjs 1.3.6",
      "  node scripts/publish-release.mjs 1.3.7-canary.1 --tag canary",
    ].join("\n"),
  );
  process.exit(code);
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

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    shell: shouldUseShell(command),
    ...options,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(stderr || `Command failed (${result.status ?? "unknown"}): ${command} ${args.join(" ")}`);
  }
  return (result.stdout ?? "").trim();
}

async function assertWorkspaceRoot(root) {
  const rootPackagePath = join(root, "package.json");
  const raw = await readFile(rootPackagePath, "utf-8").catch(() => null);
  if (!raw) {
    throw new Error(`package.json not found at ${rootPackagePath}`);
  }
  const pkg = JSON.parse(raw);
  if (pkg.name !== "inkos") {
    throw new Error(`This script must run at the inkos workspace root. Found package name: ${pkg.name ?? "(unknown)"}`);
  }
}

function assertGitClean(root) {
  const output = capture("git", ["status", "--porcelain"], { cwd: root });
  if (output.trim().length > 0) {
    throw new Error("Git worktree is not clean. Commit/stash your changes or rerun with --allow-dirty.");
  }
}

function assertNpmLogin(root) {
  capture(getCmd("npm"), ["whoami"], { cwd: root });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(process.cwd());
  const pnpm = resolvePnpmInvocation();
  const npm = getCmd("npm");

  await assertWorkspaceRoot(root);
  if (!args.allowDirty) {
    assertGitClean(root);
  }
  assertNpmLogin(root);

  runOrThrow("node", ["scripts/set-package-versions.mjs", args.version, "--root", root], { cwd: root });
  runOrThrow("node", ["scripts/verify-no-workspace-protocol.mjs", "packages/core", "packages/cli", "packages/studio"], { cwd: root });

  if (!args.skipBuild) {
    runOrThrow(pnpm.command, [...pnpm.argsPrefix, "build"], { cwd: root });
  }
  if (!args.skipTests) {
    runOrThrow(pnpm.command, [...pnpm.argsPrefix, "test"], { cwd: root });
  }

  if (args.dryRun) {
    process.stdout.write("\nDry run complete. No packages were published.\n");
    return;
  }

  const publishArgs = ["publish", "--access", "public", "--tag", args.tag];
  runOrThrow(npm, publishArgs, { cwd: join(root, "packages", "core") });
  runOrThrow(npm, publishArgs, { cwd: join(root, "packages", "studio") });
  runOrThrow(npm, publishArgs, { cwd: join(root, "packages", "cli") });

  process.stdout.write(
    `\nPublished version ${args.version} (tag: ${args.tag}).\n` +
    "Users can update via: npm i -g @actalk/inkos@latest\n",
  );
}

main().catch((error) => {
  process.stderr.write(`[release] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
