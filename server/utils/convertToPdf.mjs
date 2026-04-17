import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join, extname, basename } from 'path';
import { PDFDocument } from 'pdf-lib';

const execFileAsync = promisify(execFile);

const IMAGE_TYPES = ['.jpg','.jpeg','.png','.gif','.webp','.bmp'];
const OFFICE_TYPES = ['.docx','.doc','.xlsx','.xls','.pptx','.ppt','.odt','.ods','.odp'];

export async function convertToPdf(buffer, originalName) {
  const ext = extname(originalName).toLowerCase();

  // PDF → direct
  if (ext === '.pdf') return buffer;

  // Imagini → embed în PDF via pdf-lib
  if (IMAGE_TYPES.includes(ext)) {
    const pdfDoc = await PDFDocument.create();
    let img;
    if (ext === '.png') {
      img = await pdfDoc.embedPng(buffer);
    } else {
      img = await pdfDoc.embedJpg(buffer);
    }
    const page = pdfDoc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }

  // Office (DOCX/XLSX etc.) → LibreOffice headless
  if (OFFICE_TYPES.includes(ext)) {
    const tmpDir = await mkdtemp(join(tmpdir(), 'docflow-conv-'));
    const inputPath = join(tmpDir, basename(originalName));
    const outputPath = join(tmpDir, basename(originalName, ext) + '.pdf');
    try {
      await writeFile(inputPath, buffer);
      await execFileAsync('libreoffice', [
        '--headless', '--convert-to', 'pdf',
        '--outdir', tmpDir, inputPath
      ], { timeout: 60_000 });
      const pdfBuffer = await readFile(outputPath);
      return pdfBuffer;
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
  }

  throw new Error(`Tip fișier nesuportat pentru conversie: ${ext}`);
}

export const ACCEPTED_EXTENSIONS =
  [...IMAGE_TYPES, ...OFFICE_TYPES, '.pdf'];
