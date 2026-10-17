import type { Invocation } from './judge'
import { invocations } from './judge'

/** The Conventional Commits types {@link isConventionalCommit} accepts by default. */
export const COMMIT_TYPES: readonly string[] = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
]

/** The Conventional Branch prefixes {@link isConventionalBranch} accepts by default. */
export const BRANCH_TYPES: readonly string[] = ['feature', 'feat', 'bugfix', 'fix', 'hotfix', 'release', 'chore']

/** A commit message or pull-request text a command line writes, as {@link authoredMessages} reads it. */
export interface AuthoredMessage {
  /** `'commit'` for `git commit`; `'pull-request'` for `gh pr create`, `edit`, `comment`, `review` and `merge`. */
  kind: 'commit' | 'pull-request'
  /**
   * The text as the line spells it: the `-m` paragraphs and `--trailer` lines of a commit, or a pull request's title
   * and body. `null` when it comes from an editor, another commit, a file or an expansion; a commit whose first `-m`
   * is known but a later one is not keeps the paragraphs before the first unknown one.
   */
  text: string | null
  /** The file the text is read from (`-F path`, `--body-file path`), which this reading does not open. */
  file: string | null
}

/** Options for {@link authorshipViolations}. */
export interface AuthorshipOptions {
  /** Reads a message file named on the line; return `null` when it cannot be read. Without it, files are skipped. */
  readFile?: (path: string) => string | null
  commitTypes?: readonly string[]
  branchTypes?: readonly string[]
}

const TOOLS = '(?:Claude|Copilot|Codex|Cursor|Gemini|ChatGPT|GPT|OpenAI|Anthropic|AI)'

// Only signatures count: a tool's name in prose is content, while a trailer or footer changes who a host shows as
// the author of a commit, pull request or document.
const SIGNATURES: readonly RegExp[] = [
  new RegExp(`^\\s*[\\w-]+-(?:By|With):.*\\b${TOOLS}\\b`, 'i'),
  /noreply@anthropic\.com|copilot@github\.com/i,
  /^\s*Claude-Session:|claude\.ai\/code\/session_/i,
  new RegExp(`^\\W*Generated (?:with|by) \\[?${TOOLS}\\b`, 'i'),
  new RegExp(
    `^\\W*(?:written|created|authored|drafted|made|built|produced|generated) (?:with|by|using) (?:an? )?${TOOLS}\\b`,
    'i',
  ),
  /^\s*🤖/u,
]

