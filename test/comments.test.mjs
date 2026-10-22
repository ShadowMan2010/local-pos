// Guards against a comment that swallows the code under it.
//
// This exists because it already happened. A stray `/**` above a helper in server.js was only closed forty
// lines later, which quietly commented out the declaration of `complaintFallbackText`. The file parsed, the
// server started, and it died on the first request that used the word — with `complaintFallbackText is not
// defined` — and nothing in the test suite pointed at a comment.
//
// The failure is invisible to every tool that checks syntax, because a comment is not a syntax error. So it
// gets its own check: no block comment may contain a line that looks like a declaration.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/dhruba/m3-pos';

/** Every block comment in a file, as [startLine, endLine] with endLine null if never closed. */
function blockComments(src) {
  const spans = [];
  let i = 0;
  let line = 1;
  let instr = null;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') line++;
    if (instr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === instr) instr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { instr = ch; i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      const start = line;
      const end = src.indexOf('*/', i + 2);
      if (end === -1) { spans.push([start, null]); break; }
      spans.push([start, start + src.slice(i, end).split('\n').length - 1]);
      line += src.slice(i, end).split('\n').length - 1;
      i = end + 2;
      continue;
    }
    i++;
  }
  return spans;
}

const FILES = [
  'server.js', 'whatsapp.js', 'whatsapp-bot.js', 'complaint-ai.js', 'complaint-conversation.js', 'auth.js',
  'public/js/api.js', 'public/js/components/complaints-dialog.js'
];

test('no comment is left open, and none of them is hiding code', () => {
  // The two shapes this catches: a `/**` that is never closed, and a `/**` whose `*/` is so far away that
  // real code sits inside it. Both leave a file that parses perfectly and does not run.
  const problems = [];
  for (const rel of FILES) {
    const full = path.join(ROOT, rel);
    const src = fs.readFileSync(full, 'utf8');
    const lines = src.split('\n');
    for (const [start, end] of blockComments(src)) {
      if (end === null) {
        problems.push(`${rel}:${start} a block comment is never closed`);
        continue;
      }
      for (let n = start; n < end; n++) {
        // A declaration inside a comment is the smell. This is not a parser, it does not need to be
        // perfect: it only has to notice the case that actually happened, which is a whole function
        // quietly commented out under a doc comment that drifted.
        const t = lines[n - 1].trim();
        if (/^(export\s+)?(async\s+)?function\s+\w+|^(export\s+)?(const|let|var)\s+\w+\s*=/.test(t)
          && !t.startsWith('*') && !t.startsWith('//')) {
          problems.push(`${rel}:${n} looks like code inside a comment: ${t.slice(0, 60)}`);
        }
      }
    }
  }
  assert.equal(problems.length, 0, problems.join('\n'));
});

test('the wording helpers the complaint flow depends on are really defined', () => {
  // The same bug caught by its symptom as well as its cause, because the two catch different edits. This
  // one fails with a useful message instead of a 500 three requests later.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  for (const name of ['complaintFallbackText', 'complaintHandoffText', 'complaintConversation', 'continueComplaint']) {
    assert.ok(
      new RegExp(`^(const|let|function|async function)\\s+${name}\\b|^\\s+${name}:`, 'm').test(src),
      `${name} is not declared in server.js`
    );
  }
});
