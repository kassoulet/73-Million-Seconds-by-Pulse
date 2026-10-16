// node tools/mkmanifest.mjs  -> docs/assets/manifest.json (list of asset files) and docs/notes/index.json (list of fragments)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const list = (d, f = () => true) => fs.readdirSync(path.join(root, d)).filter((n) => n !== 'manifest.json' && n !== 'index.json' && f(n)).sort();
fs.writeFileSync(path.join(root, 'docs/assets/manifest.json'), JSON.stringify(list('docs/assets')));
fs.writeFileSync(path.join(root, 'docs/notes/index.json'), JSON.stringify(list('docs/notes', (n) => n.endsWith('.html'))));
console.log('manifest ok');
