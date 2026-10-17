import type { Mode } from './types'
import { DEFAULT_DENY } from './defaults'
import { ASSIGNMENT_WORD, LEADING_ASSIGNMENTS, read, READINGS, tokenize } from './segments'
import { EXP, GLOB } from './word-reader'

/**
 * The reasons {@link deniedBy} returns when it cannot tell what a command runs, in place of a matched pattern.
 */
export const DENY_REASONS: {
  readonly expansion: 'command word comes from an expansion'
  readonly unbalanced: 'unbalanced quoting'
  readonly gitAlias: 'git -c alias.*'
  readonly stdinScript: 'shell reads script from stdin'
  readonly scriptFile: 'shell runs a script file'
} = {
  expansion: 'command word comes from an expansion',
  unbalanced: 'unbalanced quoting',
  gitAlias: 'git -c alias.*',
  stdinScript: 'shell reads script from stdin',
  scriptFile: 'shell runs a script file',
}

/** A deny-list to add to {@link DEFAULT_DENY}. */
export interface DenyPolicy {
  deny: readonly string[]
}

// `strict` is enforcement: every shell's reading and a quote-blind pass are matched, a pattern an expansion could
// still complete counts, and a command that cannot be read is denied. Otherwise only what the bash reading shows
// certainly running counts. `gitAliasEnv` is inherited by every command started under that environment.
interface Judge {
  patterns: readonly string[]
  strict: boolean
  gitAliasEnv?: boolean
}

// What taking one wrapper off leaves: the command it runs, or the final answer.
type Next = { tokens: string[] } | { verdict: string | null }

const BASH_READING: readonly Mode[] = [{ comments: true, heredocs: 'on' }]

const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'do', 'else', 'elif', 'while', 'until'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh'])
const NONE: ReadonlySet<string> = new Set()
const SHELL_OPTS: ReadonlySet<string> = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])
const PNPM_OPTS: ReadonlySet<string> = new Set(['-C', '--dir', '-F', '--filter', '--loglevel', '--reporter'])
const NPM_OPTS: ReadonlySet<string> = new Set(['-w', '--workspace', '--prefix', '--loglevel', '--userconfig'])
const YARN_OPTS: ReadonlySet<string> = new Set(['--cwd'])
const RUNNER_OPTS: ReadonlySet<string> = new Set(['-p', '--package', '-w', '--workspace'])
const WATCH_OPTS: ReadonlySet<string> = new Set(['-n', '--interval', '-q', '--equexit'])
const FLOCK_OPTS: ReadonlySet<string> = new Set(['-w', '--wait', '--timeout', '-E', '--conflict-exit-code'])
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

// The package runner subcommands that run a command, by the options each runner takes before its subcommand.
const RUNNER_SUBCOMMANDS: Record<string, { opts: ReadonlySet<string>, subcommands: readonly string[] }> = {
  pnpm: { opts: PNPM_OPTS, subcommands: ['exec', 'dlx'] },
  npm: { opts: NPM_OPTS, subcommands: ['exec', 'x'] },
  yarn: { opts: YARN_OPTS, subcommands: ['exec', 'dlx'] },
}
const RUNNERS = new Set(['npx', 'pnpx', 'bunx'])

// Options that consume the next token; any other token starting with '-' stands alone.
const ARG_OPTS: Record<
  | 'env'
  | 'command'
  | 'time'
  | 'exec'
  | 'sudo'
  | 'nice'
  | 'xargs'
  | 'timeout'
  | 'git'
  | 'setsid'
  | 'stdbuf'
  | 'ionice'
  | 'chronic'
  | 'busybox',
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
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']),
  setsid: NONE,
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  ionice: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']),
  chronic: NONE,
  busybox: NONE,
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

// getopt takes any unambiguous prefix of a long option; three characters are enough for the ones read here.
function isLongOption(t: string, name: string): boolean {
  const given = t.split('=', 1)[0] ?? ''
  return given.length >= 3 && name.startsWith(given)
}

