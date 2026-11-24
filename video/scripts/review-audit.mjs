import {bundle} from '@remotion/bundler';
import {openBrowser,selectComposition,renderStill} from '@remotion/renderer';
import fs from 'node:fs';
const timing=JSON.parse(fs.readFileSync('src/generated/timing.json','utf8'));
fs.mkdirSync('review/audited',{recursive:true});
const url=await bundle({entryPoint:'src/index.ts'});
const browser=await openBrowser('chrome',{browserExecutable:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
for(const id of ['QPulseLandscape','QPulsePortrait']){
 const composition=await selectComposition({serveUrl:url,id,puppeteerInstance:browser});
 for(const [i,s] of timing.scenes.entries()){
  for(const phase of ['early','late']){
   let local=Math.floor(s.frames*(phase==='early'?.32:.88));
   if(s.id==='alert')local=phase==='early'?s.events.notify+26:s.events.webhook+45;
   const output=`review/audited/${id}-${String(i).padStart(2,'0')}-${s.id}-${phase}.png`;
   await renderStill({composition,serveUrl:url,output,frame:s.from+local,puppeteerInstance:browser,scale:.5,logLevel:'error'});
  }
 }
 console.log(id,'reviewed',timing.scenes.length*2,'frames');
}
await browser.close({silent:true});
