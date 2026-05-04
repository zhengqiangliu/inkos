#!/usr/bin/env node
/**
 * End-to-end acceptance checker for write command matrix.
 *
 * Example:
 * node packages/studio/scripts/write-e2e-acceptance.mjs \
 *   --base-url http://localhost:4317 \
 *   --book-id demo-book \
 *   --session-id agent-session-write-accept-1 \
 *   --strict true
 */

import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
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

function parseCommandList(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return ["write-next", "write-target", "write-shorthand", "write-batch"];
  }
  const accepted = new Set(["write-next", "write-target", "write-shorthand", "write-batch"]);
  const list = normalized.split(",").map((item) => item.trim()).filter(Boolean);
  const unique = [];
  for (const item of list) {
    if (!accepted.has(item) || unique.includes(item)) continue;
    unique.push(item);
  }
  return unique.length > 0 ? unique : ["write-next", "write-target", "write-shorthand", "write-batch"];
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

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveProjectRoot(input) {
  if (input) return resolve(input);
  const cwd = resolve(process.cwd());
  const candidates = [cwd, resolve(cwd, ".."), resolve(cwd, "..", "..")];
  for (const candidate of candidates) {
    if (
      await pathExists(join(candidate, "inkos.json"))
      || await pathExists(join(candidate, "books"))
    ) {
      return candidate;
    }
  }
  return cwd;
}

function createRunId(tag = "write-matrix") {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${tag}-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isServerAcceptedSessionId(input) {
  return /^[0-9]+-[a-z0-9]+$/.test(input);
}

async function ensureSession(baseUrl, requestedSessionId, bookId) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const normalizedRequested = typeof requestedSessionId === "string" ? requestedSessionId.trim() : "";

  if (normalizedRequested) {
    try {
      const check = await requestJson(`${normalizedBaseUrl}/api/v1/sessions/${encodeURIComponent(normalizedRequested)}`);
      if (check.status >= 200 && check.status < 300) return { sessionId: normalizedRequested, created: false };
    } catch {
      // fall through to create
    }
  }

  const candidateSessionId = isServerAcceptedSessionId(normalizedRequested)
    ? normalizedRequested
    : createSessionId();
  const payload = {
    bookId,
    sessionId: candidateSessionId,
  };
  const createResponse = await requestJson(`${normalizedBaseUrl}/api/v1/sessions`, {
    method: "POST",
    body: payload,
  });
  if (createResponse.status < 200 || createResponse.status >= 300) {
    throw new Error(`Failed to create session: ${createResponse.status}`);
  }
  const created = createResponse.json;
  const resolvedSessionId = created?.session?.sessionId;
  if (typeof resolvedSessionId !== "string" || resolvedSessionId.trim().length === 0) {
    throw new Error("Session create response missing sessionId");
  }
  return {
    sessionId: resolvedSessionId.trim(),
    created: true,
  };
}

