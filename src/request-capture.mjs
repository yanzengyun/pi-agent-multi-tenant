import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContextCapture } from './context-capture.mjs';

// Root/operator arms private files over SSH. No public endpoint and off by default.
export function requestCaptureExtensions(ctx, apiKey) {
  if (ctx.personaDraft) return [];
  const directory = join(ctx.directory, 'context-capture');
  let arm, state;
  try {
    arm = JSON.parse(readFileSync(join(directory, 'arming.json'), 'utf8'));
    state = JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'));
  } catch { return []; }
  if (arm.userId !== ctx.userId || arm.expiresAt <= Date.now() || !state.armed ||
      state.remaining <= 0 || state.captures.length >= 3) return [];
  const capture = new ContextCapture(directory, [apiKey, process.env.MINIMAX_CN_API_KEY, process.env.DEEPSEEK_API_KEY]);
  capture.expires = arm.expiresAt;
  capture.remaining = Math.min(state.remaining, 3 - state.captures.length);
  capture.entries = state.captures;
  let used = false;
  const handler = async event => {
    if (used) return;
    used = true;
    await capture.capture({ capturedAt: new Date().toISOString(),
      note: 'Final provider request, first call of this user turn; may contain private history, images and memory. No authentication headers.',
      payload: event.payload });
    // Undefined keeps the request unchanged, even if capture failed.
  };
  return [{ path: 'operator-request-capture', resolvedPath: 'operator-request-capture',
    sourceInfo: { source: 'runtime' }, handlers: new Map([['before_provider_request', [handler]]]),
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() }];
}
