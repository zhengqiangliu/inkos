#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ENTRIES = ["write-next", "write-target", "rewrite"];
const METRICS = ["fpr0", "fpr1", "failed_max_rounds_rate", "structural_ratio"];

function parseArgs(argv) {
  const args = {
    baseline: "",
    after: "",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }
    if (current === "--baseline") {
      const value = argv[i + 1];
      if (!value) throw new Error("--baseline requires a file path");
      args.baseline = value;
      i += 1;
      continue;
    }
    if (current === "--after") {
      const value = argv[i + 1];
      if (!value) throw new Error("--after requires a file path");
      args.after = value;
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
    "  node scripts/first-pass-rate-report.mjs --baseline <7d-before.ndjson> --after <7d-after.ndjson>",
    "",
    "Input format (one JSON object per line):",
    "  1) direct analytics payload containing reviewMetrics/reviewMetricsByEntry",
    "  2) wrapper payload containing .analytics.reviewMetrics/reviewMetricsByEntry",
  ].join("\n"));
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readSnapshotRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const direct = raw;
  const wrapped = raw.analytics && typeof raw.analytics === "object" ? raw.analytics : null;
  const source = direct.reviewMetrics ? direct : wrapped;
  if (!source || typeof source !== "object") return null;
  const reviewMetrics = source.reviewMetrics;
  const reviewMetricsByEntry = source.reviewMetricsByEntry;
  if (!reviewMetrics || typeof reviewMetrics !== "object") return null;
  if (!reviewMetricsByEntry || typeof reviewMetricsByEntry !== "object") return null;
  return {
    overall: {
      sample_size: toNumber(reviewMetrics.sample_size, 0),
      fpr0: toNumber(reviewMetrics.fpr0, 0),
      fpr1: toNumber(reviewMetrics.fpr1, 0),
      failed_max_rounds_rate: toNumber(reviewMetrics.failed_max_rounds_rate, 0),
      structural_ratio: toNumber(reviewMetrics.structural_ratio, 0),
    },
    byEntry: ENTRIES.reduce((acc, entry) => {
      const payload = reviewMetricsByEntry[entry];
      acc[entry] = {
        sample_size: toNumber(payload?.sample_size, 0),
        fpr0: toNumber(payload?.fpr0, 0),
        fpr1: toNumber(payload?.fpr1, 0),
        failed_max_rounds_rate: toNumber(payload?.failed_max_rounds_rate, 0),
        structural_ratio: toNumber(payload?.structural_ratio, 0),
      };
      return acc;
    }, {}),
  };
}

async function loadNdjson(filePath) {
  const content = await readFile(resolve(filePath), "utf-8");
  const lines = content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const records = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const record = readSnapshotRecord(parsed);
      if (record) records.push(record);
    } catch {
      // ignore malformed lines
    }
  }
  return records;
}

function weightedAverage(records, field) {
  let weighted = 0;
  let sample = 0;
  for (const record of records) {
    const size = toNumber(record.sample_size, 0);
    const value = toNumber(record[field], 0);
    if (size <= 0) continue;
    weighted += value * size;
    sample += size;
  }
  return {
    value: sample > 0 ? weighted / sample : 0,
    sample,
  };
}

function aggregate(records) {
  const overall = records.map((item) => item.overall);
  const overallSummary = {
    sample_size: overall.reduce((sum, item) => sum + toNumber(item.sample_size, 0), 0),
  };
  for (const metric of METRICS) {
    overallSummary[metric] = weightedAverage(overall, metric).value;
  }

  const byEntry = {};
  for (const entry of ENTRIES) {
    const series = records.map((item) => item.byEntry[entry]);
    const summary = {
      sample_size: series.reduce((sum, item) => sum + toNumber(item.sample_size, 0), 0),
    };
    for (const metric of METRICS) {
      summary[metric] = weightedAverage(series, metric).value;
    }
    byEntry[entry] = summary;
  }
  return { overall: overallSummary, byEntry };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function printSection(title, baseline, after) {
  console.log(`\n## ${title}`);
  console.log("| Metric | Baseline | After | Delta(pp) |");
  console.log("| --- | ---: | ---: | ---: |");
  for (const metric of METRICS) {
    const b = toNumber(baseline[metric], 0);
    const a = toNumber(after[metric], 0);
    const d = a - b;
    console.log(`| ${metric} | ${round1(b)} | ${round1(a)} | ${round1(d)} |`);
  }
  console.log(`| sample_size | ${toNumber(baseline.sample_size, 0)} | ${toNumber(after.sample_size, 0)} | - |`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.baseline || !args.after) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const baselineRecords = await loadNdjson(args.baseline);
  const afterRecords = await loadNdjson(args.after);
  if (baselineRecords.length === 0) {
    throw new Error(`No valid snapshot records found in baseline file: ${args.baseline}`);
  }
  if (afterRecords.length === 0) {
    throw new Error(`No valid snapshot records found in after file: ${args.after}`);
  }

  const baseline = aggregate(baselineRecords);
  const after = aggregate(afterRecords);

  console.log("# First-Pass-Rate 7-Day Comparison");
  console.log("");
  console.log(`- baseline snapshots: ${baselineRecords.length}`);
  console.log(`- after snapshots: ${afterRecords.length}`);

  printSection("Overall", baseline.overall, after.overall);
  for (const entry of ENTRIES) {
    printSection(`Entry: ${entry}`, baseline.byEntry[entry], after.byEntry[entry]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
