/**
 * server/modules/archive/drive.mjs — Google Drive upload wrapper (v4)
 *
 * Simple file upload to the configured root Drive folder.
 * Use the full archiveFlow from server/drive.mjs for flow-level archiving.
 */

import { Readable } from 'stream';
import { AppError } from '../../core/errors.mjs';
import { logger }   from '../../middleware/logger.mjs';

function _getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || raw === '{}' || raw === '') {
    throw new AppError('GOOGLE_SERVICE_ACCOUNT_JSON nu este configurat', 503, 'DRIVE_NOT_CONFIGURED');
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    throw new AppError('GOOGLE_SERVICE_ACCOUNT_JSON invalid (JSON malformat)', 503, 'DRIVE_BAD_CONFIG');
  }
  if (!creds.type && !creds.client_email) {
    throw new AppError('GOOGLE_SERVICE_ACCOUNT_JSON nu conține credențiale valide', 503, 'DRIVE_BAD_CREDS');
  }
  // Dynamic import pentru googleapis (lazy — nu penalizăm startup-ul)
  return creds;
}

async function _getDrive() {
  const creds = _getAuth();
  const { google } = await import('googleapis');
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes:      ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// ── uploadToDrive ─────────────────────────────────────────────────────────────

/**
 * Upload fișier în folderul root configurat (GOOGLE_DRIVE_FOLDER_ID).
 *
 * @param {Buffer} fileBuffer
 * @param {string} fileName
 * @param {string} mimeType
 * @returns {Promise<{ id: string, webViewLink: string }>}
 */
export async function uploadToDrive(fileBuffer, fileName, mimeType) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    throw new AppError('GOOGLE_DRIVE_FOLDER_ID nu este configurat', 503, 'DRIVE_NOT_CONFIGURED');
  }

  const drive  = await _getDrive();
  const stream = Readable.from(fileBuffer);

  try {
    const res = await drive.files.create({
      requestBody: {
        name:    fileName,
        parents: [folderId],
      },
      media: {
        mimeType,
        body: stream,
      },
      fields:            'id,webViewLink',
      supportsAllDrives: true,
    });
    logger.info({ fileId: res.data.id, fileName }, 'Drive: fișier uploadat');
    return { id: res.data.id, webViewLink: res.data.webViewLink || '' };
  } catch (e) {
    logger.error({ err: e, fileName }, 'Drive: upload error');
    throw new AppError(`Upload Drive eșuat: ${e.message}`, 502, 'DRIVE_UPLOAD_FAILED');
  }
}

// ── nullifyDriveFile ──────────────────────────────────────────────────────────

/**
 * Suprascrie conținutul unui fișier Drive cu un placeholder minimal.
 * Folosit după arhivare locală pentru a elibera spațiu pe Drive când fișierul
 * nu mai este necesar în forma originală.
 */
export async function nullifyDriveFile(fileId) {
  if (!fileId) return;
  try {
    const drive = await _getDrive();
    const placeholder = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\nstartxref\n9\n%%EOF');
    await drive.files.update({
      fileId,
      media: {
        mimeType: 'application/pdf',
        body:     Readable.from(placeholder),
      },
      supportsAllDrives: true,
    });
    logger.info({ fileId }, 'Drive: fișier nullified');
  } catch (e) {
    logger.warn({ err: e, fileId }, 'Drive: nullify error (non-fatal)');
  }
}
