import type { Doc, Found, Mode } from './types'
import { EXP, Unreadable, WordReader } from './word-reader'

const KEYWORD = String.raw`(?:!|\{|if|then|do|else|elif|while|until|time)[ \t]+`
// `((` starts arithmetic, and `case` a pattern list, only where a command starts.
const COMMAND_START = new RegExp(String.raw`^[ \t]*(?:${KEYWORD})*$`)
const CASE_START = new RegExp(String.raw`^[ \t]*(?:${KEYWORD})*case[ \t]`)
// bash reads `name[` as an array subscript only where an assignment may stand.
const ASSIGNMENT_START = new RegExp(String.raw`^[ \t]*(?:${KEYWORD}|[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=[^\s'"\\$]*[ \t]+)*$`)

// The delimiter is any shell word, ended by a blank or an operator, and loses its quotes. Shells disagree on a `$` or
// a backquote in it, so this reading stops there.
function heredocAt(s: string, i: number): { end: number, doc: Doc } {
  let j = i + 2
  const strip = s[j] === '-'

  if (strip) {
    j++
  }

  while (s[j] === ' ' || s[j] === '\t') {
    j++
  }

  const start = j
  let delim = ''
  let quoted = false

  while (j < s.length && !/[ \t\n;&|()<>]/.test(s.charAt(j))) {
    const c = s.charAt(j)

    if (c === '$' || c === '`' || (c === '\\' && j + 1 >= s.length)) {
      throw new Unreadable()
    }

    if (c === '\\' || c === '\'' || c === '"') {
      quoted = true
    }

    if (c === '\\') {
      delim += s[j + 1]
      j += 2
    }
    else if (c === '\'') {
      const end = s.indexOf('\'', j + 1)

      if (end < 0) {
        throw new Unreadable()
      }

      delim += s.slice(j + 1, end)
      j = end + 1
    }
    else if (c === '"') {
      const [end, text] = doubleQuotedDelim(s, j + 1)
      delim += text
      j = end
    }
    else {
      delim += c
      j++
    }
  }

  if (j === start) {
    throw new Unreadable()
  }

  return { end: j, doc: { delim, strip, quoted } }
}

// Inside double quotes a backslash escapes only `$`, a backquote, `"`, a backslash or a newline.
function doubleQuotedDelim(s: string, from: number): [number, string] {
  let text = ''

  for (let j = from; j < s.length; j++) {
    const c = s.charAt(j)

    if (c === '"') {
      return [j + 1, text]
    }

    if (c === '$' || c === '`') {
      throw new Unreadable()
    }

    if (c === '\\' && '$`"\\\n'.includes(s[j + 1] ?? 'x')) {
      j++
    }

    text += s[j] ?? ''
  }

  throw new Unreadable()
}

// The state one command list's scan carries from character to character.
export interface Scan {
  cur: string
  start: number
  atWord: boolean
  word: number
  parens: number
  sawCase: boolean
  pending: Doc[]
  i: number
}

export class Reader extends WordReader {
  readonly mode: Mode

  readonly base: number

  readonly found: Found[]

  // bash 3.2 parses the text it cut out of $(…) on its own, so a here-document there may end with that text.
  readonly docsEndAtEof: boolean

  constructor(s: string, mode: Mode, base: number, found: Found[], docsEndAtEof = false) {
    super(s)
    this.mode = mode
    this.base = base
    this.found = found
    this.docsEndAtEof = docsEndAtEof
  }

  // A command list from `from` to the end of the text or, when `inner`, to the `)` that closes it.
  commands(from: number, inner: boolean): number {
    const scan: Scan = { cur: '', start: from, atWord: true, word: 0, parens: 0, sawCase: false, pending: [], i: from }

    while (scan.i < this.s.length) {
      const closed = this.step(scan, inner)

      if (closed !== null) {
        return closed
      }
    }

    if (inner) {
      throw new Unreadable()
    }

    this.flush(scan, scan.i)

    if (scan.pending.length > 0 && !this.docsEndAtEof) {
      throw new Unreadable()
    }

    return scan.i
  }

  flush(scan: Scan, next: number): void {
    scan.sawCase ||= CASE_START.test(scan.cur)
    this.found.push({ start: this.base + scan.start, text: scan.cur })
    scan.cur = ''
    scan.start = next
    scan.atWord = true
  }

  step(scan: Scan, inner: boolean): number | null {
    const s = this.s
    const c = s.charAt(scan.i)

    if (c === '\\' && s[scan.i + 1] === '\n') {
      scan.i += 2
    }
    else if (c === '#' && scan.atWord && this.mode.comments) {
      const nl = s.indexOf('\n', scan.i)
      scan.i = nl < 0 ? s.length : nl
    }
    else if (s.startsWith('<<<', scan.i)) {
      scan.cur += '<<<'
      scan.i += 3
      scan.atWord = true
    }
    else if (s.startsWith('<<', scan.i)) {
      // Even a reading that keeps bodies as code stops here: past a delimiter it cannot parse, no reading is the shell's.
      const h = heredocAt(s, scan.i)

      if (this.mode.heredocs !== 'off') {
        scan.pending.push(h.doc)
      }

      scan.cur += s.slice(scan.i, h.end)
      scan.i = h.end
      scan.atWord = true
    }
    else if (c === ' ' || c === '\t' || c === '<' || c === '>') {
      scan.cur += c
      scan.i++
      scan.atWord = true
    }
    else if (c === '\n') {
      this.flush(scan, scan.i + 1)
      scan.i = scan.pending.length > 0 ? this.bodies(scan.i + 1, scan.pending.splice(0)) : scan.i + 1
      scan.start = scan.i
    }
    else if (c === ')' && scan.parens === 0 && inner) {
      this.flush(scan, scan.i)

      // Shells disagree on a body left pending at the end of a substitution.
      if (scan.pending.length > 0) {
        throw new Unreadable()
      }

      if (!scan.sawCase) {
        return scan.i
      }

      // After `case` this `)` may end a pattern instead, so what follows is read as commands too, and the substitution
      // never closes in this reading.
      scan.start = ++scan.i
    }
    else {
      this.word(scan)
    }

    return null
  }

