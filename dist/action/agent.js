import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/agent/index.ts
import { subscribe } from "node:diagnostics_channel";
import {
  request as httpRequest
} from "node:http";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/shared/protocol.ts
var ENV_REPORTER = "RESILIENCE_CHECK_REPORTER";
var ENV_TOKEN = "RESILIENCE_CHECK_TOKEN";
var ENV_FEATURES = "RESILIENCE_CHECK_FEATURES";
var PROBE_HEADER = "x-resilience-check-probe";

// src/agent/backpressure.ts
import { OutgoingMessage } from "node:http";
import { Duplex, Writable } from "node:stream";

// src/shared/stack.ts
import { fileURLToPath } from "node:url";
var FRAME_PATTERN = /^\s*at (?:async )?(?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/;
function parseStack(stack) {
  const frames = [];
  for (const raw of stack.split("\n")) {
    const match = FRAME_PATTERN.exec(raw);
    if (!match) continue;
    const [, fn, location = "", line = "0", column = "0"] = match;
    frames.push({
      fn: fn ?? null,
      file: normalizeFile(location),
      line: Number(line),
      column: Number(column)
    });
  }
  return frames;
}
function normalizeFile(location) {
  if (location.startsWith("file://")) {
    try {
      return fileURLToPath(location);
    } catch {
      return location;
    }
  }
  return location;
}
function looksLikeRealFile(file) {
  return file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith("\\\\");
}
function classifyFrame(frame, selfDir) {
  const { file } = frame;
  if (file.startsWith("node:") || !looksLikeRealFile(file)) return "internal";
  if (selfDir !== null && file.startsWith(selfDir)) return "self";
  if (/[\\/]node_modules[\\/]/.test(file)) return "dependency";
  return "application";
}

// src/agent/backpressure.ts
var emptyCounters = () => ({
  backpressureSignals: 0,
  ignoredWrites: 0,
  ignoredInternalWrites: 0,
  episodes: 0,
  overflowWrites: 0
});
function createBackpressureTracker(options = {}) {
  const selfDir = options.selfDir ?? null;
  const maxSites = options.maxSites ?? 20;
  const stackDepth = options.stackDepth ?? 30;
  const streams = /* @__PURE__ */ new WeakMap();
  let sites = /* @__PURE__ */ new Map();
  let counters = emptyCounters();
  let generation = 0;
  function captureFrames(boundary) {
    const holder = {};
    const previousLimit = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = stackDepth;
      Error.captureStackTrace(holder, boundary);
      return parseStack(holder.stack ?? "");
    } catch {
      return [];
    } finally {
      Error.stackTraceLimit = previousLimit;
    }
  }
  function siteFor(frames, stream) {
    const visible = frames.filter((frame) => {
      const origin = classifyFrame(frame, selfDir);
      return origin === "application" || origin === "dependency";
    });
    const appFrame = visible.find((frame) => classifyFrame(frame, selfDir) === "application");
    const location = appFrame ?? visible[0] ?? null;
    const streamType = stream.constructor?.name || "Writable";
    const key = location ? `${streamType}|${location.file}:${location.line}:${location.column}` : `${streamType}|unknown`;
    const existing = sites.get(key);
    if (existing) return existing;
    if (sites.size >= maxSites) return null;
    const site = {
      key,
      attribution: appFrame ? "application" : "dependency",
      location,
      frames: visible.slice(0, 8),
      streamType,
      ignoredWrites: 0,
      episodes: 0
    };
    sites.set(key, site);
    return site;
  }
  function startEpisode(stream, boundary) {
    const frames = captureFrames(boundary);
    const caller = frames[0];
    const callerOrigin = caller ? classifyFrame(caller, selfDir) : "internal";
    if (callerOrigin === "internal" || callerOrigin === "self") {
      return { generation, kind: "internal", site: null };
    }
    counters.episodes++;
    const site = siteFor(frames, stream);
    if (site) site.episodes++;
    return { generation, kind: "attributed", site };
  }
  function recordIgnoredWrite(stream, state, boundary) {
    if (!state.episode || state.episode.generation !== generation) {
      state.episode = startEpisode(stream, boundary);
    }
    const { episode } = state;
    if (episode.kind === "internal") {
      counters.ignoredInternalWrites++;
      return;
    }
    counters.ignoredWrites++;
    if (episode.site) episode.site.ignoredWrites++;
    else counters.overflowWrites++;
  }
  function wrap(original) {
    const patched = function(...args) {
      const stream = typeof this === "object" && this !== null ? this : null;
      const state = stream ? streams.get(stream) : void 0;
      if (stream && state?.waiting) {
        if (stream.writableNeedDrain === true) {
          recordIgnoredWrite(stream, state, patched);
        } else {
          state.waiting = false;
          state.episode = null;
        }
      }
      const result = Reflect.apply(original, this, args);
      if (result === false && stream) {
        counters.backpressureSignals++;
        if (state) {
          if (!state.waiting) {
            state.waiting = true;
            state.episode = null;
          }
        } else {
          streams.set(stream, { waiting: true, episode: null });
        }
      }
      return result;
    };
    Object.defineProperty(patched, "name", { value: original.name });
    return patched;
  }
  function report() {
    const list = [...sites.values()].filter((site) => site.ignoredWrites > 0).sort((a, b) => b.ignoredWrites - a.ignoredWrites).map(({ key: _key, ...site }) => ({ ...site, frames: [...site.frames] }));
    return { installed: true, ...counters, sites: list };
  }
  function reset() {
    sites = /* @__PURE__ */ new Map();
    counters = emptyCounters();
    generation++;
  }
  return { wrap, report, reset };
}
function installBackpressureTracking(tracker) {
  const prototypes = [
    Writable.prototype,
    Duplex.prototype,
    OutgoingMessage.prototype
  ];
  const restores = [];
  for (const proto of prototypes) {
    const original = proto.write;
    if (typeof original !== "function") continue;
    const patched = tracker.wrap(original);
    proto.write = patched;
    restores.push(() => {
      if (proto.write === patched) proto.write = original;
    });
  }
  return () => {
    for (const restore of restores) restore();
  };
}

