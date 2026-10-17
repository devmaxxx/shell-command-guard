# shell-command-guard

Tell whether a shell command line runs a given program, the way bash would read it.

A naive `cmd.includes('git push')` blocks `grep "git push" notes.md` and misses `sudo env A=1 git push`. This library
parses the line: it treats quoted strings, comments and quoted here-document bodies as data, and it follows the
commands inside pipelines, `&&`/`;` lists, subshells, `$(…)`, backquotes, unquoted here-documents, `bash -c`, `eval`,
and wrappers such as `env` (with `-S`), `sudo`, `nohup`, `timeout`, `nice`, `xargs`, `setsid`, `stdbuf`, `ionice`,
`flock`, `watch`, `find -exec`, `busybox`, `npx`, `pnpm exec`, `npm exec`, `yarn dlx` and `git -C dir`.

It suits pre-execution hooks for coding agents, CI bots and chat-ops tools: deny `git push`, or apply a commit-message
check only when the command really runs `git commit`.

- Zero runtime dependencies, ESM only, Node 20+
- Typed, with JSDoc on every export

## Install

```sh
npm install shell-command-guard
# or: pnpm add shell-command-guard
```

## Usage

### Enforce a deny-list: `deniedBy`

```ts
import { DEFAULT_DENY, deniedBy } from 'shell-command-guard'

deniedBy('pnpm test && sudo -u ci git push origin', ['git push']) // 'git push'
deniedBy('bash -c "echo $(git push)"', ['git push']) // 'git push'
deniedBy('grep "git push" notes.md', ['git push']) // null
deniedBy('$TOOL push', ['git push']) // 'command word comes from an expansion'
deniedBy('echo "unterminated', ['git push']) // 'unbalanced quoting'
deniedBy('sudo rm -rf build', DEFAULT_DENY) // 'sudo'
```

Each pattern is a word prefix: `'git push'` matches `git push --force` but not `git pushd`. The result is the first
pattern matched, or `null` when the command may run.

`deniedBy` fails closed. When it cannot tell what a command runs, it returns a reason in place of a pattern, one of
`DENY_REASONS`:

| Reason | When |
| --- | --- |
| `command word comes from an expansion` | the program name is `$VAR`, `$(…)`, a glob (`/usr/bin/g*`) or similar |
| `unbalanced quoting` | a quote, `$(…)` or here-document never closes |
| `git -c alias.*` | a git alias defined with `-c`, `GIT_CONFIG_KEY_n` or `GIT_CONFIG_PARAMETERS` could run anything |
| `shell reads script from stdin` | a shell runs without `-c` and without a script file (`echo … \| sh`, `bash -s`) |
| `shell runs a script file` | a shell runs a script file (`bash deploy.sh`) this reading cannot see |

An argument an expansion could complete into a denied command is denied too (`git $SUB` under `'git push'`). The line is
also read the way bash 3.2, zsh and sh would read it, and split once more without regard to quoting, so a command any
of those readings sees is denied. A quoted here-document line that is itself a denied command is therefore denied,
although bash would not run it.

### Check whether a command really runs something: `runsCommand`

```ts
import { runsCommand } from 'shell-command-guard'

runsCommand('git add -A && git -C repo commit -m "x"', 'git commit') // true
runsCommand('git commit -F - <<\'EOF\'\nfix: tidy\nEOF', 'git commit') // true
runsCommand('echo "then git commit"', 'git commit') // false
runsCommand('python3 - <<\'PY\'\nprint("git commit")\nPY', 'git commit') // false
runsCommand('gh pr edit 12 --body x', ['gh pr create', 'gh pr edit']) // true
```

`runsCommand` sees through the same wrappers and substitutions, but reads the line only as bash does and never guesses:
an expansion that could become the command, or text it cannot parse, counts as not running it. Use it to decide whether
a check applies, and `deniedBy` to block.

### List the commands a line runs: `commandSegments`

```ts
import { commandSegments } from 'shell-command-guard'

commandSegments('FOO=1 pnpm lint && echo $(gh pr list) | cat')
// ['pnpm lint', 'echo', 'gh pr list', 'cat']
```

Leading `NAME=value` assignments are dropped, expansions are removed, and whitespace is collapsed.

### Build a deny-list: `DEFAULT_DENY` and `effectiveDeny`

`DEFAULT_DENY` is a starting list: privilege escalation (`sudo`, `su`, `doas`), wiping the disk or the home directory
(`rm -rf /`, `rm -rf ~`, `mkfs`, `dd`), powering off (`shutdown`, `reboot`, `halt`, `poweroff`), and publishing beyond
the local checkout (`git push`, `git reset --hard`, `git clean`, `npm publish`, `pnpm publish`, `yarn publish`).

`rm` is matched by its flag set rather than its spelling: `rm -Rf /`, `rm -r -f /`, `rm -rfv --no-preserve-root /` and
`rm / -rf` all match `'rm -rf /'`, each operand is tried, and `$HOME` counts as `~`.

```ts
import { deniedBy, effectiveDeny } from 'shell-command-guard'

const deny = effectiveDeny({ deny: ['docker'] }, ['kubectl delete'])
// [...DEFAULT_DENY, 'docker', 'kubectl delete']

deniedBy('kubectl delete pod web', deny) // 'kubectl delete'
```

## API

| Export | Signature |
| --- | --- |
| `deniedBy` | `(cmd: string, deny: readonly string[]) => string \| null` |
| `runsCommand` | `(cmd: string, command: string \| readonly string[]) => boolean` |
| `commandSegments` | `(cmd: string) => string[]` |
| `effectiveDeny` | `(policy: DenyPolicy, extra?: readonly string[]) => string[]` |
| `DEFAULT_DENY` | `readonly string[]` |
| `DENY_REASONS` | `{ expansion, unbalanced, gitAlias, stdinScript, scriptFile }` |
| `DenyPolicy` | `{ deny: readonly string[] }` |

## What it is not

- **Not a sandbox.** It reads a command line before it runs; it does not stop a program from doing anything once it
  runs. `deniedBy` refuses a shell given a script file or stdin, but a Makefile target, a package script
  (`npm run release`), a program that runs its own commands, an alias or a function defined earlier in the session can
  all run a denied command that never appears on the line.
- **A best-effort deny-list.** Matching is by word prefix, so `rm -rf /` does not match `rm -rf /home`, and only `rm`
  is matched by flag set: `'git clean -fd'` does not match `git clean -df`. Deny the program or subcommand
  (`git clean`) when every spelling matters, and allow-list instead of deny-list when the stakes are high.
- **Not a full shell parser.** It models bash, with zsh, sh and bash 3.2 differences where they change which commands
  run. Constructs it cannot place, it reports as unreadable rather than guessing.

Run it in addition to OS-level isolation (containers, separate users, read-only mounts, scoped credentials), not in place
of it.

## License

[MIT](./LICENSE)
