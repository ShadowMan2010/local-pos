// An append-only record of the things that can cost the shop money or its reputation.
//
// This exists because of a specific gap, not general caution. Several actions in the POS deliberately
// skip the check that would normally catch a mistake: "Picked up" marks a parcel collected without the
// sticker being scanned, "Hand back" drops a job off the delivery list, and a complaint can be closed
// by typing whatever was typed. Those are good decisions — a camera that will not cooperate should not
// stop a shop from doing business — but they are also exactly the paths somebody would use to take
// money or drop a customer's problem on the floor. An audit line is what makes them answerable.
//
// Append-only, and deliberately not editable through the API. The only way to change this file is to
// edit it on disk, which needs filesystem access — a far bigger step than calling the till.
//
// Customer text is not copied in. A line records which complaint, by reference, and what was done to
// it. The complaint itself is already stored; duplicating free-text into an append-only log that gets
// copied into backups is how PII quietly spreads.
import fs from 'fs';
import path from 'path';

export function createAuditLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  /**
   * Adds one line. Never throws and never blocks: an audit failure must not stop a shop from taking
   * money or from closing a complaint. A dropped line is a gap; a crashed till is a worse gap.
   */
  function record(action, detail = {}) {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), action, ...detail }) + '\n';
      fs.appendFileSync(file, line, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reads the most recent entries, newest first. Corrupt lines are skipped rather than fatal: a
   * half-written last line (power cut mid-append) must not make the whole log unreadable.
   */
  function read(limit = 200) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
    }
    return out.reverse().slice(0, limit);
  }

  return { record, read };
}
