// Compile the same TypeScript core used by Web Workers, without a second model.
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
export async function loadCore() {
    const dir=await mkdtemp(join(tmpdir(),'dice-core-'));
    await symlink(join(root,'node_modules'),join(dir,'node_modules'),'dir');
    await writeFile(join(dir,'package.json'),'{"type":"module"}');
    for(const name of ['ble','math','faces','model','physics','learning','record','trajectory']) {
        const source=await readFile(join(root,'src',`${name}.ts`),'utf8');
        const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
            .replace(/(from\s+['"]\.\/[\w.-]+)(['"])/g,'$1.js$2');
        await writeFile(join(dir,`${name}.js`),code);
    }
    const cleanup=()=>rm(dir,{recursive:true,force:true});
    const modules={};
    for(const name of ['math','faces','model','physics','learning','record','trajectory']) modules[name]=await import(pathToFileURL(join(dir,`${name}.js`)));
    return {...modules,cleanup};
}
