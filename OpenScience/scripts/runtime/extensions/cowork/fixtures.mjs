/** Neutral public fixtures, generated without loading any vendor package on the host. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
export function zip(entries){
  const bodies=[],directory=[];let offset=0;
  for(const [name,value]of Object.entries(entries)){
    const data=Buffer.from(value),filename=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc32(data),14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc32(data),16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
    bodies.push(local,filename,data);directory.push(central,filename);offset+=local.length+filename.length+data.length;
  }
  const records=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(directory.length/2,8);end.writeUInt16LE(directory.length/2,10);end.writeUInt32LE(records.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...bodies,records,end]);
}
export async function createFixtures(root){
  await fs.mkdir(root,{recursive:true});const resources={};
  async function add(id,file,format,bytes){const data=Buffer.from(bytes);await fs.writeFile(path.join(root,file),data);resources[id]={file,format,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),dataClass:'public'};}
  const docx={'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Public technical fixture 公开文档</w:t></w:r></w:p></w:body></w:document>'};
  await add('res_docx','public.docx','docx',zip(docx));
  await add('res_external','external.docx','docx',zip({...docx,'word/_rels/document.xml.rels':'<Relationships><Relationship TargetMode="External" Target="https://example.invalid/"/></Relationships>'}));
  await add('res_macro','macro.xlsx','xlsx',zip({'xl/workbook.xml':'<workbook/>','xl/vbaProject.bin':'macro'}));
  const ipynb={nbformat:4,nbformat_minor:5,metadata:{},cells:[{cell_type:'markdown',metadata:{},source:['Public notebook 公开笔记'],outputs:[]},{cell_type:'code',metadata:{},source:['raise SystemExit("must remain inert")'],outputs:[],execution_count:null}]};
  await add('res_notebook','public.ipynb','ipynb',JSON.stringify(ipynb));
  const stream='BT /F1 12 Tf 50 750 Td (Public PDF fixture 42) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const start=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  await add('res_pdf','public.pdf','pdf',pdf);
  await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({resources}));return resources;
}
