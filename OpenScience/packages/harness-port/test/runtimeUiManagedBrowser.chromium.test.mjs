/** Real browser DOM/input lifecycle; local synthetic pixels/controller only, no managed CDP/SaaS qualification. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {managedBrowserPoint,mountManagedBrowserViewport} from '../src/runtimeUiManagedBrowser.mjs';
const executablePath=process.env.OPEN_SCIENCE_MANAGED_BROWSER_TEST_CHROME??'',enabled=process.env.EVIMED_MANAGED_BROWSER_DOM==='1'&&Boolean(executablePath);
test('actual Chromium native viewport accepts Chinese IME/input/paste once and sizes first frame', {skip:!enabled&&'Explicit owned local Chromium DOM fixture required'},async()=>{
 const require=createRequire(new URL('../../../apps/server/package.json',import.meta.url));const moduleId='playwright'+'-core', {chromium}=require(moduleId);
 const browser=await chromium.launch({headless:true,executablePath,env:{PATH:process.env.PATH},args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});
 try{
  const context=await browser.newContext({viewport:{width:900,height:700}});await context.route('**/*',(/** @type {any} */ route)=>route.abort());const page=await context.newPage();await page.setContent('<div id="owned" style="width:600px;height:400px"></div>');
  await page.addScriptTag({content:managedBrowserPoint.toString()+'\n'+mountManagedBrowserViewport.toString()+`\nconst canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;const bytes=canvas.toDataURL('image/jpeg').split(',')[1];globalThis.commands=[];let frame={width:800,height:600,mimeType:'image/jpeg',dataBase64:bytes};globalThis.hide=mountManagedBrowserViewport({snapshot:async()=>true,frame:()=>frame,command:async value=>{commands.push(value);if(value.type==='resize')frame={...frame,width:value.width,height:value.height};return true;}},window,{viewportId:'owned'});`});
  await page.waitForFunction(()=>/** @type {any} */(globalThis).commands.some((/** @type {any} */ command)=>command.type==='resize'));assert.deepEqual(await page.evaluate(()=>/** @type {any} */(globalThis).commands.find((/** @type {any} */ command)=>command.type==='resize')),{type:'resize',width:600,height:400});
  await page.locator('img').click({position:{x:100,y:100}});assert.equal(await page.evaluate(()=>/** @type {any} */(globalThis).document.activeElement?.tagName),'TEXTAREA');
  await page.evaluate(()=>{const current=/** @type {any} */(globalThis),area=current.document.querySelector('textarea');area.dispatchEvent(new current.CompositionEvent('compositionstart',{bubbles:true,data:''}));area.value='中文';area.dispatchEvent(new current.InputEvent('input',{bubbles:true,data:'中文',isComposing:true}));area.dispatchEvent(new current.CompositionEvent('compositionend',{bubbles:true,data:'中文'}));area.value='中文';area.dispatchEvent(new current.InputEvent('input',{bubbles:true,data:'中文',isComposing:false}));});
  await page.keyboard.insertText('输入');await page.waitForTimeout(80);
  await page.evaluate(()=>{const current=/** @type {any} */(globalThis),data=new current.DataTransfer();data.setData('text/plain','粘贴');current.document.querySelector('textarea').dispatchEvent(new current.ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
  const text=await page.evaluate(()=>/** @type {any} */(globalThis).commands.filter((/** @type {any} */ command)=>command.type==='text').map((/** @type {any} */ command)=>command.text));assert.deepEqual(text,['中文','输入','粘贴']);assert.equal(await page.locator('textarea').inputValue(),'');
  await page.evaluate(()=>/** @type {any} */(globalThis).hide());assert.equal(await page.locator('#owned').innerHTML(),'');await context.close();
 }finally{await browser.close();}
});
