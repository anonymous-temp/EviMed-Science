import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {isBuiltin} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import ts from 'typescript';

test('every literal production server package import survives a production-only deployment',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const missing=[];let modules=0;
  async function scan(directory){
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()){await scan(file);continue;}
      if(!entry.isFile()||!entry.name.endsWith('.mjs'))continue;
      modules++;
      const source=ts.createSourceFile(file,await fs.readFile(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
      const inspect=node=>{
        let specifier;
        if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))specifier=node.moduleSpecifier;
        else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require'))specifier=node.arguments[0];
        if(specifier&&ts.isStringLiteralLike(specifier)){
          const name=specifier.text;
          if(!name.startsWith('.')&&!name.startsWith('/')&&!isBuiltin(name)){
            const dependency=name.startsWith('@')?name.split('/').slice(0,2).join('/'):name.split('/')[0];
            if(!Object.hasOwn(manifest.dependencies,dependency))missing.push(`${path.relative(root,file)}: ${dependency}`);
          }
        }
        ts.forEachChild(node,inspect);
      };
      inspect(source);
    }
  }
  await scan(path.join(root,'src'));
  assert(modules>100,'The full production source tree must have been scanned.');
  assert.deepEqual([...new Set(missing)].sort(),[],'Runtime imports must be direct production dependencies, not development or transitive packages.');
});
