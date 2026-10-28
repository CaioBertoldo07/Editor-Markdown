import { describe, expect, it } from 'vitest';
import { BusyError, SlotPool } from '../src/slots.js';

describe('fila de compilações', () => {
  it('entrega slots livres e enfileira o excedente', async () => {
    const pool = new SlotPool(2, 1, 1000);
    expect(await pool.acquire()).toBe(1);
    expect(await pool.acquire()).toBe(2);
    const waiting = pool.acquire();
    await expect(pool.acquire()).rejects.toBeInstanceOf(BusyError);
    pool.release(1);
    expect(await waiting).toBe(1);
  });

  it('desiste depois do tempo máximo de espera', async () => {
    const pool = new SlotPool(1, 5, 50);
    await pool.acquire();
    await expect(pool.acquire()).rejects.toMatchObject({ reason: 'queue_timeout' });
  });

  it('remove da fila quem cancelou', async () => {
    const pool = new SlotPool(1, 5, 1000);
    await pool.acquire();
    const controller = new AbortController();
    const waiting = pool.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow('aborted');
    expect(pool.stats.waiting).toBe(0);
    pool.release(1);
    expect(pool.stats.free).toBe(1);
  });
});
