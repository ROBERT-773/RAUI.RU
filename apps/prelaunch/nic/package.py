"""Build the NIC.RU PHP package from the current canonical portal landing."""
import hashlib
import json
import sys
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

source = Path(__file__).resolve().parent
public = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()
target.mkdir(parents=True, exist_ok=False)
prefix = '/raui-prelaunch-20261126'
url_map = {name: prefix+name for name in [
    '/start.css','/registration.js','/assets/raui-logo.png','/assets/raui-moscow-evening.webp']}
url_map['/api/v1/launch-interest'] = prefix+'/register.php'
def hash_bytes(b):
    return hashlib.sha256(b).hexdigest()
def write(name, data):
    path = target / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
raw = (public/'index.html').read_bytes()
html = raw.decode('utf-8')
for name,destination in url_map.items():
    old='"'+name+'"'
    if html.count(old)!=1: raise ValueError('Unexpected source route '+name)
    html=html.replace(old,'"'+destination+'"')
write('raui-prelaunch-private/page.html',html.encode())
for n in ['start.css','registration.js','assets/raui-logo.png','assets/raui-moscow-evening.webp']:
    write('docs'+prefix+'/'+n,(public/n).read_bytes())
for n in ['register.php','landing.php']:
    write('docs'+prefix+'/'+n,(source/n).read_bytes())
for n in ['store.php','operator.php']:
    write('raui-prelaunch-private/'+n,(source/n).read_bytes())
write('activation/index.php',(source/'index.php').read_bytes())
write('README.md',(source/'README.md').read_bytes())
names=['index.html','start.css','registration.js','assets/raui-logo.png','assets/raui-moscow-evening.webp']
write('SOURCE.json',(json.dumps({'canonical':{n:hash_bytes((public/n).read_bytes()) for n in names},'replacedExactUrls':url_map},indent=2)+'\n').encode())
entries=sorted(p for p in target.rglob('*') if p.is_file())
write('SHA256SUMS', ''.join(hash_bytes(p.read_bytes())+'  '+p.relative_to(target).as_posix()+'\n' for p in entries).encode())
archive=target.parent/(target.name+'.zip')
with ZipFile(archive,'x',compression=ZIP_DEFLATED,compresslevel=9) as z:
    for f in sorted(p for p in target.rglob('*') if p.is_file()):
        name=f.relative_to(target).as_posix()
        zi=ZipInfo(name,(2026,11,26,0,0,0));zi.create_system=3
        zi.external_attr=(0o100644)<<16
        z.writestr(zi,f.read_bytes(),compress_type=ZIP_DEFLATED,compresslevel=9)
with ZipFile(archive) as z:
    assert z.testzip() is None
    for p in target.rglob('*'):
        if p.is_file(): assert z.read(p.relative_to(target).as_posix())==p.read_bytes()
print(hash_bytes(archive.read_bytes()),archive.stat().st_size,archive)
