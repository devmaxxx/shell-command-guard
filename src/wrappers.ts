export const NONE: ReadonlySet<string> = new Set()

function opts(...names: string[]): ReadonlySet<string> {
  return new Set(names)
}

// A wrapper runs the command that follows its options and its `operands` fixed operands (timeout's duration, chroot's
// new root). `opts` are the options that consume the next token; any other token starting with '-' stands alone.
// `zsh` marks a zsh precommand modifier, which bash would run as a program of that name.
export interface Wrapper {
  opts: ReadonlySet<string>
  operands?: number
  zsh?: boolean
}

export const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  'arch': { opts: opts('-arch', '-e', '-d') },
  'builtin': { opts: NONE },
  'busybox': { opts: NONE },
  'caffeinate': { opts: opts('-t', '-w') },
  'chronic': { opts: NONE },
  'chroot': { opts: opts('--userspec', '--groups'), operands: 1 },
  'chrt': { opts: opts('-T', '--sched-runtime', '-P', '--sched-period', '-D', '--sched-deadline'), operands: 1 },
  'command': { opts: NONE },
  'dbus-launch': { opts: NONE },
  'doas': { opts: opts('-u', '-C') },
  'env': { opts: opts('-u', '--unset', '-C', '--chdir', '-a', '--argv0', '-P') },
  'exec': { opts: opts('-a') },
  'faketime': { opts: opts('-p', '--date-prog'), operands: 1 },
  'firejail': { opts: NONE },
  'ionice': { opts: opts('-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid') },
  'ltrace': { opts: opts('-a', '-A', '-D', '-e', '-F', '-l', '-n', '-o', '-p', '-s', '-u', '-w', '-x') },
  'nice': { opts: opts('-n', '--adjustment') },
  'nohup': { opts: NONE },
  'nsenter': { opts: opts('-t', '--target', '-S', '--setuid', '-G', '--setgid') },
  'pkexec': { opts: opts('--user') },
  'run0': {
    opts: opts(
      '-u',
      '--user',
      '-g',
      '--group',
      '-D',
      '--chdir',
      '--nice',
      '--setenv',
      '--unit',
      '--property',
      '--description',
      '--slice',
      '--machine',
      '--background',
    ),
  },
  'setsid': { opts: NONE },
  'stdbuf': { opts: opts('-i', '--input', '-o', '--output', '-e', '--error') },
  'strace': { opts: opts('-a', '-b', '-e', '-E', '-I', '-o', '-O', '-p', '-P', '-s', '-S', '-u', '-U', '-X') },
  'sudo': {
    opts: opts(
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
    ),
  },
  'systemd-run': {
    opts: opts(
      '-u',
      '--unit',
      '-p',
      '--property',
      '--description',
      '--slice',
      '--service-type',
      '-E',
      '--setenv',
      '--uid',
      '--gid',
      '--nice',
      '-D',
      '--working-directory',
      '-M',
      '--machine',
      '-H',
      '--host',
      '--on-active',
      '--on-boot',
      '--on-startup',
      '--on-unit-active',
      '--on-unit-inactive',
      '--on-calendar',
      '--timer-property',
      '--path-property',
      '--socket-property',
    ),
  },
  'taskset': { opts: NONE, operands: 1 },
  'time': { opts: opts('-f', '--format', '-o', '--output') },
  'timeout': { opts: opts('-s', '--signal', '-k', '--kill-after'), operands: 1 },
  'toybox': { opts: NONE },
  // GNU coreutils installed on macOS under a `g` prefix.
  'gtimeout': { opts: opts('-s', '--signal', '-k', '--kill-after'), operands: 1 },
  'gnice': { opts: opts('-n', '--adjustment') },
  'gnohup': { opts: NONE },
  'gstdbuf': { opts: opts('-i', '--input', '-o', '--output', '-e', '--error') },
  'fakeroot': { opts: opts('-i', '-s', '-b', '--lib', '--faked') },
  'eatmydata': { opts: NONE },
  'sandbox-exec': { opts: opts('-f', '-n', '-p', '-D') },
  'unshare': { opts: opts('-S', '--setuid', '-G', '--setgid', '-R', '--root', '-w', '--wd', '--propagation', '--monotonic', '--boottime') },
  'unbuffer': { opts: NONE },
  'xvfb-run': {
    opts: opts(
      '-e',
      '--error-file',
      '-f',
      '--auth-file',
      '-n',
      '--server-num',
      '-p',
      '--xauth-protocol',
      '-s',
      '--server-args',
      '-w',
      '--wait',
    ),
  },
  '-': { opts: NONE, zsh: true },
  'noglob': { opts: NONE, zsh: true },
  'nocorrect': { opts: NONE, zsh: true },
}