// An expansion can turn into any text, so under `strict` a pattern the literal text before it could still grow into
// is matched too.
function match(tokens: string[], judge: Judge): string | null {
  const line = tokens.join(' ').replaceAll(GLOB, '')
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

function nestedScript(script: string, name: string, judge: Judge, depth: number): Next {
  return { verdict: depth >= MAX_DEPTH ? unknowable(judge, name) : judgeCommand(script, judge, depth + 1) }
}

// Every form the command passes through while its wrappers come off is matched, so a list that names a wrapper
// itself (`sudo`, `npx`) is still honoured.
function matchTokens(start: string[], outer: Judge, depth: number): string | null {
  let tokens = start
  let judge = outer

  while (tokens.length > 0) {
    const head = tokens[0]

    if (head === undefined) {
      return null
    }

    const word = head.replaceAll(GLOB, '')
    const prefix = KEYWORDS.has(word) || ASSIGNMENT_WORD.test(word)

    if (!prefix && (head.includes(EXP) || head.includes(GLOB))) {
      return unknowable(judge, DENY_REASONS.expansion)
    }

    const hit = match(tokens, judge)

    if (hit) {
      return hit
    }

    if (prefix) {
      if (!judge.gitAliasEnv && definesGitAliasEnv(word)) {
        judge = { ...judge, gitAliasEnv: true }
      }

      tokens = tokens.slice(1)
      continue
    }

    const next = unwrap(tokens, head, judge, depth)

    if ('verdict' in next) {
      return next.verdict
    }

    tokens = next.tokens
  }

  return null
}

function unwrap(tokens: string[], head: string, judge: Judge, depth: number): Next {
  const exe = head.slice(head.lastIndexOf('/') + 1)
  const runner = Object.hasOwn(RUNNER_SUBCOMMANDS, exe) ? RUNNER_SUBCOMMANDS[exe] : undefined

  if (exe !== head) {
    return { tokens: [exe, ...tokens.slice(1)] }
  }

  if (exe === 'command' && (tokens[1] === '-v' || tokens[1] === '-V')) {
    // `command -v` only looks a name up; it runs nothing.
    return { verdict: null }
  }

  if (exe === 'builtin' || exe === 'nohup') {
    return { tokens: tokens.slice(1) }
  }

  if (exe === 'timeout') {
    return { tokens: tokens.slice(skipOptions(tokens, 1, ARG_OPTS.timeout) + 1) }
  }

  if (exe === 'env') {
    return { tokens: splitEnvString(tokens) ?? tokens.slice(skipOptions(tokens, 1, ARG_OPTS.env)) }
  }

  if (hasArgOpts(exe) && exe !== 'git') {
    return { tokens: tokens.slice(skipOptions(tokens, 1, ARG_OPTS[exe])) }
  }

  if (runner && runner.subcommands.includes(tokens[skipOptions(tokens, 1, runner.opts)] ?? '')) {
    return packageRunner(tokens, skipOptions(tokens, 1, runner.opts) + 1, judge, depth)
  }

  if (RUNNERS.has(exe)) {
    return packageRunner(tokens, 1, judge, depth)
  }

  if (exe === 'watch') {
    return watch(tokens, judge, depth)
  }

  if (exe === 'flock') {
    return flock(tokens, judge, depth)
  }

  if (exe === 'find') {
    return { verdict: findCommands(tokens).reduce<string | null>((hit, sub) => hit ?? matchTokens(sub, judge, depth), null) }
  }

  if (exe === 'eval') {
    return nestedScript(tokens.slice(1).join(' '), 'eval', judge, depth)
  }

  if (SHELLS.has(exe)) {
    return shellScript(tokens, exe, judge, depth)
  }

  if (exe === 'git') {
    return git(tokens, judge)
  }

  if (exe === 'rm') {
    return { verdict: rmByFlags(tokens, judge) }
  }

  return { verdict: null }
}

// `env -S "A=1 git push"` splits its string into words the way a shell would, though it expands only `${NAME}`.
function splitEnvString(tokens: string[]): string[] | null {
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i] ?? ''

    if (t === '--' || !t.startsWith('-')) {
      return null
    }

    if (t.startsWith('--')) {
      if (isLongOption(t, '--split-string')) {
        const value = t.includes('=') ? t.slice(t.indexOf('=') + 1) : tokens[i + 1]
        return splitEnvWords(value, tokens.slice(t.includes('=') ? i + 1 : i + 2))
      }

      i += ARG_OPTS.env.has(t) ? 1 : 0
      continue
    }

    for (let j = 1; j < t.length; j++) {
      const letter = t[j]

      if (letter === 'S') {
        const value = j + 1 < t.length ? t.slice(j + 1) : tokens[i + 1]
        return splitEnvWords(value, tokens.slice(j + 1 < t.length ? i + 1 : i + 2))
      }

      if (letter === 'u' || letter === 'C') {
        i += j === t.length - 1 ? 1 : 0
        break
      }
    }
  }

  return null
}

