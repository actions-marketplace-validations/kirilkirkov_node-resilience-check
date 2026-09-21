import { accessSync, constants, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { loadConfig } from '../../config/load.js';
import type { ResolvedConfig } from '../../config/types.js';
import { createStyle, shouldUseColor, type Style } from '../../reporter/style.js';
import { planChecks } from '../../runner/plan.js';
import { renderConfigProblem } from '../errors.js';

type DoctorStatus = 'ok' | 'info' | 'warn' | 'fail';

interface DoctorItem {
  status: DoctorStatus;
  message: string;
  hint?: string;
}

export interface DoctorCommandOptions {
  config: string;
  color: boolean;
}

const MIN_NODE: [number, number] = [22, 12];
const SHELL_SYNTAX = /&&|\|\||[;|<>`$()]/;
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'npx', 'bun']);

export function checkNodeVersion(version: string): DoctorItem {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  const supported = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return supported
    ? { status: 'ok', message: `Node.js ${version}` }
    : {
        status: 'fail',
        message: `Node.js ${version} is not supported`,
        hint: `ResilienceCheck needs Node.js ${MIN_NODE.join('.')} or newer.`,
      };
}

function findExecutable(name: string, cwd: string): string | null {
  const candidates =
    name.includes('/') || name.includes('\\')
      ? [isAbsolute(name) ? name : resolve(cwd, name)]
      : (process.env.PATH ?? '').split(delimiter).flatMap((dir) => {
          const extensions =
            process.platform === 'win32'
              ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
              : [''];
          return extensions.map((ext) => join(dir, name + ext));
        });
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

function checkCommand(config: ResolvedConfig): DoctorItem[] {
  const { command, cwd } = config.service;
  if (!existsSync(cwd)) {
    return [{ status: 'fail', message: `service.cwd does not exist: ${cwd}` }];
  }
  if (SHELL_SYNTAX.test(command)) {
    return [
      { status: 'info', message: 'service.command uses shell syntax; executable lookup skipped' },
    ];
  }
  // Skip leading VAR=value assignments.
  const program =
    command.split(/\s+/).find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) ?? '';
  const found = findExecutable(program, cwd);
  const items: DoctorItem[] = [
    found
      ? { status: 'ok', message: `"${program}" found at ${found}` }
      : {
          status: 'fail',
          message: `"${program}" was not found`,
          hint: 'Check service.command and your PATH.',
        },
  ];
  if (PACKAGE_MANAGERS.has(program)) {
    items.push({
      status: 'info',
      message: `service.command starts through ${program}`,
      hint:
        'ResilienceCheck signals the Node.js process directly, so this works locally. In containers, ' +
        'package managers often do not forward SIGTERM; prefer "node <entry>" as the entrypoint.',
    });
  }
  return items;
}

function isListening(url: string): Promise<boolean> {
  const parsed = new URL(url);
  return new Promise((resolvePromise) => {
    const socket = connect({ host: parsed.hostname, port: Number(parsed.port || 80) });
    socket.setTimeout(1000);
    const done = (listening: boolean): void => {
      socket.destroy();
      resolvePromise(listening);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function checkNetwork(config: ResolvedConfig): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  items.push(
    (await isListening(config.service.baseUrl))
      ? {
          status: 'warn',
          message: `Something is already listening on ${config.service.baseUrl}`,
          hint: 'verify starts the service itself and will refuse to run while the port is taken.',
        }
      : { status: 'ok', message: `${config.service.baseUrl} is free` },
  );
  const retryStorm = config.checks.retryStorm;
  if (retryStorm) {
    items.push(
      (await isListening(retryStorm.dependency.target))
        ? { status: 'ok', message: `Downstream ${retryStorm.dependency.target} is reachable` }
        : {
            status: 'warn',
            message: `Downstream ${retryStorm.dependency.target} is not reachable`,
            hint: 'The fault proxy forwards to it outside the fault window; forwarded calls will get 502.',
          },
    );
  }
  return items;
}

function checkPlatform(): DoctorItem {
  return process.platform === 'win32'
    ? {
        status: 'warn',
        message: 'Windows: the graceful shutdown check is skipped',
        hint: 'POSIX signals are not available on Windows.',
      }
    : { status: 'ok', message: `${process.platform}: all checks supported` };
}

const SYMBOLS: Record<DoctorStatus, string> = { ok: '✓', info: 'i', warn: '!', fail: '✗' };

function renderItem(style: Style, item: DoctorItem): string {
  const color =
    item.status === 'ok'
      ? style.green
      : item.status === 'fail'
        ? style.red
        : item.status === 'warn'
          ? style.yellow
          : style.cyan;
  const lines = [`${color(SYMBOLS[item.status])} ${item.message}`];
  if (item.hint) lines.push(style.dim(`    ${item.hint}`));
  return lines.join('\n');
}

export async function doctorCommand(options: DoctorCommandOptions): Promise<number> {
  const style = createStyle(shouldUseColor(process.stdout, process.env, options.color));
  const out: string[] = [style.bold('ResilienceCheck doctor'), ''];
  const items: DoctorItem[] = [checkNodeVersion(process.version), checkPlatform()];

  let config: ResolvedConfig;
  try {
    config = await loadConfig(options.config);
    const count = planChecks(config.checks, null).length;
    items.push({ status: 'ok', message: `Configuration is valid (${count} checks enabled)` });
  } catch (error) {
    const rendered = renderConfigProblem(style, error);
    if (rendered === null) throw error;
    out.push(...items.map((item) => renderItem(style, item)), rendered);
    process.stdout.write(`${out.join('\n')}\n`);
    return 1;
  }

  items.push(...checkCommand(config), ...(await checkNetwork(config)));
  out.push(...items.map((item) => renderItem(style, item)), '');
  process.stdout.write(`${out.join('\n')}\n`);
  return items.some((item) => item.status === 'fail') ? 1 : 0;
}
