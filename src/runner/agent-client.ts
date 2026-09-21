import { requestJson } from '../http/json.js';
import type {
  AgentFeature,
  AgentRegistration,
  AgentStatus,
  BackpressureReport,
  EventLoopSnapshot,
} from '../shared/protocol.js';

/** Typed calls to the control server of the agent inside the service. */
export class AgentClient {
  constructor(
    readonly registration: AgentRegistration,
    private readonly token: string,
  ) {}

  get pid(): number {
    return this.registration.pid;
  }

  hasFeature(feature: AgentFeature): boolean {
    return this.registration.features.includes(feature);
  }

  status(): Promise<AgentStatus> {
    return this.call('GET', '/v1/status');
  }

  async startEventLoop(resolutionMs: number): Promise<void> {
    await this.call('POST', '/v1/event-loop/start', { resolutionMs });
  }

  stopEventLoop(): Promise<EventLoopSnapshot> {
    // Generous timeout: if the loop is still blocked the reply waits for it.
    return this.call('POST', '/v1/event-loop/stop', undefined, 60_000);
  }

  backpressure(): Promise<BackpressureReport> {
    return this.call('GET', '/v1/backpressure');
  }

  async resetBackpressure(): Promise<void> {
    await this.call('POST', '/v1/backpressure/reset');
  }

  private call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ): Promise<T> {
    return requestJson<T>(this.registration.controlUrl + path, {
      method,
      body,
      token: this.token,
      timeoutMs,
    });
  }
}
