import type { Mode } from './types'
import { DEFAULT_DENY } from './defaults'
import { ASSIGNMENT_WORD, LEADING_ASSIGNMENTS, read, READINGS, tokenize } from './segments'
import { EXP, GLOB } from './word-reader'
import {
  AWK_OPTS,
  AWKS,
  FD_EXEC,
  FIND_EXEC,
  FLOCK_OPTS,
  GIT_OPTS,
  GIT_SCRIPT_OPTS,
  INTERPRETERS,
  PARALLEL_OPTS,
  RUNNER_OPTS,
  RUNNER_SUBCOMMANDS,
  RUNNERS,
  RUNUSER_OPTS,
  SCRIPT_OPTS,
  SHELL_OPTS,
  SHELLS,
  SSH_OPTS,
  WATCH_OPTS,
  WRAPPERS,
  XARGS_OPTS,
} from './wrappers'

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
const NO_ARGS: ReadonlySet<string> = new Set()
const PARALLEL_SEPARATOR = /^:{3,4}\+?$/
// GNU parallel's replacement strings: `{}`, `{.}`, `{/}`, `{//}`, `{/.}`, `{#}`, `{%}` and the positional `{1}`.
const PARALLEL_REPLACEMENT = /\{[\d./#%]*\}/g
const STDIN_FILE = /^(?:-|\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/self\/fd\/\d+)$/

function firstHit<T>(items: readonly T[], judgeItem: (item: T) => string | null): string | null {
  for (const item of items) {
    const hit = judgeItem(item)

    if (hit) {
      return hit
    }
  }

  return null
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

function scriptVerdict(script: string, name: string, judge: Judge, depth: number): string | null {
  return depth >= MAX_DEPTH ? unknowable(judge, name) : judgeCommand(script, judge, depth + 1)
}

function nestedScript(script: string, name: string, judge: Judge, depth: number): Next {
  return { verdict: scriptVerdict(script, name, judge, depth) }
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
  const wrapper = Object.hasOwn(WRAPPERS, exe) ? WRAPPERS[exe] : undefined
  const runner = Object.hasOwn(RUNNER_SUBCOMMANDS, exe) ? RUNNER_SUBCOMMANDS[exe] : undefined

  // zsh replaces a word starting with `=` by the path of the command it names.
  if (judge.strict && head.length > 1 && head.startsWith('=')) {
    return { tokens: [head.slice(1), ...tokens.slice(1)] }
  }

  if (exe !== head) {
    return { tokens: [exe, ...tokens.slice(1)] }
  }

  if (exe === 'command' && tokens.slice(1, skipOptions(tokens, 1, NO_ARGS)).some(t => /^-\w*v/i.test(t))) {
    // `command -v` only looks a name up; it runs nothing.
    return { verdict: null }
  }

  if (wrapper && (judge.strict || !wrapper.zsh)) {
    const end = skipOptions(tokens, 1, wrapper.opts) + (wrapper.operands ?? 0)
    return { tokens: (exe === 'env' ? splitEnvString(tokens) : null) ?? tokens.slice(end) }
  }

  if (runner) {
    const at = skipOptions(tokens, 1, runner.opts)
    const subcommand = tokens[at] ?? ''

    if (runner.run.includes(subcommand)) {
      return packageRunner(tokens, at + 1, judge, depth)
    }

    if (runner.shell.includes(subcommand)) {
      return nestedScript(tokens.slice(at + 1).join(' '), exe, judge, depth)
    }
  }

  return unwrapProgram(tokens, exe, judge, depth)
}

function unwrapProgram(tokens: string[], exe: string, judge: Judge, depth: number): Next {
  switch (exe) {
    case 'coproc':
      return { tokens: tokens.slice(tokens[2] === '{' ? 2 : 1) }
    case 'function':
      return { tokens: tokens.slice(2) }
    case '[[':
      return zshShortCondition(tokens, judge)
    case 'xargs':
      return { tokens: xargs(tokens) }
    case 'parallel':
      return parallel(tokens, judge, depth)
    case 'watch':
      return watch(tokens, judge, depth)
    case 'flock':
      return flock(tokens, judge, depth)
    case 'find':
      return { verdict: firstHit(execCommands(tokens, FIND_EXEC), sub => matchTokens(sub, judge, depth)) }
    case 'fd':
      return { verdict: firstHit(execCommands(tokens, FD_EXEC), sub => matchTokens(sub, judge, depth)) }
    case 'eval':
      return nestedScript(tokens.slice(1).join(' '), 'eval', judge, depth)
    case 'ssh':
      return ssh(tokens, judge, depth)
    case 'script':
      return script(tokens, judge, depth)
    case 'su':
    case 'runuser':
      return switchUser(tokens, exe, judge, depth)
    case 'trap':
      return trap(tokens, judge, depth)
    case 'alias':
      return alias(tokens, judge, depth)
    case 'source':
    case '.':
      return source(tokens, judge)
    case 'git':
      return git(tokens, judge, depth)
    case 'rm':
      return { verdict: rmByFlags(tokens, judge) }
  }

  if (RUNNERS.has(exe)) {
    return packageRunner(tokens, 1, judge, depth)
  }

  if (SHELLS.has(exe)) {
    return shellScript(tokens, exe, judge, depth)
  }

  if (Object.hasOwn(INTERPRETERS, exe) || AWKS.has(exe)) {
    return { verdict: judge.strict ? firstHit(inlinePrograms(tokens, exe), p => wordsMatch(p, judge)) : null }
  }

  return { verdict: null }
}

// zsh runs `[[ cond ]] cmd` as a short `if`; bash rejects it, so only the strict reading follows it.
function zshShortCondition(tokens: string[], judge: Judge): Next {
  const end = tokens.indexOf(']]')
  return judge.strict && end > 0 ? { tokens: tokens.slice(end + 1) } : { verdict: null }
}

// xargs appends the words it reads to the command, or puts them where its replace-string stands, so a pattern they
// could complete counts.
function xargs(tokens: string[]): string[] {
  const end = skipOptions(tokens, 1, XARGS_OPTS)
  const replace = replaceString(tokens.slice(1, end))
  const command = end < tokens.length ? tokens.slice(end) : ['echo']

  return replace === null ? [...command, EXP] : command.map(t => t.replaceAll(replace, EXP))
}

function replaceString(options: string[]): string | null {
  let replace: string | null = null

  for (let i = 0; i < options.length; i++) {
    const t = options[i] ?? ''

    if (t === '-I') {
      replace = options[++i] ?? null
    }
    else if (t === '-i' || t === '--replace') {
      replace = '{}'
    }
    else if (/^-I./i.test(t)) {
      replace = t.slice(2)
    }
    else if (t.startsWith('--replace=')) {
      replace = t.slice('--replace='.length)
    }
  }

  return replace || null
}

// GNU parallel runs its command through a shell with the input appended; with no command, each input is a command.
function parallel(tokens: string[], judge: Judge, depth: number): Next {
  const end = skipOptions(tokens, 1, PARALLEL_OPTS)
  const separator = tokens.findIndex((t, i) => i >= end && PARALLEL_SEPARATOR.test(t))
  const command = tokens.slice(end, separator < 0 ? tokens.length : separator)

  if (command.length > 0) {
    return nestedScript([...command, EXP].join(' ').replace(PARALLEL_REPLACEMENT, EXP), 'parallel', judge, depth)
  }

  if (separator < 0) {
    return { verdict: unknowable(judge, DENY_REASONS.stdinScript) }
  }

  if (tokens.some(t => t.startsWith('::::'))) {
    return { verdict: unknowable(judge, DENY_REASONS.scriptFile) }
  }

  const inputs = tokens.slice(separator).filter(t => !PARALLEL_SEPARATOR.test(t))
  return { verdict: firstHit(inputs, input => scriptVerdict(input, 'parallel', judge, depth)) }
}

// ssh hands the words after the host to a shell on that host, which reaches the same remotes and registries.
function ssh(tokens: string[], judge: Judge, depth: number): Next {
  const script = tokens.slice(skipOptions(tokens, 1, SSH_OPTS) + 1)
  return script.length === 0 ? { verdict: null } : nestedScript(script.join(' '), 'ssh', judge, depth)
}

// util-linux takes the command as `-c script`; BSD and macOS take it as the words after the typescript file.
function script(tokens: string[], judge: Judge, depth: number): Next {
  const scripts = optionValues(tokens, ['-c', '--command'])

  if (scripts.length > 0) {
    return { verdict: firstHit(scripts, s => scriptVerdict(s, 'script', judge, depth)) }
  }

  return { tokens: tokens.slice(skipOptions(tokens, 1, SCRIPT_OPTS) + 1) }
}

// `su user -c script` hands the script to the user's shell; `runuser -u user command` runs the command itself.
function switchUser(tokens: string[], exe: string, judge: Judge, depth: number): Next {
  const scripts = optionValues(tokens, ['-c', '--command'])

  if (scripts.length > 0) {
    return { verdict: firstHit(scripts, s => scriptVerdict(s, exe, judge, depth)) }
  }

  return exe === 'runuser' ? { tokens: tokens.slice(skipOptions(tokens, 1, RUNUSER_OPTS)) } : { verdict: null }
}

// The action runs later, when the signal arrives or the shell exits, so only the strict reading counts it.
function trap(tokens: string[], judge: Judge, depth: number): Next {
  const at = tokens[1] === '--' ? 2 : 1
  const action = tokens[at]

  if (!judge.strict || action === undefined || action.startsWith('-') || tokens.length <= at + 1) {
    return { verdict: null }
  }

  return nestedScript(action, 'trap', judge, depth)
}

// zsh expands aliases even in scripts, and the line after the definition can append any words to the value.
function alias(tokens: string[], judge: Judge, depth: number): Next {
  if (!judge.strict) {
    return { verdict: null }
  }

  const values = tokens.slice(1).filter(t => t.includes('=')).map(t => `${t.slice(t.indexOf('=') + 1)} ${EXP}`)
  return { verdict: firstHit(values, value => scriptVerdict(value, 'alias', judge, depth)) }
}

// A regular file is not followed, like any program that runs its own commands; stdin or a process substitution is a
// script built on this very line.
function source(tokens: string[], judge: Judge): Next {
  const file = tokens[tokens[1] === '--' ? 2 : 1]
  const fromStdin = file === undefined || STDIN_FILE.test(file)

  return { verdict: fromStdin ? unknowable(judge, DENY_REASONS.stdinScript) : null }
}

// The values of the options that carry a program or script: `-c code`, a cluster ending in it (`-Ic code`,
// `-le code`), `--eval code` and `--eval=code`.
function optionValues(tokens: string[], names: readonly string[]): string[] {
  const values: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i] ?? ''
    const name = names.find(n =>
      n.startsWith('--')
        ? t === n || t.startsWith(`${n}=`)
        : t === n || (/^-[a-z]+$/i.test(t) && t.endsWith(n.charAt(1))),
    )

    if (name === undefined) {
      continue
    }

    const value = t.startsWith(`${name}=`) ? t.slice(name.length + 1) : tokens[++i]

    if (value !== undefined) {
      values.push(value)
    }
  }

  return values
}

function inlinePrograms(tokens: string[], exe: string): string[] {
  if (!AWKS.has(exe)) {
    return optionValues(tokens, INTERPRETERS[exe] ?? [])
  }

  const end = skipOptions(tokens, 1, AWK_OPTS)
  const fromFile = tokens.slice(1, end).some(t => t.startsWith('-f') || isLongOption(t, '--file'))
  const program = fromFile ? [] : tokens.slice(end, end + 1)

  return [...optionValues(tokens.slice(0, end), ['-e', '--source']), ...program]
}

// An interpreter's program can run any command, and its quoting is not the shell's, so its words are searched for a
// pattern wherever they stand.
function wordsMatch(program: string, judge: Judge): string | null {
  const words = program.split(/[\s"'`,;()[\]{}|&$=<>]+/).filter(Boolean)
  const width = Math.max(0, ...judge.patterns.map(p => p.split(' ').length)) + 1
  const certain = { ...judge, strict: false }

  for (let i = 0; i < words.length; i++) {
    const hit = match(words.slice(i, i + width), certain)

    if (hit) {
      return hit
    }
  }

  return null
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

      i += t === '--unset' || t === '--chdir' ? 1 : 0
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
function execCommands(tokens: string[], exec: ReadonlySet<string>): string[][] {
  const commands: string[][] = []

  for (let i = 1; i < tokens.length; i++) {
    if (!exec.has(tokens[i] ?? '')) {
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
function git(tokens: string[], judge: Judge, depth: number): Next {
  const subcommand = tokens[1] ?? ''

  if (subcommand.startsWith('-')) {
    const end = skipOptions(tokens, 1, GIT_OPTS)
    const globals = tokens.slice(1, end)

    if (definesGitAlias(globals)) {
      return { verdict: unknowable(judge, DENY_REASONS.gitAlias) }
    }

    // A pager, editor, ssh command or helper set with `-c` is run by git; any other value read as a script is harmless.
    const values = judge.strict ? configValues(globals) : []
    const hit = firstHit(values, v => scriptVerdict(v.replace(/^!/, ''), 'git', judge, depth))

    return hit ? { verdict: hit } : { tokens: ['git', ...tokens.slice(end)] }
  }

  if (subcommand === 'config' && tokens.some(t => /^alias\./i.test(t))) {
    return { verdict: unknowable(judge, DENY_REASONS.gitAlias) }
  }

  if (subcommand === 'bisect' && tokens[2] === 'run') {
    return { tokens: tokens.slice(3) }
  }

  const hit = firstHit(gitScripts(tokens), script => scriptVerdict(script, 'git', judge, depth))
  return { verdict: hit ?? (judge.gitAliasEnv ? unknowable(judge, DENY_REASONS.gitAlias) : null) }
}

function configValues(globals: string[]): string[] {
  return globals.flatMap((t, i) => {
    const pair = globals[i - 1] === '-c' ? t : /^-c./.test(t) ? t.slice(2) : ''
    return pair.includes('=') ? [pair.slice(pair.indexOf('=') + 1)] : []
  })
}

// The shell commands a subcommand runs: `rebase -x`, `difftool -x`, the `filter-branch` filters, `submodule foreach`.
function gitScripts(tokens: string[]): string[] {
  const subcommand = tokens[1] ?? ''
  const foreach = subcommand === 'submodule' ? tokens.indexOf('foreach') : -1

  if (foreach > 0) {
    return [tokens.slice(foreach + 1).filter(t => t !== '--recursive').join(' ')]
  }

  return Object.hasOwn(GIT_SCRIPT_OPTS, subcommand) ? optionValues(tokens, GIT_SCRIPT_OPTS[subcommand] ?? []) : []
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
// `rm -rf <operand>` for each operand, as written and with `//`, `/./` and a trailing `/` or `/.` folded away.
// `$HOME` names the same directory as `~`.
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

  const spellings = operands.flatMap(operand => [operand, foldPath(operand)])
  return firstHit(spellings, operand => match(['rm', `-${flags}`, operand], judge))
}

function foldPath(path: string): string {
  let folded = path.replace(/\/{2,}/g, '/').replace(/\/\.(?=\/)/g, '')

  for (let prev = ''; prev !== folded;) {
    prev = folded
    folded = folded.replace(/(?<=.)\/$/, '').replace(/\/\.$/, '')
  }

  return folded || '/'
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
 * quotes and unquoted here-documents, each script given to `bash -c`/`sh -c`/`eval`/`ssh`/`trap`/`git rebase -x`,
 * and each command behind a wrapper such as `env` (and `env -S`), `sudo`, `nohup`, `timeout`, `nice`, `xargs`,
 * `parallel`, `flock`, `watch`, `find -exec`, `npx`, `pnpm exec`, `busybox` or `git -C dir`. `rm` is matched by its
 * flag set, so `rm -r -f /` matches `'rm -rf /'`. The inline program of `python -c`, `node -e` and similar is
 * searched for a pattern's words.
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