export const XARGS_OPTS: ReadonlySet<string> = opts(
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
  '--process-slot-var',
)
export const GIT_OPTS: ReadonlySet<string> = opts(
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
)
export const SHELL_OPTS: ReadonlySet<string> = opts('-o', '+o', '-O', '+O', '--rcfile', '--init-file')
export const SSH_OPTS: ReadonlySet<string> = opts(
  '-B',
  '-b',
  '-c',
  '-D',
  '-E',
  '-e',
  '-F',
  '-I',
  '-i',
  '-J',
  '-L',
  '-l',
  '-m',
  '-O',
  '-o',
  '-p',
  '-Q',
  '-R',
  '-S',
  '-W',
  '-w',
)
export const PARALLEL_OPTS: ReadonlySet<string> = opts(
  '-a',
  '--arg-file',
  '-C',
  '--colsep',
  '-d',
  '--delimiter',
  '-E',
  '-I',
  '-j',
  '--jobs',
  '-L',
  '-n',
  '--max-args',
  '-N',
  '-S',
  '--sshlogin',
  '--delay',
  '--halt',
  '--header',
  '--tagstring',
  '--sshloginfile',
  '--slf',
  '--load',
  '--nice',
  '--rpl',
  '--env',
  '--joblog',
  '--results',
  '--retries',
  '--timeout',
  '--tmpdir',
  '--workdir',
)
export const WATCH_OPTS: ReadonlySet<string> = opts('-n', '--interval', '-q', '--equexit')
export const FLOCK_OPTS: ReadonlySet<string> = opts('-w', '--wait', '--timeout', '-E', '--conflict-exit-code', '-c', '--command')
export const AWK_OPTS: ReadonlySet<string> = opts('-F', '-v', '-f', '-e', '--source', '-i', '--include')
export const RUNNER_OPTS: ReadonlySet<string> = opts(
  '-p',
  '--package',
  '-w',
  '--workspace',
  '--registry',
  '--cache',
  '--prefix',
  '--userconfig',
  '--loglevel',
)

// The subcommands of a package manager that run a program (`run`) or hand their arguments to a shell (`shell`), by
// the options the manager takes before its subcommand.
export const RUNNER_SUBCOMMANDS: Readonly<
  Record<string, { opts: ReadonlySet<string>, run: readonly string[], shell: readonly string[] }>
> = {
  pnpm: { opts: opts('-C', '--dir', '-F', '--filter', '--loglevel', '--reporter'), run: ['exec', 'dlx'], shell: [] },
  npm: { opts: opts('-w', '--workspace', '--prefix', '--loglevel', '--userconfig'), run: ['exec', 'x'], shell: [] },
  yarn: { opts: opts('--cwd'), run: ['dlx'], shell: ['exec'] },
  bun: { opts: opts('--cwd'), run: ['x'], shell: ['exec'] },
}
export const RUNNERS: ReadonlySet<string> = opts('npx', 'pnpx', 'bunx')

export const SHELLS: ReadonlySet<string> = opts('bash', 'sh', 'zsh', 'dash', 'ash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh')

export const FIND_EXEC: ReadonlySet<string> = opts('-exec', '-execdir', '-ok', '-okdir')
export const FD_EXEC: ReadonlySet<string> = opts('-x', '--exec', '-X', '--exec-batch')

// Interpreters that take a program on the command line, by the options that carry it. awk takes it as its first operand.
export const INTERPRETERS: Readonly<Record<string, readonly string[]>> = {
  python: ['-c'],
  python2: ['-c'],
  python3: ['-c'],
  node: ['-e', '--eval', '-p', '--print'],
  nodejs: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
  lua: ['-e'],
  osascript: ['-e'],
  Rscript: ['-e'],
}
export const AWKS: ReadonlySet<string> = opts('awk', 'gawk', 'mawk', 'nawk')

export const GIT_SCRIPT_OPTS: Readonly<Record<string, readonly string[]>> = {
  'rebase': ['-x', '--exec'],
  'difftool': ['-x', '--extcmd'],
  'filter-branch': [
    '--env-filter',
    '--tree-filter',
    '--index-filter',
    '--parent-filter',
    '--msg-filter',
    '--commit-filter',
    '--tag-name-filter',
  ],
}

export const SCRIPT_OPTS: ReadonlySet<string> = opts(
  '-B',
  '--log-io',
  '-E',
  '--echo',
  '-F',
  '-I',
  '--log-in',
  '-m',
  '--logging-format',
  '-O',
  '--log-out',
  '-o',
  '--output-limit',
  '-T',
  '--log-timing',
  '-t',
)
export const RUNUSER_OPTS: ReadonlySet<string> = opts(
  '-u',
  '--user',
  '-g',
  '--group',
  '-G',
  '--supp-group',
  '-s',
  '--shell',
  '-w',
  '--whitelist-environment',
)
