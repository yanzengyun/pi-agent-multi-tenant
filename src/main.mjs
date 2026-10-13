import { resolve } from 'node:path';
import { Store } from './store.mjs';
import { MockEngine } from './engine.mjs';
import { PiEngine } from './pi-engine.mjs';
import { makeServer } from './server.mjs';

process.umask(0o077);
const host = process.env.ASSISTANT_HOST || '127.0.0.1';
if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Development server must bind loopback; publish through an authenticated HTTPS gateway later');
const mode = process.env.ASSISTANT_ENGINE || 'mock';
if (!['mock', 'pi'].includes(mode)) throw new Error('Unknown engine');
const engine = mode === 'mock' ? new MockEngine() : new PiEngine({
  sdkModule: process.env.PI_SDK_MODULE || '@earendil-works/pi-coding-agent',
  modelsPath: resolve(process.env.ASSISTANT_MODELS_FILE || './models.json'),
  provider: process.env.ASSISTANT_PROVIDER || 'minimax-cn',
  model: process.env.ASSISTANT_MODEL || 'MiniMax-M3.1-Flash-Preview',
  thinkingLevel: 'medium', apiKey: process.env.MINIMAX_CN_API_KEY,
  searchKey: process.env.ASSISTANT_SEARCH === 'on' ? process.env.MINIMAX_CN_API_KEY : undefined,
});
if (mode === 'pi') {
  if (!process.env.MINIMAX_CN_API_KEY) throw new Error('Missing model credential');
  await engine.initialize();
}
const store = new Store(process.env.ASSISTANT_DATA_DIR || './.data');
const app = await makeServer({ store, engine, adminPassword: process.env.ASSISTANT_ADMIN_PASSWORD,
  secureCookies: process.env.ASSISTANT_SECURE_COOKIES === 'on', origin: process.env.ASSISTANT_ORIGIN });
app.server.listen(Number(process.env.ASSISTANT_PORT || 32214), host, () => {
  console.log(JSON.stringify({ status: 'listening', host, port: app.server.address().port, engine: mode }));
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await app.close(); process.exit(0);
});
