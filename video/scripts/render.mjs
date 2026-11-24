import {execFileSync,spawn} from 'node:child_process';
import fs from 'node:fs';
fs.mkdirSync('review',{recursive:true});
execFileSync(process.execPath,['scripts/prepare.ts'],{stdio:'inherit'});
const jobs=[['landscape','QPulseLandscape'],['portrait','QPulsePortrait']];
await Promise.all(jobs.map(([shape,id])=>new Promise((resolve,reject)=>{
 const log=fs.openSync(`review/render-${shape}.log`,'w');
 const child=spawn('npx',['remotion','render','src/index.ts',id,`out/picture-${shape}.mp4`,'--concurrency=4','--x264-preset=fast','--muted'],{stdio:['ignore',log,log]});
 child.on('error',reject);child.on('exit',code=>{fs.closeSync(log);code===0?resolve():reject(new Error(`${shape} render failed; see review/render-${shape}.log`));});
})));
execFileSync('python3',['scripts/finalize.py','--picture-only'],{stdio:'inherit'});
for(const size of ['1920x1080','1080x1920']){
 const source=`out/qpulse-demo-${size}.mp4`;
 for(const revision of ['audited','neromtoobad']){
  const target=`out/qpulse-demo-${revision}-${size}.mp4`;
  if(fs.existsSync(target))fs.unlinkSync(target);
  fs.linkSync(source,target);
 }
}
