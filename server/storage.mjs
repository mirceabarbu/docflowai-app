import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.SEMDOC_DATA_DIR || path.join(process.cwd(), 'data');
const FLOWS_PATH = path.join(DATA_DIR, 'flows.json');

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(FLOWS_PATH); }
  catch { await fs.writeFile(FLOWS_PATH, JSON.stringify({ flows: {} }, null, 2), 'utf8'); }
}

export async function readAll() {
  await ensure();
  const raw = await fs.readFile(FLOWS_PATH, 'utf8');
  return JSON.parse(raw);
}

export async function writeAll(obj) {
  await ensure();
  await fs.writeFile(FLOWS_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

export function nowIso() { return new Date().toISOString(); }

export function genId() {
  return 'FLOW-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10).toUpperCase();
}

export function sanitizeSigner(s) {
  return {
    order: Number(s.order) || 0,
    rol: String(s.rol || '').slice(0, 120),
    name: String(s.name || '').slice(0, 160),
    email: String(s.email || '').slice(0, 200),
    status: s.status === 'signed' ? 'signed' : 'pending',
    signedAt: s.signedAt || null,
    token: String(s.token || ''),
  };
}
