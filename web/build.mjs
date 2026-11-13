// 把網頁部分打包到 ../build/web（之後會被嵌入 EXE）
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateNotices } from './notices.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'build', 'web');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: { app: path.join(here, 'main.js') },
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome110'],
  outdir: out,
  legalComments: 'none',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  assetNames: 'fonts/[name]',
  logLevel: 'warning',
});

fs.copyFileSync(path.join(here, 'index.html'), path.join(out, 'index.html'));
fs.copyFileSync(path.join(here, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'), path.join(out, 'mermaid.min.js'));

// WebView2 只會用到 woff2，刪掉 woff/ttf 讓 EXE 小一點
const fontDir = path.join(out, 'fonts');
for (const f of fs.readdirSync(fontDir)) if (!f.endsWith('.woff2')) fs.rmSync(path.join(fontDir, f));

// 第三方授權聲明：嵌進程式（關於畫面可看）＋放在專案根目錄
const notices = generateNotices(here, path.resolve(here, '..', 'build', 'deps', 'wv2'));
fs.writeFileSync(path.join(out, 'licenses.txt'), notices.text, 'utf8');
fs.writeFileSync(path.resolve(here, '..', 'THIRD-PARTY-NOTICES.txt'), notices.text, 'utf8');
console.log(`授權聲明：${notices.count} 個元件`);

let total = 0;
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else total += s.size; } };
walk(out);
console.log(`網頁打包完成：${out}（${(total / 1024 / 1024).toFixed(2)} MB）`);
