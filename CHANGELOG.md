# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

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
- Matches `rm` by flag set and operand, with `$HOME` read as `~`.
- Zero runtime dependencies, ESM only, TypeScript declarations, Node 20+.

[0.1.0]: https://github.com/devmaxxx/shell-command-guard/releases/tag/v0.1.0
