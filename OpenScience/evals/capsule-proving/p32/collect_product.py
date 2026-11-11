"""Collect final replies AND delivered document text; a file handoff alone is not the answer."""
import gzip
import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


def collect(directory):
    root = Path(directory)
    rows = []
    for file in sorted((root/'records').glob('*.json')):
        record = json.loads(file.read_text())
        turn = record['turns'][0]
        evidence = file.with_suffix('.files')
        texts = [turn.get('reply','')]
        artifacts = []
        for relative in turn.get('changed',[]):
            path = evidence/'ws-t0'/relative
            if path.suffix.lower() in ('.md','.txt','.csv'):
                text = path.read_text()
            elif path.suffix.lower()=='.docx':
                with zipfile.ZipFile(path) as z:
                    document = ET.fromstring(z.read('word/document.xml'))
                    ns = {'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                    text = '\n'.join(''.join(p.itertext()) for p in document.findall('.//w:p',ns))
            else:
                raise ValueError(f'unsupported_artifact_format:{path.suffix}')
            artifacts.append(relative)
            texts.append(f'\nDelivered artifact: {relative}\n{text}')
        reads = []
        for path in (evidence/'transcripts').glob('*.jsonl.gz'):
            with gzip.open(path,'rt') as f:
                for message in map(json.loads,f):
                    for part in message.get('parts',[]):
                        if part.get('type')=='tool' and part.get('tool') in ('mcp__openviking__read','mcp__openviking__search'):
                            reads.append({'tool':part['tool'],'status':part.get('status'),'output':part.get('output')})
        rows.append({'arm':'product','case':record['cell'],'variant':'partial','sample':0,'reply':'\n\n'.join(texts),
            'runStatus':turn.get('run',{}).get('status'),'runRoute':turn.get('run',{}).get('effectiveAgentId'),
            'memoryReads':reads,'targetOpeningRequests':record.get('targetOpeningRequests'), 'artifacts':artifacts,
            'lockIsolation':True,'seed':record['seed'],'sourceRecord':str(file),
            'platformObservations':{'currentDate':record['startedAt'][:10], 'createdArtifacts':artifacts,
                'workspaceEmptyBefore':not record.get('workspaceBefore'), 'knowledgeBaseEmptyBefore':True,
                'rememberedPreferences':record['seed']['recordsBeforeAnswer']} })
    return rows

if __name__=='__main__':
    rows=collect(sys.argv[1])
    Path(sys.argv[2]).write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
    print(json.dumps({'rows':len(rows),'withArtifacts':sum(bool(r['artifacts']) for r in rows),'withMemoryReads':sum(bool(r['memoryReads']) for r in rows)}))
