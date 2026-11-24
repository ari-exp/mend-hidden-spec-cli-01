// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run as `node main.ts [options] [PATCH]`.
//
// This file was written from SPEC.md (version 1) for the make.fun bounty
// hidden-spec-cli-01-run-20261122. It implements all four patch formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), the three-tier
// line matching of section 5, the all-or-nothing write of section 10, and
// the exact stdout / exit codes of section 2.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under section 3: its line break, its lines, whether it ends with a break. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, in patch order. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---- section 5: matching lines ---- */

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function tierEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function occurrencesAt(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(tier, lines[i + j]!, O[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once at or after `from`, with its positions. */
function findTier(lines: string[], O: string[], strict: boolean, from: number, eof: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    let occ = occurrencesAt(lines, O, t, from);
    if (eof) occ = occ.filter((i) => i + O.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = from; i < lines.length; i++) {
      if (tierEq(t, lines[i]!, anchor)) return i;
    }
  }
  return -1;
}

/** Section 5 re-indentation of one added line at tier 2. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || onlyWs(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** One line of N: a context line (written as the file's own matched line) or an added line. */
type NEntry = { kind: 'ctx'; oi: number } | { kind: 'add'; text: string };

function buildN(N: NEntry[], fileLines: string[], at: number, tier: number, O: string[]): string[] {
  if (tier !== 2) return N.map((e) => (e.kind === 'ctx' ? fileLines[at + e.oi]! : e.text));
  const f = leadWs(fileLines[at]!);
  const p = leadWs(O[0]!);
  return N.map((e) => (e.kind === 'ctx' ? fileLines[at + e.oi]! : reindent(e.text, p, f)));
}

/** Split O (context and old lines) and N (context and new lines) out of a hunk/chunk body. */
function splitON(body: BodyLine[]): { O: string[]; N: NEntry[] } {
  const O: string[] = [];
  const N: NEntry[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ kind: 'ctx', oi: O.length - 1 });
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else if (b.kind === 'new') {
      N.push({ kind: 'add', text: b.text });
    }
  }
  return { O, N };
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bslash';
  text: string;
}

