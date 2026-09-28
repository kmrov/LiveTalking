import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { realpath } from 'node:fs/promises';
import { desktopHealth } from '../electron/supervisor.mjs';
import { normalizeProfile } from '../src/profile.mjs';
import { defaultProbes } from '../electron/prerequisites.mjs';

test('adoption requires the selected model and canonical checkout while retaining external ownership',async t=>{
 const root=await realpath(os.tmpdir());
 const profile=normalizeProfile({liveTalking:{root,model:'musetalk'}});
 const data={service:'livetalking',api_version:1,brain:{mode:'direct'},avatar:{model:'wav2lip',root}};
 t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>({code:0,data})}));
 assert.equal(await desktopHealth(8010,profile),false);
 assert.equal(await defaultProbes.port(8010,profile),'incompatible');
 data.avatar.model='musetalk';assert.equal(await desktopHealth(8010,profile),true);
 data.avatar.root='/elsewhere';assert.equal(await desktopHealth(8010,profile),false);
 delete data.avatar;assert.equal(await desktopHealth(8010,profile),false);
 assert.equal(await desktopHealth(8010),true);
});
