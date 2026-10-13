// Only requests an anonymous login QR. Never confirms a login or sends a message.
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {ILinkClient,WechatManager} from '../src/wechat.mjs';
const directory=mkdtempSync(join(tmpdir(),'pi-wechat-live-')),store=new Store(directory);
const manager=new WechatManager(store,new ILinkClient());
try{
 const user=store.createUser('synthetic_qr_test','fake-only-password-hash');
 const qr=await manager.login(user.id);assert.match(qr.image,/^data:image\/png;base64,/);
 assert.ok(!JSON.stringify(qr).includes('qr_token'));
 const status=await manager.status(user.id,qr.id);assert.ok(['wait','scaned','scaned_but_redirect'].includes(status.status));
 manager.cancelLogin(user.id,qr.id);assert.equal((await manager.status(user.id,qr.id)).status,'cancelled');
 assert.equal(store.wechatBindings().length,0);
 const report={real_qr_created:true,provider_status:status.status,qr_cancelled:true,no_account_bound:true,no_message_sent:true,
  confirmation_and_delivery:'pending_independent_test_account_scan'};
 writeFileSync('test/wechat-live-verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await manager.close();store.close();rmSync(directory,{recursive:true,force:true});}
