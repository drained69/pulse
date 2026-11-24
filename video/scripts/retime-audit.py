"""Build a speech-led edit from original recordings, with timestamped captions and cues."""
import pathlib,json,subprocess,re,difflib,math,wave,numpy as np
root=pathlib.Path(__file__).resolve().parents[1]
scenes=json.loads((root/'src/scenes.json').read_text())
speech=json.loads((root/'src/generated/speech-audit.json').read_text())
def display(text):
 for a,b in [('Q Pulse','Q-Pulse'),('Q I E','QIE'),('Q U S D C','QUSDC'),('A I','AI'),('A P I','API'),('M C P','MCP'),('R P C','RPC'),('Q R','QR')]:text=text.replace(a,b)
 return text
norm=lambda s:re.sub('[^a-z0-9]','',s.lower())
lead=8;start=0;entries=[];captions={};audit=[]
event_phrases={
 'signin':{'sheet':'Approve','signed':'This is a signature'},
 'template':{'typing':'Enter','resolved':'resolves','assets':'Select','destination':'watch'},
 'telegram':{'phone':'one-time code','reply':'Once','create':'create your hook'},
 'alert':{'payment':'customer pays','notify':'sends a payment alert','webhook':'A separate','verified':'verify'},
 'paylink':{'create':'create a payment link','share':'Share','pay':'The customer','paid':'Paid after'},
 'traction':{'count':'wallet','proof':'Daily','verify':'Verify in your browser','checked':'on-chain proof'},
 'communities':{'alert':'send large-move'},'traders':{'chart':'liquidity drops','alert':'signals to investigate'},
 'holders':{'warning':'Address-poisoning'},'sellers':{'paid':'payment event'},
 'developers':{'subscribe':'WebSocket','receive':'Their apps'},'agents':{'create':'create payment links','wait':'wait for payment','done':'larger workflow'}
}
for s in scenes:
 source=root/'public/vo-neromtoobad'/f"{s['id']}.wav"
 raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(source),'-ar','48000','-ac','2','-f','f32le','-'])
 samples=np.frombuffer(raw,dtype='<f4').reshape(-1,2).copy();duration=len(samples)/48000
 chunks=[dict(text=x['text'].strip(),start=x['timestamp'][0] or 0,end=x['timestamp'][1] or duration) for x in speech[s['id']]['chunks']]
 chunks=[x for x in chunks if x['text']]
 merged_chunks=[]
 for x in chunks:
  if x['text'].startswith('-') and merged_chunks:
   merged_chunks[-1]['text']+=x['text'];merged_chunks[-1]['end']=x['end']
  else:merged_chunks.append(x)
 chunks=merged_chunks
 for i in range(len(chunks)-1,0,-1):
  if norm(chunks[i-1]['text'])=='q' and norm(chunks[i]['text']) in ['polls','pose','poles','pulse']:
   chunks[i-1]['text']='Q-Pulse';chunks[i-1]['end']=chunks[i]['end'];chunks.pop(i)
 for x in chunks:
  if norm(x['text']) in ['qpoles','qpose','qpolls']:x['text']='Q-Pulse'
 if s['id']=='close':
  for i in range(len(chunks)-1):
   if norm(chunks[i]['text'])=='a' and norm(chunks[i+1]['text'])=='lot':
    chunks[i]['text']='Alert';chunks[i]['end']=chunks[i+1]['end'];chunks.pop(i+1);break
  if chunks and norm(chunks[-1]['text'])=='proof':chunks[-1]['text']='Prove.'
 speech_end=duration
 if s['id']=='cover':
  turn=next((x for x in chunks if norm(x['text']).startswith('turn')),None)
  speech_end=turn['start']-.04 if turn else min(duration,4.2)
 chunks=[x for x in chunks if x['start']<speech_end-.04]
 log=subprocess.run(['ffmpeg','-hide_banner','-i',str(source),'-af','silencedetect=n=-43dB:d=0.30','-f','null','-'],capture_output=True,text=True).stderr
 starts=list(map(float,re.findall(r'silence_start: ([0-9.]+)',log)));ends=list(map(float,re.findall(r'silence_end: ([0-9.]+)',log)))
 if len(starts)>len(ends):ends.append(duration)
 remove=[]
 for a,b in zip(starts,ends):
  b=min(b,speech_end)
  if a>=speech_end:continue
  if a<.08:
   if b>.05:remove.append((0,b-.045))
  elif b>=speech_end-.04:
   if b-a>.18:remove.append((a+.15,speech_end))
  elif b-a>.38:remove.append((a+.11,b-.13))
 if speech_end<duration:remove.append((speech_end,duration))
 # Coalesce cuts to maintain a monotonic source-to-edit time map.
 merged=[]
 for a,b in sorted(remove):
  if b<=a:continue
  if merged and a<=merged[-1][1]:merged[-1]=(merged[-1][0],max(b,merged[-1][1]))
  else:merged.append((a,b))
 segments=[];position=0
 for a,b in merged:
  if a>position:segments.append(samples[round(position*48000):round(a*48000)])
  position=b
 if position<duration:segments.append(samples[round(position*48000):])
 for seg in segments:
  n=min(120,len(seg)//2)
  if n:
   seg[:n]*=np.linspace(0,1,n)[:,None];seg[-n:]*=np.linspace(1,0,n)[:,None]
 clean=np.concatenate(segments);clean_seconds=len(clean)/48000
 words=display(s['text']).split();desired=len(words)/2.55
 tempo=max(.98,min(1.16,clean_seconds/max(desired,.1)))
 intermediate=root/'review'/f"clean-{s['id']}.wav"
 with wave.open(str(intermediate),'wb') as w:
  w.setnchannels(2);w.setsampwidth(2);w.setframerate(48000);w.writeframes((np.clip(clean,-1,1)*32767).astype('<i2').tobytes())
 target=root/'public/vo'/f"{s['id']}.wav"
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(intermediate),'-af',f'atempo={tempo:.9f},afade=t=in:d=0.008,areverse,afade=t=in:d=0.025,areverse','-ar','48000','-ac','2','-c:a','pcm_s16le',str(target)],check=True)
 with wave.open(str(target),'rb') as w:audio_seconds=w.getnframes()/w.getframerate()
 def tx(t):return max(0,min(audio_seconds,(t-sum(max(0,min(t,b)-a) for a,b in merged if t>a))/tempo))
 # Match the approved script to ASR words. Unknown acronym spans interpolate only
 # between neighbouring recognized anchors; displayed text always uses the script.
 a=[norm(w) for w in words];b=[norm(x['text']) for x in chunks]
 matches=difflib.SequenceMatcher(None,a,b,autojunk=False).get_matching_blocks();anchors={}
 for block in matches:
  for k in range(block.size):anchors[block.a+k]=(tx(chunks[block.b+k]['start']),tx(chunks[block.b+k]['end']))
 starts_final=[];ends_final=[]
 for i,w in enumerate(words):
  if i in anchors:st,en=anchors[i]
  else:
   left=max([k for k in anchors if k<i],default=-1);right=min([k for k in anchors if k>i],default=len(words))
   lo=anchors[left][1] if left>=0 else 0;hi=anchors[right][0] if right<len(words) else audio_seconds
   weights=[max(2,len(words[k])) for k in range(left+1,right)];total=sum(weights) or 1;before=sum(weights[:i-left-1]);weight=max(2,len(w))
   st=lo+(hi-lo)*before/total;en=lo+(hi-lo)*(before+weight)/total
  starts_final.append(max(st,starts_final[-1] if starts_final else 0));ends_final.append(max(en,starts_final[-1]+.03))
 cues=[];group=[];group_start=0
 for i,w in enumerate(words):
  if not group:group_start=i
  group.append(w);length=len(' '.join(group));last=i==len(words)-1
  split=last or len(group)>=7 or length>=39 or (len(group)>=3 and re.search('[.!?;:]$',w))
  if split:
   st=round(starts_final[group_start]*30)+lead;en=round(ends_final[i]*30)+lead
   cues.append({'from':st,'to':max(st+12,en),'text':' '.join(group)});group=[]
 for i,c in enumerate(cues[:-1]):c['to']=max(c['from']+8,min(cues[i+1]['from'],c['to']+5))
 events={}
 for name,phrase in event_phrases.get(s['id'],{}).items():
  phrase_tokens=[norm(x) for x in phrase.split()];idx=next((i for i in range(len(a)) if a[i:i+len(phrase_tokens)]==phrase_tokens),None)
  if idx is None:
   needle=norm(phrase);idx=next((i for i,x in enumerate(a) if needle in x),0)
  events[name]=lead+round(starts_final[idx]*30)
 audio_frames=math.ceil(audio_seconds*30);tail=36 if s['id']=='close' else 14
 frames=lead+audio_frames+tail
 if s['id']=='traction':frames=max(frames,events.get('checked',audio_frames)+60)
 if s['id']=='alert':frames=max(frames,events.get('verified',audio_frames)+45)
 entries.append({'id':s['id'],'from':start,'frames':frames,'audioFrames':audio_frames,'seconds':audio_seconds,'leadFrames':lead,'events':events})
 captions[s['id']]=cues;start+=frames
 audit.append({'id':s['id'],'rawSeconds':duration,'removedSilenceSeconds':duration-clean_seconds,'tempo':tempo,'finalSeconds':audio_seconds,'scriptWords':len(words),'wpm':60*len(words)/audio_seconds,'matchedWords':len(anchors),'alignmentCoverage':len(anchors)/len(words),'events':events})
 print(s['id'],round(audio_seconds,2),'s',round(tempo,2),'tempo',round(100*len(anchors)/len(words)),'% anchors',flush=True)
(root/'src/generated/timing.json').write_text(json.dumps({'frames':start,'fps':30,'voice':'neromtoobad','provider':'Higgsfield Seed Audio 1.0','edit':'audited','scenes':entries},indent=2))
(root/'src/generated/captions.json').write_text(json.dumps(captions,indent=2))
(root/'src/generated/pacing-audit.json').write_text(json.dumps(audit,indent=2))
def stamp(seconds):
 ms=round(seconds*1000);return f'{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}'
srt=[];n=1
for s in entries:
 for c in captions[s['id']]:
  srt.append(f"{n}\n{stamp((s['from']+c['from'])/30)} --> {stamp((s['from']+c['to'])/30)}\n{c['text']}\n");n+=1
(root/'out/qpulse-demo.srt').write_text('\n'.join(srt))
(root/'out/chapters.txt').write_text('\n'.join(f"{stamp(e['from']/30)[3:8]} {s['label']}" for s,e in zip(scenes,entries)))
(root/'out/script.txt').write_text('\n\n'.join(s['label']+'\n'+display(s['text']) for s in scenes))
print('TOTAL',start/30,'seconds',flush=True)
