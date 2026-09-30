import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { createDocumentRenderController, documentExportDirectory } from '../src/documentRenderController.mjs';
import { exportHash } from '../src/documentExport.mjs';
import { DOCUMENT_RENDERER_VERSION, VCR_EXPORT_KINDS } from '@evimed/domain';
import { canonicalVcrDocument } from '../src/vcrDocumentExport.mjs';

const image = process.env.OPEN_SCIENCE_DOCUMENT_RENDER_TEST_IMAGE;
const destination = process.env.OPEN_SCIENCE_DOCUMENT_RENDER_TEST_OUTPUT ?? '/tmp/evimed-document-render-acceptance';
function png() {
  const width=160, height=80;
  const pixels=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=y*(width*3+1)+1+x*3;
    pixels[i]=30; pixels[i+1]=90+(x%70); pixels[i+2]=200;
  }
  const crc = data => { let n=0xffffffff; for(const x of data){n^=x;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0; };
  const chunk=(kind,data)=>{const name=Buffer.from(kind),size=Buffer.alloc(4),check=Buffer.alloc(4);size.writeUInt32BE(data.length);check.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([size,name,data,check]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

test('real isolated runtime renders Chinese tables, figures, math and all three formats', { skip: !image && 'Set OPEN_SCIENCE_DOCUMENT_RENDER_TEST_IMAGE to a renderer-enabled test runtime.', timeout: 210000 }, async () => {
  const config = { dataDir: destination, runtimeContainerImage: image, runtimeContainerBin: 'docker' };
  await fs.mkdir(destination, { recursive: true });
  const imageId = spawnSync('docker',['image','inspect','--format','{{.Id}}',image],{encoding:'utf8'}).stdout.trim();
  assert.ok(imageId.startsWith('sha256:'));
  // Docker Desktop's VM is the render host; read its actual headroom rather
  // than treating macOS's reclaimable file cache as unavailable memory.
  const memory = spawnSync('docker',['run','--rm','--network=none','--entrypoint','cat',image,'/proc/meminfo'],{encoding:'utf8',timeout:10000});
  assert.equal(memory.status,0,memory.stderr);
  const available = Number(memory.stdout.match(/^MemAvailable:\s+(\d+)/m)?.[1])*1024;
  const reference = { ownerId:'render-test', projectId:'scientific-report', exportId:'export-one', attemptId:`attempt-${Date.now()}` };
  const directory = path.join(documentExportDirectory(config,reference),'attempts',reference.attemptId);
  await fs.mkdir(path.join(directory,'input'),{recursive:true});await fs.mkdir(path.join(directory,'output'));
  const figure=png();await fs.writeFile(path.join(directory,'input/figure.png'),figure);
  const canonicalMarkdown='# 中文循证研究\n\nMixed Latin 95% CI; effect 12.5; 缺失值：未计算。\n\n数学：$x=\\beta+0.5$。\n\n![本地研究图](figure.png)\n\n| 指标 | 结果 |\n|---|---|\n'+Array.from({length:120},(_,i)=>`| 样本 ${i} | ${i}.25 |`).join('\n')+'\n\n## 参考文献\n\n[1] Example reference.\n';
  const input={version:1,rendererVersion:DOCUMENT_RENDERER_VERSION,rendererImage:imageId,sourceDigest:exportHash(canonicalMarkdown),canonicalMarkdown,title:'中文循证研究',assets:[{path:'figure.png',mime:'image/png',sha256:exportHash(figure)}],formats:['docx','pdf','html']};
  const bytes=JSON.stringify(input);await fs.writeFile(path.join(directory,'input/document.json'),bytes);reference.inputDigest=exportHash(bytes);
  const controller=createDocumentRenderController(config,{availableMemory:async()=>available});
  const started=Date.now();
  await controller.render(reference);
  await controller.close();
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'output/manifest.json'),'utf8'));
  for(const format of ['docx','pdf','html']){
    const outcome=manifest.formats[format];assert.equal(outcome.state,'ready',JSON.stringify(manifest));
    assert.equal(exportHash(await fs.readFile(path.join(directory,'output',outcome.path))),outcome.sha256);
  }
  const html=await fs.readFile(path.join(directory,'output/document.html'),'utf8');
  assert.match(html,/data:image\/png;base64/);assert.match(html,/119\.25/);assert.match(html,/<math/);
  const vcrOutputs = [];
  for (const kind of VCR_EXPORT_KINDS) {
    const study = { id:'study', name:'虚拟研究', intendedUse:'exploratory' };
    const canonical = canonicalVcrDocument(study, { kind, cover:{ results:{ study, counts:{sample:42}, review:{records:[]}, stale:[] }, reports:[
      { section:'Methods', template:'样本量 {{n:counts.sample|int}}。\n\n![研究图](figure.png)' },
      { section:'Limitations', template:'缺失值 {{n:counts.missing}}。' },
    ] } });
    const reference2 = { ...reference, exportId:kind };
    const dir = path.join(documentExportDirectory(config,reference2),'attempts',reference2.attemptId);
    await fs.mkdir(path.join(dir,'input'),{recursive:true});await fs.mkdir(path.join(dir,'output'));
    await fs.writeFile(path.join(dir,'input/figure.png'),figure);
    const document = { ...input, ...canonical, assets:input.assets, sourceDigest:exportHash(canonical.canonicalMarkdown) };
    const frozen = JSON.stringify(document);
    await fs.writeFile(path.join(dir,'input/document.json'),frozen);
    reference2.inputDigest = exportHash(frozen);
    await controller.render(reference2);
    const rendered = JSON.parse(await fs.readFile(path.join(dir,'output/manifest.json'),'utf8'));
    for (const format of ['docx','pdf','html']) assert.equal(rendered.formats[format].state,'ready',JSON.stringify(rendered));
    vcrOutputs.push({ kind, outputDirectory:path.join(dir,'output'), canonicalMarkdown:canonical.canonicalMarkdown, manifest:rendered });
  }
  const check = spawnSync(process.env.OPEN_SCIENCE_DOCUMENT_RENDER_TEST_PYTHON ?? 'python3', ['-c', `
import json, re, sys, unicodedata
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree
from pypdf import PdfReader
cases=json.loads(sys.stdin.read())
for case in cases:
 root=Path(case['outputDirectory'])
 with ZipFile(root/'document.docx') as archive:
  text=' '.join(ElementTree.fromstring(archive.read('word/document.xml')).itertext())
  assert any(name.startswith('word/media/') for name in archive.namelist())
 pdf=PdfReader(root/'document.pdf')
 pdf_text=unicodedata.normalize('NFKC',' '.join(page.extract_text(extraction_mode='layout') for page in pdf.pages))
 expected=set(re.findall(r'\\d+(?:\\.\\d+)?',case['canonicalMarkdown']))
 assert expected <= set(re.findall(r'\\d+(?:\\.\\d+)?',text)), 'DOCX numeric tokens missing'
 assert expected <= set(re.findall(r'\\d+(?:\\.\\d+)?',pdf_text)), 'PDF numeric tokens missing'
 assert '未计算' in pdf_text
print(json.dumps({'verifiedDocuments':len(cases)},ensure_ascii=False))
`], { input:JSON.stringify([{ outputDirectory:path.join(directory,'output'), canonicalMarkdown },...vcrOutputs]), encoding:'utf8', timeout:30000 });
  assert.equal(check.status,0,check.stderr);
  await fs.writeFile(path.join(destination,'acceptance.json'),JSON.stringify({imageId,rendererVersion:DOCUMENT_RENDERER_VERSION,availableMemory:available,elapsedMs:Date.now()-started,outputDirectory:path.join(directory,'output'),sourceDigest:input.sourceDigest,manifest,vcrOutputs,textCheck:JSON.parse(check.stdout)},null,2));
});
