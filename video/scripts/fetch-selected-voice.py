import pathlib,json,urllib.request,concurrent.futures,os
root=pathlib.Path(__file__).resolve().parents[1]
scenes=json.loads((root/'src/scenes.json').read_text());jobs=json.loads((root/'src/generated/neromtoobad-jobs.json').read_text())
def get(j):
 if not j.get('result_url'): return
 p=root/'public/vo-neromtoobad'/(scenes[j['index']]['id']+'.wav')
 if p.exists():return p.name
 temp=p.with_suffix('.part')
 urllib.request.urlretrieve(j['result_url'],temp);os.replace(temp,p)
 return p.name
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as e:
 for x in e.map(get,jobs):print(x,flush=True)
