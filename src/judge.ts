import type { Mode } from './types'
import { DEFAULT_DENY } from './defaults'
import { read, READINGS, tokenize } from './segments'
import { EXP } from './word-reader'

/**
 * The reasons {@link deniedBy} returns when it cannot tell what a command runs, in place of a matched pattern.
 */
export const DENY_REASONS: {
  readonly expansion: 'command word comes from an expansion'
  readonly unbalanced: 'unbalanced quoting'
  readonly gitAlias: 'git -c alias.*'
} = {
  expansion: 'command word comes from an expansion',
  unbalanced: 'unbalanced quoting',
  gitAlias: 'git -c alias.*',
}

/** A deny-list to add to {@link DEFAULT_DENY}. */
export interface DenyPolicy {
  deny: readonly string[]
}

// `strict` is enforcement: every shell's reading and a quote-blind pass are matched, a pattern an expansion could
// still complete counts, and a command that cannot be read is denied. Otherwise only what the bash reading shows
// certainly running counts.
interface Judge {
  patterns: readonly string[]
  strict: boolean
}

const BASH_READING: readonly Mode[] = [{ comments: true, heredocs: 'on' }]

const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'do', 'else', 'elif', 'while', 'until'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
const NONE: ReadonlySet<string> = new Set()
const SHELL_OPTS: ReadonlySet<string> = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])
const PNPM_OPTS: ReadonlySet<string> = new Set(['-C', '--dir', '-F', '--filter', '--loglevel', '--reporter'])

// Options that consume the next token; any other token starting with '-' stands alone.
const ARG_OPTS: Record<
  'env' | 'command' | 'time' | 'exec' | 'sudo' | 'nice' | 'xargs' | 'npx' | 'timeout' | 'git',
  ReadonlySet<string>