/** Whether a `\` line follows the body's last context or `+` line (section 6 no-newline rule). */
function noEol(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') last = k;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'bslash';
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---- section 9: JSON edits ---- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- section 6: unified diffs ---- */

interface Hunk {
  /** A: the 1-based old line number the hunk header names. */
  a: number;
  body: BodyLine[];
}

interface USection {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

const DIFF_RE = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripAB(p: string): string {
  return p.startsWith('a/') ? p.slice(2) : p.startsWith('b/') ? p.slice(2) : p;
}

/** The path a `--- ` / `+++ ` header line names: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (oldPath: string | null, newPath: string | null): void => {
    cur = { oldPath, newPath, creation: false, deletion: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      newSection(stripAB(m[1]!), stripAB(m[2]!));
      // Remember the diff --git paths for the fallback below.
      (cur as USection & { diffOld?: string; diffNew?: string }).diffOld = stripAB(m[1]!);
      (cur as USection & { diffOld?: string; diffNew?: string }).diffNew = stripAB(m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      let j = i + 1;
      const body: BodyLine[] = [];
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          body.push({ kind: 'ctx', text: '' });
          j++;
          continue;
        }
        const c = l[0]!;
        if (c === ' ') {
          body.push({ kind: 'ctx', text: l.slice(1) });
          j++;
          continue;
        }
        if (c === '-') {
          body.push({ kind: 'old', text: l.slice(1) });
          j++;
          continue;
        }
        if (c === '+') {
          body.push({ kind: 'new', text: l.slice(1) });
          j++;
          continue;
        }
        if (c === '\\') {
          body.push({ kind: 'bslash', text: l.slice(1) });
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') body.pop();
        else break;
      }
      cur.hunks.push({ a, body });
      inHeader = false;
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        const o = headerPath(line);
        const n = headerPath(lines[i + 1]!);
        cur.oldPath = o === '/dev/null' ? null : stripAB(o);
        cur.newPath = n === '/dev/null' ? null : stripAB(n);
        (cur as USection & { hasPair?: boolean }).hasPair = true;
      } else {
        const o = headerPath(line);
        const n = headerPath(lines[i + 1]!);
        newSection(o === '/dev/null' ? null : stripAB(o), n === '/dev/null' ? null : stripAB(n));
        (cur as USection & { hasPair?: boolean }).hasPair = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        (cur as USection & { renameFrom?: string }).renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        (cur as USection & { renameTo?: string }).renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.creation = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletion = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  // Resolve each section's paths: ---/+++ pair, then rename from/to, then diff --git.
  for (const s of sections) {
    const x = s as USection & { diffOld?: string; diffNew?: string; renameFrom?: string; renameTo?: string; hasPair?: boolean };
    if (!x.hasPair) {
      if (x.renameFrom !== undefined) s.oldPath = x.renameFrom === '/dev/null' ? null : x.renameFrom;
      else if (x.diffOld !== undefined) s.oldPath = x.diffOld;
      if (x.renameTo !== undefined) s.newPath = x.renameTo === '/dev/null' ? null : x.renameTo;
      else if (x.diffNew !== undefined) s.newPath = x.diffNew;
    }
    if (s.oldPath === null) s.creation = true;
    if (s.newPath === null) s.deletion = true;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply a section's hunks in order to a file's text (section 6). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitON(h.body);
    const eol = noEol(h.body);
    if (O.length === 0) {
      const idx = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = idx === f.lines.length;
      const adds = N.map((e) => (e.kind === 'add' ? e.text : ''));
      f.lines.splice(idx, 0, ...adds);
      if (atEnd) f.final = !eol;
      d += N.length;
      continue;
    }
    const found = findTier(f.lines, O, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const o of found.occ) {
      const dist = Math.abs(o - target);
      if (dist < bestDist) {
        best = o;
        bestDist = dist;
      }
    }
    const at = best;
    const runsToEnd = at + O.length === f.lines.length;
    const prime = buildN(N, f.lines, at, found.tier, O);
    f.lines.splice(at, O.length, ...prime);
    if (runsToEnd) f.final = !eol;
    d += N.length - O.length;
  }
  return joinFile(f);
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (sec.creation) {
      if (newP === null) return; // old and new are both /dev/null: nothing to create
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let finalBr = true;
      let lastPlus: { h: number; b: number } | null = null;
      sec.hunks.forEach((h, hi) => {
        h.body.forEach((bd, bi) => {
          if (bd.kind === 'new') {
            plus.push(bd.text);
            lastPlus = { h: hi, b: bi };
          }
        });
      });
      if (lastPlus !== null) {
        const h = sec.hunks[lastPlus.h]!;
        if (h.body[lastPlus.b + 1]?.kind === 'bslash') finalBr = false;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    if (sec.deletion) {
      if (oldP === null) return; // nothing to delete
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(cur, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = (oldP ?? newP)!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(cur, sec.hunks, strict, p));
  };
}

/* ---- section 7: SEARCH/REPLACE blocks ---- */

interface SRBlock {
  path: string;
  old: string[];
  next: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevReplace = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const sIdx = i;
      let path: string | null = null;
      for (let j = i - 1; j > prevReplace; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
        else throw new Exit2(`error: parse ${sIdx + 1}`);
      }
      let eq = -1;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '=======') {
          eq = k;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
      let rep = -1;
      for (let k = eq + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
      blocks.push({ path, old: lines.slice(i + 1, eq), next: lines.slice(eq + 1, rep) });
      prevReplace = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.next.length === 0 ? '' : b.next.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const f = splitFile(cur);
    const found = findTier(f.lines, b.old, strict, 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length !== 1) throw new Fail('ambiguous', b.path);
    const at = found.occ[0]!;
    let prime: string[];
    if (found.tier === 2) {
      const p = leadWs(b.old[0]!);
      const fw = leadWs(f.lines[at]!);
      prime = b.next.map((t) => reindent(t, p, fw));
    } else {
      prime = b.next.slice();
    }
    f.lines.splice(at, b.old.length, ...prime);
    tree.now.set(b.path, joinFile(f));
  };
}

/* ---- section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[]; // Add File lines
  chunks: VChunk[]; // Update File chunks
  updateLine: number; // 0-based index of the Update File line, for parse errors
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const raw: number[] = [];
      while (i < last) {
        if (isSectionStart(lines[i]!)) break;
        raw.push(i);
        i++;
      }
      // Blank lines at the end of a section are not part of it (section 8):
      // blank is empty or only whitespace (section 4).
      while (raw.length > 0 && blank(lines[raw[raw.length - 1]!])) raw.pop();
      const fl: string[] = [];
      for (const idx of raw) {
        const l = lines[idx]!;
        if (l.startsWith('+')) fl.push(l.slice(1));
        else if (l === '') fl.push('');
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      sections.push({ kind: 'add', path, moveTo: null, lines: fl, chunks: [], updateLine: -1 });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (blank(l)) {
          i++;
          continue;
        }
        if (isSectionStart(l)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ kind: 'delete', path, moveTo: null, lines: [], chunks: [], updateLine: -1 });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const raw: number[] = [];
      while (i < last) {
        if (isSectionStart(lines[i]!)) break;
        raw.push(i);
        i++;
      }
      while (raw.length > 0 && blank(lines[raw[raw.length - 1]!])) raw.pop();
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let firstChunk = true;
      for (const idx of raw) {
        const l = lines[idx]!;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(curChunk);
          firstChunk = false;
          continue;
        }
        if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${idx + 1}`);
          curChunk.eof = true;
          curChunk = null;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curChunk === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${idx + 1}`);
            curChunk = { anchor: null, eof: false, body: [] };
            chunks.push(curChunk);
            firstChunk = false;
          }
          const kind = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
          curChunk.body.push({ kind, text: l === '' ? '' : l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${idx + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      sections.push({ kind: 'update', path, moveTo, lines: [], chunks, updateLine });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(cur);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(f.lines, ch.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const { O, N } = splitON(ch.body);
      if (O.length === 0) {
        const ins = ch.eof ? f.lines.length : cursor;
        const adds = N.map((e) => (e.kind === 'add' ? e.text : ''));
        f.lines.splice(ins, 0, ...adds);
        cursor = ins + adds.length;
        continue;
      }
      const found = findTier(f.lines, O, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', s.path);
      const at = found.occ[0]!;
      const prime = buildN(N, f.lines, at, found.tier, O);
      f.lines.splice(at, O.length, ...prime);
      cursor = at + prime.length;
    }
    const out = joinFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

/* ---- sections 1, 2 and 10: invocation, output, order and atomicity ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: A / D / M per changed path, R for a successful move (sorted by the new path).
  const rows = new Map<string, { key: string; text: string }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  const rRows: Array<{ key: string; text: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    const origOld = tree.original(oldP);
    const origNew = tree.original(newP);
    const finOld = tree.get(oldP);
    const finNew = tree.get(newP);
    if (origOld !== null && finOld === null && origNew === null && finNew !== null) {
      rows.delete(oldP);
      rows.delete(newP);
      rRows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  const all = [...rows.values(), ...rRows].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const p of changed) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    // Let a file take the place of a directory its own move emptied.
    for (const p of changed) {
      if (tree.now.get(p) === null && tree.original(p) !== null) {
        let d = dirname(p);
        while (d !== '.' && d !== '' && d !== '/') {
          try {
            rmdirSync(d);
          } catch {
            break;
          }
          d = dirname(d);
        }
      }
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now !== null && now !== tree.original(p)) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...all.map((r) => r.text), `ok: ${all.length} ${all.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