async function fetchBookDetail(baseUrl, bookId) {
  const response = await requestJson(`${baseUrl.replace(/\/$/, "")}/api/v1/books/${encodeURIComponent(bookId)}`);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to fetch book detail: ${response.status}`);
  }
  const json = response.json;
  const nextChapter = Number(json?.nextChapter ?? 0);
  if (!Number.isFinite(nextChapter) || nextChapter <= 0) {
    throw new Error("Book detail missing nextChapter");
  }
  return {
    nextChapter,
    chapters: Array.isArray(json?.chapters) ? json.chapters : [],
  };
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
          if (payload.sessionId !== input.sessionId || payload.runId !== input.runId) continue;
          records.push({
            ts: Date.now(),
            event: eventName,
            data: payload,
          });
        }
      }
    } catch (error) {
      const aborted = error && typeof error === "object" && "name" in error && error.name === "AbortError";
      if (!aborted) {
        records.push({
          ts: Date.now(),
          event: "capture:error",
          data: { message: String(error) },
        });
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

async function validateBookArtifacts(input) {
  const bookDir = join(input.projectRoot, "books", input.bookId);
  const chaptersDir = join(bookDir, "chapters");
  const indexPath = join(chaptersDir, "index.json");
  let indexEntries = [];
  try {
    const raw = await readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) indexEntries = parsed;
  } catch {
    indexEntries = [];
  }

  let allChapterFiles = [];
  try {
    allChapterFiles = (await readdir(chaptersDir)).filter((name) => name.endsWith(".md"));
  } catch {
    allChapterFiles = [];
  }

  const perChapter = [];
  for (const chapter of input.expectedChapters) {
    const padded = String(chapter).padStart(4, "0");
    const chapterFiles = allChapterFiles.filter((name) => name.startsWith(`${padded}_`));
    const snapshotsDir = join(bookDir, "story", "snapshots", String(chapter));
    const snapshotExists = await pathExists(snapshotsDir);
    const snapshotCurrentStateExists = await pathExists(join(snapshotsDir, "current_state.md"));
    const snapshotPendingHooksExists = await pathExists(join(snapshotsDir, "pending_hooks.md"));
    const indexEntry = indexEntries.find((item) => Number(item?.number) === chapter) ?? null;

    perChapter.push({
      chapter,
      indexEntry,
      chapterFiles,
      snapshotDir: snapshotsDir,
      snapshotExists,
      snapshotCurrentStateExists,
      snapshotPendingHooksExists,
      pass:
        Boolean(indexEntry)
        && chapterFiles.length > 0
        && snapshotExists
        && snapshotCurrentStateExists
        && snapshotPendingHooksExists,
    });
  }

  return {
    indexPath,
    perChapter,
    pass: perChapter.every((item) => item.pass),
  };
}

async function waitForArtifactConsistency(input) {
  const startedAt = Date.now();
  let last = await validateBookArtifacts(input);
  while (!last.pass && Date.now() - startedAt < input.waitMs) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, input.intervalMs));
    last = await validateBookArtifacts(input);
  }
  return last;
}

function buildExpectedChapters(command, nextChapter, counts) {
  if (command === "write-next") {
    return {
      instruction: "写下一章",
      expectedChapters: [nextChapter],
      kind: command,
    };
  }
  if (command === "write-target") {
    return {
      instruction: `写第${nextChapter}章`,
      expectedChapters: [nextChapter],
      kind: command,
    };
  }
  if (command === "write-shorthand") {
    const count = Math.max(2, Math.min(9, counts.shorthandCount));
    return {
      instruction: `写${count}章`,
      expectedChapters: Array.from({ length: count }, (_, index) => nextChapter + index),
      kind: command,
    };
  }
  const count = Math.max(2, Math.min(20, counts.batchCount));
  return {
    instruction: `连写${count}章`,
    expectedChapters: Array.from({ length: count }, (_, index) => nextChapter + index),
    kind: command,
  };
}

async function runSingleCase(input) {
  const runId = createRunId(input.caseName);
  const capture = await startFilteredSseCapture({
    baseUrl: input.baseUrl,
    sessionId: input.sessionId,
    runId,
  });
  const startedAt = Date.now();

  let responseStatus = 0;
  let responseJson = null;
  let responseError = null;
  try {
    const response = await requestJson(`${input.baseUrl.replace(/\/$/, "")}/api/v1/agent`, {
      method: "POST",
      body: {
        instruction: input.instruction,
        activeBookId: input.bookId,
        sessionId: input.sessionId,
        runId,
      },
      timeoutMs: input.requestTimeoutMs,
    });
    responseStatus = response.status;
    responseJson = response.json;
  } catch (error) {
    responseError = String(error);
  }

  const remaining = Math.max(0, Math.min(input.postWaitMs, input.durationMs - (Date.now() - startedAt)));
  if (remaining > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, remaining));
  }
  await capture.stop();

  const endedAt = Date.now();
  const gaps = summarizeEventGaps(capture.records);

  const artifactCheck = await waitForArtifactConsistency({
    projectRoot: input.projectRoot,
    bookId: input.bookId,
    expectedChapters: input.expectedChapters,
    waitMs: input.artifactWaitMs,
    intervalMs: input.artifactPollMs,
  });

  const responseAddedChapters = Array.isArray(responseJson?.details?.effects?.writeNext?.addedChapterNumbers)
    ? responseJson.details.effects.writeNext.addedChapterNumbers
      .map((chapterNumber) => Number(chapterNumber))
      .filter((chapterNumber) => Number.isFinite(chapterNumber))
    : [];
  const responsePersisted = Boolean(responseJson?.details?.effects?.writeNext?.persisted);
  const responseErrorCode = typeof responseJson?.error?.code === "string" ? responseJson.error.code : null;
  const responseErrorMessage = typeof responseJson?.error?.message === "string" ? responseJson.error.message : null;
  const responseText = typeof responseJson?.response === "string" ? responseJson.response : null;
  const responseMissingFiles = responseJson?.details?.writeIntegrity?.missingChapterFiles;
  const responseMissingFilesOk = Array.isArray(responseMissingFiles) ? responseMissingFiles.length === 0 : true;
  const expectedAddedMatches = input.expectedChapters.length > 0
    && input.expectedChapters.every((chapterNumber) => responseAddedChapters.includes(chapterNumber))
    && responseAddedChapters.length === input.expectedChapters.length;
  const responsePass = responseStatus === 200 && responsePersisted && responseMissingFilesOk && expectedAddedMatches;
  const gapPass = gaps.count > 0 && gaps.maxGapMs <= input.heartbeatLimitMs;
  const pass = responsePass && artifactCheck.pass && gapPass;

  return {
    caseName: input.caseName,
    runId,
    instruction: input.instruction,
    expectedChapters: input.expectedChapters,
    startedAt,
    endedAt,
    elapsedMs: endedAt - startedAt,
    response: {
      status: responseStatus,
      error: responseError,
      errorCode: responseErrorCode,
      errorMessage: responseErrorMessage,
      persisted: responsePersisted,
      addedChapterNumbers: responseAddedChapters,
      addedChapterNumbersMatchExpected: expectedAddedMatches,
      missingChapterFiles: Array.isArray(responseMissingFiles) ? responseMissingFiles : null,
      pass: responsePass,
      bodyPreview: responseText ? responseText.slice(0, 200) : null,
    },
    artifacts: artifactCheck,
    sse: {
      endpoint: capture.endpoint,
      eventCount: gaps.count,
      maxGapMs: gaps.maxGapMs,
      maxGapFromEvent: gaps.maxGapFromEvent,
      maxGapToEvent: gaps.maxGapToEvent,
      limitMs: input.heartbeatLimitMs,
      pass: gapPass,
      sampleEvents: capture.records.slice(0, 20).map((item) => ({
        ts: item.ts,
        event: item.event,
      })),
    },
    pass,
  };
}

async function main() {
  const baseUrl = readArg("--base-url", "http://localhost:4317");
  const bookId = readArg("--book-id", "");
  const requestedSessionId = readArg("--session-id", "");
  const durationMs = readIntArg("--duration-ms", 120000);
  const postWaitMs = readIntArg("--post-wait-ms", 2500);
  const heartbeatLimitMs = readIntArg("--heartbeat-limit-ms", 15000);
  const artifactWaitMs = readIntArg("--artifact-wait-ms", 15000);
  const artifactPollMs = readIntArg("--artifact-poll-ms", 500);
  const requestTimeoutMs = readIntArg("--request-timeout-ms", 0);
  const shorthandCount = readIntArg("--shorthand-count", 2);
  const batchCount = readIntArg("--batch-count", 2);
  const commands = parseCommandList(readArg("--commands", ""));
  const projectRootArg = readArg("--project-root", process.env.INKOS_PROJECT_ROOT ?? "");
  const strict = readBoolArg("--strict", false);
  const outputPath = readArg("--output", "");

  if (!bookId) {
    console.error("Missing required arg: --book-id");
    process.exit(2);
  }
  if (commands.length === 0) {
    console.error("No command cases selected.");
    process.exit(2);
  }

  const projectRoot = await resolveProjectRoot(projectRootArg);
  let sessionId = requestedSessionId;
  let sessionCreated = false;
  try {
    const ensuredSession = await ensureSession(baseUrl, requestedSessionId, bookId);
    sessionId = ensuredSession.sessionId;
    sessionCreated = ensuredSession.created;
  } catch (error) {
    console.error(`Failed to ensure session: ${String(error)}`);
    process.exit(2);
  }

  const results = [];
  for (const command of commands) {
    const detail = await fetchBookDetail(baseUrl, bookId);
    const plan = buildExpectedChapters(command, detail.nextChapter, { shorthandCount, batchCount });
    const single = await runSingleCase({
      caseName: command,
      baseUrl,
      bookId,
      sessionId,
      projectRoot,
      instruction: plan.instruction,
      expectedChapters: plan.expectedChapters,
      durationMs,
      postWaitMs,
      heartbeatLimitMs,
      artifactWaitMs,
      artifactPollMs,
      requestTimeoutMs,
    });
    results.push(single);
  }

  const overallPass = results.length > 0 && results.every((item) => item.pass);
  const summary = {
    baseUrl,
    bookId,
    projectRoot,
    sessionId,
    requestedSessionId: requestedSessionId || null,
    sessionCreated,
    commands,
    commandCount: results.length,
    cases: results,
    overallPass,
  };

  const summaryJson = JSON.stringify(summary, null, 2);
  console.log(summaryJson);
  if (outputPath) {
    await writeFile(resolve(outputPath), summaryJson, "utf-8");
  }
  if (strict && !overallPass) {
    process.exit(1);
  }
}

await main();
