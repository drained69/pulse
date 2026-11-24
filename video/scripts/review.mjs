import {bundle} from '@remotion/bundler';
import {openBrowser,selectComposition,renderStill} from '@remotion/renderer';
import fs from 'node:fs';
const timing=JSON.parse(fs.readFileSync('src/generated/timing.json','utf8'));
const browserExecutable='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url=await bundle({entryPoint:'src/index.ts'});
const browser=await openBrowser('chrome',{browserExecutable});
for(const id of ['QPulseLandscape','QPulsePortrait']){
 const c=await selectComposition({serveUrl:url,id,puppeteerInstance:browser});
 for(const [i,s] of timing.scenes.entries()){
 const name=`review/${id}-${String(i).padStart(2,'0')}-${s.id}.png`;
 await renderStill({composition:c,serveUrl:url,output:name,frame:s.from+Math.floor(s.frames*.72),puppeteerInstance:browser,scale:.5,logLevel:'error'});
 console.log(name);
 }
}
await browser.close({silent:true});
