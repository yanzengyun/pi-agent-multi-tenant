import { mkdirSync, writeFileSync, chmodSync, createWriteStream, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';

// Serialize incrementally: do not build a second complete copy of image-heavy history.
function* jsonChunks(value, secrets, stats, key = '') {
  if (/^(authorization|x-api-key|api_?key|access_?token|refresh_?token|password|secret)$/i.test(key)) {
    stats.redactions++; yield '"[REDACTED]"'; return;
  }
  if (typeof value === 'string') {
    for (const secret of secrets) if (value.includes(secret)) {
      value = value.split(secret).join('[REDACTED]'); stats.redactions++;
    }
    yield JSON.stringify(value); return;
  }
  if (Array.isArray(value)) {
    yield '[';
    for (let i = 0; i < value.length; i++) {
      if (i) yield ',';
      yield* jsonChunks(value[i] ?? null, secrets, stats);
    }
    yield ']'; return;
  }
  if (value && typeof value === 'object') {
    yield '{'; let first = true;
    for (const [name, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (!first) yield ',';
      first = false; yield JSON.stringify(name); yield ':';
      yield* jsonChunks(item, secrets, stats, name);
    }
    yield '}'; return;
  }
  yield JSON.stringify(value ?? null);
}

export class ContextCapture {
  constructor(directory, secrets = []) {
    this.directory = directory;
    this.secrets = secrets.filter(value => typeof value === 'string' && value.length >= 8);
    this.expires = 0; this.remaining = 0; this.entries = []; this.busy = false;
    this.maxBytes = 48 * 1024 * 1024;
  }
  status() {
    return { armed: this.remaining > 0 && this.expires > Date.now(), remaining: this.remaining,
      expiresAt: this.expires ? new Date(this.expires).toISOString() : null, captures: this.entries };
  }
  saveStatus(extra = {}) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
    writeFileSync(join(this.directory, 'status.json'), JSON.stringify({ ...this.status(), ...extra }, null, 2), { mode: 0o600 });
  }
  arm() {
    this.expires = Date.now() + 15 * 60 * 1000; this.remaining = 2; this.entries = [];
    this.saveStatus({ state: 'waiting_for_wechat' });
  }
  async capture(snapshot) {
    if (!this.status().armed || this.busy) return false;
    this.busy = true; this.remaining--;
    const index = this.entries.length + 1, name = `request-${index}.json.gz`;
    const target = join(this.directory, name), partial = target + '.part';
    const stats = { bytes: 0, redactions: 0 }, hash = createHash('sha256'), limit = this.maxBytes;
    const source = jsonChunks(snapshot, this.secrets, stats);
    function* bounded() {
      for (const chunk of source) {
        stats.bytes += Buffer.byteLength(chunk);
        if (stats.bytes > limit) throw new Error('capture_too_large');
        hash.update(chunk); yield chunk;
      }
    }
    try {
      await pipeline(Readable.from(bounded(), { highWaterMark: 1 }), createGzip({ level: 1 }),
        createWriteStream(partial, { mode: 0o600 }));
      renameSync(partial, target); chmodSync(target, 0o600);
      this.entries.push({ file: name, capturedAt: snapshot.capturedAt, bytes: stats.bytes,
        gzipBytes: statSync(target).size, sha256: hash.digest('hex'), redactions: stats.redactions });
      if (!this.remaining) this.expires = 0;
      this.saveStatus({ state: this.remaining ? 'waiting_for_wechat' : 'captured' });
      return true;
    } catch (error) {
      this.remaining = 0; this.expires = 0; rmSync(partial, { force: true });
      this.saveStatus({ state: error.message === 'capture_too_large' ? 'too_large' : 'capture_failed', maxBytes: limit });
      return false;
    } finally { this.busy = false; }
  }
}