function splitEnvWords(value: string | undefined, rest: string[]): string[] {
  return ['env', ...tokenize((value ?? '').replace(/\$\{[^}]*\}/g, EXP)), ...rest]
}

// `-c` (npx, npm exec) and `--shell-mode` (pnpm) hand what follows to a shell.
function packageRunner(tokens: string[], from: number, judge: Judge, depth: number): Next {
  const end = skipOptions(tokens, from, RUNNER_OPTS)
  const options = tokens.slice(from, end)
  const call = options.find(t => t.startsWith('--call='))

  if (call === undefined && !options.some(t => ['-c', '--call', '--shell-mode'].includes(t))) {
    return { tokens: tokens.slice(end) }
  }

  const script = [...(call === undefined ? [] : [call.slice('--call='.length)]), ...tokens.slice(end)].join(' ')
  return nestedScript(script, tokens[0] ?? '', judge, depth)
}

// Without `-x`, watch joins its arguments and gives them to `sh -c`.
function watch(tokens: string[], judge: Judge, depth: number): Next {
  const end = skipOptions(tokens, 1, WATCH_OPTS)
  const exec = tokens.slice(1, end).some(t => t === '--exec' || /^-[a-z]*x/i.test(t))

  return exec ? { tokens: tokens.slice(end) } : nestedScript(tokens.slice(end).join(' '), 'watch', judge, depth)
}

// `flock [options] lock command…` or `flock [options] lock -c script`; with a file descriptor alone it runs nothing.
function flock(tokens: string[], judge: Judge, depth: number): Next {
  const rest = tokens.slice(skipOptions(tokens, 1, FLOCK_OPTS) + 1)

  if (rest[0] !== '-c' && rest[0] !== '--command') {
    return { tokens: rest }
  }

  return rest[1] === undefined ? { verdict: null } : nestedScript(rest[1], 'flock', judge, depth)
}

// Each `-exec cmd … ;` runs a command; `+` ends one only right after `{}`.
function findCommands(tokens: string[]): string[][] {
  const commands: string[][] = []

  for (let i = 1; i < tokens.length; i++) {
    if (!FIND_EXEC.has(tokens[i] ?? '')) {
      continue
    }

    let j = i + 1

    while (j < tokens.length && tokens[j] !== ';' && !(tokens[j] === '+' && tokens[j - 1] === '{}')) {
      j++
    }

    commands.push(tokens.slice(i + 1, j))
    i = j
  }

  return commands
}

