#!/usr/bin/env python3
"""Install bootstrap and MCP connections. Read per-client credentials as JSON on stdin.

Usage: python3 scripts/install-client.py < protected-client-credentials.json
Input: {"clients":{"codex"|"claude"|"cursor"|"devin":{"url":"https://...","token":"..."}, ...}}
Existing skills and unrelated MCP settings are preserved; backups are mode 0600.
"""
import datetime, hashlib, json, os, re, shlex, shutil, subprocess, sys, urllib.request
from pathlib import Path
import tomllib

root=Path.home()
payload=json.load(sys.stdin)
credentials=payload['clients']
assert credentials and set(credentials)<= {'codex','claude','cursor','devin'}
urls={c['url'].rstrip('/') for c in credentials.values()}
assert len(urls)==1
base=urls.pop()
assert base.startswith('https://') or (base.startswith('http://') and all(c.get('allowInsecureHttp') is True for c in credentials.values())), 'Use HTTPS, or explicitly opt every client into trusted-LAN HTTP with allowInsecureHttp:true'
for c in credentials.values():
    assert isinstance(c['token'],str) and len(c['token'])>=32
runtime=shutil.which('node') or shutil.which('bun')
assert runtime,'Install Node or Bun first'
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
backup=root/'.local/state/skillbox'/('setup-'+stamp)
backup.mkdir(parents=True,mode=0o700)
def write(path,content,mode=0o600):
    path=Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        target=backup/str(path.relative_to(root)).replace('/','__')
        shutil.copyfile(path,target); target.chmod(0o600)
    temporary=path.with_name(path.name+'.skillbox-new')
    with open(temporary,'x') as f:
        os.chmod(temporary,mode); f.write(content)
    os.replace(temporary,path)
    path.chmod(mode)
    return path

def get(path):
    with urllib.request.urlopen(base+path,timeout=30) as response:
        assert response.geturl()==base+path,'Unexpected download redirect'
        return response.read()

# --expected-checksums <path> substitutes a locally pinned checksums.json for
# the server-published one (out-of-band verification channel).
expected=None
if '--expected-checksums' in sys.argv[1:]:
    i=sys.argv.index('--expected-checksums')+1
    assert i<len(sys.argv),'--expected-checksums needs a file path'
    expected=json.loads(Path(sys.argv[i]).read_text())
else:
    expected=json.loads(get('/cli/checksums.json'))
assert expected.get('algorithm')=='sha256','Unsupported checksum algorithm'

def verified(path):
    body=get(path)
    want=expected['files'][path.lstrip('/')]
    got=hashlib.sha256(body).hexdigest()
    assert got==want,f'Checksum mismatch for {path} (expected {want}, got {got}) — aborting, nothing written'
    return body.decode()

# Download and verify everything before any file is written.
install=root/'.local/share/skillbox'
downloads={name:verified('/cli/'+name) for name in ['skillbox.mjs','package.mjs']}
bootstrap=verified('/bootstrap/SKILL.md')
for name,body in downloads.items():
    write(install/name,body,0o644)
write(root/'.agents/skills/skills-library/SKILL.md',bootstrap,0o644)
for client in credentials:
    config=write(root/'.config/skillbox'/f'{client}.json',json.dumps(credentials[client],indent=2)+'\n')
    server={'command':runtime,'args':[str(install/'skillbox.mjs'),'mcp'],'env':{'SKILLBOX_CONFIG':str(config)}}
    if client=='codex':
        path=root/'.codex/config.toml'
        content=path.read_text() if path.exists() else ''
        parsed=tomllib.loads(content)
        existing=parsed.get('mcp_servers',{}).get('skillbox')
        if existing and existing!=server:
            raise SystemExit('Existing Codex Skillbox settings differ; inspect before replacing')
        if not existing:
            content+='\n[mcp_servers.skillbox]\ncommand = '+json.dumps(runtime)+'\nargs = '+json.dumps(server['args'])+'\n\n[mcp_servers.skillbox.env]\nSKILLBOX_CONFIG = '+json.dumps(str(config))+'\n'
            tomllib.loads(content)
            write(path,content)
    elif client=='devin':
        path=root/'.config/devin/mcp_config.json'
        data=json.loads(path.read_text()) if path.exists() else {}
        servers=data.setdefault('mcpServers',{})
        existing=servers.get('skillbox')
        if existing and existing!=server:
            raise SystemExit('Existing devin Skillbox settings differ; inspect before replacing')
        servers['skillbox']=server
        write(path,json.dumps(data,indent=2)+'\n')
    else:
        path=root/('.claude.json' if client=='claude' else '.cursor/mcp.json')
        data=json.loads(path.read_text()) if path.exists() else {}
        servers=data.setdefault('mcpServers',{})
        existing=servers.get('skillbox')
        if existing and existing!=server:
            raise SystemExit('Existing '+client+' Skillbox settings differ; inspect before replacing')
        servers['skillbox']=server
        write(path,json.dumps(data,indent=2)+'\n')
        skill=root/('.claude' if client=='claude' else '.cursor')/'skills/skills-library/SKILL.md'
        if skill.resolve()!=(root/'.agents/skills/skills-library/SKILL.md').resolve():
            if skill.exists() and skill.read_text()!=bootstrap:
                raise SystemExit('Existing bootstrap differs; inspect before replacing')
            target=root/'.agents/skills/skills-library'
            if skill.parent.exists():
                saved=backup/str(skill.parent.relative_to(root)).replace('/','__')
                shutil.move(str(skill.parent),str(saved))
            skill.parent.parent.mkdir(parents=True,exist_ok=True)
            skill.parent.symlink_to(os.path.relpath(target,skill.parent.parent),target_is_directory=True)
    # The actual stdio command must negotiate and list this credential's tools.
    requests=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':client+'-setup','version':'1'}}},{'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}},{'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'search_skills','arguments':{}}}]
    result=subprocess.run([runtime,str(install/'skillbox.mjs'),'mcp'],input=''.join(json.dumps(r)+'\n' for r in requests),env={**os.environ,'SKILLBOX_CONFIG':str(config)},capture_output=True,text=True,timeout=100)
    assert result.returncode==0,'stdio bridge failed'
    messages={r['id']:r for line in result.stdout.splitlines() if (r:=json.loads(line)).get('id')}
    assert 'result' in messages[1] and 'result' in messages[2] and 'result' in messages[3],'MCP protocol check failed'
    catalog=messages[2]['result']['tools']
    index=json.loads(messages[3]['result']['content'][0]['text'])
    assert catalog and index['items'],'Empty skill catalog'
    print(json.dumps({'client':client,'stdio':'passed','tools':len(catalog),'skills':len(index['items'])}))
default='codex' if 'codex' in credentials else next(iter(credentials))
write(root/'.config/skillbox/config.json',json.dumps(credentials[default],indent=2)+'\n')
first=root/'.config/skillbox'/(next(iter(credentials))+'.json')
wrapper='#!/bin/sh\n: "${SKILLBOX_CONFIG:='+shlex.quote(str(first))+'}"\nexport SKILLBOX_CONFIG\nexec '+shlex.quote(runtime)+' '+shlex.quote(str(install/'skillbox.mjs'))+' "$@"\n'
write(root/'.local/bin/skillbox',wrapper,0o755)
if str(root/'.local/bin') not in os.environ.get('PATH','').split(os.pathsep):
    print('Warning: ~/.local/bin is not on PATH; add it to run the skillbox command')
print('Installed Skills Library bootstrap and MCP connections; existing native skills retained. Config backups: '+str(backup))
