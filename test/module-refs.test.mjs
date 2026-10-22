/* Feature: catch calls to things that were never defined or imported.
   This exists because of a bug that reached a live till twice.

   The WhatsApp bot was fully linked, the till was up, the status API said "connected", and every test
   passed - and yet not one message worked, because `complaintRoute()` was called in whatsapp.js
   without being imported. It threw a ReferenceError on the first message and the bot silently dropped
   everything after it. The same thing had already happened with the sound module: four files imported
   it, three of them never called it, and every check in the app still parsed.

   Both times the cause was the same - a mechanical edit that was never verified - and both times the
   test suite said everything was fine, because the unit tests import whatsapp-bot.js directly and so
   never load whatsapp.js's use of it. A green suite is worth much less than it looks like if it never
   executes the line that is broken.

   So this is a static check for the specific shape of that failure: an identifier being called that the
   file neither declares nor imports. It is deliberately a check on *names*, not a parser, so it will
   have gaps. It is here to catch the ordinary mistake, cheaply, on every run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The server-side modules. These are the ones a broken import in takes the whole till down with, and
// they are the ones the unit tests load piecemeal rather than as a running program.
const MODULES = [
  'server.js', 'whatsapp.js', 'whatsapp-bot.js', 'whatsapp-bill.js', 'qr-reader.js',
  'auth.js', 'audit.js', 'products.js', 'orders.js', 'photos.js', 'complaints.js', 'reports.js',
  'deliveries.js', 'customers.js', 'settings.js', 'wa-store.js', 'wa-replies.js', 'wa-orders.js',
  'wa-menu.js', 'wa-flow.js', 'wa-ai.js', 'wa-i18n.js', 'ai.js', 'catalog-ai.js', 'voice-ai.js', 'license.js', 'counters.js', 'backup.js',
].map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f));

// The browser modules too. The same mistake has a browser shape: a component calls a helper that was
// never imported, and the screen it belongs to is simply blank - no error banner, no test failure,
// because the unit tests never load that component.
function browserModules() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); }
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(path.join(ROOT, 'public', 'js'));
  return out;
}

const ALL_MODULES = [...MODULES, ...browserModules()];

/**
 * Names that are always available. Being generous here costs nothing but a missed detection; being
 * stingy would produce failures that are noise, and a check people learn to ignore is worse than none.
 */
const AMBIENT = new Set(`
  Array ArrayBuffer ArrayBufferView BigInt BigInt64Array BigUint64Array Blob Boolean
  BroadcastChannel Buffer CacheStorage CustomEvent DataTransfer DataView DOMParser DocumentFragment
  Element Error Event EventSource EventTarget File FileReader FinalizationRegistry Float32Array
  Float64Array FormData Headers Image ImageData ImageBitmapRenderingContext Int16Array Int32Array
  Int8Array Intl Map Math MessageChannel MessageEvent MessagePort MutationObserver Number Object
  OffscreenCanvas Performance Profiler Promise Proxy Range ReadableStream Reflect Request
  Response Set SharedArrayBuffer String Symbol TextDecoder TextEncoder TransformStream URL
  URLSearchParams Uint16Array Uint32Array Uint8Array Uint8ClampedArray WeakMap WeakRef WeakSet
  WebSocket WritableStream XMLHttpRequest AbortController AbortSignal
  alert atob btoa cancelAnimationFrame clearInterval clearTimeout confirm createImageBitmap decodeURIComponent
  encodeURIComponent fetch getComputedStyle isNaN localStorage location matchMedia parseFloat
  parseInt postMessage queueMicrotask removeEventListener requestAnimationFrame scrollTo
  sessionStorage setInterval setTimeout structuredClone prompt
  console crypto document exports globalThis history module navigator performance process
  require self window Date
  addEventListener dispatchEvent setImmediate clearImmediate
  new delete typeof instanceof void in of this null true false undefined NaN Infinity
  function return if else for while do switch case break continue try catch finally throw
  import export await async yield class extends super static get set
`.trim().split(/\s+/));

/**
 * Blanks out comments, strings, template bodies and regex literals, replacing each character with a
 * space but leaving newlines alone. Preserving length and line count is not cosmetic: the first version
 * collapsed them, and every failure it reported pointed at a line that had nothing to do with the
 * problem, which is the fastest way to make someone stop reading a test's output.
 */