// src/agent/control-server.ts
import { createServer } from "node:http";
var MAX_BODY_BYTES = 16 * 1024;
function startControlServer(token2, handlers) {
  const server = createServer((req, res) => {
    void handle(req, res, token2, handlers);
  });
  server.on("connection", (socket) => socket.unref());
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve(server);
    });
  });
}
async function handle(req, res, token2, handlers) {
  try {
    if (req.headers.authorization !== `Bearer ${token2}`) {
      return send(res, 401, { error: "unauthorized" });
    }
    const body = await readJson(req);
    const route = `${req.method ?? "GET"} ${req.url ?? "/"}`;
    switch (route) {
      case "GET /v1/status":
        return send(res, 200, handlers.status());
      case "POST /v1/event-loop/start": {
        const resolution = Number(body?.resolutionMs ?? 10);
        handlers.startEventLoop(Number.isFinite(resolution) && resolution >= 1 ? resolution : 10);
        return send(res, 200, { ok: true });
      }
      case "POST /v1/event-loop/stop":
        return send(res, 200, handlers.stopEventLoop());
      case "GET /v1/backpressure":
        return send(res, 200, handlers.backpressure());
      case "POST /v1/backpressure/reset":
        handlers.resetBackpressure();
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { error: "not found" });
    }
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    connection: "close"
  });
  res.end(body);
}

