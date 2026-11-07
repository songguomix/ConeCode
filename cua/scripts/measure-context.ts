import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from '../src/fixtures/web-app.js';
import { BrowserDriver } from '../src/drivers/browser/browser-driver.js';
import { ArtifactStore } from '../src/store/artifacts.js';
import { SessionStore } from '../src/store/store.js';
import { observationForModel } from '../src/protocol/observation-utils.js';
import { newId } from '../src/protocol/ids.js';

async function main(){
 const fixture=await startFixtureServer(); await fixture.reset();
 const dir=await mkdtemp(join(tmpdir(),'cua-context-'));
 const store=new SessionStore(':memory:'); const artifacts=new ArtifactStore(dir,store);
 const taskId=newId('task'); const suffix=taskId.slice(5);
 const driver=new BrowserDriver({taskId,runId:`run_${suffix}`,sessionId:`ses_${suffix}`},{kind:'browser',startUrl:fixture.url,headless:true,profile:'default'},artifacts);
 await driver.start(); const obs=await driver.observe();
 const full=JSON.stringify(obs); const trimmed=JSON.stringify(observationForModel(obs,80,6000));
 const shot=obs.screenshot ? (await stat(obs.screenshot.path)).size : 0;
 console.log(JSON.stringify({fullChars:full.length,modelChars:trimmed.length,reductionPercent:Number((100*(1-trimmed.length/full.length)).toFixed(1)),targets:obs.targets.length,textChars:obs.visibleText.length,screenshotPixels:`${obs.screenshot?.width}x${obs.screenshot?.height}`,screenshotBytes:shot,note:'Structured observation projection only; this is not a model token/cost comparison.'},null,2));
 await driver.close(); await fixture.close(); store.close(); await rm(dir,{recursive:true,force:true});
}
main().catch(e=>{console.error(e);process.exit(1)});
