# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- `invocations(cmd, command)` — lists each command a line certainly runs with its words as the shell passes them and
  what it reads from a here-document or here-string; a word that is one whole `$(cat <<'EOF' … EOF)` resolves to the
  here-document.
- Authorship checks: `authorshipViolations(cmd, options?)` reports AI signatures, non-Conventional commit subjects and
  non-Conventional branch names in what a line writes; built on `authoredMessages(cmd)` (commit and `gh pr` text),
  `branchNames(cmd)`, `aiSignatures(text)`, `isConventionalCommit(message, types?)`,
  `isConventionalBranch(name, types?)`, `COMMIT_TYPES` and `BRANCH_TYPES`.
- `deniedBy(cmd, deny)` — checks a command line against word-prefix patterns and fails closed: returns the matched
  pattern, a `DENY_REASONS` value when what the line runs cannot be known, or `null`.
- `runsCommand(cmd, command)` — tells whether a line certainly runs a program or subcommand, reading it only as bash
  does and never guessing.
- `commandSegments(cmd)` — lists the simple commands a line runs, with leading assignments and expansions removed.
- `effectiveDeny(policy, extra?)` and `DEFAULT_DENY` — a starter deny-list (privilege escalation, wiping the disk,
  powering off, publishing) and a helper to extend it.
- Follows pipelines, lists, subshells, `$(…)`, backquotes, unquoted here-documents, `bash -c`, `sh -c` and `eval`.
- Sees through wrappers: `env` (with `-S`), `sudo`, `nohup`, `timeout`, `nice`, `xargs`, `setsid`, `stdbuf`, `ionice`,
  `flock`, `watch`, `find -exec`, `busybox`, `command`, `exec`, `npx`, `pnpm exec`, `npm exec`, `yarn dlx` and
  `git -C dir`.
- Reads each line as bash, bash 3.2, zsh and sh, plus a quote-blind split, and denies when any reading runs a denied
  command.
- Fails closed on expansions in command position, brace and glob command words, unbalanced quoting, shells reading a
  script from stdin or a file, and `git -c alias.*` / `GIT_CONFIG_*` aliases.
- Matches `rm` by flag set and operand, with `$HOME` read as `~` and `//`, `/./` and a trailing `/` or `/.` folded.
- Sees through `doas`, `su -c`, `run0`, `pkexec`, `runuser`, `chrt`, `taskset`, `caffeinate`, `arch`, `parallel`,
  `script`, `strace`, `ltrace`, `nsenter`, `chroot`, `systemd-run`, `firejail`, `faketime`, `dbus-launch`,
  `xvfb-run`, `unbuffer`, `toybox`, `fd -x`, `ssh host …`, `yarn exec`, `bun x`/`bun exec`, `coproc`, `function`, and
  zsh's `=cmd`, `noglob`, `nocorrect`, `-` and `[[ … ]] cmd`.
- Reads commands set up to run later: `trap` actions, `alias` values, `git rebase -x`, `git difftool -x`,
  `git bisect run`, `git submodule foreach`, `git filter-branch` filters and `git -c` values; denies
  `git config alias.*`.
- Counts the words `xargs` and `parallel` add to a command, and its replace-string, as expansions.
- Fails closed on `source` of stdin or a process substitution, and on a line nested deeper than the stack instead of
  throwing a `RangeError`.
- Searches the inline program of `python -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, `osascript -e`, `awk` and
  similar for a pattern's words.
- `DEFAULT_DENY` also holds `pkexec`, `run0` and `rm -rf ~/*`.
- Reads attached option values (`-c'code'`), options after `ssh`'s host, GNU `time -f`, `env -a`/`-P`, `..` in `rm`
  operands, versioned interpreters (`python3.12`), and `gtimeout`, `fakeroot`, `unshare` and `sandbox-exec`.
- Zero runtime dependencies, ESM only, TypeScript declarations, Node 20+.

[0.1.0]: https://github.com/devmaxxx/shell-guards/releases/tag/v0.1.0
