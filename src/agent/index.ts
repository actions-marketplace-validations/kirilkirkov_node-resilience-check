/**
 * Preload agent, loaded into the target service with
 * `NODE_OPTIONS=--import=<this file>`.
 *
 * NODE_OPTIONS is inherited by every Node.js process the service command
 * starts (npm, shells, build tools). The agent therefore stays inert until it
 * sees an HTTP request carrying the CLI's probe header; only the process that
 * actually serves HTTP opens a control channel and registers with the CLI.
 *
 * Nothing in here may throw into, or change the behaviour of, the host app.
 */
import { subscribe } from 'node:diagnostics_channel';
import {
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  ENV_FEATURES,
  ENV_REPORTER,
  ENV_TOKEN,
  PROBE_HEADER,
  type AgentFeature,
  type AgentRegistration,
  type BackpressureReport,
} from '../shared/protocol.js';
import { createBackpressureTracker, installBackpressureTracking } from './backpressure.js';
import { startControlServer } from './control-server.js';
import { createEventLoopProbe } from './event-loop.js';

interface RequestStartMessage {
  request: IncomingMessage;
  response: ServerResponse;
  server: Server;
}

const EMPTY_BACKPRESSURE: BackpressureReport = {
  installed: false,
  backpressureSignals: 0,
  ignoredWrites: 0,
  ignoredInternalWrites: 0,
  episodes: 0,
  sites: [],
  overflowWrites: 0,
};

function parseFeatures(raw: string | undefined): AgentFeature[] {
  return (raw ?? '')
    .split(',')
    .map((feature) => feature.trim())
    .filter((feature): feature is AgentFeature => feature === 'backpressure');
}

function register(reporterUrl: string, registration: AgentRegistration): void {
  const body = JSON.stringify(registration);
  const req = httpRequest(
    new URL('/v1/agents', reporterUrl),
    {
      method: 'POST',
      agent: false,
      timeout: 5000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    },
    (res) => res.resume(),
  );
  req.on('socket', (socket) => socket.unref());
  req.on('timeout', () => req.destroy());
  req.on('error', () => {
    // The CLI treats a missing registration as "agent not loaded".
  });
  req.end(body);
}

function startAgent(reporterUrl: string, token: string): void {
  const features = parseFeatures(process.env[ENV_FEATURES]);
  const selfDir = fileURLToPath(new URL('..', import.meta.url));

  const tracker = features.includes('backpressure') ? createBackpressureTracker({ selfDir }) : null;
  if (tracker) installBackpressureTracking(tracker);

  const eventLoop = createEventLoopProbe();
  let controlServer: Server | null = null;
  let active = false;
  let activeRequests = 0;
  const onResponseClose = (): void => {
    activeRequests--;
  };

  const activate = async (): Promise<void> => {
    const server = await startControlServer(token, {
      status: () => ({
        pid: process.pid,
        activeRequests,
        signalListeners: {
          SIGTERM: process.listenerCount('SIGTERM'),
          SIGINT: process.listenerCount('SIGINT'),
        },
      }),
      startEventLoop: (resolutionMs) => eventLoop.start(resolutionMs),
      stopEventLoop: () => eventLoop.stop(),
      backpressure: () => tracker?.report() ?? EMPTY_BACKPRESSURE,
      resetBackpressure: () => tracker?.reset(),
    });
    controlServer = server;
    const address = server.address();
    if (address === null || typeof address === 'string') return;
    register(reporterUrl, {
      token,
      pid: process.pid,
      ppid: process.ppid,
      controlUrl: `http://127.0.0.1:${address.port}`,
      nodeVersion: process.version,
      features: tracker ? ['backpressure'] : [],
    });
  };

  subscribe('http.server.request.start', (message) => {
    try {
      const { request, response, server } = message as RequestStartMessage;
      if (server === controlServer) return;
      if (!active) {
        if (request.headers[PROBE_HEADER] !== token) return;
        active = true;
        activate().catch(() => {
          // Leave the service untouched; the CLI reports the agent as missing.
        });
      }
      activeRequests++;
      response.once('close', onResponseClose);
    } catch {
      // Never let instrumentation break request handling.
    }
  });
}

const reporterUrl = process.env[ENV_REPORTER];
const token = process.env[ENV_TOKEN];
if (reporterUrl && token) {
  try {
    startAgent(reporterUrl, token);
  } catch {
    // Instrumentation failures must not prevent the service from starting.
  }
}
