"""Local word timing audit of the original selected-voice recordings."""
import os,pathlib,json,subprocess,numpy as np,torch
os.environ['HF_HOME']='/private/tmp/qpulse-audit-models'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
os.environ['HF_HUB_DISABLE_XET']='1'
os.environ['HF_HUB_DOWNLOAD_TIMEOUT']='60'
os.environ['HF_HUB_ETAG_TIMEOUT']='60'
from transformers import pipeline
root=pathlib.Path(__file__).resolve().parents[1]
torch.set_num_threads(4)
asr=pipeline('automatic-speech-recognition',model='openai/whisper-tiny.en',device='cpu',model_kwargs={'cache_dir':'/private/tmp/qpulse-audit-models','attn_implementation':'eager','use_safetensors':False})
scenes=json.loads((root/'src/scenes.json').read_text())
out=root/'src/generated/speech-audit.json'
results=json.loads(out.read_text()) if out.exists() else {}
for s in scenes:
 if s['id'] in results:continue
 file=root/'public/vo-neromtoobad'/f"{s['id']}.wav"
 data=subprocess.check_output(['ffmpeg','-v','error','-i',str(file),'-ac','1','-ar','16000','-f','f32le','-'])
 result=asr({'raw':np.frombuffer(data,dtype=np.float32).copy(),'sampling_rate':16000},return_timestamps='word')
 results[s['id']]=result;out.write_text(json.dumps(results,indent=2))
 print(s['id'],result['text'],flush=True)
