/**
 * DocFlowAI — Semafor de concurență cu coadă mărginită (#107)
 *
 * Protejează resurse care lansează subprocese scumpe (LibreOffice) de la a fi
 * pornite în paralel nelimitat. Trei praguri:
 *   max            — câte task-uri rulează simultan
 *   maxQueue       — câte așteaptă; peste asta se refuză IMEDIAT (fail fast)
 *   queueTimeoutMs — cât așteaptă un task în coadă înainte să renunțe
 *
 * Erorile poartă `err.code` ca să poată fi mapate la HTTP de către apelant:
 *   GATE_BUSY    — coada e plină
 *   GATE_TIMEOUT — a expirat așteptarea în coadă
 *
 * În memorie, per proces — ca middleware/rateLimiter.mjs. Nu supraviețuiește
 * restartului Railway și nu e partajat între instanțe. Acceptat: o singură
 * instanță în producție azi, iar scopul e protecția memoriei procesului.
 */
export function createConcurrencyGate({
  max = 2,
  maxQueue = 8,
  queueTimeoutMs = 45_000,
  name = 'gate',
} = {}) {
  let active = 0;
  const queue = []; // { resolve, reject, timer, settled }

  function _next() {
    while (queue.length) {
      const w = queue.shift();
      if (w.settled) continue;      // expirat între timp — sari peste, NU pierde slotul
      w.settled = true;
      clearTimeout(w.timer);
      w.resolve();
      return;                        // slotul rămâne ocupat, doar și-a schimbat proprietarul
    }
    active--;                        // nimeni în coadă — eliberează efectiv
  }

  async function _acquire() {
    if (active < max) { active++; return; }
    if (queue.length >= maxQueue) {
      const e = new Error(`${name}: coadă plină (${maxQueue})`);
      e.code = 'GATE_BUSY';
      throw e;
    }
    await new Promise((resolve, reject) => {
      const w = { resolve, reject, settled: false, timer: null };
      w.timer = setTimeout(() => {
        if (w.settled) return;
        w.settled = true;
        const e = new Error(`${name}: timeout în coadă (${queueTimeoutMs}ms)`);
        e.code = 'GATE_TIMEOUT';
        reject(e);
      }, queueTimeoutMs);
      if (typeof w.timer.unref === 'function') w.timer.unref();
      queue.push(w);
    });
  }

  return {
    /**
     * Rulează fn() cu slot rezervat. Slotul se eliberează ÎNTOTDEAUNA,
     * inclusiv dacă fn aruncă.
     */
    async run(fn) {
      await _acquire();
      try { return await fn(); }
      finally { _next(); }
    },
    stats() { return { active, queued: queue.length, max, maxQueue }; },
  };
}
