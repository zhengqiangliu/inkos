#!/usr/bin/env node
/**
 * SSE gap monitor for Studio events.
 * Usage:
 *   node packages/studio/scripts/sse-gap-monitor.mjs \
 *     --base-url http://localhost:4317 \
 *     --duration-ms 120000 \
 *     --session-id agent-session-1 \
 *     --run-id run-xxx
 */

const args = process.argv.slice(2);

function readArg(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (typeof value !== "string" || value.startsWith("--")) return fallback;
  return value;
}

function parseIntArg(name, fallback) {
  const raw = readArg(name, "");
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const baseUrl = readArg("--base-url", "http://localhost:4317");
const durationMs = parseIntArg("--duration-ms", 120000);
const sessionIdFilter = readArg("--session-id", "");
const runIdFilter = readArg("--run-id", "");
const includePing = readArg("--include-ping", "false").toLowerCase() === "true";

const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/events`;
const controller = new AbortController();
const startedAt = Date.now();

let acceptedCount = 0;
let firstTs = 0;
let lastTs = 0;
let maxGapMs = 0;
let lastEventName = "";

function shouldAccept(eventName, data) {
  if (!includePing && eventName === "ping") return false;
  if (!data || typeof data !== "object") return false;
  if (sessionIdFilter && data.sessionId !== sessionIdFilter) return false;
  if (runIdFilter && data.runId !== runIdFilter) return false;
  return true;
}

function handleAccepted(eventName) {
  const now = Date.now();
  if (!firstTs) firstTs = now;
  if (lastTs) {
    const gap = now - lastTs;
    if (gap > maxGapMs) maxGapMs = gap;
  }
  lastTs = now;
  lastEventName = eventName;
  acceptedCount += 1;
}

setTimeout(() => controller.abort("duration reached"), durationMs);

try {
  const response = await fetch(endpoint, { signal: controller.signal });
  if (!response.ok || !response.body) {
    console.error(`Failed to connect SSE: ${response.status} ${response.statusText}`);
    process.exit(2);
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
      if (!eventName || !dataRaw) continue;

      let data;
      try {
        data = JSON.parse(dataRaw);
      } catch {
        continue;
      }

      if (!shouldAccept(eventName, data)) continue;
      handleAccepted(eventName);
    }
  }
} catch (error) {
  const aborted = error && typeof error === "object" && "name" in error && error.name === "AbortError";
  if (!aborted) {
    console.error(String(error));
    process.exit(2);
  }
}

const endedAt = Date.now();
const summary = {
  endpoint,
  sessionIdFilter: sessionIdFilter || null,
  runIdFilter: runIdFilter || null,
  startedAt,
  endedAt,
  elapsedMs: endedAt - startedAt,
  acceptedCount,
  firstEventAt: firstTs || null,
  lastEventAt: lastTs || null,
  maxGapMs,
  lastEventName: lastEventName || null,
};

console.log(JSON.stringify(summary, null, 2));
process.exit(0);

