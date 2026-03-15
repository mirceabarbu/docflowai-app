import { google } from "googleapis";

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON lipsește din environment.");
  const creds = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

// Creează folder dacă nu există, returnează ID
async function ensureFolder(drive, name, parentId) {
  const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
    fields: "files(id,name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  return created.data.id;
}

// Normalizează diacritice pentru nume foldere Drive (ă→a, î→i, ș→s etc.)
function normalizeForFolder(str) {
  return (str || "Necunoscut")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // elimină diacritice
    .replace(/[^\w\s\-]/g, "")                        // elimină caractere speciale
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 50);
}

// Structură: DocFlowAI/Institutie/An/Luna/FlowId/
async function ensureFlowFolder(drive, institutie, createdAt, flowId) {
  const date = new Date(createdAt || Date.now());
  const an = String(date.getFullYear());
  const luna = String(date.getMonth() + 1).padStart(2, "0");
  const instClean = normalizeForFolder(institutie);

  const instFolder = await ensureFolder(drive, instClean, ROOT_FOLDER_ID);
  const anFolder = await ensureFolder(drive, an, instFolder);
  const lunaFolder = await ensureFolder(drive, luna, anFolder);
  const flowFolder = await ensureFolder(drive, flowId || "FLOW_UNKNOWN", lunaFolder);
  return flowFolder;
}

// Upload fișier, returnează { id, webViewLink }
async function uploadFile(drive, folderId, name, buffer, mimeType) {
  const { Readable } = await import("stream");
  const stream = Readable.from(buffer);
  const res = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType, body: stream },
    fields: "id,webViewLink",
    supportsAllDrives: true,
  });
  return { id: res.data.id, webViewLink: res.data.webViewLink };
}

// Arhivează un flow complet
export async function archiveFlow(flowData, pool) {
  if (!ROOT_FOLDER_ID) throw new Error("GOOGLE_DRIVE_FOLDER_ID lipsește.");
  const drive = getDrive();

  // Multi-tenant: folosim flowData.institutie setat la creare, NU derivăm din email
  const institutie = (flowData.institutie || "").trim() || "Necunoscut";
  const folderId = await ensureFlowFolder(drive, institutie, flowData.createdAt, flowData.flowId);

  const safeName = (flowData.docName || "document").replace(/[^\w\s\-]/g, "").trim().substring(0, 60);
  const prefix = `${flowData.flowId}_${safeName}`;
  const result = {};

  // 1. PDF final semnat
  if (flowData.signedPdfB64) {
    const raw = flowData.signedPdfB64.includes("base64,")
      ? flowData.signedPdfB64.split("base64,")[1]
      : flowData.signedPdfB64;
    const buf = Buffer.from(raw, "base64");
    const up = await uploadFile(drive, folderId, `${prefix}_semnat.pdf`, buf, "application/pdf");
    result.driveFileIdFinal = up.id;
    result.driveFileLinkFinal = up.webViewLink;
  }

  // 2. PDF original
  if (flowData.pdfB64) {
    const raw = flowData.pdfB64.includes("base64,")
      ? flowData.pdfB64.split("base64,")[1]
      : flowData.pdfB64;
    const buf = Buffer.from(raw, "base64");
    const up = await uploadFile(drive, folderId, `${prefix}_original.pdf`, buf, "application/pdf");
    result.driveFileIdOriginal = up.id;
    result.driveFileLinkOriginal = up.webViewLink;
  }

  // 3. Documente suport (flow_attachments) — dacă pool disponibil
  if (pool) {
    try {
      const { rows: attachments } = await pool.query(
        'SELECT id, filename, mime_type, data FROM flow_attachments WHERE flow_id=$1 ORDER BY uploaded_at ASC',
        [flowData.flowId]
      );
      const driveAttachments = [];
      for (const att of attachments) {
        const safeFn = att.filename.replace(/[^\w\-\.]/g, '_').substring(0, 100);
        const up = await uploadFile(drive, folderId, `${prefix}_suport_${safeFn}`, att.data, att.mime_type);
        // Actualizare drive_file_id în DB
        await pool.query(
          'UPDATE flow_attachments SET drive_file_id=$1, drive_file_link=$2 WHERE id=$3',
          [up.id, up.webViewLink, att.id]
        ).catch(() => {});
        driveAttachments.push({ id: att.id, filename: att.filename, driveFileId: up.id, driveFileLink: up.webViewLink });
      }
      if (driveAttachments.length) result.driveAttachments = driveAttachments;
    } catch(attErr) {
      // Non-fatal — continuăm arhivarea fără documente suport
      console.warn('[drive] archiveFlow attachments error (non-fatal):', attErr.message);
    }
  }

  // 4. Audit JSON
  const audit = {
    flowId: flowData.flowId,
    docName: flowData.docName,
    initName: flowData.initName,
    initEmail: flowData.initEmail,
    createdAt: flowData.createdAt,
    completedAt: flowData.completedAt,
    signers: (flowData.signers || []).map(s => ({
      name: s.name, email: s.email, rol: s.rol,
      functie: s.functie, compartiment: s.compartiment,
      status: s.status, signedAt: s.signedAt,
    })),
    events: flowData.events || [],
  };
  const auditBuf = Buffer.from(JSON.stringify(audit, null, 2), "utf8");
  const upAudit = await uploadFile(drive, folderId, `${prefix}_audit.json`, auditBuf, "application/json");
  result.driveFileIdAudit = upAudit.id;
  result.driveFileLinkAudit = upAudit.webViewLink;
  result.driveFolderId = folderId;

  return result;
}

// Stream PDF din Drive direct către response (proxy — fără redirect public)
export async function streamFromDrive(fileId, res) {
  const drive = getDrive();
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );
  await new Promise((resolve, reject) => {
    response.data
      .on("error", reject)
      .on("end", resolve)
      .pipe(res, { end: true });
  });
}

export async function getBufferFromDrive(fileId) {
  const drive = getDrive();
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(response.data);
}

// Verifică conexiunea Drive
export async function verifyDrive() {
  const drive = getDrive();
  const res = await drive.files.get({ fileId: ROOT_FOLDER_ID, fields: "id,name", supportsAllDrives: true });
  return { ok: true, folder: res.data.name, folderId: res.data.id };
}
