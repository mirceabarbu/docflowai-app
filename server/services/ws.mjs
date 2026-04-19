/**
 * server/services/ws.mjs — WebSocket server for DocFlowAI v4.
 *
 * Provides real-time push to connected browser clients.
 * Auth: JWT from ?token= query param or Authorization header.
 * Connections tracked in two Maps:
 *   _byUser: Map<userId, Set<ws>>   — for per-user push
 *   _byOrg:  Map<orgId,  Set<ws>>   — for org-wide broadcast
 */

import { WebSocketServer } from 'ws';
import jwt                 from 'jsonwebtoken';
import { logger }          from '../middleware/logger.mjs';

const JWT_SECRET = process.env.JWT_SECRET;

/** @type {Map<string|number, Set<import('ws').WebSocket>>} */
const _byUser = new Map();
/** @type {Map<string|number, Set<import('ws').WebSocket>>} */
const _byOrg  = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function _addConn(ws, userId, orgId) {
  if (!_byUser.has(userId)) _byUser.set(userId, new Set());
  _byUser.get(userId).add(ws);

  if (orgId != null) {
    if (!_byOrg.has(orgId)) _byOrg.set(orgId, new Set());
    _byOrg.get(orgId).add(ws);
  }

  ws._dfai = { userId, orgId };
}

function _removeConn(ws) {
  const { userId, orgId } = ws._dfai ?? {};
  if (userId !== undefined) {
    const set = _byUser.get(userId);
    if (set) { set.delete(ws); if (!set.size) _byUser.delete(userId); }
  }
  if (orgId != null) {
    const set = _byOrg.get(orgId);
    if (set) { set.delete(ws); if (!set.size) _byOrg.delete(orgId); }
  }
}

function _parseToken(req) {
  // 1. Query param: ?token=xxx
  const url = new URL(req.url, 'ws://localhost');
  const qToken = url.searchParams.get('token');
  if (qToken) return qToken;

  // 2. Authorization header: Bearer xxx
  const auth = req.headers['authorization'] ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * createWsServer — attach a WebSocket server to an existing http.Server.
 *
 * @param {import('http').Server} httpServer
 * @returns {WebSocketServer}
 */
export function createWsServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const token = _parseToken(req);
    if (!token || !JWT_SECRET) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const userId = payload.sub ?? payload.userId;
    const orgId  = payload.org_id ?? payload.orgId ?? null;

    if (!userId) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    _addConn(ws, userId, orgId);
    logger.debug({ userId, orgId }, 'ws: client connected');

    // Heartbeat — send ping every 30s to keep alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, 30_000);

    ws.on('close', () => {
      clearInterval(pingInterval);
      _removeConn(ws);
      logger.debug({ userId }, 'ws: client disconnected');
    });

    ws.on('error', (err) => {
      logger.warn({ err, userId }, 'ws: client error');
      _removeConn(ws);
    });

    // Clients may send pong back automatically; ignore other messages
    ws.on('message', () => {});
  });

  logger.info('WebSocket server initialised');
  return wss;
}

/**
 * sendToUser — push a JSON message to all open connections for a user.
 *
 * @param {string|number} userId
 * @param {object}        message
 */
export function sendToUser(userId, message) {
  const conns = _byUser.get(userId);
  if (!conns?.size) return;

  const payload = JSON.stringify(message);
  for (const ws of conns) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload, (err) => {
        if (err) logger.warn({ err, userId }, 'ws: send error');
      });
    }
  }
}

/**
 * broadcastToOrg — push a JSON message to all users connected from an org.
 *
 * @param {string|number} orgId
 * @param {object}        message
 */
export function broadcastToOrg(orgId, message) {
  const conns = _byOrg.get(orgId);
  if (!conns?.size) return;

  const payload = JSON.stringify(message);
  for (const ws of conns) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload, (err) => {
        if (err) logger.warn({ err, orgId }, 'ws: broadcast error');
      });
    }
  }
}
