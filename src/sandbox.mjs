import { request } from 'node:http';
import { randomUUID } from 'node:crypto';

// Only the backend assigns userId. Neither socket paths nor identities are model inputs.
export class Sandbox {
  constructor(socketPath) { this.socketPath = socketPath; }
  release(userId) { return this.call('/release', { userId }); }
  call(path, body, signal) {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, path, method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' } }, response => {
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 250000) req.destroy(new Error('sandbox_response_too_large'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks));
            if (response.statusCode !== 200) reject(new Error(data.error || 'sandbox_unavailable'));
            else resolve(data);
          } catch { reject(new Error('sandbox_invalid_response')); }
        });
      });
      req.setTimeout(35000, () => req.destroy(new Error('sandbox_unavailable')));
      req.on('error', reject); req.end(JSON.stringify(body));
    });
  }
  tools(userId) {
    return { execute: async (command, signal) => {
      if (typeof command !== 'string' || !command.trim() || command.length > 8000) throw new Error('invalid_sandbox_command');
      const requestId = randomUUID();
      const cancel = () => { void this.call('/cancel', { userId, requestId }).catch(() => {}); };
      signal?.throwIfAborted(); signal?.addEventListener('abort', cancel, { once: true });
      try { return await this.call('/execute', { userId, requestId, command }, signal); }
      finally { signal?.removeEventListener('abort', cancel); }
    } };
  }
}
