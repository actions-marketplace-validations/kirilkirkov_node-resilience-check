import type { RequestSpec } from '../config/types.js';
import { verdict, type Verdict } from './types.js';

export function describeRequest(request: RequestSpec): string {
  return `${request.method} ${request.path}`;
}

export function agentMissing(): Verdict<never> {
  return verdict('error', 'agent not available in the service process', [
    'This check measures from inside the Node.js process, but the ResilienceCheck agent did not register.',
    'Make sure the service runs on Node.js and its start command does not overwrite NODE_OPTIONS.',
    'Run "resilience-check doctor" for more diagnostics.',
  ]);
}
