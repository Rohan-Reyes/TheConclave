// Native image arguments come only from uploaded files inside this project.
import fs from 'node:fs';
import path from 'node:path';

const inside = (base, file) => { const rel = path.relative(base, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
export function messageImages(text, cwd) {
  if (!cwd) return [];
  try {
    const root = fs.realpathSync(cwd);
    const uploads = fs.realpathSync(path.join(root, '.conclave', 'attachments'));
    if (!inside(root, uploads)) return [];
    const images = [];
    for (const match of String(text || '').matchAll(/^- Image:[^\n]*?\(canonical path: `([^`\n]+)`\)/gm)) {
      try {
        const image = fs.realpathSync(match[1]);
        const stat = fs.statSync(image);
        if (inside(uploads, image) && /\.(png|jpe?g|webp|gif)$/i.test(image) && stat.isFile() && stat.size <= 4 * 1024 * 1024 && !images.includes(image)) images.push(image);
      } catch {}
      if (images.length >= 8) break;
    }
    return images;
  } catch { return []; }
}
