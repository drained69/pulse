import fs from 'node:fs';
import {probeDuration,writeWav} from './audio-io.ts';
type Cue={from:number;to:number;text:string};
type Entry={id:string;from:number;frames:number;audioFrames:number;seconds:number;leadFrames:number;events:Record<string,number>};
const scenes=JSON.parse(fs.readFileSync('src/scenes.json','utf8')) as {id:string;label:string;text:string}[];
const timing=JSON.parse(fs.readFileSync('src/generated/timing.json','utf8')) as {frames:number;edit:string;scenes:Entry[]};
const captions=JSON.parse(fs.readFileSync('src/generated/captions.json','utf8')) as Record<string,Cue[]>;
if(timing.edit!=='audited'||scenes.length!==timing.scenes.length)throw new Error('Regenerate the audited edit with python3 scripts/retime-audit.py.');
for(const [i,s] of scenes.entries()){
 const entry=timing.scenes[i]!;
 if(entry.id!==s.id||Math.abs(probeDuration(`public/vo/${s.id}.wav`)-entry.seconds)>.034)throw new Error(`Narration changed for ${s.id}; run retime-audit.py before rendering.`);
 if(!captions[s.id]?.length)throw new Error(`Missing speech-aligned captions: ${s.id}`);
}
const rate=48000,n=Math.round(timing.frames/30*rate),left=new Float32Array(n),right=new Float32Array(n);
const notes=[130.8128,164.8138,195.9977,246.9417];
for(let i=0;i<n;i++){
 const t=i/rate,beat=t%.5,section=Math.floor(t/8)%4;let v=0;
 for(let k=0;k<3;k++){const hz=notes[(section+k)%4]!;v+=Math.sin(2*Math.PI*hz*t)*.055+Math.sin(2*Math.PI*hz*1.002*t)*.028;}
 const hz=notes[(Math.floor(t/.5)+section)%4]!*2;
 v+=Math.sin(2*Math.PI*hz*beat)*Math.exp(-beat*12)*.13;
 v+=Math.sin(2*Math.PI*(44*beat+7*(1-Math.exp(-beat*22))))*Math.exp(-beat*23)*.1;
 const fade=Math.max(0,Math.min(1,t/.6,(n/rate-t)/2));left[i]=v*fade;right[i]=v*fade*.96;
}
writeWav('public/music.wav',left,right,rate);
const stamp=(seconds:number)=>{const ms=Math.round(seconds*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`};
const display=(text:string)=>text.replaceAll('Q Pulse','Q-Pulse').replaceAll('Q I E','QIE').replaceAll('Q U S D C','QUSDC').replaceAll('A I','AI').replaceAll('A P I','API').replaceAll('M C P','MCP').replaceAll('R P C','RPC').replaceAll('Q R','QR');
let count=1;const srt:string[]=[];
for(const entry of timing.scenes)for(const cue of captions[entry.id]!)srt.push(`${count++}\n${stamp((entry.from+cue.from)/30)} --> ${stamp((entry.from+cue.to)/30)}\n${cue.text}\n`);
fs.mkdirSync('out',{recursive:true});
fs.writeFileSync('out/qpulse-demo.srt',srt.join('\n'));
fs.writeFileSync('out/chapters.txt',timing.scenes.map((e,i)=>`${stamp(e.from/30).slice(3,8)} ${scenes[i]!.label}`).join('\n'));
fs.writeFileSync('out/script.txt',scenes.map(s=>s.label+'\n'+display(s.text)).join('\n\n'));
console.log(`Prepared ${scenes.length} chapters, ${timing.frames/30}s, ${count-1} speech-aligned caption phrases.`);
