import { openAsBlob } from 'node:fs';
import { listZip, entryFile, expandZip, isImageryZip } from './app/src/formats/zip-container.js';
const b = await openAsBlob(process.argv[2]);
const f = new File([b], 'x.zip');
try { const es = await listZip(f); console.log('entries', es.length, es.slice(0, 3)); 
  const inner = await entryFile(f, es.find((e) => e.name.endsWith('.zip')));
  console.log('inner', inner.size); console.log((await listZip(inner)).slice(0, 3).map((e) => e.path));
} catch (e) { console.log('ERR', e.message); }
console.log('isImagery', await isImageryZip(f));
