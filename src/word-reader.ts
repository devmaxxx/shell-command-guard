// A reading stops at text it cannot place the way the shells place it. What it found before that still counts.
export class Unreadable extends Error {}

// Marks where an expansion stood in a segment: what it expands to is known only when the shell runs.
export const EXP = '\u0000'

// Marks an unquoted `*`, `?` or `[…]`: in the command word it is an expansion, elsewhere the matcher reads it as text.
export const GLOB = '\u0001'

// Brackets the index of a $(…) right after its `EXP`, so the text a substitution holds can still be looked up.
export const SUB = '\u0002'

// The quotes, escapes and expansions inside a word. Substitutions hold whole command lists, so the reader that scans
// those supplies them.
export abstract class WordReader {
  readonly s: string

  constructor(s: string) {
    this.s = s
  }

  abstract backquote(i: number): number

  abstract comsub(i: number): number

  // The marker a $(…) from `from` to `to` leaves in the segment, after its `EXP`.
  abstract substitution(from: number, to: number): string

  // The quoted string, escape or expansion at i, or null. `dq`: inside double quotes or a here-document body. An
  // expansion is marked, because what it becomes is text the matcher cannot see.
  part(i: number, dq: boolean): [number, string] | null {
    const s = this.s

    switch (s[i]) {
      case '\\':
        return [i + 2, s.slice(i, i + 2)]
      case '\'':
        return dq ? null : this.single(i)
      case '"':
        return this.double(i)
      case '`':
        return [this.backquote(i), EXP]
      case '$': {
        const [end, text] = this.dollar(i, dq)
        return [end, EXP + text]
      }
      default:
        return null
    }
  }

  dollar(i: number, dq: boolean): [number, string] {
    const s = this.s
    const next = s[i + 1]

    if (s.startsWith('$((', i)) {
      const [end, text] = this.arith(i + 3, true)
      return [end, `$((${text}))`]
    }

    if (next === '(') {
      const end = this.comsub(i + 2)
      return [end, this.substitution(i + 2, end - 1)]
    }

    if (next === '[') {
      const [end, text] = this.arith(i + 2, false)
      return [end, `$[${text}]`]
    }

    if (next === '{') {
      return this.param(i + 2, dq)
    }

    if (next === '\'' && !dq) {
      return this.ansiC(i)
    }

    // `$$` is one parameter, so the `{` in `$${` opens nothing.
    return next === '$' ? [i + 2, '$$'] : [i + 1, '$']
  }

  single(i: number): [number, string] {
    const end = this.s.indexOf('\'', i + 1)

    if (end < 0) {
      throw new Unreadable()
    }

    return [end + 1, this.s.slice(i, end + 1)]
  }

  double(i: number): [number, string] {
    let text = '"'

    for (let j = i + 1; j < this.s.length;) {
      if (this.s[j] === '"') {
        return [j + 1, `${text}"`]
      }

      const p = this.part(j, true)
      text += p ? p[1] : this.s[j]
      j = p ? p[0] : j + 1
    }

    throw new Unreadable()
  }

  // In $'…' a backslash escapes the closing quote, which a plain single-quote scan would take as the end.
  ansiC(i: number): [number, string] {
    let text = ''

    for (let j = i + 2; j < this.s.length; j++) {
      if (this.s[j] === '\'') {
        return [j + 1, `'${text.replaceAll('\'', '')}'`]
      }

      if (this.s[j] === '\\') {
        j++
      }

      text += this.s[j] ?? ''
    }

    throw new Unreadable()
  }

  // bash ends ${…} at the first `}` outside quotes and nested expansions; it does not count plain braces.
  param(i: number, dq: boolean): [number, string] {
    let text = '${'

    for (let j = i; j < this.s.length;) {
      const c = this.s[j]

      if (c === '}') {
        return [j + 1, `${text}}`]
      }

      // Inside double quotes bash takes this apostrophe for a quote and zsh does not.
      if (c === '\'' && dq) {
        throw new Unreadable()
      }

      const p = this.part(j, dq)
      text += p ? p[1] : c
      j = p ? p[0] : j + 1
    }

    throw new Unreadable()
  }

  // When `((` does not close on `))` the shell reads nested subshells instead, which this reading does not follow.
  arith(i: number, parens: boolean): [number, string] {
    const [open, close] = parens ? ['(', ')'] : ['[', ']']
    let depth = 0
    let text = ''

    for (let j = i; j < this.s.length;) {
      const c = this.s[j]

      if (c === close && depth === 0) {
        if (!parens) {
          return [j + 1, text]
        }

        if (this.s[j + 1] === ')') {
          return [j + 2, text]
        }

        throw new Unreadable()
      }

      if (c === '\'') {
        throw new Unreadable()
      }

      if (c === open) {
        depth++
      }
      else if (c === close) {
        depth--
      }

      const p = this.part(j, false)
      text += p ? p[1] : c
      j = p ? p[0] : j + 1
    }

    throw new Unreadable()
  }

  // Shells disagree whether `<<` and a `#` after a blank in a subscript are a here-document and a comment.
  subscript(i: number): [number, string] {
    let depth = 0
    let text = ''

    for (let j = i; j < this.s.length;) {
      const c = this.s[j]

      if (c === ']' && depth === 0) {
        return [j + 1, text]
      }

      if (this.s.startsWith('<<', j) || (c === '#' && (this.s[j - 1] === ' ' || this.s[j - 1] === '\t'))) {
        throw new Unreadable()
      }

      if (c === '[') {
        depth++
      }
      else if (c === ']') {
        depth--
      }

      const p = this.part(j, false)
      text += p ? p[1] : c
      j = p ? p[0] : j + 1
    }

    throw new Unreadable()
  }
}
