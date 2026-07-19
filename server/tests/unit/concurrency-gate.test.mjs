import { describe, it, expect } from 'vitest';
import { createConcurrencyGate } from '../../utils/concurrency-gate.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createConcurrencyGate', () => {
  it('never exceeds max concurrency across 5 simultaneous tasks and returns correct values', async () => {
    const gate = createConcurrencyGate({ max: 2, maxQueue: 10, queueTimeoutMs: 5000 });
    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = [0, 1, 2, 3, 4].map((i) =>
      gate.run(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await delay(30);
        concurrent--;
        return i * 10;
      })
    );

    const results = await Promise.all(tasks);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(results).toEqual([0, 10, 20, 30, 40]);
    expect(gate.stats().active).toBe(0);
  });

  it('rejects immediately with GATE_BUSY when queue is full', async () => {
    const gate = createConcurrencyGate({ max: 1, maxQueue: 1, queueTimeoutMs: 5000, name: 'busy-gate' });

    // Occupies the single active slot.
    const first = gate.run(() => delay(100));
    // Fills the single queue slot.
    const second = gate.run(() => delay(100));

    const start = Date.now();
    await expect(gate.run(() => delay(100))).rejects.toMatchObject({ code: 'GATE_BUSY' });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50); // fail fast, no waiting

    await Promise.all([first, second]);
  });

  it('rejects with GATE_TIMEOUT when a queued waiter times out behind a slow task', async () => {
    const gate = createConcurrencyGate({ max: 1, maxQueue: 5, queueTimeoutMs: 30, name: 'timeout-gate' });

    const slow = gate.run(() => delay(200));
    await expect(gate.run(() => delay(10))).rejects.toMatchObject({ code: 'GATE_TIMEOUT' });

    await slow;
  });

  it('releases the slot when a task throws, allowing the next call to run normally', async () => {
    const gate = createConcurrencyGate({ max: 1, maxQueue: 5, queueTimeoutMs: 5000 });

    await expect(
      gate.run(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const result = await gate.run(async () => 'ok');
    expect(result).toBe('ok');
    expect(gate.stats().active).toBe(0);
  });

  it('does not lose a slot when a timed-out waiter is skipped in the queue', async () => {
    const gate = createConcurrencyGate({ max: 1, maxQueue: 5, queueTimeoutMs: 30, name: 'skip-gate' });

    // Active slot occupied for 200ms.
    const slow = gate.run(() => delay(200));
    // This waiter will time out at ~30ms, while still queued behind `slow`.
    const timedOut = gate.run(() => delay(10));
    await expect(timedOut).rejects.toMatchObject({ code: 'GATE_TIMEOUT' });

    await slow;

    // After slow finishes and the timed-out waiter is skipped in _next(),
    // a fresh call must still be able to acquire the slot (not lost).
    const result = await gate.run(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(gate.stats().active).toBe(0);
  });
});
