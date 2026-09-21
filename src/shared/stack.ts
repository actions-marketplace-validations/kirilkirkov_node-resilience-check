import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StackFrame {
  fn: string | null;
  file: string;
  line: number;
  column: number;
}

/**
 * Where a frame's code comes from. Only `application` and `dependency` frames
 * are meaningful to show to a user; `internal` covers Node.js core and
 * anything without a real file, `self` is ResilienceCheck's own code.
 */
export type FrameOrigin = 'internal' | 'self' | 'dependency' | 'application';

// Matches V8 frames such as:
//   at fn (/abs/file.js:10:5)
//   at async fn (file:///abs/file.js:10:5)
//   at /abs/file.js:10:5
const FRAME_PATTERN = /^\s*at (?:async )?(?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/;

export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of stack.split('\n')) {
    const match = FRAME_PATTERN.exec(raw);
    if (!match) continue;
    const [, fn, location = '', line = '0', column = '0'] = match;
    frames.push({
      fn: fn ?? null,
      file: normalizeFile(location),
      line: Number(line),
      column: Number(column),
    });
  }
  return frames;
}

function normalizeFile(location: string): string {
  if (location.startsWith('file://')) {
    try {
      return fileURLToPath(location);
    } catch {
      return location;
    }
  }
  return location;
}

function looksLikeRealFile(file: string): boolean {
  return file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith('\\\\');
}

export function classifyFrame(frame: StackFrame, selfDir: string | null): FrameOrigin {
  const { file } = frame;
  if (file.startsWith('node:') || !looksLikeRealFile(file)) return 'internal';
  if (selfDir !== null && file.startsWith(selfDir)) return 'self';
  if (/[\\/]node_modules[\\/]/.test(file)) return 'dependency';
  return 'application';
}

/** Renders `file:line`, relative to `rootDir` when the file lives inside it. */
export function formatFrameLocation(frame: StackFrame, rootDir: string): string {
  let file = frame.file;
  if (isAbsolute(file)) {
    const rel = relative(rootDir, file);
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
      file = rel.split(sep).join('/');
    }
  }
  return `${file}:${frame.line}`;
}
