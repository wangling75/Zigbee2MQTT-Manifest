#!/usr/bin/env python3
import hashlib, json, os, struct, sys

MAGIC=b'Z2MB'; HEADER=64; ENTRY=32

def fnv1a_32(text):
    h=0x811C9DC5
    for b in text.lower().strip().encode():
        h ^= b; h=(h*0x01000193)&0xffffffff
    return h

if len(sys.argv)!=4:
    raise SystemExit('usage: verify_z2m_bundle.py BUNDLE MANIFEST INDEX')
bin_path, manifest_path, index_path=sys.argv[1:]
assert os.path.exists(bin_path)
with open(bin_path,'rb') as f:
    raw=f.read()
assert len(raw)>=HEADER
HEADER_STRUCT='<4sHIIIII32s'
HEADER_STRUCT_SIZE=struct.calcsize(HEADER_STRUCT)
magic,ver,count,idx_off,data_off,str_off,total_size,digest=struct.unpack(HEADER_STRUCT,raw[:HEADER_STRUCT_SIZE])
assert magic==MAGIC, magic
assert ver==2, f'format version={ver}'
assert total_size==len(raw), (total_size,len(raw))
payload=raw[HEADER:]
assert hashlib.sha256(payload).digest()==digest, 'payload SHA256 mismatch'
assert idx_off==64 and data_off>=idx_off and str_off>=data_off
assert data_off-idx_off==count*ENTRY

with open(manifest_path) as f: mf=json.load(f)
assert mf['format']=='z2m-binary-bundle-v2'
assert mf['ir_version']==2
assert mf['device_count']==count
assert mf['sha256']==hashlib.sha256(raw).hexdigest()

with open(index_path) as f: idx=json.load(f)
assert len(idx)>0, 'empty model index'

# Verify sorted FNV index and probe lookups.
hashes=[]
for i in range(count):
    off=idx_off+i*ENTRY
    e=raw[off:off+ENTRY]
    mh=struct.unpack('<I',e[:4])[0]
    hashes.append(mh)
assert hashes==sorted(hashes), 'index is not sorted by model hash'
for model in list(idx)[:10] + ['TS0601','TS0201','SNZB-02P']:
    target=fnv1a_32(model); lo,hi=0,count-1; found=False
    while lo<=hi:
        mid=(lo+hi)//2; mh=hashes[mid]
        if mh==target: found=True; break
        if mh<target: lo=mid+1
        else: hi=mid-1
    if model in idx:
        assert found, f'indexed model not found: {model}'
    print(f'[verify] {model}: {"FOUND" if found else "not present"}')
print(f'[verify] OK: {count} records, {len(idx)} model aliases, {len(raw)} bytes')