  word(scan: Scan): void {
    const s = this.s
    const c = s.charAt(scan.i)

    if (c === '(' && s[scan.i + 1] === '(' && COMMAND_START.test(scan.cur)) {
      const [end, text] = this.arith(scan.i + 2, true)
      scan.cur += `((${text}))`
      scan.i = end
      scan.atWord = false
    }
    else if (
      c === '('
      && !scan.atWord
      && /^[A-Z_]\w*\+?=$/i.test(scan.cur.slice(scan.word))
      && ASSIGNMENT_START.test(scan.cur.slice(0, scan.word))
    ) {
      // `a=(git push)` assigns words; only the substitutions inside it run.
      scan.i = this.arrayList(scan.i + 1)
      scan.cur += EXP
    }
    else if (c === '(' || c === ')') {
      scan.parens = Math.max(0, scan.parens + (c === '(' ? 1 : -1))
      this.flush(scan, scan.i + 1)
      scan.i++
    }
    else if (c === '&' && (scan.cur.endsWith('>') || scan.cur.endsWith('<') || s[scan.i + 1] === '>')) {
      scan.cur += c
      scan.i++
    }
    else if (c === ';' || c === '&' || c === '|') {
      this.flush(scan, scan.i + 1)
      scan.i++
    }
    else if (
      c === '['
      && !scan.atWord
      && /^[A-Z_]\w*$/i.test(scan.cur.slice(scan.word))
      && ASSIGNMENT_START.test(scan.cur.slice(0, scan.word))
    ) {
      const [end, text] = this.subscript(scan.i + 1)
      scan.cur += `[${text}]`
      scan.i = end
    }
    else {
      if (scan.atWord) {
        scan.word = scan.cur.length
        scan.atWord = false
      }

      const p = this.part(scan.i, false)
      scan.cur += p ? p[1] : c
      scan.i = p ? p[0] : scan.i + 1
    }
  }

  // A compound array assignment ends at its `)`; an operator inside it is a syntax error the shells report differently.
  arrayList(i: number): number {
    const s = this.s

    for (let j = i; j < s.length;) {
      const c = s.charAt(j)

      if (c === ')') {
        return j + 1
      }

      if ('(;&|<>'.includes(c)) {
        throw new Unreadable()
      }

      if (c === '#' && this.mode.comments && /[ \t\n(]/.test(s[j - 1] ?? '')) {
        const nl = s.indexOf('\n', j)
        j = nl < 0 ? s.length : nl
        continue
      }

      const p = this.part(j, false)
      j = p ? p[0] : j + 1
    }

    throw new Unreadable()
  }

  // Each body runs to the line equal to its delimiter. In an unquoted body a line ending in a backslash joins the next first.
  bodies(i: number, docs: Doc[]): number {
    const s = this.s

    for (const doc of docs) {
      const from = i
      let to = -1

      while (to < 0 && i < s.length) {
        const lineStart = i
        let line = ''

        for (;;) {
          const nl = s.indexOf('\n', i)
          const piece = s.slice(i, nl < 0 ? s.length : nl)
          i = nl < 0 ? s.length : nl + 1

          if (doc.quoted || nl < 0 || !/(?:^|[^\\])(?:\\\\)*\\$/.test(piece)) {
            line += piece
            break
          }

          line += piece.slice(0, -1)
        }

        if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) {
          to = lineStart
        }
      }

      // A shell runs the substitutions of a body that never closes, so they are read before this reading stops.
      if (!doc.quoted) {
        new Reader(s.slice(from, to < 0 ? s.length : to), this.mode, this.base + from, this.found).body()
      }

      if (to < 0 && !this.docsEndAtEof) {
        throw new Unreadable()
      }
    }

    return i
  }

  // In an unquoted body only escapes, expansions and substitutions are live; quotes are plain text.
  body(): void {
    for (let i = 0; i < this.s.length;) {
      const c = this.s[i]
      const p = c === '\\' || c === '$' || c === '`' ? this.part(i, true) : null
      i = p ? p[0] : i + 1
    }
  }

  // A backquoted command ends at the next unescaped backquote, whatever lies between, and is parsed afterwards.
  backquote(i: number): number {
    let j = i + 1

    while (j < this.s.length && this.s[j] !== '`') {
      j += this.s[j] === '\\' ? 2 : 1
    }

    if (j >= this.s.length) {
      throw new Unreadable()
    }

    new Reader(this.s.slice(i + 1, j).replace(/\\([\\`$])/g, '$1'), this.mode, this.base + i + 1, this.found).commands(
      0,
      false,
    )

    return j + 1
  }

  comsub(i: number): number {
    if (this.mode.heredocs !== 'bash32') {
      return this.commands(i, true) + 1
    }

    const end = new Reader(this.s, { ...this.mode, heredocs: 'off' }, this.base, []).commands(i, true)
    new Reader(this.s.slice(i, end), this.mode, this.base + i, this.found, true).commands(0, false)
    return end + 1
  }
}
