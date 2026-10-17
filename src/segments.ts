import type { Found, Mode } from './types'
import { Reader } from './shell-reader'
import { EXP, GLOB, Unreadable } from './word-reader'

// A quoted or escaped value may hold blanks, so the leading assignments are matched as shell words, not as `\S*`.
const ASSIGNMENT_VALUE = String.raw`(?:[^\s'"\\]|\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*")*`
export const LEADING_ASSIGNMENTS: RegExp = new RegExp(
  String.raw`^(?:[A-Z_]\w*(?:\[[^\]]*\])?\+?=${ASSIGNMENT_VALUE}(?:\s+|$))+`,
  'i',
)
export const ASSIGNMENT_WORD: RegExp = /^[A-Z_]\w*(?:\[[^\]]*\])?\+?=/i

export const READINGS: readonly Mode[] = [true, false].flatMap(comments =>
  (['on', 'bash32', 'off'] as const).map(heredocs => ({ comments, heredocs })),
)

export function read(cmd: string, mode: Mode): { segments: string[], complete: boolean } {
  const found: Found[] = []
  let complete = true

  try {
    new Reader(cmd, mode, 0, found).commands(0, false)
  }
  catch (e) {
    // A line nested deeper than the stack allows cannot be read either, and a throw would let a caller that fails
    // open run it.
    if (!(e instanceof Unreadable || e instanceof RangeError)) {
      throw e
    }

    complete = false
  }

  return { segments: found.toSorted((a, b) => a.start - b.start).map(f => f.text), complete }
}

/**
 * Splits a command line into the simple commands bash would run, in source order: the parts of pipelines and
 * `&&`/`||`/`;` lists, subshells, and the commands inside `$(…)` and backquotes, including those inside unquoted
 * here-documents. Leading `NAME=value` assignments are dropped, expansions are removed, and whitespace is collapsed.
 * Quoted here-document bodies and comments are data and yield nothing.
 *
 * When the line cannot be read to the end (an open quote, say), the commands found before that point are returned.
 *
 * @example
 * commandSegments('FOO=1 pnpm lint && echo $(gh pr list) | cat') // ['pnpm lint', 'echo', 'gh pr list', 'cat']
 */
export function commandSegments(cmd: string): string[] {
  return read(cmd, { comments: true, heredocs: 'on' })
    .segments
    .map(s =>
      s
        .replaceAll(EXP, '')
        .trim()
        .replace(LEADING_ASSIGNMENTS, '')
        .replace(/\s+/g, ' '),
    )
    .filter(Boolean)
}

const BRACE_EXPANSION = /^\{[^\s,]*,\S*\}|^\{[^\s,.]*\.\.\S*\}/
// A lone `[` is the test command; only a bracket closed within the word is a pattern.
const GLOB_START = /^(?:[*?]|\[\S+\])/

export function tokenize(seg: string): string[] {
  const tokens: string[] = []
  let cur: string | null = null
  let q: '"' | '\'' | null = null
  let dropNext = false

  function end(): void {
    if (cur !== null && !dropNext) {
      tokens.push(cur)
    }

    if (cur !== null) {
      dropNext = false
    }

    cur = null
  }

  for (let i = 0; i < seg.length; i++) {
    const c = seg.charAt(i)

    if (q) {
      if (c === q) {
        q = null
      }
      else if (c === '\\' && q === '"' && seg[i + 1] === '\n') {
        i++
      }
      else if (c === '\\' && q === '"' && i + 1 < seg.length) {
        cur = (cur ?? '') + seg[++i]
      }
      else {
        cur = (cur ?? '') + c
      }
    }
    else if (c === '"' || c === '\'') {
      q = c
      cur ??= ''
    }
    else if (c === '\\' && seg[i + 1] === '\n') {
      i++
    }
    else if (c === '\\' && i + 1 < seg.length) {
      cur = (cur ?? '') + seg[++i]
    }
    else if (c === '{' && BRACE_EXPANSION.test(seg.slice(i))) {
      // `{git,push}` and `pu{s,}h` become other words before the command runs, like any expansion.
      cur = (cur ?? '') + EXP + c
    }
    else if (GLOB_START.test(seg.slice(i))) {
      cur = (cur ?? '') + GLOB + c
    }
    else if (/\s/.test(c)) {
      end()
    }
    else if (c === '<' || c === '>') {
      // A redirection and its target are not part of the command; a bare number before it is the redirected descriptor.
      if (cur !== null && /^\d+$/.test(cur)) {
        cur = null
      }

      end()

      while ('<>&|'.includes(seg[i + 1] ?? ' ')) {
        i++
      }

      dropNext = true
    }
    else {
      cur = (cur ?? '') + c
    }
  }

  end()
  return tokens
}