function stripNoise(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m) => m[0] + blank(m.slice(1)))
    .replace(/`(?:\\.|[^`\\])*`/g, blank)
    .replace(/'(?:\\.|[^'\\\n])*'/g, blank)
    .replace(/"(?:\\.|[^"\\\n])*"/g, blank)
    // The space between the operator and the slash is allowed because almost every regex literal in
    // real code is written `x = /.../`, not `x=/.../`.
    .replace(/(^|[=(,:[!&|?{};+\-*]|\breturn|\btypeof)\s*\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/g,
      (m) => m[0] + blank(m.slice(m[0].indexOf('/'))));
}

/**
 * Adds every name bound by a binding list: `a, b`, `{ a, b: c }`, `[d, ...e]`, `{ a = 1 }`.
 * Destructuring with a default or a rename is where a naive `split(',')` goes wrong, and getting it
 * wrong showed up as a false alarm on `renderCatalog({ onAdd, onScan })`.
 */
function addBindings(add, list) {
  // Take the outer delimiters off the whole list before splitting. Doing it per-part loses the first
  // and last name, because a leading `{` or a trailing ` }` is not itself a name - which is how
  // `renderCatalog({ onAdd, onScan })` came to look like a file calling an undefined `onAdd`.
  const inner = list.trim().replace(/^\{/, '').replace(/\}$/, '').replace(/^\[/, '').replace(/\]$/, '');
  for (const raw of inner.split(',')) {
    let part = raw.trim().replace(/^\.\.\./, '');
    // A default value may itself contain commas: `{ a = { b: 1 }, c }`. Take the left of the first
    // `=` that is not inside a nested bracket.
    let depth = 0, cut = part.length;
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      if ('{[('.includes(ch)) depth++;
      else if ('}])'.includes(ch)) depth--;
      else if (ch === '=' && depth === 0) { cut = i; break; }
    }
    part = part.slice(0, cut);
    // A rename binds the right-hand side: `{ saveCreds: saveCredsRaw }` binds saveCredsRaw.
    const colon = part.indexOf(':');
    if (colon >= 0) part = part.slice(colon + 1);
    part = part.trim().replace(/[{}[\]\s].*$/, '').trim();
    add(part);
  }
}

/** Every name the file binds: imports, top-level and nested declarations, and destructured bindings. */
function boundNames(src) {
  const names = new Set();
  const add = (n) => { if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); };

  // import defaultName, * as ns from '...'  /  import { a, b as c } from '...'  /  import X, { a } from '...'
  for (const m of src.matchAll(/import\s+([\w$]+)\s*(?:,|from)/g)) add(m[1]);
  for (const m of src.matchAll(/import\s*\*\s*as\s+([\w$]+)/g)) add(m[1]);
  for (const m of src.matchAll(/import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      add((bits[1] || bits[0] || '').trim());
    }
  }

  // Declarations, at any depth. Over-approximating on purpose: a name bound *somewhere* in the file is
  // treated as available, which can only cost us a missed detection, never a false alarm.
  for (const m of src.matchAll(/(?:^|[^.\w$])(?:const|let|var|function|class)\s+([\w$]+)/g)) add(m[1]);
  // Object-literal and class methods: `sendText(jid, body) {` and `async sendWelcome(phone) {`. These
  // are how the WhatsApp bot gets its whole API surface, and missing them produced a wall of false
  // alarms on the first run.
  for (const m of src.matchAll(/^\s*(?:async\s+|static\s+|get\s+|set\s+)*([\w$]+)\s*\([^()]*\)\s*\{/gm)) add(m[1]);
  for (const m of src.matchAll(/(?:^|[^.\w$])(?:const|let|var)\s*\{([^}]*)\}/g)) addBindings(add, m[1]);
  // Parameters, for `function f(a, b) {`, `async function f(a) {` and `(...)=>` alike. The earlier
  // version only matched a parameter list followed by another bracket, so every ordinary single
  // argument list - including express's `next` - was invisible to it.
  for (const m of src.matchAll(/(?:function\s*\*?\s*[\w$]*\s*|\bcatch\s*)\(([^()]*)\)/g)) addBindings(add, m[1]);
  for (const m of src.matchAll(/(?:^|[^.\w$])\(([^()]*)\)\s*=>/g)) addBindings(add, m[1]);
  return names;
}

/** Identifiers that are being called, as opposed to being read or declared. */
function calledNames(src) {
  const out = new Map();
  for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (name === 'function' || name === 'new') continue;
    if (!out.has(name)) out.set(name, src.slice(0, m.index).split('\n').length);
  }
  return out;
}

test('no server-side module calls something it never defined or imported', () => {
  const problems = [];
  for (const file of ALL_MODULES) {
    const src = stripNoise(fs.readFileSync(file, 'utf8'));
    const bound = boundNames(src);
    for (const [name, line] of calledNames(src)) {
      if (bound.has(name) || AMBIENT.has(name)) continue;
      problems.push(`  ${path.relative(ROOT, file)}:${line} calls ${name}(), which is never defined or imported in that file`);
    }
  }
  assert.equal(problems.length, 0,
    `\n${problems.join('\n')}\n\n` +
    'A call to something that was never imported is a ReferenceError the first time that line runs - ' +
    'which, for a WhatsApp bot, means every message is silently dropped while the till looks fine.\n');
});

test('every named import actually exists in the module it comes from', () => {
  // The other half of the same mistake: importing something that was renamed or removed. Node only
  // reports that at load time, and only if the code path is reached, so it is checked here directly.
  const problems = [];
  for (const file of ALL_MODULES) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g)) {
      const spec = m[2];
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) { problems.push(`  ${path.relative(ROOT, file)} imports from ${spec}, which does not exist`); continue; }
      const targetSrc = fs.readFileSync(target, 'utf8');
      const exported = new Set();
      for (const e of targetSrc.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/g)) exported.add(e[1]);
      for (const e of targetSrc.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of e[1].split(',')) {
          const bits = part.trim().split(/\s+as\s+/);
          exported.add((bits[1] || bits[0] || '').trim());
        }
      }
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!exported.has(name)) {
          problems.push(`  ${path.relative(ROOT, file)} imports { ${name} } from ${spec}, which does not export it`);
        }
      }
    }
  }
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
});
