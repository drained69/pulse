"""Fit selected Higgsfield recordings to the approved picture while preserving pitch."""
import pathlib,json,subprocess,math
root=pathlib.Path(__file__).resolve().parents[1]
meta=json.loads((root/'backups/grady/timing.json').read_text())
rows=[]
for s in meta['scenes']:
 src=root/'public/vo-neromtoobad'/f"{s['id']}.wav"
 duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(src)]))
 target=s['seconds'];factor=duration/target
 remaining=factor;filters=[]
 while remaining>2:filters.append('atempo=2');remaining/=2
 while remaining<.5:filters.append('atempo=0.5');remaining/=.5
 filters.append(f'atempo={remaining:.9f}')
 filters.extend(['apad',f'atrim=duration={target:.9f}'])
 out=root/'public/vo'/src.name
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(src),'-af',','.join(filters),'-ar','48000','-ac','2','-c:a','pcm_s16le',str(out)],check=True)
 rows.append(dict(id=s['id'],original_seconds=duration,final_seconds=target,tempo=factor))
 print(f"{s['id']:15} {duration:6.2f}s -> {target:6.2f}s (tempo {factor:.3f})",flush=True)
meta.update(voice='neromtoobad',voice_id='caec4873-074b-4be8-8db0-b314f3618dae',voice_type='element')
(root/'src/generated/timing.json').write_text(json.dumps(meta,indent=2))
(root/'src/generated/voice-fit.json').write_text(json.dumps(rows,indent=2))
