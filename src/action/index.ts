import * as core from '@actions/core';
import { runAction } from './run.js';

/**
 * GitHub Action entry point, bundled into dist/action/index.js. The agent
 * preload is bundled next to it because it runs inside the service process.
 */
process.exitCode = await runAction({
  io: core,
  workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
  agentUrl: new URL('./agent.js', import.meta.url).href,
});
