#!/usr/bin/env node
/**
 * E2E acceptance checker for audit auto-review convergence.
 *
 * Run mode example:
 * node packages/studio/scripts/audit-auto-review-e2e.mjs \
 *   --base-url http://localhost:4317 \
 *   --book-id demo-book \
 *   --chapters 10,11,12-14 \
 *   --output .\\audit-auto-review-after.json
 *
 * Compare mode example:
 * node packages/studio/scripts/audit-auto-review-e2e.mjs \
 *   --baseline .\\audit-auto-review-baseline.json \
 *   --after .\\audit-auto-review-after.json
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const args = process.argv.slice(2);

function readArg(name, fallback = "") {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (typeof value !== "string" || value.startsWith("--")) return fallback;
  return value;
}

function readIntArg(name, fallback) {
  const raw = readArg(name, "");
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function readBoolArg(name, fallback = false) {
  const raw = readArg(name, "");
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function parseChapterList(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return [];
  const numbers = new Set();
  for (const token of input.split(",").map((item) => item.trim()).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/u);
    if (range) {
      const start = Number.parseInt(range[1], 10);
      const end = Number.parseInt(range[2], 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      for (let chapter = from; chapter <= to; chapter += 1) {
        if (chapter > 0) numbers.add(chapter);
      }
      continue;
    }
    const single = Number.parseInt(token, 10);
    if (Number.isFinite(single) && single > 0) numbers.add(single);
  }
  return [...numbers].sort((a, b) => a - b);
}

async function requestJson(url, options = {}) {
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const requester = isHttps ? httpsRequest : httpRequest;
  const payload = options.body === undefined ? null : JSON.stringify(options.body);

  return await new Promise((resolvePromise, rejectPromise) => {
    const req = requester(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolvePromise({
            status: typeof res.statusCode === "number" ? res.statusCode : 0,
            text,
            json,
          });
        });
      },
    );

    req.on("error", rejectPromise);
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 0;
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
      });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

async function startFilteredSseCapture(input) {
  const endpoint = `${input.baseUrl.replace(/\/$/, "")}/api/v1/events`;
  const controller = new AbortController();
  const records = [];

  const task = (async () => {
    try {
      const response = await fetch(endpoint, { signal: controller.signal });
      if (!response.ok || !response.body) {
        records.push({
          ts: Date.now(),
          event: "capture:error",
          data: { message: `SSE connect failed: ${response.status} ${response.statusText}` },
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf("\n\n");

          let eventName = "";
          let dataRaw = "";
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
            if (line.startsWith("data:")) dataRaw += line.slice("data:".length).trim();
          }
          if (!eventName || !dataRaw || eventName === "ping") continue;

          let payload;
          try {
            payload = JSON.parse(dataRaw);
          } catch {
            continue;
          }
          if (!payload || typeof payload !== "object") continue;
          if (payload.bookId !== input.bookId) continue;

          const payloadChapterRaw = payload.chapterNumber ?? payload.chapter;
          const payloadChapter = Number(payloadChapterRaw);
          if (!Number.isFinite(payloadChapter) || payloadChapter !== input.chapter) continue;

          records.push({ ts: Date.now(), event: eventName, data: payload });
        }
      }
    } catch (error) {
      const aborted = error && typeof error === "object" && "name" in error && error.name === "AbortError";
      if (!aborted) {
        records.push({ ts: Date.now(), event: "capture:error", data: { message: String(error) } });
      }
    }
  })();

  return {
    endpoint,
    records,
    stop: async () => {
      controller.abort("capture-stopped");
      await task.catch(() => undefined);
    },
  };
}

function summarizeEventGaps(records) {
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  let maxGapMs = 0;
  let maxGapFromEvent = null;
  let maxGapToEvent = null;
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i].ts - sorted[i - 1].ts;
    if (gap > maxGapMs) {
      maxGapMs = gap;
      maxGapFromEvent = sorted[i - 1].event;
      maxGapToEvent = sorted[i].event;
    }
  }
  return {
    count: sorted.length,
    maxGapMs,
    maxGapFromEvent,
    maxGapToEvent,
  };
}

function buildConvergenceSignals(args) {
  const autoReview = args.autoReview && typeof args.autoReview === "object"
    ? args.autoReview
    : null;
  const revisions = Array.isArray(autoReview?.revisions) ? autoReview.revisions : [];

  const reviseRoundsUsedRaw = Number(autoReview?.reviseRoundsUsed);
  const reviseRoundsUsed = Number.isFinite(reviseRoundsUsedRaw)
    ? Math.max(0, Math.trunc(reviseRoundsUsedRaw))
    : revisions.length;

  const finalState = typeof autoReview?.finalState === "string" ? autoReview.finalState : "unknown";
  const stopReason = typeof autoReview?.stopReason === "string" ? autoReview.stopReason : null;

  const unchangedRounds = revisions.filter((entry) => {
    const applied = entry?.applied === true;
    const status = typeof entry?.status === "string" ? entry.status.toLowerCase() : "";
    return !applied || status.includes("unchanged");
  }).length;

  let unchangedTailStreak = 0;
  for (let i = revisions.length - 1; i >= 0; i -= 1) {
    const entry = revisions[i];
    const applied = entry?.applied === true;
    const status = typeof entry?.status === "string" ? entry.status.toLowerCase() : "";
    const unchanged = !applied || status.includes("unchanged");
    if (!unchanged) break;
    unchangedTailStreak += 1;
  }

  const lastRevision = revisions.length > 0 ? revisions[revisions.length - 1] : null;
  const lastMustFixOutcomes = Array.isArray(lastRevision?.mustFixOutcomes) ? lastRevision.mustFixOutcomes : [];
  const unresolvedMustFixCount = lastMustFixOutcomes.filter((item) => item?.outcome !== "resolved").length;

  const reviseStartEvents = args.events
    .filter((event) => event.event === "revise:start")
    .map((event) => event.data)
    .filter((data) => data && typeof data === "object");

  const modes = reviseStartEvents
    .map((data) => (typeof data.mode === "string" ? data.mode.trim() : ""))
    .filter(Boolean);
  const uniqueModes = [...new Set(modes)];
  const hasEscalatedMode = uniqueModes.length > 1 || uniqueModes.some((mode) => mode === "rework" || mode === "rewrite");

  const strategyReasonCount = reviseStartEvents
    .map((data) => (typeof data.strategyReason === "string" ? data.strategyReason.trim() : ""))
    .filter(Boolean)
    .length;

  const stagnationLikely = (finalState === "failed-max-rounds" && unchangedTailStreak >= 2)
    || (reviseRoundsUsed >= 3 && unchangedRounds >= 2 && !hasEscalatedMode);

  return {
    reviseRoundsUsed,
    finalState,
    stopReason,
    revisionCount: revisions.length,
    unchangedRounds,
    unchangedTailStreak,
    unresolvedMustFixCount,
    modes: uniqueModes,
    hasEscalatedMode,
    strategyReasonCount,
    stagnationLikely,
  };
}

function summarizeRun(args) {
  const cases = Array.isArray(args.cases) ? args.cases : [];
  const total = cases.length;
  const passedCases = cases.filter((item) => item?.response?.passed === true).length;
  const finalPassedCases = cases.filter((item) => item?.response?.auditPassed === true).length;
  const failedMaxRounds = cases.filter((item) => item?.signals?.finalState === "failed-max-rounds").length;
  const stagnationLikely = cases.filter((item) => item?.signals?.stagnationLikely === true).length;
  const tailNoChange2Plus = cases.filter((item) => Number(item?.signals?.unchangedTailStreak) >= 2).length;

  const toRate = (value) => (total > 0 ? Math.round((value / total) * 1000) / 10 : 0);

  return {
    total,
    passedCases,
    finalPassedCases,
    failedMaxRounds,
    stagnationLikely,
    tailNoChange2Plus,
    passedRate: toRate(passedCases),
    finalPassedRate: toRate(finalPassedCases),
    failedMaxRoundsRate: toRate(failedMaxRounds),
    stagnationLikelyRate: toRate(stagnationLikely),
    tailNoChange2PlusRate: toRate(tailNoChange2Plus),
  };
}

function printCompareSummary(args) {
  const baseline = args.baseline?.summary ?? null;
  const after = args.after?.summary ?? null;
  if (!baseline || !after) {
    throw new Error("Invalid compare payload: missing summary");
  }

  const deltas = {
    finalPassedRate: Number((after.finalPassedRate - baseline.finalPassedRate).toFixed(1)),
    failedMaxRoundsRate: Number((after.failedMaxRoundsRate - baseline.failedMaxRoundsRate).toFixed(1)),
    stagnationLikelyRate: Number((after.stagnationLikelyRate - baseline.stagnationLikelyRate).toFixed(1)),
    tailNoChange2PlusRate: Number((after.tailNoChange2PlusRate - baseline.tailNoChange2PlusRate).toFixed(1)),
  };

  const accepted = deltas.stagnationLikelyRate <= -10
    || (deltas.failedMaxRoundsRate <= -10 && deltas.tailNoChange2PlusRate <= -10);

  const report = {
    baselineFile: args.baselinePath,
    afterFile: args.afterPath,
    baselineSummary: baseline,
    afterSummary: after,
    deltas,
    accepted,
    acceptanceRule: "stagnationLikelyRate 下降>=10pp；或 (failedMaxRoundsRate 与 tailNoChange2PlusRate 均下降>=10pp)",
  };

  console.log(JSON.stringify(report, null, 2));
  if (args.strict && !accepted) {
    process.exit(1);
  }
}

async function runCase(args) {
  const capture = await startFilteredSseCapture({
    baseUrl: args.baseUrl,
    bookId: args.bookId,
    chapter: args.chapter,
  });

  const startedAt = Date.now();
  let responseStatus = 0;
  let responseJson = null;
  let responseError = null;

  try {
    const response = await requestJson(
      `${args.baseUrl.replace(/\/$/, "")}/api/v1/books/${encodeURIComponent(args.bookId)}/audit/${args.chapter}`,
      {
        method: "POST",
        timeoutMs: args.requestTimeoutMs,
      },
    );
    responseStatus = response.status;
    responseJson = response.json;
  } catch (error) {
    responseError = String(error);
  }

  if (args.postWaitMs > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, args.postWaitMs));
  }
  await capture.stop();

  const endedAt = Date.now();
  const gaps = summarizeEventGaps(capture.records);
  const autoReview = responseJson?.autoReview;
  const signals = buildConvergenceSignals({ autoReview, events: capture.records });

  const auditPassed = responseJson?.passed === true;
  const responsePass = responseStatus >= 200 && responseStatus < 300 && responseError === null;

  return {
    chapter: args.chapter,
    startedAt,
    endedAt,
    elapsedMs: endedAt - startedAt,
    response: {
      status: responseStatus,
      error: responseError,
      passed: responsePass,
      auditPassed,
      score: Number.isFinite(Number(responseJson?.score)) ? Number(responseJson.score) : null,
      issueCount: Number.isFinite(Number(responseJson?.issueCount)) ? Number(responseJson.issueCount) : null,
      failureGate: typeof responseJson?.failureGate === "string" ? responseJson.failureGate : null,
      autoReview,
    },
    signals,
    sse: {
      endpoint: capture.endpoint,
      eventCount: gaps.count,
      maxGapMs: gaps.maxGapMs,
      maxGapFromEvent: gaps.maxGapFromEvent,
      maxGapToEvent: gaps.maxGapToEvent,
      auditStartCount: capture.records.filter((item) => item.event === "audit:start").length,
      auditCompleteCount: capture.records.filter((item) => item.event === "audit:complete").length,
      reviseStartCount: capture.records.filter((item) => item.event === "revise:start").length,
      reviseCompleteCount: capture.records.filter((item) => item.event === "revise:complete").length,
      sampleEvents: capture.records.slice(0, 30).map((item) => ({ ts: item.ts, event: item.event })),
    },
  };
}

async function runMain() {
  const baselinePath = readArg("--baseline", "");
  const afterPath = readArg("--after", "");
  const strict = readBoolArg("--strict", false);

  if (baselinePath && afterPath) {
    const baseline = JSON.parse(await readFile(resolve(baselinePath), "utf-8"));
    const after = JSON.parse(await readFile(resolve(afterPath), "utf-8"));
    printCompareSummary({ baselinePath, afterPath, baseline, after, strict });
    return;
  }

  const baseUrl = readArg("--base-url", "http://localhost:4317");
  const bookId = readArg("--book-id", "");
  const chapters = parseChapterList(readArg("--chapters", ""));
  const requestTimeoutMs = readIntArg("--request-timeout-ms", 0);
  const postWaitMs = readIntArg("--post-wait-ms", 1500);
  const outputPath = readArg("--output", "");

  if (!bookId) {
    console.error("Missing required arg: --book-id");
    process.exit(2);
  }
  if (chapters.length === 0) {
    console.error("Missing required arg: --chapters, e.g. 10,11,12-14");
    process.exit(2);
  }

  const cases = [];
  for (const chapter of chapters) {
    const result = await runCase({
      baseUrl,
      bookId,
      chapter,
      requestTimeoutMs,
      postWaitMs,
    });
    cases.push(result);
  }

  const summary = summarizeRun({ cases });
  const payload = {
    baseUrl,
    bookId,
    chapters,
    generatedAt: new Date().toISOString(),
    summary,
    cases,
  };

  const output = JSON.stringify(payload, null, 2);
  console.log(output);
  if (outputPath) {
    await writeFile(resolve(outputPath), output, "utf-8");
  }

  if (strict && summary.stagnationLikelyRate > 0) {
    process.exit(1);
  }
}

runMain().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