// src/agent/event-loop.ts
import {
  monitorEventLoopDelay,
  performance
} from "node:perf_hooks";
function createEventLoopProbe() {
  let histogram = null;
  let utilizationStart = null;
  let startedAt = 0;
  return {
    start(resolutionMs) {
      histogram?.disable();
      histogram = monitorEventLoopDelay({ resolution: resolutionMs });
      histogram.enable();
      utilizationStart = performance.eventLoopUtilization();
      startedAt = performance.now();
    },
    stop() {
      if (!histogram || !utilizationStart) {
        throw new Error("Event loop measurement was not started.");
      }
      histogram.disable();
      const snapshot = snapshotHistogram(
        histogram,
        performance.eventLoopUtilization(utilizationStart).utilization,
        performance.now() - startedAt
      );
      histogram = null;
      utilizationStart = null;
      return snapshot;
    }
  };
}
function snapshotHistogram(histogram, utilization, windowMs) {
  const samples = histogram.count;
  if (samples === 0) {
    return {
      samples,
      minNs: 0,
      maxNs: 0,
      meanNs: 0,
      stddevNs: 0,
      p50Ns: 0,
      p95Ns: 0,
      p99Ns: 0,
      utilization,
      windowMs
    };
  }
  return {
    samples,
    minNs: histogram.min,
    maxNs: histogram.max,
    meanNs: finiteOrZero(histogram.mean),
    stddevNs: finiteOrZero(histogram.stddev),
    p50Ns: histogram.percentile(50),
    p95Ns: histogram.percentile(95),
    p99Ns: histogram.percentile(99),
    utilization,
    windowMs
  };
}
function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

// src/agent/index.ts
var EMPTY_BACKPRESSURE = {
  installed: false,
  backpressureSignals: 0,
  ignoredWrites: 0,
  ignoredInternalWrites: 0,
  episodes: 0,
  sites: [],
  overflowWrites: 0
};
function parseFeatures(raw) {
  return (raw ?? "").split(",").map((feature) => feature.trim()).filter((feature) => feature === "backpressure");
}
function register(reporterUrl2, registration) {
  const body = JSON.stringify(registration);
  const req = httpRequest(
    new URL("/v1/agents", reporterUrl2),
    {
      method: "POST",
      agent: false,
      timeout: 5e3,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
    },
    (res) => res.resume()
  );
  req.on("socket", (socket) => socket.unref());
  req.on("timeout", () => req.destroy());
  req.on("error", () => {
  });
  req.end(body);
}
function startAgent(reporterUrl2, token2) {
  const features = parseFeatures(process.env[ENV_FEATURES]);
  const selfDir = fileURLToPath2(new URL("..", import.meta.url));
  const tracker = features.includes("backpressure") ? createBackpressureTracker({ selfDir }) : null;
  if (tracker) installBackpressureTracking(tracker);
  const eventLoop = createEventLoopProbe();
  let controlServer = null;
  let active = false;
  let activeRequests = 0;
  const onResponseClose = () => {
    activeRequests--;
  };
  const activate = async () => {
    const server = await startControlServer(token2, {
      status: () => ({
        pid: process.pid,
        activeRequests,
        signalListeners: {
          SIGTERM: process.listenerCount("SIGTERM"),
          SIGINT: process.listenerCount("SIGINT")
        }
      }),
      startEventLoop: (resolutionMs) => eventLoop.start(resolutionMs),
      stopEventLoop: () => eventLoop.stop(),
      backpressure: () => tracker?.report() ?? EMPTY_BACKPRESSURE,
      resetBackpressure: () => tracker?.reset()
    });
    controlServer = server;
    const address = server.address();
    if (address === null || typeof address === "string") return;
    register(reporterUrl2, {
      token: token2,
      pid: process.pid,
      ppid: process.ppid,
      controlUrl: `http://127.0.0.1:${address.port}`,
      nodeVersion: process.version,
      features: tracker ? ["backpressure"] : []
    });
  };
  subscribe("http.server.request.start", (message) => {
    try {
      const { request, response, server } = message;
      if (server === controlServer) return;
      if (!active) {
        if (request.headers[PROBE_HEADER] !== token2) return;
        active = true;
        activate().catch(() => {
        });
      }
      activeRequests++;
      response.once("close", onResponseClose);
    } catch {
    }
  });
}
var reporterUrl = process.env[ENV_REPORTER];
var token = process.env[ENV_TOKEN];
if (reporterUrl && token) {
  try {
    startAgent(reporterUrl, token);
  } catch {
  }
}
