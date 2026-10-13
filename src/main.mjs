import { resolve } from 'node:path';
import { Store } from './store.mjs';
import { MockEngine } from './engine.mjs';
import { PiEngine } from './pi-engine.mjs';
import { makeServer } from './server.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { ILinkClient } from './wechat.mjs';
import { SilverBullet } from './silverbullet.mjs';
import { Sandbox } from './sandbox.mjs';
import { Speech } from './speech.mjs';

process.umask(0o077);
const host = process.env.ASSISTANT_HOST || '127.0.0.1';
if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Development server must bind loopback; publish through an authenticated HTTPS gateway later');
const mode = process.env.ASSISTANT_ENGINE || 'mock';
if (!['mock', 'pi'].includes(mode)) throw new Error('Unknown engine');
const engine = mode === 'mock' ? new MockEngine() : new PiEngine({
  sdkModule: process.env.PI_SDK_MODULE || (existsSync('./sdk-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js')
    ? resolve('./sdk-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js') : '@earendil-works/pi-coding-agent'),
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
const silverbullet = process.env.ASSISTANT_SB_CONFIG && new SilverBullet(store, JSON.parse(readFileSync(process.env.ASSISTANT_SB_CONFIG, 'utf8')));
const wechatProtection = process.env.ASSISTANT_WECHAT_PROTECTION
  ? JSON.parse(readFileSync(process.env.ASSISTANT_WECHAT_PROTECTION, 'utf8')) : {};
const app = await makeServer({ store, engine, adminPassword: process.env.ASSISTANT_ADMIN_PASSWORD,
  secureCookies: process.env.ASSISTANT_SECURE_COOKIES === 'on', origin: process.env.ASSISTANT_ORIGIN,
  basePath: process.env.ASSISTANT_BASE_PATH || '',
  wechatClient: process.env.ASSISTANT_WECHAT === 'on' ? new ILinkClient() : undefined,
  wechatOptions: wechatProtection, silverbullet,
  speech: process.env.ASSISTANT_TTS === 'on' ? new Speech(process.env.MINIMAX_CN_API_KEY, { voiceId: process.env.ASSISTANT_TTS_VOICE }) : undefined,
  sandbox: process.env.ASSISTANT_SANDBOX_SOCKET ? new Sandbox(process.env.ASSISTANT_SANDBOX_SOCKET) : undefined });
app.server.listen(Number(process.env.ASSISTANT_PORT || 32214), host, () => {
  console.log(JSON.stringify({ status: 'listening', host, port: app.server.address().port, engine: mode }));
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await app.close(); process.exit(0);
});
