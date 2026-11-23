// main.ts is mend, the CLI SPEC.md specifies (MIT). Sections 1 to 4, 9 and 10 come from the kit's starting point;
// sections 5 to 8 (the three matching tiers, unified diffs, SEARCH/REPLACE blocks and V4A patches) are below.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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

/** A file's text as lines, its line break and whether it ended with one (SPEC.md section 3). */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

function joinLF(lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (final ? '\n' : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

interface Ctx {
  strict: boolean;
  moves: [string, string][];
}
type Edit = (tree: Tree, ctx: Ctx) => void;

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

// ---------------------------------------------------------------------------------------------------------------
// Section 5: matching lines

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function norm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchesAt(fileLines: string[], O: string[], i: number, tier: number): boolean {
  if (i < 0 || i + O.length > fileLines.length) return false;
  for (let j = 0; j < O.length; j++) if (norm(fileLines[i + j]!, tier) !== norm(O[j]!, tier)) return false;
  return true;
}

function findTier(fileLines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const maxTier = 0;
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ: number[] = [];
    for (let i = 0; i + O.length <= fileLines.length; i++) if (matchesAt(fileLines, O, i, tier)) occ.push(i);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** Write N's non-context lines, re-indented at tier 2 (SPEC.md section 5). */
function writeLine(text: string, tier: number, F: string, P: string): string {
  if (tier !== 2) return text;
  if (text.trim() === '') return text;
  if (!text.startsWith(P)) return text;
  return F + text.slice(P.length);
}

// ---------------------------------------------------------------------------------------------------------------
// Unified diffs (section 6)

interface Body {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  rawEmpty: boolean;
}
interface Hunk {
  A: number;
  body: Body[];
}
interface Section {
  diffOld?: string;
  diffNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  create?: boolean;
  del?: boolean;
  hunks: Hunk[];
}

function cleanPath(s: string): string | null {
  let t = s;
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseDiffGit(line: string, no: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${no}`);
  const mid = rest.indexOf(' b/', 2);
  if (mid < 0) throw new Exit2(`error: parse ${no}`);
  const a = rest.slice(2, mid);
  const b = rest.slice(mid + 3);
  if (a === '' || b === '') throw new Exit2(`error: parse ${no}`);
  return [a, b];
}

const isSectionStart = (l: string): boolean => l.startsWith('diff --git ') || (l.startsWith('--- ') && false);

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const [a, b] = parseDiffGit(l, i + 1);
      const sec: Section = { diffOld: a, diffNew: b, hunks: [] };
      i++;
      i = parseHeader(lines, i, sec, false);
      i = parseHunks(lines, i, sec);
      edits.push(sectionEdit(sec));
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { pairOld: cleanPath(l.slice(4)), pairNew: cleanPath(lines[i + 1]!.slice(4)), hunks: [] };
      i += 2;
      i = parseHeader(lines, i, sec, true);
      i = parseHunks(lines, i, sec);
      edits.push(sectionEdit(sec));
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else i++;
  }
  return edits;
}

function parseHeader(lines: string[], i: number, sec: Section, bareStart: boolean): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) return i;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ')) {
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      if (bareStart && sec.pairOld !== undefined) return i;
      sec.pairOld = cleanPath(l.slice(4));
      sec.pairNew = cleanPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (l.startsWith('rename from ')) {
      sec.renameFrom = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.renameTo = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.create = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.del = true;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

function parseHunks(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (!l.startsWith('@@')) {
      // Outside a body, lines that are not a new section or hunk are ignored (prose, code fences).
      i++;
      continue;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const A = parseInt(m[1]!, 10);
    i++;
    const body: Body[] = [];
    while (i < n) {
      const b = lines[i]!;
      if (b.startsWith('diff --git ')) break;
      if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (b === '') {
        body.push({ kind: ' ', text: '', rawEmpty: true });
        i++;
        continue;
      }
      const c = b[0]!;
      if (c === ' ' || c === '-' || c === '+' || c === '\\') {
        body.push({ kind: c, text: b.slice(1), rawEmpty: false });
        i++;
        continue;
      }
      break;
    }
    while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.rawEmpty) body.pop();
    sec.hunks.push({ A, body });
  }
  return i;
}

function noNewlineLastCtxPlus(body: Body[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) if (body[k]!.kind === ' ' || body[k]!.kind === '+') last = k;
  if (last < 0) return false;
  for (let k = last + 1; k < body.length; k++) if (body[k]!.kind === '\\') return true;
  return false;
}

function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let lines = doc.lines.slice();
  let final = doc.final;
  let d = 0;
  for (const h of hunks) {
    const O = h.body.filter((e) => e.kind === ' ' || e.kind === '-').map((e) => e.text);
    const nlen = h.body.filter((e) => e.kind === ' ' || e.kind === '+').length;
    let pos: number;
    let tier = 0;
    if (O.length > 0) {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      tier = found.tier;
      const target = h.A - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      pos = best;
    } else {
      pos = Math.min(h.A + d, lines.length);
    }
    const F = O.length > 0 && tier === 2 ? leadWs(lines[pos]!) : '';
    const P = O.length > 0 && tier === 2 ? leadWs(O[0]!) : '';
    const out: string[] = [];
    let fi = pos;
    for (const e of h.body) {
      if (e.kind === ' ') {
        out.push(lines[fi]!);
        fi++;
      } else if (e.kind === '-') {
        fi++;
      } else if (e.kind === '+') {
        out.push(writeLine(e.text, tier, F, P));
      }
    }
    if (pos + O.length === lines.length) final = !noNewlineLastCtxPlus(h.body);
    lines = [...lines.slice(0, pos), ...out, ...lines.slice(pos + O.length)];
    d += nlen - O.length;
  }
  return { lines, br: doc.br, final };
}

function createdFromHunks(hunks: Hunk[]): string {
  const lines: string[] = [];
  let noNl = false;
  for (const h of hunks) {
    for (let k = 0; k < h.body.length; k++) {
      const e = h.body[k]!;
      if (e.kind !== '+') continue;
      lines.push(e.text);
      noNl = false;
      for (let j = k + 1; j < h.body.length; j++) if (h.body[j]!.kind === '\\') noNl = true;
    }
  }
  return joinLF(lines, !noNl);
}

function sectionEdit(sec: Section): Edit {
  return (tree, ctx) => {
    const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    const create = oldPath === null || sec.create === true;
    const del = newPath === null || sec.del === true;
    // Every named path is checked for safety before anything else.
    if (oldPath !== undefined && oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== undefined && newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (create) {
      const p = newPath!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, createdFromHunks(sec.hunks));
      return;
    }
    if (del) {
      const p = oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const op = oldPath!;
    const np = newPath!;
    if (tree.get(op) === null) throw new Fail('missing', op);
    if (op !== np) {
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(parseDoc(tree.get(op)!), sec.hunks, ctx.strict, op);
      tree.now.set(np, joinDoc(out));
      tree.now.set(op, null);
      ctx.moves.push([op, np]);
      return;
    }
    const out = applyHunks(parseDoc(tree.get(op)!), sec.hunks, ctx.strict, op);
    tree.now.set(op, joinDoc(out));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)

function parseSearchReplace(lines: string[]): Edit[] {
  return [];
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let start = 0;
  let prevPath: string | null = null;
  const marker = (l: string, m: string): boolean => l.replace(/[ \t]+$/, '') === m;
  while (i < n) {
    if (!marker(lines[i]!, '<<<<<<< SEARCH')) {
      i++;
      continue;
    }
    const se = i;
    let path: string | null = null;
    for (let j = se - 1; j >= start; j--) {
      const t = lines[j]!;
      const tr = t.trim();
      if (tr === '') continue;
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${se + 1}`);
      path = prevPath;
    }
    // find ======= then >>>>>>> REPLACE
    let eq = -1;
    for (let j = se + 1; j < n; j++) {
      if (marker(lines[j]!, '=======')) {
        eq = j;
        break;
      }
      if (marker(lines[j]!, '>>>>>>> REPLACE') || marker(lines[j]!, '<<<<<<< SEARCH')) break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${se + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (marker(lines[j]!, '>>>>>>> REPLACE')) {
        rep = j;
        break;
      }
      if (marker(lines[j]!, '<<<<<<< SEARCH')) break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${se + 1}`);
    const oldLines = lines.slice(se + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines));
    prevPath = path;
    start = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree, ctx) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const cur = tree.get(path);
    if (oldLines.length === 0) {
      if (cur !== null) throw new Fail('exists', path);
      tree.now.set(path, joinLF(newLines, true));
      return;
    }
    if (cur === null) throw new Fail('missing', path);
    const doc = parseDoc(cur);
    const found = findTier(doc.lines, oldLines, ctx.strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const F = found.tier === 2 ? leadWs(doc.lines[pos]!) : '';
    const P = found.tier === 2 ? leadWs(oldLines[0]!) : '';
    const out = newLines.map((t) => writeLine(t, found.tier, F, P));
    const lines = [...doc.lines.slice(0, pos), ...out, ...doc.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinDoc({ lines, br: doc.br, final: doc.final }));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// V4A patches (section 8)

interface VChunk {
  anchor: string | null;
  body: Body[];
  eof: boolean;
}

const vSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
const vBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';

function parseV4A(lines: string[]): Edit[] {
  return [];
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++)
    if (lines[i]!.trim() !== '') {
      first = i;
      break;
    }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--)
    if (lines[i]!.trim() !== '') {
      last = i;
      break;
    }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (l.trim() === '') {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const raw: string[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (vSectionStart(b)) break;
        raw.push(b);
        i++;
      }
      // Blank lines at the end of a section are not part of it.
      while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop();
      const body: string[] = [];
      for (let r = 0; r < raw.length; r++) {
        const b = raw[r]!;
        if (b.startsWith('+')) body.push(b.slice(1));
        else if (b === '') body.push('');
        else throw new Exit2(`error: parse ${i - raw.length + r + 1}`);
      }
      edits.push(vAddEdit(path, body));
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const b = lines[i]!;
        if (vSectionStart(b)) break;
        if (b.trim() === '') {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(vDeleteEdit(path));
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const headerNo = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const sec: { text: string; rawEmpty: boolean; no: number }[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (vSectionStart(b)) break;
        sec.push({ text: b, rawEmpty: b === '', no: i + 1 });
        i++;
      }
      while (sec.length > 0 && sec[sec.length - 1]!.text.trim() === '') sec.pop();
      const chunks: VChunk[] = [];
      let k = 0;
      while (k < sec.length) {
        const e = sec[k]!;
        if (e.text.startsWith('@@')) {
          const a = e.text.slice(2).trim();
          k++;
          const r = collectVBody(sec, k);
          k = r.next;
          chunks.push({ anchor: a === '' ? null : a, body: r.body, eof: r.eof });
        } else if (vBodyLine(e.text) && chunks.length === 0) {
          const r = collectVBody(sec, k);
          k = r.next;
          chunks.push({ anchor: null, body: r.body, eof: r.eof });
        } else {
          throw new Exit2(`error: parse ${chunks.length === 0 && moveTo === null ? headerNo : e.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
      edits.push(vUpdateEdit(path, moveTo, chunks));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

function collectVBody(sec: { text: string; rawEmpty: boolean; no: number }[], k: number): { body: Body[]; eof: boolean; next: number } {
  const body: Body[] = [];
  let eof = false;
  while (k < sec.length) {
    const e = sec[k]!;
    if (e.text.startsWith('@@')) break;
    if (e.text === '*** End of File') {
      eof = true;
      k++;
      break;
    }
    if (e.text === '') {
      body.push({ kind: ' ', text: '', rawEmpty: true });
      k++;
      continue;
    }
    const c = e.text[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      body.push({ kind: c, text: e.text.slice(1), rawEmpty: false });
      k++;
      continue;
    }
    throw new Exit2(`error: parse ${e.no}`);
  }
  while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.rawEmpty) body.pop();
  return { body, eof, next: k };
}

function vAddEdit(path: string, lines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinLF(lines, true));
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[]): Edit {
  return (tree, ctx) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(cur);
    const maxTier = 0;
    let lines = doc.lines.slice();
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        let found = -1;
        for (let tier = 0; tier <= maxTier && found < 0; tier++) {
          for (let i = cursor; i < lines.length; i++) {
            if (norm(lines[i]!, tier) === norm(c.anchor, tier)) {
              found = i;
              break;
            }
          }
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const O = c.body.filter((e) => e.kind === ' ' || e.kind === '-').map((e) => e.text);
      let nlen = 0;
      for (const e of c.body) if (e.kind === ' ' || e.kind === '+') nlen++;
      let pos: number;
      let tier = 0;
      if (O.length === 0) {
        pos = c.eof ? lines.length : cursor;
      } else {
        let found = -1;
        for (let t = 0; t <= maxTier && found < 0; t++) {
          for (let i = cursor; i + O.length <= lines.length; i++) {
            if (!matchesAt(lines, O, i, t)) continue;
            if (c.eof && i + O.length !== lines.length) continue;
            found = i;
            tier = t;
            break;
          }
        }
        if (found < 0) throw new Fail('no-match', path);
        pos = found;
      }
      const F = O.length > 0 && tier === 2 ? leadWs(lines[pos]!) : '';
      const P = O.length > 0 && tier === 2 ? leadWs(O[0]!) : '';
      const out: string[] = [];
      let fi = pos;
      for (const e of c.body) {
        if (e.kind === ' ') {
          out.push(lines[fi]!);
          fi++;
        } else if (e.kind === '-') {
          fi++;
        } else if (e.kind === '+') {
          out.push(writeLine(e.text, tier, F, P));
        }
      }
      lines = [...lines.slice(0, pos), ...out, ...lines.slice(pos + O.length)];
      cursor = pos + nlen;
    }
    const target = moveTo ?? path;
    tree.now.set(target, joinDoc({ lines, br: doc.br, final: doc.final }));
    if (moveTo !== null) {
      tree.now.set(path, null);
      ctx.moves.push([path, moveTo]);
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// JSON edits (section 9)

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

// ---------------------------------------------------------------------------------------------------------------
// Section 1, 2, 10: the command line, the output and the all-or-nothing write

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
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4A(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const ctx: Ctx = { strict, moves: [] };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = ctx.moves.length;
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const keys = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const recs: { sort: string; line: string }[] = [];
  const handled = new Set<string>();
  for (const [o, np] of ctx.moves) {
    if (handled.has(o) || handled.has(np)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(np) === null && tree.get(np) !== null) {
      recs.push({ sort: np, line: `R ${o} -> ${np}` });
      handled.add(o);
      handled.add(np);
    }
  }
  for (const p of keys) {
    if (handled.has(p)) continue;
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    recs.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  recs.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  if (!check) {
    for (const p of keys) {
      const now = tree.get(p);
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...recs.map((r) => r.line), `ok: ${recs.length} ${recs.length === 1 ? 'file' : 'files'}`] };
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
