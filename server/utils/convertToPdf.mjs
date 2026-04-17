import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join, extname, basename } from 'path';
import { PDFDocument } from 'pdf-lib';

const exec = promisify(execFile);

const IMAGE_EXTS  = ['.jpg','.jpeg','.png','.gif','.webp','.bmp'];
const OFFICE_EXTS = ['.docx','.doc','.xlsx','.xls',
                     '.pptx','.ppt','.odt','.ods','.odp'];

export async function convertToPdf(buffer, originalName) {
  const ext = extname(originalName).toLowerCase();
  if (ext === '.pdf') return buffer;

  // Imagini → pdf-lib (fără LibreOffice, mai rapid)
  if (IMAGE_EXTS.includes(ext)) {
    const pdfDoc = await PDFDocument.create();
    const img = (ext === '.png')
      ? await pdfDoc.embedPng(buffer)
      : await pdfDoc.embedJpg(buffer);
    const page = pdfDoc.addPage([img.width, img.height]);
    page.drawImage(img, { x:0, y:0, width:img.width, height:img.height });
    return Buffer.from(await pdfDoc.save());
  }

  // Office → LibreOffice headless (fidelitate vizuală 100%)
  if (OFFICE_EXTS.includes(ext)) {
    const tmpDir = await mkdtemp(join(tmpdir(), 'docflow-'));
    const inPath  = join(tmpDir, basename(originalName));
    const outPath = join(tmpDir,
      basename(originalName, ext) + '.pdf');
    try {
      await writeFile(inPath, buffer);
      await exec('libreoffice', [
        '--headless',
        '--norestore',
        '--nofirststartwizard',
        '--convert-to', 'pdf',
        '--outdir', tmpDir,
        inPath
      ], {
        timeout: 90_000,
        env: { ...process.env, HOME: '/tmp' }
      });
      return await readFile(outPath);
    } finally {
      await unlink(inPath).catch(()=>{});
      await unlink(outPath).catch(()=>{});
    }
  }

  throw new Error(`Tip fișier nesuportat: ${ext}`);
}

export const ACCEPTED_EXTENSIONS =
  [...IMAGE_EXTS, ...OFFICE_EXTS, '.pdf'];
