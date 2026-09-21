import type { BackpressureConfig } from '../config/types.js';
import { slowRead, type SlowReadOutcome } from '../http/slow-client.js';
import { formatCount, plural } from '../shared/format.js';
import type { BackpressureReport, BackpressureSite } from '../shared/protocol.js';
import { formatFrameLocation } from '../shared/stack.js';
import { agentMissing, describeRequest } from './common.js';
import { verdict, type CheckDefinition, type Verdict } from './types.js';

export interface BackpressureSiteMetrics {
  location: string | null;
  attribution: BackpressureSite['attribution'];
  streamType: string;
  ignoredWrites: number;
  episodes: number;
  stack: string[];
}

export interface BackpressureMetrics {
  request: string;
  requests: number;
  holdMs: number;
  maxIgnoredWrites: number;
  backpressureSignals: number;
  ignoredWrites: number;
  ignoredInternalWrites: number;
  episodes: number;
  sites: BackpressureSiteMetrics[];
  clients: Array<{ outcome: string; status: number | null; bytes: number }>;
}

export function toBackpressureMetrics(
  report: BackpressureReport,
  clients: SlowReadOutcome[],
  config: BackpressureConfig,
  rootDir: string,
): BackpressureMetrics {
  return {
    request: describeRequest(config.request),
    requests: config.requests,
    holdMs: config.holdMs,
    maxIgnoredWrites: config.maxIgnoredWrites,
    backpressureSignals: report.backpressureSignals,
    ignoredWrites: report.ignoredWrites,
    ignoredInternalWrites: report.ignoredInternalWrites,
    episodes: report.episodes,
    sites: report.sites.map((site) => ({
      location: site.location ? formatFrameLocation(site.location, rootDir) : null,
      attribution: site.attribution,
      streamType: site.streamType,
      ignoredWrites: site.ignoredWrites,
      episodes: site.episodes,
      stack: site.frames.map((frame) => {
        const where = formatFrameLocation(frame, rootDir);
        return frame.fn ? `${frame.fn} (${where})` : where;
      }),
    })),
    clients: clients.map((client) => ({
      outcome: client.kind === 'completed' ? 'completed' : client.error,
      status: client.kind === 'completed' ? client.status : null,
      bytes: client.bytes,
    })),
  };
}

function describeSite(site: BackpressureSiteMetrics): string[] {
  const lines =
    site.attribution === 'application'
      ? [`Writable stream (${site.streamType}) ignored backpressure.`]
      : [
          `Possible backpressure violation inside a dependency (${site.streamType}).`,
          'No application frame was found on the stack, so the producer may be library code.',
        ];
  lines.push(
    `write() returned false, then ${plural(site.ignoredWrites, 'more write')} happened before 'drain'.`,
  );
  if (site.location) lines.push(`Source: ${site.location}`);
  return lines;
}

export function evaluateBackpressure(metrics: BackpressureMetrics): Verdict<BackpressureMetrics> {
  const [top, ...others] = metrics.sites;

  if (metrics.ignoredWrites > metrics.maxIgnoredWrites) {
    const details = top ? describeSite(top) : [];
    for (const site of others.slice(0, 3)) {
      details.push(
        `Also: ${site.location ?? 'unknown location'} (${plural(site.ignoredWrites, 'write')})`,
      );
    }
    if (metrics.maxIgnoredWrites > 0)
      details.push(`Allowed: ${formatCount(metrics.maxIgnoredWrites)}.`);
    return verdict(
      'fail',
      `${plural(metrics.ignoredWrites, 'write')} after write() returned false`,
      details,
      metrics,
    );
  }

  const clientErrors = metrics.clients.filter((client) => client.outcome !== 'completed');
  if (metrics.backpressureSignals === 0 && clientErrors.length === metrics.clients.length) {
    return verdict(
      'error',
      'the slow client could not complete a request',
      [`Outcomes: ${clientErrors.map((client) => client.outcome).join(', ')}.`],
      metrics,
    );
  }

  if (metrics.backpressureSignals === 0) {
    return verdict(
      'warn',
      'backpressure was never triggered',
      [
        `write() never returned false while serving ${metrics.request}, so the check could not observe how the producer reacts.`,
        'Use an endpoint that streams more data than the socket buffers hold, or increase holdMs.',
      ],
      metrics,
    );
  }

  const summary =
    metrics.ignoredWrites === 0
      ? `write() returned false ${plural(metrics.backpressureSignals, 'time')}; every producer waited for 'drain'`
      : `${plural(metrics.ignoredWrites, 'ignored write')} (allowed ${formatCount(metrics.maxIgnoredWrites)})`;
  return verdict('pass', summary, [], metrics);
}

export function backpressureCheck(config: BackpressureConfig): CheckDefinition {
  return {
    id: 'backpressure',
    name: 'Backpressure',
    async run(context) {
      const { agent } = context.service;
      if (!agent) return agentMissing();
      if (!agent.hasFeature('backpressure')) {
        return verdict('error', 'stream instrumentation is not active in the service process');
      }

      await agent.resetBackpressure();
      const clients = await Promise.all(
        Array.from({ length: config.requests }, () =>
          slowRead(context.baseUrl, config.request, {
            holdMs: config.holdMs,
            timeoutMs: config.timeoutMs,
            signal: context.signal,
          }),
        ),
      );
      const report = await agent.backpressure();
      return evaluateBackpressure(toBackpressureMetrics(report, clients, config, context.rootDir));
    },
  };
}
