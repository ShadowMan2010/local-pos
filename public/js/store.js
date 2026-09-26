// Browser-side persistence. The server (./data) is the source of truth for everything;
// this file only keeps a config cache (so the POS opens if the server is briefly offline),
// the paper-width choice, and a small "unsent bills" queue for when a save fails.
import { saveOrder } from './api.js';

const CFG = 'm3pos.config.v1';
const PENDING = 'm3pos.pendingOrders.v1';
const PAPER = 'm3pos.paper';

export const cacheConfig = (cfg) => localStorage.setItem(CFG, JSON.stringify(cfg));
export function loadCachedConfig() {
  try { return JSON.parse(localStorage.getItem(CFG)); } catch { return null; }
}

const readPending = () => {
  try { return JSON.parse(localStorage.getItem(PENDING)) || []; } catch { return []; }
};

/** A paid bill the server could not save (e.g. Wi-Fi dropped). It is kept here and re-sent later. */
export function addPendingOrder(order) {
  const list = readPending().filter((o) => o.id !== order.id);
  list.push(order);
  localStorage.setItem(PENDING, JSON.stringify(list.slice(-100)));
}

export const pendingCount = () => readPending().length;

/** Try to send every unsent bill again. Safe to repeat: the server ignores a bill it already has. @returns {Promise<number>} how many were sent */
export async function retryPendingOrders() {
  let sent = 0;
  for (const o of readPending()) {
    try {
      await saveOrder(o);
      localStorage.setItem(PENDING, JSON.stringify(readPending().filter((x) => x.id !== o.id)));
      sent++;
    } catch (err) {
      // a bill the server keeps rejecting (not a network problem) would block the queue forever
      if (/^(Bad|One of|The bill|Customer|Payment)/.test(err.message)) {
        localStorage.setItem(PENDING, JSON.stringify(readPending().filter((x) => x.id !== o.id)));
      } else break;
    }
  }
  return sent;
}

export const getPaper = () => localStorage.getItem(PAPER) || '80';
export const setPaper = (p) => localStorage.setItem(PAPER, p);
