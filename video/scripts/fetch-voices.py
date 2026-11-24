import json,urllib.request,concurrent.futures,pathlib
root=pathlib.Path(__file__).resolve().parents[1]
scenes=json.loads((root/'src/scenes.json').read_text())
jobs=json.loads((root/'src/generated/voice-jobs.json').read_text())
def get(j):
 if not j.get('result_url'): return
 p=root/'public/vo'/(scenes[j['index']]['id']+'.wav')
 if not p.exists(): urllib.request.urlretrieve(j['result_url'],p)
 return p.name
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as e:
 for x in e.map(get,jobs): print(x)
