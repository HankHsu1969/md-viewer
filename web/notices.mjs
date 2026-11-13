// 產生第三方元件授權聲明（THIRD-PARTY-NOTICES.txt）
// 收集 node_modules 裡所有正式相依套件的授權全文，再加上微軟 WebView2 SDK 的授權。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 雙重授權的套件：註明我們選用哪一個
const CHOSEN = {
  dompurify: 'Apache-2.0（原為 MPL-2.0 OR Apache-2.0 雙授權，本程式選用 Apache-2.0）',
  elkjs: 'EPL-2.0（原為 EPL-2.0 OR GPL-3.0-or-later 雙授權，本程式選用 EPL-2.0）。原始碼可於 https://github.com/kieler/elkjs 取得',
};

function readLicenseText(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^(licen[cs]e|copying)/i.test(f)).sort();
  return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim()).join('\n\n');
}

function repoUrl(pkg) {
  let r = pkg.repository;
  if (r && typeof r === 'object') r = r.url;
  if (!r && pkg.homepage) r = pkg.homepage;
  if (!r) return '';
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r}`;
  return String(r).replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, 'https://github.com/');
}

export function generateNotices(webDir, wv2Dir) {
  const dirs = execSync('npm ls --omit=dev --all --parseable', { cwd: webDir, encoding: 'utf8' })
    .trim().split(/\r?\n/).slice(1);
  const seen = new Set();
  const groups = new Map(); // 授權全文 -> 套件清單
  for (const dir of dirs) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
    if (pkg.name.startsWith('@types/')) continue; // 只有型別宣告，不會打包進程式
    const id = `${pkg.name}@${pkg.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const license = CHOSEN[pkg.name] || (typeof pkg.license === 'string' ? pkg.license : (pkg.license && pkg.license.type) || 'MIT');
    const text = readLicenseText(dir) || `（套件未附授權全文，授權類型：${license}）`;
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push({ id, license, url: repoUrl(pkg) });
  }

  const line = '='.repeat(72);
  let out = '';
  out += 'MD 閱讀器（MDViewer）— 第三方元件授權聲明\n';
  out += 'Third-party software notices for MDViewer\n\n';
  out += '本程式使用了下列開源元件，依照各元件的授權條款附上授權聲明。\n';
  out += 'This program includes the open-source components listed below.\n';
  out += 'Their license notices are reproduced here as required by their licenses.\n\n';

  if (wv2Dir && fs.existsSync(path.join(wv2Dir, 'LICENSE.txt'))) {
    const nuspec = fs.readFileSync(path.join(wv2Dir, 'Microsoft.Web.WebView2.nuspec'), 'utf8');
    const ver = (/<version>([^<]+)<\/version>/.exec(nuspec) || [])[1] || '';
    out += `${line}\nMicrosoft.Web.WebView2 ${ver}\n授權 / License: Microsoft (BSD-style)\nhttps://aka.ms/webview2\n${line}\n\n`;
    out += fs.readFileSync(path.join(wv2Dir, 'LICENSE.txt'), 'utf8').trim() + '\n\n';
    if (fs.existsSync(path.join(wv2Dir, 'NOTICE.txt'))) out += fs.readFileSync(path.join(wv2Dir, 'NOTICE.txt'), 'utf8').trim() + '\n\n';
  }

  const sorted = [...groups.entries()].sort((a, b) => a[1][0].id.localeCompare(b[1][0].id));
  for (const [text, pkgs] of sorted) {
    out += `${line}\n`;
    for (const p of pkgs) out += `${p.id}  —  ${p.license}${p.url ? '  —  ' + p.url : ''}\n`;
    out += `${line}\n\n${text}\n\n`;
  }
  return { text: out, count: seen.size + 1 };
}