// Git writes these subjects itself, so they pass whatever the convention.
const GENERATED_SUBJECT = /^(?:Merge |fixup! |squash! |amend! |Revert ")/
const TRUNKS = new Set(['main', 'master', 'develop'])

interface OptionSpec {
  // Short letters that take a value, attached or in the next word.
  short: string
  // Short letters whose value is only ever attached (`-uno`).
  attached?: string
  long: readonly string[]
  // Long options whose value is only ever given with `=`.
  optionalLong?: readonly string[]
  flags: readonly string[]
  // Git takes any unambiguous prefix of a long option; gh's flag library does not.
  abbrev?: boolean
}

interface Parsed {
  options: [string, string | null][]
  operands: (string | null)[]
  // An option this reading cannot place, so what follows it may be misread.
  unknown: boolean
}

const GIT_COMMIT: OptionSpec = {
  short: 'mFCct',
  attached: 'uS',
  long: [
    'message',
    'file',
    'reuse-message',
    'reedit-message',
    'fixup',
    'squash',
    'author',
    'date',
    'template',
    'trailer',
    'cleanup',
    'pathspec-from-file',
  ],
  optionalLong: ['untracked-files', 'gpg-sign'],
  flags: [
    'all',
    'patch',
    'reset-author',
    'short',
    'branch',
    'porcelain',
    'long',
    'null',
    'signoff',
    'verify',
    'allow-empty',
    'allow-empty-message',
    'edit',
    'amend',
    'post-rewrite',
    'include',
    'only',
    'pathspec-file-nul',
    'verbose',
    'quiet',
    'dry-run',
    'status',
    'interactive',
    'ahead-behind',
  ],
  abbrev: true,
}

const GH_PR: Readonly<Record<string, OptionSpec>> = {
  create: {
    short: 'tbFBHalmprRT',
    long: [
      'title',
      'body',
      'body-file',
      'base',
      'head',
      'assignee',
      'label',
      'milestone',
      'project',
      'reviewer',
      'repo',
      'template',
      'recover',
    ],
    flags: ['draft', 'fill', 'fill-first', 'fill-verbose', 'web', 'dry-run', 'no-maintainer-edit', 'editor'],
  },
  edit: {
    short: 'tbFBmR',
    long: [
      'title',
      'body',
      'body-file',
      'base',
      'milestone',
      'repo',
      'add-label',
      'remove-label',
      'add-assignee',
      'remove-assignee',
      'add-reviewer',
      'remove-reviewer',
      'add-project',
      'remove-project',
    ],
    flags: ['remove-milestone'],
  },
  comment: {
    short: 'bFR',
    long: ['body', 'body-file', 'repo'],
    flags: ['editor', 'web', 'edit-last', 'delete-last', 'yes', 'create-if-none'],
  },
  review: {
    short: 'bFR',
    long: ['body', 'body-file', 'repo'],
    flags: ['approve', 'request-changes', 'comment'],
  },
  merge: {
    short: 'tbFAR',
    long: ['subject', 'body', 'body-file', 'author-email', 'match-head-commit', 'repo'],
    flags: ['admin', 'auto', 'delete-branch', 'disable-auto', 'merge', 'rebase', 'squash'],
  },
}

const GIT_CHECKOUT: OptionSpec = {
  short: 'bB',
  long: ['orphan', 'conflict', 'pathspec-from-file'],
  optionalLong: ['track', 'recurse-submodules'],
  flags: [
    'quiet',
    'progress',
    'force',
    'ours',
    'theirs',
    'merge',
    'detach',
    'guess',
    'overlay',
    'ignore-skip-worktree-bits',
    'ignore-other-worktrees',
    'overwrite-ignore',
    'patch',
    'pathspec-file-nul',
  ],
  abbrev: true,
}

const GIT_SWITCH: OptionSpec = {
  short: 'cC',
  long: ['create', 'force-create', 'orphan', 'conflict'],
  optionalLong: ['track', 'recurse-submodules'],
  flags: ['detach', 'guess', 'discard-changes', 'merge', 'quiet', 'progress', 'force', 'ignore-other-worktrees'],
  abbrev: true,
}

const GIT_BRANCH: OptionSpec = {
  short: 'u',
  attached: 't',
  long: ['set-upstream-to', 'sort', 'format', 'points-at'],
  optionalLong: ['track', 'contains', 'no-contains', 'merged', 'no-merged', 'abbrev', 'color', 'column'],
  flags: [
    'delete',
    'create-reflog',
    'force',
    'move',
    'copy',
    'list',
    'all',
    'remotes',
    'show-current',
    'verbose',
    'quiet',
    'ignore-case',
    'unset-upstream',
    'edit-description',
    'omit-empty',
    'recurse-submodules',
  ],
  abbrev: true,
}

const GIT_WORKTREE_ADD: OptionSpec = {
  short: 'bB',
  long: ['reason'],
  flags: ['force', 'detach', 'checkout', 'lock', 'orphan', 'quiet', 'track', 'guess-remote', 'relative-paths'],
  abbrev: true,
}

// `git branch` only lists, deletes or configures with any of these, and then names no new branch.
const BRANCH_NOT_CREATING = new Set([
  '-d',
  '-D',
  '--delete',
  '-l',
  '--list',
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '--verbose',
  '--show-current',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '-u',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
])
const BRANCH_RENAMING = new Set(['-m', '-M', '--move', '-c', '-C', '--copy'])

function resolveLong(given: string, spec: OptionSpec): string | null {
  const all = [...spec.long, ...(spec.optionalLong ?? []), ...spec.flags]

  if (all.includes(given)) {
    return given
  }

  // Git takes `--no-<flag>` for most flags; the value-taking ones do not matter once negated.
  if (given.startsWith('no-') && all.includes(given.slice(3))) {
    return given
  }

  if (!spec.abbrev) {
    return null
  }

  const candidates = all.filter(name => name.startsWith(given))
  return candidates.length === 1 ? (candidates[0] ?? null) : null
}

function parseOptions(args: readonly (string | null)[], spec: OptionSpec): Parsed {
  const parsed: Parsed = { options: [], operands: [], unknown: false }
  let options = true

  for (let i = 0; i < args.length; i++) {
    const t = args[i] ?? null

    if (t === null) {
      // An expansion could be an option as well as an operand.
      parsed.unknown ||= options
      parsed.operands.push(null)
    }
    else if (!options || !t.startsWith('-') || t === '-') {
      parsed.operands.push(t)
    }
    else if (t === '--') {
      options = false
    }
    else if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = resolveLong(eq < 0 ? t.slice(2) : t.slice(2, eq), spec)

      if (name === null) {
        parsed.unknown = true
        continue
      }

      const takesNext = spec.long.includes(name) && eq < 0
      const value = eq >= 0 ? t.slice(eq + 1) : takesNext ? (args[++i] ?? null) : null
      parsed.options.push([`--${name}`, value])
    }
    else {
      i = parseCluster(args, i, spec, parsed)
    }
  }

  return parsed
}

