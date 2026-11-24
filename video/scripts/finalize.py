"""Join the independently rendered chapters, mix one continuous soundtrack, verify outputs."""
import json,pathlib,subprocess,wave,array,math,sys,os
root=pathlib.Path(__file__).resolve().parents[1]
meta=json.loads((root/'src/generated/timing.json').read_text())
scenes=json.loads((root/'src/scenes.json').read_text())
rate=48000
# Continuous PCM avoids AAC padding at the chapter join.
music=root/'public/music.wav'
with wave.open(str(music),'rb') as w:
 assert w.getframerate()==rate and w.getnchannels()==2
 mix=array.array('h',w.readframes(w.getnframes()))
acc=array.array('f',(v*.12 for v in mix));del mix
for s in meta['scenes']:
 with wave.open(str(root/'public/vo'/f"{s['id']}.wav"),'rb') as w:
  assert w.getframerate()==rate and w.getnchannels()==2 and w.getsampwidth()==2
  raw=array.array('h',w.readframes(w.getnframes()))
 offset=round((s['from']+s.get('leadFrames',15))/30*rate)*2
 for i,v in enumerate(raw):
  if offset+i<len(acc):acc[offset+i]+=v
# Small interface accents, all generated locally. Narration remains foreground.
for s in meta['scenes']:
 cue_name={'signin':'signed','template':'resolved','telegram':'reply','alert':'notify','paylink':'paid','traction':'checked'}.get(s['id'])
 if cue_name is None:continue
 cue_frame=s.get('events',{}).get(cue_name)
 if cue_frame is None:continue
 start=round((s['from']+cue_frame)/30*rate);length=.24 if s['id']!='paylink' else .6
 for i in range(int(length*rate)):
  t=i/rate;freq=880 if s['id'] in ['alert','paylink'] else 720
  v=math.sin(2*math.pi*freq*t)*math.exp(-t*18)*900
  if s['id']=='paylink':v+=math.sin(2*math.pi*1320*t)*math.exp(-t*9)*600
  j=(start+i)*2
  if j+1<len(acc):acc[j]+=v;acc[j+1]+=v
pcm=array.array('h',(max(-32767,min(32767,round(v))) for v in acc));del acc
wav=root/'out/mix.wav'
with wave.open(str(wav),'wb') as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(rate);w.writeframes(pcm.tobytes())
audio_only='--audio-only' in sys.argv
picture_only='--picture-only' in sys.argv
for shape,size in [('landscape','1920x1080'),('portrait','1080x1920')]:
 target=root/'out'/f'qpulse-demo-{size}.mp4'
 if picture_only:
  joined=root/'out'/f'picture-{shape}.mp4'
  final=root/'out'/f'revised-{size}.mp4'
 elif audio_only:
  joined=target
  final=root/'out'/f'revoiced-{size}.mp4'
 else:
  parts=root/'out'/f'concat-{shape}.txt';parts.write_text(f"file 'head-{shape}.mp4'\nfile 'tail-{shape}.mp4'\n")
  joined=root/'out'/f'picture-{shape}.mp4'
  subprocess.run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(parts),'-map','0:v:0','-an','-c:v','copy',str(joined)],check=True)
  final=target
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(joined),'-i',str(wav),'-i',str(root/'out/qpulse-demo.srt'),'-map','0:v:0','-map','1:a:0','-map','2:0','-c:v','copy','-af','loudnorm=I=-16:TP=-1.8:LRA=11','-c:a','aac','-b:a','320k','-ar','48000','-c:s','mov_text','-metadata:s:s:0','language=eng','-metadata','title=Q-Pulse — Watch. Alert. Prove.','-movflags','+faststart',str(final)],check=True)
 info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(final)]))
 v=next(s for s in info['streams'] if s['codec_type']=='video');a=next(s for s in info['streams'] if s['codec_type']=='audio')
 assert v['codec_name']=='h264' and v['pix_fmt']=='yuv420p'
 assert int(v['nb_frames'])==meta['frames'],(v['nb_frames'],meta['frames'])
 assert abs(float(info['format']['duration'])-meta['frames']/30)<.12
 assert a['codec_name']=='aac'
 if audio_only or picture_only:
  os.replace(final,target)
  final=target
  info['format']['filename']=str(target)
 (root/'out'/f'verification-{shape}.json').write_text(json.dumps(info,indent=2))
 print(final,info['format']['duration'],v['width'],v['height'],flush=True)
