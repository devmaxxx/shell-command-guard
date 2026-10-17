<div align="center">

# shell-guards

**Tell whether a shell command line really runs a program — the way bash would read it.**

Sees through `sudo`/`env`/`xargs`/`bash -c`/heredocs/`$(…)` and fails closed — zero dependencies.

[![npm version](https://img.shields.io/npm/v/shell-guards)](https://www.npmjs.com/package/shell-guards)
[![npm downloads](https://img.shields.io/npm/dm/shell-guards)](https://www.npmjs.com/package/shell-guards)
[![CI](https://img.shields.io/github/actions/workflow/status/devmaxxx/shell-guards/ci.yml?branch=main&label=CI)](https://github.com/devmaxxx/shell-guards/actions/workflows/ci.yml)
[![types included](https://img.shields.io/npm/types/shell-guards)](https://www.npmjs.com/package/shell-guards)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![bundle size](https://img.shields.io/bundlephobia/minzip/shell-guards)](https://bundlephobia.com/package/shell-guards)
[![license MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[Install](#install) · [Quick start](#quick-start) · [API](#api) · [Recipes](#recipes) · [FAQ](#faq) ·
[Security model](#security-model-and-limits)

<img src="./assets/demo.svg" width="760" alt="Terminal demo: deniedBy allows grep &quot;git push&quot; notes.md but denies git push hidden behind env, bash -c, xargs, quoting, a stdin shell and python -c, and denies rm -r -f /">

</div>

<details>
<summary><strong>Table of contents</strong></summary>

- [Why](#why)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [API](#api)
  - [`deniedBy`](#deniedbycmd-deny) · [`runsCommand`](#runscommandcmd-command) ·
    [`commandSegments`](#commandsegmentscmd) · [`effectiveDeny`](#effectivedenypolicy-extra) ·
    [`DEFAULT_DENY`](#default_deny) · [`DENY_REASONS`](#deny_reasons) ·
    [`invocations`](#invocationscmd-command)
- [Authorship](#authorship)
  - [`authorshipViolations`](#authorshipviolationscmd-options) ·
    [`authoredMessages`](#authoredmessagescmd) · [`branchNames`](#branchnamescmd) ·
    [`aiSignatures`](#aisignaturestext) · [`isConventionalCommit`](#isconventionalcommitmessage-types) ·
    [`isConventionalBranch`](#isconventionalbranchname-types)
- [Recipes](#recipes)
- [How it works](#how-it-works)
- [Comparison](#comparison)
- [Security model and limits](#security-model-and-limits)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

</details>

## Why

A coding agent, CI bot or chat-ops tool is about to run a shell command, and you want to stop `git push`. The naive check
is `cmd.startsWith('git push')` or a regex. Both are bypassed in one line, and both block harmless commands that only
mention the words.

| Command | Naive `startsWith('git push')` | `deniedBy(cmd, ['git push'])` |
| --- | --- | --- |
| `env FOO=1 git push` | allowed | `'git push'` |
| `bash -c "git push"` | allowed | `'git push'` |
| `echo 'git push' \| sh` | allowed | `'shell reads script from stdin'` |
| `{git,push}` | allowed | `'command word comes from an expansion'` |
| `echo origin \| xargs git push` | allowed | `'git push'` |
| `g'i't push` | allowed | `'git push'` |
| `trap 'git push' EXIT` | allowed | `'git push'` |
| `python3 -c "import os; os.system('git push')"` | allowed | `'git push'` |
| `grep "git push" notes.md` | allowed (`includes` would block it) | `null` — it only mentions it |

`shell-guards` parses the line instead. Quoted strings, comments and quoted here-document bodies are data; every
command the line could run is checked; and anything it cannot read is denied rather than guessed.

## Features

- 🔍 **Follows what bash runs** — pipelines, `&&`/`||`/`;` lists, subshells, `{ …; }`, `$(…)`, backquotes, unquoted
  here-documents, `bash -c`, `sh -c`, `eval`, `coproc`, `function` bodies.
- 🧅 **Sees through wrappers** — `env` (with `-S`), `sudo`, `doas`, `su -c`, `run0`, `pkexec`, `runuser`, `nohup`,
  `timeout`, `nice`, `chrt`, `taskset`, `caffeinate`, `arch`, `xargs`, `parallel`, `setsid`, `stdbuf`, `ionice`,
  `flock`, `watch`, `script`, `strace`, `ltrace`, `nsenter`, `chroot`, `systemd-run`, `firejail`, `faketime`,
  `xvfb-run`, `unbuffer`, `find -exec`, `fd -x`, `ssh host …`, `busybox`, `toybox`, `command`, `exec`, `npx`,
  `pnpm exec`, `npm exec`, `yarn exec`, `bun x`, `git -C dir`, and zsh's `=cmd`, `noglob` and `nocorrect`.
- ⏱️ **Catches commands set up to run later** — `trap '…' EXIT`, `alias`, `git rebase -x`, `git bisect run`,
  `git submodule foreach`, `git filter-branch`, and a pager, editor or ssh command set with `git -c`.
- ✍️ **Checks what a line writes** — commit messages, `gh pr` text and new branch names, read from `-m`, `--trailer`,
  `-F -` here-documents and `$(cat <<'EOF' …)`, checked for AI signatures, Conventional Commits and Conventional Branch.
- 🔒 **Fails closed** — an expansion in command position, unbalanced quoting, a stdin-fed shell or `source`, a script
  file, a `git -c alias.*` or `git config alias.*`, and a line nested deeper than the stack return a reason instead
  of `null` — never a throw.
- Reads the line as bash, bash 3.2, zsh and sh do, so a command any of them would run is caught.
- Searches the inline program of `python -c`, `node -e`, `perl -e`, `ruby -e`, `osascript -e`, `awk` and similar for
  a pattern's words (`os.system("git push")`), since those can run anything.
- `rm` is matched by flag set and folded path: `rm -r -f /`, `rm -Rf //` and `rm / -rf` all match `'rm -rf /'`.
- Word-prefix patterns: `'git push'` matches `git push --force`, not `git pushd`.
- A starter deny-list, `DEFAULT_DENY`.
- Zero runtime dependencies, ESM only, typed, Node 20+.

## Install

```sh
npm install shell-guards
pnpm add shell-guards
yarn add shell-guards
bun add shell-guards
```

## Quick start

```ts
import { DEFAULT_DENY, deniedBy, runsCommand } from 'shell-guards'

deniedBy('pnpm test && sudo -u ci git push origin', ['git push']) // 'git push'
deniedBy('grep "git push" notes.md', ['git push']) // null
deniedBy('$TOOL push', ['git push']) // 'command word comes from an expansion'
deniedBy('rm -r -f /', DEFAULT_DENY) // 'rm -rf /'

runsCommand('git add -A && git -C repo commit -m "x"', 'git commit') // true
runsCommand('echo "then git commit"', 'git commit') // false
```

`deniedBy` returns `null` when the command may run, and a string — the matched pattern or a reason — when it may not.

## API

| Export | Signature |
| --- | --- |
| [`deniedBy`](#deniedbycmd-deny) | `(cmd: string, deny: readonly string[]) => string \| null` |
| [`runsCommand`](#runscommandcmd-command) | `(cmd: string, command: string \| readonly string[]) => boolean` |
| [`commandSegments`](#commandsegmentscmd) | `(cmd: string) => string[]` |
| [`effectiveDeny`](#effectivedenypolicy-extra) | `(policy: DenyPolicy, extra?: readonly string[]) => string[]` |
| [`DEFAULT_DENY`](#default_deny) | `readonly string[]` |
| [`DENY_REASONS`](#deny_reasons) | `{ expansion, unbalanced, gitAlias, stdinScript, scriptFile }` |
| `DenyPolicy` (type) | `{ deny: readonly string[] }` |
| [`invocations`](#invocationscmd-command) | `(cmd: string, command: string \| readonly string[]) => Invocation[]` |
| [`authorshipViolations`](#authorshipviolationscmd-options) | `(cmd: string, options?: AuthorshipOptions) => string[]` |
| [`authoredMessages`](#authoredmessagescmd) | `(cmd: string) => AuthoredMessage[]` |
| [`branchNames`](#branchnamescmd) | `(cmd: string) => (string \| null)[]` |
| [`aiSignatures`](#aisignaturestext) | `(text: string) => { line: number, text: string }[]` |
| [`isConventionalCommit`](#isconventionalcommitmessage-types) | `(message: string, types?: readonly string[]) => boolean` |
| [`isConventionalBranch`](#isconventionalbranchname-types) | `(name: string, types?: readonly string[]) => boolean` |
| `COMMIT_TYPES`, `BRANCH_TYPES` | `readonly string[]` |

### `deniedBy(cmd, deny)`

Decides whether `cmd` may run under the deny-list `deny`, failing closed. Each pattern is a word prefix matched against
every command the line could run.

Returns the first pattern matched; one of [`DENY_REASONS`](#deny_reasons) (or the name of a wrapper nested too deep)
when what the command runs cannot be known; or `null` when the command may run.

```ts
deniedBy('bash -c "echo $(git push)"', ['git push']) // 'git push'
deniedBy('git $SUB', ['git push']) // 'git push' — an expansion could complete it
deniedBy('echo "unterminated', ['git push']) // 'unbalanced quoting'
deniedBy('sudo rm -rf build', DEFAULT_DENY) // 'sudo'
```

The line is also read the way bash 3.2, zsh and sh would read it, and split once more without regard to quoting, so a
command any of those readings sees is denied. A quoted here-document line that is itself a denied command is therefore
denied, although bash would not run it.

### `runsCommand(cmd, command)`

Tells whether `cmd` certainly runs a program or subcommand, as opposed to merely mentioning it. It sees through the
same wrappers and substitutions as `deniedBy`, but reads the line only as bash does and never guesses: an expansion
that could become the command, or text it cannot parse, counts as not running it. Use it to decide whether a check
applies, and `deniedBy` to block.

```ts
runsCommand('git commit -F - <<\'EOF\'\nfix: tidy\nEOF', 'git commit') // true
runsCommand('python3 - <<\'PY\'\nprint("git commit")\nPY', 'git commit') // false
runsCommand('gh pr edit 12 --body x', ['gh pr create', 'gh pr edit']) // true
```

### `commandSegments(cmd)`

Lists the simple commands bash would run, in source order. Leading `NAME=value` assignments are dropped, expansions
are removed, and whitespace is collapsed. When the line cannot be read to the end, the commands found before that
point are returned.

```ts
commandSegments('FOO=1 pnpm lint && echo $(gh pr list) | cat')
// ['pnpm lint', 'echo', 'gh pr list', 'cat']
```

### `effectiveDeny(policy, extra?)`

Builds a deny-list: `DEFAULT_DENY`, then `policy.deny`, then `extra`.

```ts
effectiveDeny({ deny: ['docker'] }, ['kubectl delete'])
// [...DEFAULT_DENY, 'docker', 'kubectl delete']
```

### `DEFAULT_DENY`

A starting list for commands an unattended process should not run on its own:

- privilege escalation — `sudo`, `su`, `doas`, `pkexec`, `run0`
- wiping the disk or home directory — `rm -rf /`, `rm -rf /*`, `rm -rf ~`, `rm -rf ~/`, `rm -rf ~/*`, `rm -fr /`,
  `rm -fr ~`, `mkfs`, `dd`
- powering off — `shutdown`, `reboot`, `halt`, `poweroff`
- publishing beyond the local checkout — `git push`, `git reset --hard`, `git clean`, `npm publish`, `pnpm publish`,
  `yarn publish`

`$HOME` counts as `~`, and each `rm` operand is tried as written and with `//`, `/./` and a trailing `/` or `/.`
folded away.

### `DENY_REASONS`

| Key | Value | When |
| --- | --- | --- |
| `expansion` | `'command word comes from an expansion'` | the program name is `$VAR`, `$(…)`, a glob (`/usr/bin/g*`), a brace expansion or similar |
| `unbalanced` | `'unbalanced quoting'` | a quote, `$(…)` or here-document never closes, or the line nests deeper than the stack can read |
| `gitAlias` | `'git -c alias.*'` | a git alias defined with `-c`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_PARAMETERS` or `git config alias.*` could run anything |
| `stdinScript` | `'shell reads script from stdin'` | a shell runs without `-c` and without a script file (`echo … \| sh`, `bash -s`), `source` reads stdin or a process substitution, or `parallel` reads its commands from stdin |
| `scriptFile` | `'shell runs a script file'` | a shell runs a script file (`bash deploy.sh`) this reading cannot see |

### `invocations(cmd, command)`

Lists every command a line certainly runs that starts with one of the patterns, read the way `runsCommand` reads it.
Each entry has the command's words as the shell passes them (wrappers off, quotes removed, `null` for a word that
depends on what runs) and what it reads on stdin from a here-document or here-string. A word that is one whole
`$(cat <<'EOF' … EOF)` resolves to the here-document.

```ts
invocations('sudo git -C repo commit -m "fix: x" <<< y', 'git commit')
// [{ args: ['git', 'commit', '-m', 'fix: x'], stdin: 'y\n' }]
```

## Authorship

Checks for what a command line *writes*: commit messages, pull-request text and branch names. Commands are found with
`invocations`, so a message that only appears in an `echo` or a heredoc body is never read, and one behind `env`,
`sudo` or `bash -c` always is.

### `authorshipViolations(cmd, options?)`

Returns one line per violation: an AI signature in any `git commit` or `gh pr create|edit|comment|review|merge`
(message, `--trailer`, title, body or file), a commit subject that is not Conventional Commits, or a new branch that
is not Conventional Branch. What the line does not show (an editor, `-C HEAD`, `$MSG`) is not a violation. Message
files are read only through `options.readFile`; `commitTypes` and `branchTypes` replace the defaults.

```ts
authorshipViolations('git switch -c Fix_Login && git commit -m "fixed it"')
// ['branch "Fix_Login" is not a Conventional Branch', 'commit subject "fixed it" is not a Conventional Commit']
```

### `authoredMessages(cmd)`

One `{ kind: 'commit' | 'pull-request', text, file }` per `git commit` or `gh pr …` the line runs. `text` joins
`-m` paragraphs and `--trailer` lines, or a title and body; it reads `-F -` / `--body-file -` from a here-document.
`file` names a message file, which is not opened.

### `branchNames(cmd)`

The branches a line creates or renames: `git checkout -b`, `git switch -c`, `git branch <name>`, `git branch -m`,
`git worktree add -b`, and `git worktree add <path>`, which names its branch after the path.

### `aiSignatures(text)`

The 1-based lines that sign a text as AI-written: a `*-By:` / `*-With:` trailer naming an AI tool, its no-reply
address, a Claude Code session link, a "Generated with …" footer or a leading 🤖. A tool named in prose does not count.

### `isConventionalCommit(message, types?)`

Whether the first non-comment line is `<type>(<scope>)!: <description>` with a lowercase scope. Subjects git writes
(`Merge …`, `fixup! …`, `Revert "…"`) pass. Types default to `COMMIT_TYPES`.

### `isConventionalBranch(name, types?)`

Whether a name is `<type>/<description>` in lowercase letters, digits and single hyphens, with dots only in a
`release/` version. `main`, `master` and `develop` pass. Prefixes default to `BRANCH_TYPES`.

## Recipes

### Claude Code (or any AI agent) `PreToolUse` hook

Block denied Bash commands before the agent runs them. Claude Code passes the tool call as JSON on stdin; exit code 2
blocks the call and shows stderr to the model.

```js
// ~/.claude/hooks/guard.mjs
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { deniedBy, effectiveDeny } from 'shell-guards'

const { tool_input: input } = JSON.parse(readFileSync(0, 'utf8'))
const hit = deniedBy(input.command ?? '', effectiveDeny({ deny: ['gh pr merge'] }))

if (hit) {
  console.error(`Blocked by shell-guards: ${hit}`)
  process.exit(2)
}
```

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/guard.mjs" }] }
    ]
  }
}
```

### Authorship hook for an AI agent

Block a commit or pull request that an agent signs, or that breaks Conventional Commits or Conventional Branch.

```js
// ~/.claude/hooks/authorship.mjs
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { authorshipViolations } from 'shell-guards'

const { tool_input: input } = JSON.parse(readFileSync(0, 'utf8'))
function readFile(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  catch {
    return null
  }
}
const violations = authorshipViolations(input.command ?? '', { readFile })

if (violations.length > 0) {
  console.error(`Fix and retry:\n- ${violations.join('\n- ')}`)
  process.exit(2)
}
```

### Pre-exec / CI guard

Check a command before a bot or pipeline hands it to a shell.

```js
// guard.mjs — usage: node guard.mjs "$CMD" && sh -c "$CMD"
import process from 'node:process'
import { DEFAULT_DENY, deniedBy } from 'shell-guards'

const hit = deniedBy(process.argv[2] ?? '', DEFAULT_DENY)

if (hit) {
  console.error(`refusing to run: ${hit}`)
  process.exit(1)
}
```

### Custom deny-list, and checks that apply only to one command

```ts
import { deniedBy, effectiveDeny, runsCommand } from 'shell-guards'

const deny = effectiveDeny({ deny: ['docker', 'kubectl delete', 'terraform apply'] })

deniedBy('kubectl delete pod web', deny) // 'kubectl delete'

// Lint the commit message only when the line really commits, not when it echoes "git commit".
if (runsCommand(cmd, 'git commit')) {
  checkCommitMessage(cmd)
}
```

Patterns are word prefixes, so deny the program or subcommand (`'git clean'`) when every spelling of its flags matters.

## How it works

- A hand-written reader walks the line the way bash does, tracking quotes, `$(…)`, backquotes, comments and
  here-documents, and splits it into simple commands.
- Each command loses its leading `NAME=value` assignments and wrappers (`sudo`, `env`, `xargs`, …); scripts given to
  `bash -c`, `sh -c` and `eval` are read recursively.
- The remaining words are matched against each pattern by word prefix; `rm` is compared by flag set and operand.
- `deniedBy` repeats this under bash 3.2, zsh and sh rules, plus a quote-blind split, and denies if any reading hits.
- Anything it cannot resolve — an expansion in command position, an open quote, a shell reading stdin or a file —
  becomes a deny reason. `runsCommand` takes only the bash reading and treats the unknown as "not run".

## Comparison

| | shell-guards | [unbash](https://www.npmjs.com/package/unbash) | [shell-quote](https://www.npmjs.com/package/shell-quote) | Naive regex / `startsWith` |
| --- | --- | --- | --- | --- |
| Purpose | decide if a line runs a command | full bash AST parser (no policy) | tokenize and quote argv | — |
| Quotes and comments are data | ✅ | ✅ | ✅ | ❌ |
| Commands inside `$(…)` and backquotes | ✅ | in the AST, you walk it | tokenised, not recognised as substitution | ❌ |
| Reads `bash -c` / `eval` scripts | ✅ | ❌ | ❌ | ❌ |
| Sees through `sudo`, `env`, `xargs`, … | ✅ | ❌ | ❌ | ❌ |
| Fails closed on unknowns | ✅ | ❌ | ❌ | ❌ |
| Runtime dependencies | 0 | 0 | 0 | 0 |

unbash and shell-quote are parsers you could build a guard on; this package is that guard. If you need a full bash AST for
something other than a policy decision, use unbash. ([bash-parser](https://www.npmjs.com/package/bash-parser) has had no
release since 2022.)

Ready-made agent hooks take a different trade-off. Matt Pocock's
[git-guardrails](https://www.aihero.dev/this-hook-stops-claude-code-running-dangerous-git-commands) skill blocks a fixed
set of git commands from a Claude Code hook. [destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard)
(dcg, Rust) matches pattern packs fast and, by its own description, allows unrecognised commands and does not look
inside scripts. Both fail open on what they do not recognise; this package fails closed, so pair it with an allow
rule when a reason such as `'shell runs a script file'` blocks a command you trust.

## Security model and limits

- **Not a sandbox.** It reads a command line before it runs; it does not stop a program from doing anything once it
  runs. `deniedBy` refuses a shell given a script file or stdin, but a Makefile target, a package script
  (`npm run release`), a file read with `source`, an executable script (`./deploy`), a program that runs its own
  commands, an alias or a function defined earlier in the session can all run a denied command that never appears on
  the line. An interpreter's inline program is only searched for a pattern's words, so code that builds the command
  (`"gi" + "t"`) passes.
- **A best-effort deny-list.** Matching is by word prefix, so `rm -rf /` does not match `rm -rf /home`, and only `rm`
  is matched by flag set: `'git clean -fd'` does not match `git clean -df`. Deny the program or subcommand
  (`git clean`) when every spelling matters, and allow-list instead of deny-list when the stakes are high.
- **Not a full shell parser.** It models bash, with zsh, sh and bash 3.2 differences where they change which commands
  run. Constructs it cannot place, it reports as unreadable rather than guessing.

Run it in addition to OS-level isolation (containers, separate users, read-only mounts, scoped credentials), not in place
of it.

## FAQ

<details>
<summary><strong>Why is <code>rm -rf $DIR</code> denied?</strong></summary>

`$DIR` is known only when the shell runs, and it could be `/`. `deniedBy` matches a pattern that an expansion could
still complete, so `rm -rf $DIR` returns `'rm -rf /'` under `DEFAULT_DENY`. Spell the path out, or use `runsCommand`
when you only need to know what certainly runs.

</details>

<details>
<summary><strong>How do I allow a command that a deny reason blocks?</strong></summary>

`deniedBy` returns the reason as a string, so you decide which ones to let through:

```ts
import { deniedBy, DENY_REASONS } from 'shell-guards'

const hit = deniedBy(cmd, deny)
const trusted = hit === DENY_REASONS.scriptFile && /^bash scripts\/[\w-]+\.sh$/.test(cmd)

if (hit && !trusted) {
  block(hit)
}
```

</details>

<details>
<summary><strong>Which shells does it understand?</strong></summary>

It parses bash syntax and also reads each line the way bash 3.2, zsh and sh would, so a command that any of them runs
is caught. Scripts handed to `bash`, `sh`, `zsh`, `dash`, `ksh`, `fish`, `csh` and others with `-c` are read the same
way.

</details>

<details>
<summary><strong>Does it run anything, or touch the filesystem?</strong></summary>

No. It is a pure function over the command string: no child processes, no file reads, no environment lookups.

</details>

<details>
<summary><strong>Should I use a deny-list or an allow-list?</strong></summary>

A deny-list blocks the commands you name and lets the rest through, which suits an agent that should mostly work
unattended. When the stakes are high, allow-list instead. `commandSegments` lists every command a line runs, so you can
check each one against the list.

</details>

## Roadmap

- [ ] More launchers: `setpriv`, `xcrun`, `direnv exec`, `mise exec`, `op run`
- [ ] Resolve `rm` operands above `~` (`rm -rf ~/..`) against the real home directory
- [ ] A small CLI for shell hooks and CI: `shell-guards --deny 'git push' -- "$CMD"`

Found a bypass or a missing wrapper? [Open an issue](https://github.com/devmaxxx/shell-guards/issues).

## Contributing

Issues and pull requests are welcome. A bypass — a line that runs a denied command while `deniedBy` returns `null` — is
the most useful report; please include the line and the shell that runs it.

```sh
pnpm i
pnpm test       # vitest
pnpm lint       # eslint
pnpm typecheck  # tsc
pnpm build      # tsdown
pnpm demo       # regenerate assets/demo.svg from the real deniedBy output
```

## License

[MIT](./LICENSE) © Maksym Synenko