// In a cluster such as `-am msg` the first letter that takes a value consumes the rest of the word, or the next word.
function parseCluster(args: readonly (string | null)[], at: number, spec: OptionSpec, parsed: Parsed): number {
  const t = args[at] ?? ''

  for (let j = 1; j < t.length; j++) {
    const letter = t.charAt(j)
    const rest = t.slice(j + 1)

    if (spec.short.includes(letter)) {
      parsed.options.push([`-${letter}`, rest === '' ? (args[at + 1] ?? null) : rest])
      return rest === '' ? at + 1 : at
    }

    if (spec.attached?.includes(letter)) {
      parsed.options.push([`-${letter}`, rest === '' ? null : rest])
      return at
    }

    parsed.options.push([`-${letter}`, null])
  }

  return at
}

function values(parsed: Parsed, ...names: string[]): (string | null)[] {
  return parsed.options.filter(([name]) => names.includes(name)).map(([, value]) => value)
}

function knownAll(items: (string | null)[]): items is string[] {
  return items.every(item => item !== null)
}

// Git joins `-m` values as paragraphs and appends `--trailer` lines as one block after them.
function commitMessage(inv: Invocation): AuthoredMessage {
  const parsed = parseOptions(inv.args.slice(2), GIT_COMMIT)
  const paragraphs = values(parsed, '-m', '--message')
  const file = values(parsed, '-F', '--file').at(-1)
  const trailers = values(parsed, '--trailer').filter(t => t !== null)
  const unread: AuthoredMessage = { kind: 'commit', text: null, file: null }

  if (parsed.unknown) {
    return unread
  }

  let text: string | null = null

  if (paragraphs.length > 0) {
    // The subject is the first paragraph, so it stays checkable when a later one comes from an expansion.
    const unknownAt = paragraphs.indexOf(null)
    const known = unknownAt < 0 ? paragraphs : paragraphs.slice(0, unknownAt)
    text = known.length > 0 ? known.join('\n\n') : null
  }
  else if (file === '-') {
    text = inv.stdin
  }
  else if (file !== undefined) {
    return { ...unread, file }
  }

  if (text === null || trailers.length === 0) {
    return { ...unread, text }
  }

  return { ...unread, text: `${text.replace(/\n+$/, '')}\n\n${trailers.join('\n')}` }
}

function pullRequestMessage(inv: Invocation): AuthoredMessage {
  const subcommand = inv.args[2] ?? ''
  const spec = Object.hasOwn(GH_PR, subcommand) ? GH_PR[subcommand] : undefined
  const unread: AuthoredMessage = { kind: 'pull-request', text: null, file: null }

  if (spec === undefined) {
    return unread
  }

  const parsed = parseOptions(inv.args.slice(3), spec)
  const titles = values(parsed, '-t', '--title', '--subject')
  const bodies = values(parsed, '-b', '--body')
  const file = values(parsed, '-F', '--body-file').at(-1)

  if (parsed.unknown || !knownAll(titles) || !knownAll(bodies)) {
    return unread
  }

  if (file !== undefined && file !== '-') {
    return { ...unread, file }
  }

  const body = file === '-' ? inv.stdin : bodies.at(-1)
  const parts = [titles.at(-1), body].filter(part => part !== undefined)

  if (body === null || parts.length === 0) {
    return unread
  }

  return { ...unread, text: parts.join('\n\n') }
}

const COMMIT_PATTERN = 'git commit'
const PR_PATTERNS = ['create', 'edit', 'comment', 'review', 'merge'].map(sub => `gh pr ${sub}`)

