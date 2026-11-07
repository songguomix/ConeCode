import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFixtureServer } from '../src/fixtures/web-app.js';
import { RuntimeService } from '../src/service/runtime-service.js';
import { CuaHttpServer } from '../src/service/http-server.js';

async function main(){
 const fixture=await startFixtureServer(); await fixture.reset();
 const dir=await mkdtemp(join(tmpdir(),'cua-console-'));
 const svc=new RuntimeService({dataDir:dir,recoverOnStart:false,monitorIntervalMs:0}); await svc.start();
 const http=new CuaHttpServer(svc,{port:0,token:'console-verify',ssePollMs:100}); const info=await http.start();
 const task=await svc.createTask({goal:'Console screenshot task: rename to ConsoleDemo and save.',acceptance:[{kind:'record_field',url:`${fixture.url}/api/projects/1`,path:['name'],equals:'ConsoleDemo'}],environment:{kind:'browser',startUrl:fixture.url,headless:true,profile:'default'},model:{provider:'scripted',model:'scripted-deterministic'},script:[{kind:'tool',name:'browser_fill',arguments:{target:{role:'textbox',name:'Project name'},value:'ConsoleDemo'}},{kind:'tool',name:'browser_click',arguments:{target:{role:'button',name:'Save'},expected:[{kind:'record_field',url:`${fixture.url}/api/projects/1`,path:['name'],equals:'ConsoleDemo',withinMs:5000}]}},{kind:'tool',name:'finish',arguments:{summary:'done'}}]} as any);
 await svc.awaitTask(task.id,{timeoutMs:60000});
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto(info.url,{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:'Computer Use Agent'}).waitFor();
 await page.getByText('Console screenshot task').first().click();
 await page.getByText('Current observation').waitFor();
 await page.waitForTimeout(1200);
 const out=resolve('artifacts/console.png');
 await page.screenshot({path:out,fullPage:true});
 const text=(await page.locator('body').innerText()).slice(0,800);
 console.log('CONSOLE_TEXT', text.replace(/\n+/g,' | '));
 console.log('SCREENSHOT', out);
 await browser.close(); await http.close(); await svc.close(); await fixture.close();
}
main().catch(e=>{console.error(e);process.exit(1)});
