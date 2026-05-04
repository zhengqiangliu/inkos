#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const METRICS = [
  "totalMs",
  "inputPrepMs",
  "writingMs",
  "auditMs",
  "reviseMs",
  "truthRebuildMs",
  "stateValidationMs",
  "indexSyncMs",
];

function parseArgs(argv) {
  const args = {
    inputs: [],
    left: null,
    right: null,
    from: null,
    to: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }
    if (current === "--input") {
      const value = argv[i + 1];
      if (!value) throw new Error("--input requires a value");
      args.inputs.push(value);
      i += 1;
      continue;
    }
    if (current === "--left") {
      const value = argv[i + 1];
      if (!value) throw new Error("--left requires a value");
      args.left = value;
      i += 1;
      continue;
    }
    if (current === "--right") {
      const value = argv[i + 1];
      if (!value) throw new Error("--right requires a value");
      args.right = value;
      i += 1;
      continue;
    }
    if (current === "--from") {
      const value = argv[i + 1];
      if (!value) throw new Error("--from requires an ISO datetime");
      args.from = value;
      i += 1;
      continue;
    }
    if (current === "--to") {
      const value = argv[i + 1];
      if (!value) throw new Error("--to requires an ISO datetime");
      args.to = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown arg: ${current}`);
  }

  return args;
}

function printHelp() {
  console.log([
    "Usage:",
    "  node scripts/write-next-perf-report.mjs [--input <ndjson> ...] [--from <iso>] [--to <iso>]",
    "  node scripts/write-next-perf-report.mjs --left <baseline.ndjson> --right <after.ndjson> [--from <iso>] [--to <iso>]",
    "",
    "If no --input/--left/--right is provided, the script scans current workspace",
    "for files named write-next-performance.ndjson.",
  ].join("\n"));
}

function toTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid datetime: ${value}`);
  }
  return timestamp;
}

async function findDefaultInputs(rootDir) {
  const matches = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "write-next-performance.ndjson") {
        matches.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  return matches;
}

async function loadSamples(paths, fromTs, toTs) {
  const records = [];
  for (const path of paths) {
    const content = await readFile(path, "utf-8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const atTs = Date.parse(String(parsed.at ?? ""));
      if (Number.isFinite(fromTs) && (!Number.isFinite(atTs) || atTs < fromTs)) continue;
      if (Number.isFinite(toTs) && (!Number.isFinite(atTs) || atTs > toTs)) continue;
      records.push(parsed);
    }
  }
  return records;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = p * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const ratio = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * ratio;
}

function summarize(records) {
  const summary = {};
  for (const metric of METRICS) {
    const values = records
      .map((record) => Number(record[metric]))
      .filter((value) => Number.isFinite(value));
    const count = values.length;
    const total = values.reduce((sum, value) => sum + value, 0);
    summary[metric] = {
      count,
      mean: count > 0 ? total / count : 0,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: count > 0 ? Math.max(...values) : 0,
    };
  }
  return summary;
}

function printSummary(title, summary) {
  console.log(`\n=== ${title} ===`);
  console.log("metric,count,mean_ms,p50_ms,p95_ms,max_ms");
  for (const metric of METRICS) {
    const row = summary[metric];
    console.log([
      metric,
      row.count,
      row.mean.toFixed(1),
      row.p50.toFixed(1),
      row.p95.toFixed(1),
      row.max.toFixed(1),
    ].join(","));
  }
}

function printCompare(left, right) {
  console.log("\n=== Delta (right - left) ===");
  console.log("metric,mean_ms,p50_ms,p95_ms,max_ms");
  for (const metric of METRICS) {
    const a = left[metric];
    const b = right[metric];
    console.log([
      metric,
      (b.mean - a.mean).toFixed(1),
      (b.p50 - a.p50).toFixed(1),
      (b.p95 - a.p95).toFixed(1),
      (b.max - a.max).toFixed(1),
    ].join(","));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const fromTs = toTimestamp(args.from);
  const toTs = toTimestamp(args.to);

  if ((args.left && !args.right) || (!args.left && args.right)) {
    throw new Error("--left and --right must be used together");
  }

  if (args.left && args.right) {
    const leftRecords = await loadSamples([resolve(args.left)], fromTs, toTs);
    const rightRecords = await loadSamples([resolve(args.right)], fromTs, toTs);
    const leftSummary = summarize(leftRecords);
    const rightSummary = summarize(rightRecords);
    printSummary(`Baseline (${leftRecords.length} samples)`, leftSummary);
    printSummary(`After (${rightRecords.length} samples)`, rightSummary);
    printCompare(leftSummary, rightSummary);
    return;
  }

  const resolvedInputs = args.inputs.length > 0
    ? args.inputs.map((path) => resolve(path))
    : await findDefaultInputs(process.cwd());
  if (resolvedInputs.length === 0) {
    console.log("No write-next-performance.ndjson files found.");
    return;
  }

  const records = await loadSamples(resolvedInputs, fromTs, toTs);
  const summary = summarize(records);
  printSummary(`Merged (${records.length} samples from ${resolvedInputs.length} files)`, summary);
}

main().catch((error) => {
  console.error(`[write-next-perf-report] ${String(error)}`);
  process.exitCode = 1;
});