function readMessages(cmd: string): { message: AuthoredMessage, inv: Invocation }[] {
  return invocations(cmd, [COMMIT_PATTERN, ...PR_PATTERNS]).map(inv => ({
    message: inv.args[0] === 'git' ? commitMessage(inv) : pullRequestMessage(inv),
    inv,
  }))
}

/**
 * Reads the commit messages and pull-request texts a command line writes: what `git commit` takes from `-m`, `-F -`
 * fed by a here-document or here-string, `-m "$(cat <<'EOF' … EOF)"` and `--trailer`, and what `gh pr create`,
 * `edit`, `comment`, `review` and `merge` take from `--title`, `--subject`, `--body` and `--body-file`.
 *
 * Commands are found the way {@link runsCommand} finds them, through wrappers and nested scripts, so a message that
 * only appears in an `echo` is not read.
 *
 * @param cmd - The command line, as a shell would receive it.
 * @returns One entry per `git commit` or `gh pr …` the line runs, in source order.
 *
 * @example
 * authoredMessages('git commit -m "fix: tidy" --trailer "Refs: #12"')
 * // [{ kind: 'commit', text: 'fix: tidy\n\nRefs: #12', file: null }]
 */
export function authoredMessages(cmd: string): AuthoredMessage[] {
  return readMessages(cmd).map(({ message }) => message)
}

function newBranches(inv: Invocation): (string | null)[] {
  const [, subcommand] = inv.args

  switch (subcommand) {
    case 'checkout':
      return values(parseOptions(inv.args.slice(2), GIT_CHECKOUT), '-b', '-B', '--orphan')
    case 'switch':
      return values(parseOptions(inv.args.slice(2), GIT_SWITCH), '-c', '-C', '--create', '--force-create', '--orphan')
    case 'worktree':
      return worktreeBranch(parseOptions(inv.args.slice(3), GIT_WORKTREE_ADD))
    default:
      return branchCommandBranch(parseOptions(inv.args.slice(2), GIT_BRANCH))
  }
}

// Without `-b` or a commit to check out, `git worktree add <path>` creates a branch named after the path.
function worktreeBranch(parsed: Parsed): (string | null)[] {
  const named = values(parsed, '-b', '-B')

  if (named.length > 0 || parsed.options.some(([name]) => name === '--detach' || name === '-d')) {
    return named
  }

  const [path, commit] = parsed.operands

  if (path === undefined || commit !== undefined) {
    return []
  }

  return [path === null ? null : (path.replace(/\/+$/, '').split('/').at(-1) ?? null)]
}

// `git branch <name>` creates, `git branch -m [<old>] <new>` renames or copies, and every listing option names none.
function branchCommandBranch(parsed: Parsed): (string | null)[] {
  const names = parsed.options.map(([name]) => name)

  if (names.some(name => BRANCH_NOT_CREATING.has(name))) {
    return []
  }

  if (names.some(name => BRANCH_RENAMING.has(name))) {
    return parsed.operands.slice(-1)
  }

  return parsed.operands.slice(0, 1)
}

/**
 * Lists the branches a command line creates or renames: `git checkout -b`, `git switch -c`, `git branch <name>`,
 * `git branch -m [<old>] <new>`, `git worktree add -b` and `git worktree add <path>`, which names its branch after
 * the path.
 *
 * @param cmd - The command line, as a shell would receive it.
 * @returns Each new branch name in source order; `null` for one that comes from an expansion.
 *
 * @example
 * branchNames('git switch -c feat/login && git branch -m feat/login feat/sign-in') // ['feat/login', 'feat/sign-in']
 */
export function branchNames(cmd: string): (string | null)[] {
  return invocations(cmd, ['git checkout', 'git switch', 'git branch', 'git worktree add']).flatMap(newBranches)
}

/**
 * Finds the lines of a text that sign it as written by an AI tool: a `Co-Authored-By:`, `Generated-By:` or other
 * `*-By:` / `*-With:` trailer naming one, an AI tool's no-reply address, a Claude Code session link, a "Generated with
 * …" footer, or a leading robot emoji. A tool's name in prose is content and is not matched.
 *
 * @param text - A commit message, pull-request body, comment or document.
 * @returns Each signing line, 1-based, trimmed.
 *
 * @example
 * aiSignatures('fix: tidy\n\nCo-Authored-By: Claude <noreply@anthropic.com>')
 * // [{ line: 3, text: 'Co-Authored-By: Claude <noreply@anthropic.com>' }]
 */