> = {
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  command: NONE,
  time: NONE,
  exec: new Set(['-a']),
  sudo: new Set([
    '-u',
    '--user',
    '-g',
    '--group',
    '-h',
    '--host',
    '-p',
    '--prompt',
    '-C',
    '--close-from',
    '-D',
    '--chdir',
    '-R',
    '--chroot',
    '-r',
    '--role',
    '-t',
    '--type',
    '-T',
    '--command-timeout',
    '-U',
    '--other-user',
  ]),
  nice: new Set(['-n', '--adjustment']),
  xargs: new Set([
    '-a',
    '--arg-file',
    '-d',
    '--delimiter',
    '-E',
    '-I',
    '-L',
    '--max-lines',
    '-n',
    '--max-args',
    '-P',
    '--max-procs',
    '-s',
    '--max-chars',
  ]),
  npx: new Set(['-p', '--package']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']),
}

function hasArgOpts(exe: string): exe is keyof typeof ARG_OPTS {
  return Object.hasOwn(ARG_OPTS, exe)
}

function needsArg(t: string, takesArg: ReadonlySet<string>): boolean {
  if (takesArg.has(t)) {
    return true
  }

  if (t.startsWith('--') || t.length <= 2) {
    return false
  }

  // In a cluster such as -iu the first letter that takes an argument consumes the rest of the cluster,
  // or the next token when it is the last letter.
  for (let j = 1; j < t.length; j++) {
    if (takesArg.has(`${t[0]}${t[j]}`)) {
      return j === t.length - 1
    }
  }

  return false
}

// Shells also take options that start with '+'; for every other wrapper a '+' word is an operand.
function skipOptions(tokens: string[], from: number, takesArg: ReadonlySet<string>, plus = false): number {
  let i = from

  const isOption = (t: string): boolean => t.startsWith('-') || (plus && t.startsWith('+'))

  for (let t = tokens[i]; t !== undefined && isOption(t); t = tokens[i]) {
    if (t === '--') {
      return i + 1
    }

    i += needsArg(t, takesArg) ? 2 : 1
  }

  return i
}

// An expansion can turn into any text, so under `strict` a pattern the literal text before it could still grow into
// is matched too.
function match(tokens: string[], judge: Judge): string | null {
  const line = tokens.join(' ')
  const cut = line.indexOf(EXP)
  const literal = cut < 0 ? line : line.slice(0, cut)

  const certain = (p: string): boolean => (literal === line && line === p) || literal.startsWith(`${p} `)
  const possible = (p: string): boolean => literal !== line && `${p} `.startsWith(literal)

  return judge.patterns.find(p => certain(p) || (judge.strict && possible(p))) ?? null
}

function unknowable(judge: Judge, reason: string): string | null {
  return judge.strict ? reason : null
}

const MAX_DEPTH = 8

// Every form the command passes through while its wrappers come off is matched, so a list that names a wrapper
// itself (`sudo`, `npx`) is still honoured.
function matchTokens(start: string[], judge: Judge, depth: number): string | null {
  let tokens = start

  while (tokens.length > 0) {
    const head = tokens[0]

    if (head === undefined) {
      return null
    }

    const prefix = KEYWORDS.has(head) || /^[A-Z_]\w*=/i.test(head)

    if (!prefix && head.includes(EXP)) {
      return unknowable(judge, DENY_REASONS.expansion)
    }

    const hit = match(tokens, judge)

    if (hit) {
      return hit
    }

    const exe = head.slice(head.lastIndexOf('/') + 1)

    if (prefix) {
      tokens = tokens.slice(1)
    }
    else if (exe !== head) {
      tokens = [exe, ...tokens.slice(1)]
    }
    else if (exe === 'command' && (tokens[1] === '-v' || tokens[1] === '-V')) {
      // `command -v` only looks a name up; it runs nothing.
      return null
    }
    else if (exe === 'builtin' || exe === 'nohup') {
      tokens = tokens.slice(1)
    }
    else if (exe === 'timeout') {
      tokens = tokens.slice(skipOptions(tokens, 1, ARG_OPTS.timeout) + 1)
    }
    else if (hasArgOpts(exe) && exe !== 'git') {
      tokens = tokens.slice(skipOptions(tokens, 1, ARG_OPTS[exe]))
    }
    else if (exe === 'pnpm' && ['exec', 'dlx'].includes(tokens[skipOptions(tokens, 1, PNPM_OPTS)] ?? '')) {
      tokens = tokens.slice(skipOptions(tokens, 1, PNPM_OPTS) + 1)
    }
    else if (exe === 'eval') {
      return depth >= MAX_DEPTH ? unknowable(judge, 'eval') : judgeCommand(tokens.slice(1).join(' '), judge, depth + 1)
    }
    else if (SHELLS.has(exe)) {
      return shellScript(tokens, exe, judge, depth)
    }
    else if (exe === 'git' && (tokens[1] ?? '').startsWith('-')) {
      const end = skipOptions(tokens, 1, ARG_OPTS.git)

      if (definesGitAlias(tokens.slice(1, end))) {
        return unknowable(judge, DENY_REASONS.gitAlias)
      }

      tokens = ['git', ...tokens.slice(end)]
    }
    else {
      return null
    }
  }

  return null
}

// Only `-c` makes a shell run its argument; `bash script.sh` runs a file this reading cannot see.
function shellScript(tokens: string[], exe: string, judge: Judge, depth: number): string | null {
  const end = skipOptions(tokens, 1, SHELL_OPTS, true)
  const script = tokens[end]

  if (!tokens.slice(1, end).some(t => /^-[abd-z]*c[a-z]*$/.test(t)) || script === undefined) {
    return null
  }

  return depth >= MAX_DEPTH ? unknowable(judge, exe) : judgeCommand(script, judge, depth + 1)
}

// An alias can rename any subcommand, so what it runs cannot be known from the command line.
function definesGitAlias(globals: string[]): boolean {
  return globals.some(
    (t, i) =>
      (/^alias\./i.test(t) && ['-c', '--config-env'].includes(globals[i - 1] ?? ''))
      || /^--config-env=alias\./i.test(t),
  )
}

// A matcher blind to quoting: a comment, a here-document or $'…' can put the scanner out of step with the shell,
// and this layer keeps every command a naive split would deny denied.
function quoteBlindMatch(cmd: string, judge: Judge): string | null {
  for (const seg of cmd.split(/&&|\|\||[;|\n`)]|\$\(/)) {
    const hit = match(
      seg
        .trim()
        .replace(/^(\w+=\S*\s+)+/, '')
        .split(/\s+/),
      judge,
    )

    if (hit) {
      return hit
    }
  }

  return null
}

// Under `strict` every reading is matched, so a command only one shell's reading sees is still caught. The scanner
// gets raw text, because a backslash-newline inside a quoted here-document is data, not a continuation.
function judgeCommand(cmd: string, judge: Judge, depth: number): string | null {
  const segments = new Set<string>()
  let complete = false

  for (const mode of judge.strict ? READINGS : BASH_READING) {
    const r = read(cmd, mode)
    complete ||= r.complete

    for (const seg of r.segments) {
      segments.add(seg)
    }
  }

  for (const seg of segments) {
    const hit = matchTokens(tokenize(seg), judge, depth)

    if (hit) {
      return hit
    }
  }

  if (!judge.strict) {
    return null
  }

  return (
    quoteBlindMatch(cmd, judge)
    ?? quoteBlindMatch(cmd.replace(/\\\n/g, ' '), judge)
    ?? (complete ? null : DENY_REASONS.unbalanced)
  )
}

/**
 * Decides whether a shell command may run under a deny-list, failing closed.
 *
 * Each pattern is a word prefix (`'git push'`, `'rm -rf /'`) matched against every command the line could run:
 * each part of a pipeline or `&&`/`;` list, each `$(…)` and backquoted substitution, including those inside double
 * quotes and unquoted here-documents, each script given to `bash -c`/`sh -c`/`eval`, and each command behind a
 * wrapper such as `env`, `sudo`, `nohup`, `timeout`, `nice`, `xargs`, `npx`, `pnpm exec` or `git -C dir`.
 *
 * @param cmd - The command line, as a shell would receive it.
 * @param deny - Word-prefix patterns to deny.
 * @returns The first pattern matched; or one of {@link DENY_REASONS} (or the name of a wrapper nested too deep)
 * when what the command runs cannot be known; or `null` when the command may run.
 *
 * @example
 * deniedBy('FOO=1 sudo -u ci git push origin', ['git push']) // 'git push'
 * deniedBy('grep "git push" notes.md', ['git push']) // null
 * deniedBy('$TOOL push', ['git push']) // 'command word comes from an expansion'
 */
export function deniedBy(cmd: string, deny: readonly string[]): string | null {
  return judgeCommand(cmd, { patterns: deny, strict: true }, 0)
}

/**
 * Tells whether a shell command certainly runs a program or subcommand, as opposed to merely mentioning it in a
 * quoted argument, a comment or a here-document body.
 *
 * It sees through the same wrappers and substitutions as {@link deniedBy} but reads the line as bash does and never
 * guesses: an expansion that could become the command, or text it cannot parse, counts as not running it. Use it to
 * decide whether a check applies to a command, not to enforce a deny-list.
 *
 * @param cmd - The command line, as a shell would receive it.
 * @param command - One word-prefix pattern (`'git commit'`, `'gh pr create'`) or a list of them.
 * @returns `true` when some command the line runs starts with one of the patterns.
 *
 * @example
 * runsCommand('git add -A && git -C repo commit -m "x"', 'git commit') // true
 * runsCommand('echo "then git commit"', 'git commit') // false
 */
export function runsCommand(cmd: string, command: string | readonly string[]): boolean {
  const patterns = typeof command === 'string' ? [command] : command
  return judgeCommand(cmd, { patterns, strict: false }, 0) !== null
}

/**
 * Builds a deny-list from {@link DEFAULT_DENY} followed by a policy's own patterns and any extra ones.
 *
 * @example
 * effectiveDeny({ deny: ['docker'] }, ['kubectl delete']) // [...DEFAULT_DENY, 'docker', 'kubectl delete']
 */
export function effectiveDeny(policy: DenyPolicy, extra: readonly string[] = []): string[] {
  return [...DEFAULT_DENY, ...policy.deny, ...extra]
}
