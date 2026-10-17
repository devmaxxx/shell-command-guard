import type { Found, Mode, Sink } from './types'
import { Reader } from './shell-reader'
import { EXP, GLOB, SUB, Unreadable } from './word-reader'

// A quoted or escaped value may hold blanks, so the leading assignments are matched as shell words, not as `\S*`.
const ASSIGNMENT_VALUE = String.raw`(?:[^\s'"\\]|\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*")*`
export const LEADING_ASSIGNMENTS: RegExp = new RegExp(
  String.raw`^(?:[A-Z_]\w*(?:\[[^\]]*\])?\+?=${ASSIGNMENT_VALUE}(?:\s+|$))+`,
  'i',
)
export const ASSIGNMENT_WORD: RegExp = /^[A-Z_]\w*(?:\[[^\]]*\])?\+?=/i

export const BASH: Mode = { comments: true, heredocs: 'on' }

export const READINGS: readonly Mode[] = [true, false].flatMap(comments =>
  (['on', 'bash32', 'off'] as const).map(heredocs => ({ comments, heredocs })),
)

// What a $(…) leaves in a segment: its `EXP`, then the index of its source between two `SUB`s.
export const SUBSTITUTION: RegExp = new RegExp(`${EXP}${SUB}(\\d+)${SUB}`, 'g')

// `subs` is shared with the readings of any script nested in this one, so an index stays valid across them.
export function read(
  cmd: string,
  mode: Mode,
  subs: string[] = [],
): { segments: string[], found: Found[], complete: boolean } {
  const sink: Sink = { found: [], subs }
  let complete = true

  try {
    new Reader(cmd, mode, 0, sink).commands(0, false)
  }
  catch (e) {
    // A line nested deeper than the stack allows cannot be read either, and a throw would let a caller that fails
    // open run it.
    if (!(e instanceof Unreadable || e instanceof RangeError)) {
      throw e
    }

    complete = false
  }

  const found = sink.found.toSorted((a, b) => a.start - b.start)
  return { segments: found.map(f => f.text), found, complete }
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
  return read(cmd, BASH)
    .segments
    .map(s =>
      s
        .replace(SUBSTITUTION, '')
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
  return words(seg).tokens
}

// The words of a segment, and the word a `<<<` here-string feeds it, which a redirection would otherwise drop.
export function words(seg: string): { tokens: string[], hereString: string | null } {
  const tokens: string[] = []
  let hereString: string | null = null
  let cur: string | null = null
  let q: '"' | '\'' | null = null
  let dropNext = false
  let takeNext = false

  function end(): void {
    if (cur !== null && takeNext) {
      hereString = cur
    }
    else if (cur !== null && !dropNext) {
      tokens.push(cur)
    }

    if (cur !== null) {
      dropNext = false
      takeNext = false
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
      const op = i

      while ('<>&|'.includes(seg[i + 1] ?? ' ')) {
        i++
      }

      takeNext = seg.slice(op, i + 1) === '<<<'
      dropNext = !takeNext
    }
    else {
      cur = (cur ?? '') + c
    }
  }

  end()
  return { tokens, hereString }
}

// A word's text once the shell has expanded it, or null when that depends on what runs. A word that is one whole
// $(…) is known when the substitution only prints a here-document or here-string, the way a message is passed in
// `-m "$(cat <<'EOF' … EOF)"`; like any substitution it loses its trailing newlines.
export function resolveWord(word: string, subs: readonly string[]): string | null {
  const whole = new RegExp(`^${SUBSTITUTION.source}$`).exec(word)

  if (whole) {
    const output = substitutionOutput(subs[Number(whole[1])] ?? '')
    return output === null ? null : output.replace(/\n+$/, '')
  }

  return word.includes(EXP) ? null : word.replaceAll(GLOB, '')
}

function substitutionOutput(source: string): string | null {
  const subs: string[] = []
  const { found, complete } = read(source, BASH, subs)
  const commands = found.filter(f => f.text.trim() !== '')
  const only = commands[0]

  if (!complete || commands.length !== 1 || only === undefined) {
    return null
  }

  const { tokens, hereString } = words(only.text)

  if (tokens[0] !== 'cat' || tokens.slice(1).some(t => t !== '-')) {
    return null
  }

  return stdinOf(only, hereString, subs) ?? null
}

// What a command reads on stdin from its own redirections: a here-document body, or a here-string's word and the
// newline the shell adds. `undefined` when it has neither, null when it has one whose text is unknown.
export function stdinOf(found: Found, hereString: string | null, subs: readonly string[]): string | null | undefined {
  if (found.stdin !== undefined) {
    return found.stdin
  }

  if (hereString === null) {
    return undefined
  }

  const text = resolveWord(hereString, subs)
  return text === null ? null : `${text}\n`
}