export function aiSignatures(text: string): { line: number, text: string }[] {
  return text
    .split('\n')
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter(({ text }) => SIGNATURES.some(re => re.test(text)))
}

// Git drops `#` lines from a message it cleans up, so the subject is the first line left.
function subjectOf(message: string): string {
  return message.split('\n').find(line => line.trim() !== '' && !line.startsWith('#')) ?? ''
}

/**
 * Tells whether a commit message's subject follows Conventional Commits: `<type>(<scope>)!: <description>` with a
 * lowercase scope. The subject is the first line that is neither blank nor a `#` comment. Subjects git writes itself
 * (`Merge …`, `fixup! …`, `squash! …`, `amend! …`, `Revert "…"`) pass.
 *
 * @param message - The whole message or only its subject.
 * @param types - The accepted types; {@link COMMIT_TYPES} by default.
 *
 * @example
 * isConventionalCommit('feat(api)!: drop v1 routes') // true
 * isConventionalCommit('Fixed the thing') // false
 */
export function isConventionalCommit(message: string, types: readonly string[] = COMMIT_TYPES): boolean {
  const subject = subjectOf(message)
  const alternatives = types.map(type => type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const pattern = new RegExp(`^(?:${alternatives})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S`)

  return GENERATED_SUBJECT.test(subject) || pattern.test(subject)
}

/**
 * Tells whether a branch name follows Conventional Branch: `<type>/<description>`, lowercase letters, digits and
 * single hyphens, with dots allowed only in a `release/` version. `main`, `master` and `develop` pass.
 *
 * @param name - The branch name.
 * @param types - The accepted prefixes; {@link BRANCH_TYPES} by default.
 *
 * @example
 * isConventionalBranch('feat/add-login') // true
 * isConventionalBranch('release/v1.2.0') // true
 * isConventionalBranch('Feature/Add_Login') // false
 */
export function isConventionalBranch(name: string, types: readonly string[] = BRANCH_TYPES): boolean {
  if (TRUNKS.has(name)) {
    return true
  }

  const slash = name.indexOf('/')
  const type = name.slice(0, slash)
  const description = name.slice(slash + 1)
  const words = type === 'release' ? /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/ : /^[a-z0-9]+(?:-[a-z0-9]+)*$/

  return slash > 0 && types.includes(type) && words.test(description)
}

/**
 * Checks what a command line authors against the authorship conventions: no AI signature in any commit message,
 * pull-request text or other word of those commands, a Conventional Commits subject on every commit, and a
 * Conventional Branch name on every branch it creates.
 *
 * Only what the line shows is checked: a message from an editor, another commit or an expansion, and a branch name
 * from an expansion, are not violations. A message file is read only through `options.readFile`.
 *
 * @param cmd - The command line, as a shell would receive it.
 * @param options - How to read message files, and the commit types and branch prefixes to accept.
 * @returns One line per violation, empty when there are none.
 *
 * @example
 * authorshipViolations('git switch -c Fix_Login && git commit -m "fixed it"')
 * // ['branch "Fix_Login" is not a Conventional Branch', 'commit subject "fixed it" is not a Conventional Commit']
 */
export function authorshipViolations(cmd: string, options: AuthorshipOptions = {}): string[] {
  const violations = new Set<string>()

  for (const name of branchNames(cmd)) {
    if (name !== null && !isConventionalBranch(name, options.branchTypes)) {
      violations.add(`branch "${name}" is not a Conventional Branch`)
    }
  }

  for (const { message, inv } of readMessages(cmd)) {
    const fromFile = message.file !== null && options.readFile ? options.readFile(message.file) : null
    const body = message.text ?? fromFile
    // `--trailer=…`, `-b"…"` and `--body=…` glue a message to its flag, which hides a signature from a line anchor, so
    // the parsed text is scanned as well as the raw words.
    const words = [...inv.args, message.text, inv.stdin, fromFile].filter(word => word !== null)

    for (const { text } of aiSignatures(words.join('\n'))) {
      violations.add(`AI signature: "${text}"`)
    }

    if (message.kind === 'commit' && body !== null && !isConventionalCommit(body, options.commitTypes)) {
      violations.add(`commit subject "${subjectOf(body)}" is not a Conventional Commit`)
    }
  }

  return [...violations]
}
