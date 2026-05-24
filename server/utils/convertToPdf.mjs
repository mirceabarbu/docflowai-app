import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink, mkdtemp, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join, extname, basename } from 'path';
import { PDFDocument, PDFArray, PDFRawStream } from 'pdf-lib';
import zlib from 'zlib';
import crypto from 'crypto';

const exec = promisify(execFile);

// v3.9.494: LibreOffice produce uneori pagini trailing goale când conversia
// DOCX→PDF interpretează layout-ul diferit de Word (paginare diferită).
// Trim-uim paginile trailing fără conținut real înainte de stamping pentru
// a evita „pagina albă între body și cartuș".
export function pageHasRenderableContent(page) {
  try {
    const ctx = page.doc.context;
    const contentsRef = page.node.Contents();
    if (!contentsRef) return false;

    const streams = [];
    if (contentsRef instanceof PDFArray) {
      for (let i = 0; i < contentsRef.size(); i++) {
        const r = ctx.lookup(contentsRef.get(i));
        if (r) streams.push(r);
      }
    } else {
      const r = ctx.lookup(contentsRef);
      if (r) streams.push(r);
    }

    for (const s of streams) {
      if (!(s instanceof PDFRawStream) || !s.contents) continue;
      let text;
      try { text = zlib.inflateSync(Buffer.from(s.contents)).toString('latin1'); }
      catch { text = Buffer.from(s.contents).toString('latin1'); }

      // Caut text-show operators (Tj, TJ, ', ") SAU rectangle (re) SAU
      // image-show (Do). Orice paginare LibreOffice care a vrut să tipărească
      // ceva pe pagină ar lăsa măcar un Tj/TJ. Pagini cu doar CTM/empty BT/ET
      // sunt considerate trailing-empty.
      if (/\bTj\b|\bTJ\b|\bDo\b/.test(text)) return true;
      // Forme geometrice — linii (l), curbe (c), umpleri (f), stroke (S)
      // după path-construction. Verific path operators de bază.
      if (/\bre\s+[fFSsBb]\b|\bm\s+[\d.\-\s]+\bl\b/.test(text)) return true;
    }
    return false;
  } catch {
    // Pe orice eroare, fii conservativ — păstrează pagina (nu pierde date).
    return true;
  }
}

export async function trimEmptyTrailingPages(pdfBuffer) {
  const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const total = doc.getPageCount();
  if (total <= 1) return pdfBuffer;

  let trimCount = 0;
  for (let i = total - 1; i > 0; i--) {
    if (pageHasRenderableContent(doc.getPage(i))) break;
    doc.removePage(i);
    trimCount++;
  }
  if (trimCount === 0) return pdfBuffer;
  return Buffer.from(await doc.save());
}

// pdf-lib suportă nativ doar jpg/png — fast path, fără subprocess
const FAST_IMAGE_EXTS = ['.jpg', '.jpeg', '.png'];

// LibreOffice: fișiere Office + imagini pe care pdf-lib nu le suportă
const LO_EXTS = [
  '.docx', '.doc', '.xlsx', '.xls',
  '.pptx', '.ppt', '.odt', '.ods', '.odp',
  '.gif', '.webp', '.bmp',
];

export const ACCEPTED_EXTENSIONS = ['.pdf', ...FAST_IMAGE_EXTS, ...LO_EXTS];

export async function convertToPdf(buffer, originalName) {
  const ext = extname(originalName).toLowerCase();

  // PDF passthrough
  if (ext === '.pdf') return buffer;

  // Fast path: jpg/png → pdf-lib (~10ms, fără subprocess)
  if (FAST_IMAGE_EXTS.includes(ext)) {
    const pdfDoc = await PDFDocument.create();
    const img = ext === '.png'
      ? await pdfDoc.embedPng(buffer)
      : await pdfDoc.embedJpg(buffer);
    const page = pdfDoc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    return Buffer.from(await pdfDoc.save());
  }

  // LibreOffice path: office docs + gif/webp/bmp
  if (LO_EXTS.includes(ext)) {
    const uid        = crypto.randomBytes(8).toString('hex');
    const tmpDir     = await mkdtemp(join(tmpdir(), 'docflow-'));
    const profileDir = join(tmpdir(), `lo-profile-${uid}`);
    const inPath     = join(tmpDir, basename(originalName));
    const outPath    = join(tmpDir, basename(originalName, ext) + '.pdf');

    try {
      await writeFile(inPath, buffer);
      await exec('libreoffice', [
        '--headless',
        '--norestore',
        '--nofirststartwizard',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to', 'pdf',
        '--outdir', tmpDir,
        inPath,
      ], {
        timeout: 90_000,
        env: { ...process.env, HOME: '/tmp' },
      });

      // Verificare explicită: dacă LibreOffice a eșuat silențios
      await access(outPath);
      const raw = await readFile(outPath);
      // v3.9.494: trim pagini trailing goale (LibreOffice produce uneori
      // pagina suplimentară goală când layout-ul DOCX diferă de Word).
      try { return await trimEmptyTrailingPages(raw); }
      catch { return raw; }
    } finally {
      await unlink(inPath).catch(() => {});
      await unlink(outPath).catch(() => {});
      await rm(tmpDir,     { recursive: true, force: true }).catch(() => {});
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  throw new Error(`Tip fișier nesuportat: ${ext}`);
}