// Only `-c` names the script on the command line. Otherwise a shell reads it from a file or from stdin, which this
// reading cannot see.
function shellScript(tokens: string[], exe: string, judge: Judge, depth: number): Next {
  const end = skipOptions(tokens, 1, SHELL_OPTS, true)
  const options = tokens.slice(1, end)
  const script = tokens[end]

  if (options.some(t => /^-[abd-z]*c[a-z]*$/.test(t))) {
    return script === undefined ? { verdict: null } : nestedScript(script, exe, judge, depth)
  }

  if (options.some(t => t === '--version' || t === '--help')) {
    return { verdict: null }
  }

  if (script === undefined || options.some(t => /^-[a-z]+$/.test(t) && t.includes('s'))) {
    return { verdict: unknowable(judge, DENY_REASONS.stdinScript) }
  }

  return { verdict: unknowable(judge, DENY_REASONS.scriptFile) }
}

// Git ignores an alias that shadows a real command, so the subcommand is matched before an alias is suspected.
function git(tokens: string[], judge: Judge): Next {
  if ((tokens[1] ?? '').startsWith('-')) {
    const end = skipOptions(tokens, 1, ARG_OPTS.git)

    if (definesGitAlias(tokens.slice(1, end))) {
      return { verdict: unknowable(judge, DENY_REASONS.gitAlias) }
    }

    return { tokens: ['git', ...tokens.slice(end)] }
  }

  return { verdict: judge.gitAliasEnv ? unknowable(judge, DENY_REASONS.gitAlias) : null }
}

// An alias can rename any subcommand, so what it runs cannot be known from the command line.
function definesGitAlias(globals: string[]): boolean {
  return globals.some(
    (t, i) =>
      (/^alias\./i.test(t) && ['-c', '--config-env'].includes(globals[i - 1] ?? ''))
      || /^(?:--config-env=|-c)alias\./i.test(t),
  )
}

// Git reads `-c` pairs from these variables too. Any GIT_CONFIG_PARAMETERS counts, since its quoting can hide the key.
function definesGitAliasEnv(assignment: string): boolean {
  const key = /^GIT_CONFIG_KEY_\d+\+?=([\s\S]*)$/.exec(assignment)?.[1]
  return /^GIT_CONFIG_PARAMETERS\+?=/.test(assignment) || (key !== undefined && (/^alias\./i.test(key) || key.includes(EXP)))
}

// GNU rm takes its options anywhere before `--`, in any order and spelling, so `rm` is matched once more as
// `rm -rf <operand>` for each operand. `$HOME` names the same directory as `~`.
function rmByFlags(tokens: string[], judge: Judge): string | null {
  let recursive = false
  let force = false
  let options = true
  const operands: string[] = []

  for (const t of tokens.slice(1)) {
    if (options && t === '--') {
      options = false
    }
    else if (options && t.startsWith('--')) {
      recursive ||= isLongOption(t, '--recursive')
      force ||= isLongOption(t, '--force')
    }
    else if (options && t.startsWith('-') && t.length > 1) {
      recursive ||= /r/i.test(t)
      force ||= t.includes('f')
    }
    else {
      operands.push(t.replace(/^\0\$(?:HOME|\{HOME\})(?=\/|$)/, '~'))
    }
  }

  const flags = `${recursive ? 'r' : ''}${force ? 'f' : ''}`

  if (flags === '') {
    return null
  }

  return operands.reduce<string | null>((hit, operand) => hit ?? match(['rm', `-${flags}`, operand], judge), null)
}

// A matcher blind to quoting: a comment, a here-document or $'…' can put the scanner out of step with the shell,
// and this layer keeps every command a naive split would deny denied.
function quoteBlindMatch(cmd: string, judge: Judge): string | null {
  for (const seg of cmd.split(/&&|\|\||[;|\n`)]|\$\(/)) {
    const hit = match(
      seg
        .trim()
        .replace(LEADING_ASSIGNMENTS, '')
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
 * wrapper such as `env` (and `env -S`), `sudo`, `nohup`, `timeout`, `nice`, `xargs`, `setsid`, `stdbuf`, `ionice`,
 * `flock`, `watch`, `find -exec`, `npx`, `pnpm exec`, `npm exec`, `yarn dlx`, `busybox` or `git -C dir`. `rm` is matched
 * by its flag set, so `rm -r -f /` matches `'rm -rf /'`.
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
