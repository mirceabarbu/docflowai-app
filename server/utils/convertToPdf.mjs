import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink, mkdtemp, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join, extname, basename } from 'path';
import { PDFDocument } from 'pdf-lib';
import crypto from 'crypto';

const exec = promisify(execFile);

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
      return await readFile(outPath);
    } finally {
      await unlink(inPath).catch(() => {});
      await unlink(outPath).catch(() => {});
      await rm(tmpDir,     { recursive: true, force: true }).catch(() => {});
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  throw new Error(`Tip fișier nesuportat: ${ext}`);
}
