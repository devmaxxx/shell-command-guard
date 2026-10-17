import { describe, expect, it } from 'vitest'
import { commandSegments, DEFAULT_DENY, deniedBy, DENY_REASONS, runsCommand } from '../src'

describe('runsCommand sees through wrappers and substitutions', () => {
  it.each([
    'env FOO=1 git commit -m x',
    'env -u HOME git commit -m x',
    'sudo -u ci git commit -m x',
    'printf "%s\\n" a | xargs -I{} git commit -m {}',
    'xargs -n 1 git commit -m',
    'timeout -s KILL 30 git commit -m x',
    'timeout 30 git commit -m x',
    'nohup git commit -m x &',
    'nice -n 5 git commit -m x',
    'bash -c "git commit -m x"',
    'sh -c \'bash -c "git commit -m x"\'',
    'eval git commit -m x',
    'echo $(git commit -m x)',
    'echo "$(git commit -m x)"',
    'echo `git commit -m x`',
    'cat <<EOF\n$(git commit -m x)\nEOF',
    'cat <<EOF\n`git commit -m x`\nEOF',
    '( cd repo && git commit -m x )',
    '/usr/bin/git commit -m x',
    '\\git commit -m x',
    '"git" commit -m x',
  ])('runs git commit: %j', (cmd) => {
    expect(runsCommand(cmd, 'git commit')).toBe(true)
  })

  it.each(['npx gh pr create', 'npx -p gh gh pr create', 'pnpm exec gh pr create', 'pnpm dlx gh pr create'])(
    'runs gh pr create through a package runner: %j',
    (cmd) => {
      expect(runsCommand(cmd, 'gh pr create')).toBe(true)
    },
  )

  it.each([
    ['cat <<\'EOF\'\n$(git commit -m x)\nEOF', 'git commit'],
    ['cat <<\'EOF\'\ngit commit -m x\nEOF', 'git commit'],
    ['echo \'$(git commit -m x)\'', 'git commit'],
    ['git commit-tree HEAD^{tree}', 'git commit'],
    ['command -v git', 'git'],
  ])('%j does not run %j', (cmd, pattern) => {
    expect(runsCommand(cmd, pattern)).toBe(false)
  })

  it.each(['$GIT commit -m x', 'git $SUBCOMMAND -m x', 'git -c alias.c=commit c -m x', 'echo "unterminated'])(
    'never guesses about what it cannot know: %j',
    (cmd) => {
      expect(runsCommand(cmd, 'git commit')).toBe(false)
    },
  )
})

describe('deniedBy closes the same bypasses', () => {
  const DENY = ['git push', 'gh']

  it.each([
    'env -u HOME git push',
    'timeout -s KILL 30 git push',
    'xargs -n 1 -I{} git push',
    'echo `git push`',
    'echo "`git push`"',
    'cat <<EOF\n`git push`\nEOF',
    'sh -c \'bash -c "git push"\'',
    'sudo -E env A=1 nohup nice git push',
  ])('denies git push: %j', (cmd) => {
    expect(deniedBy(cmd, DENY)).toBe('git push')
  })

  it.each(['npx -p x gh pr create', 'pnpm --filter app exec gh pr create'])('denies gh: %j', (cmd) => {
    expect(deniedBy(cmd, DENY)).toBe('gh')
  })

  it('denies a quoted here-document line that is itself a denied command, where runsCommand sees data', () => {
    const cmd = 'cat <<\'EOF\'\ngit push\nEOF'
    expect(deniedBy(cmd, DENY)).toBe('git push')
    expect(runsCommand(cmd, 'git push')).toBe(false)
  })

  it('denies a command word that only an expansion supplies, where runsCommand does not guess', () => {
    expect(deniedBy('$TOOL push', DENY)).toBe(DENY_REASONS.expansion)
    expect(runsCommand('$TOOL push', 'git push')).toBe(false)
  })
})

describe('the default deny-list', () => {
  it.each([
    ['sudo apt-get install x', 'sudo'],
    ['FOO=1 command sudo reboot', 'sudo'],
    ['rm -rf /', 'rm -rf /'],
    ['rm -rf ~', 'rm -rf ~'],
    ['dd if=/dev/zero of=/dev/sda', 'dd'],
    ['git push origin main', 'git push'],
    ['git reset --hard HEAD~1', 'git reset --hard'],
    ['npm publish --access public', 'npm publish'],
    ['bash -c "pnpm publish"', 'pnpm publish'],
  ])('denies %j', (cmd, pattern) => {
    expect(deniedBy(cmd, DEFAULT_DENY)).toBe(pattern)
  })

  it.each(['rm -rf ./build', 'git status && pnpm test', 'git commit -m "push later"', 'echo sudo', 'ddrescue --help'])(
    'allows %j',
    (cmd) => {
      expect(deniedBy(cmd, DEFAULT_DENY)).toBeNull()
    },
  )
})

describe('deniedBy reads words the shell rewrites before running', () => {
  it.each([
    'git -calias.p=push p',
    '{git,push}',
    'git push{,}',
    'a+=1 git push',
    'a[1]=2 git push',
    'FOO="a b" git push',
    'pnpm exec -- git push',
    'ksh -c "git push"',
    'fish -c "git push"',
  ])('denies %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).not.toBeNull()
  })

  it('drops leading assignments whose value holds blanks', () => {
    expect(commandSegments('FOO="a b" pnpm lint')).toEqual(['pnpm lint'])
  })
})

describe('a shell that reads its script from stdin or a file', () => {
  it.each(['echo \'git push\' | sh', 'sh <<< \'git push\'', 'printf \'git push\' | bash -s', 'echo git push | zsh', 'bash < script.sh', 'bash <<EOF\ngit push\nEOF', 'env bash -l'])(
    'fails closed on %j',
    (cmd) => {
      expect(deniedBy(cmd, ['git push'])).toBe(DENY_REASONS.stdinScript)
      expect(runsCommand(cmd, 'git push')).toBe(false)
    },
  )

  it.each(['bash script.sh', 'sh -x deploy.sh arg'])('fails closed on a script file: %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).toBe(DENY_REASONS.scriptFile)
    expect(runsCommand(cmd, 'git push')).toBe(false)
  })

  it('still reads the script of -c, and allows --version', () => {
    expect(deniedBy('bash -c "pnpm test"', ['git push'])).toBeNull()
    expect(deniedBy('bash --version', ['git push'])).toBeNull()
  })
})

describe('more wrappers come off', () => {
  it.each([
    'setsid -f git push',
    'stdbuf -o L git push',
    'stdbuf -oL -e0 git push',
    'ionice -c 3 git push',
    'ionice -c3 -n 7 git push',
    'flock /tmp/lock git push',
    'flock -w 5 /tmp/lock git push',
    'flock /tmp/lock -c "git push"',
    'flock -E 9 /tmp/lock --command "echo; git push"',
    'chronic -e git push',
    'watch -n 5 git push',
    'watch "echo; git push"',
    'watch -x git push',
    'find . -exec git push \\;',
    'find . -name x -execdir git push {} +',
    'find . -exec true \\; -ok git push \\;',
    'find . -exec sh -c \'git push\' \\;',
    'npm exec -- git push',
    'npm x git push',
    'npm exec -c "echo; git push"',
    'npm --prefix app exec --package=x git push',
    'npx -c "echo; git push"',
    'yarn exec git push',
    'yarn dlx -p x git push',
    'yarn --cwd app exec git push',
    'pnpx git push',
    'pnpm exec -c "echo; git push"',
    'bunx git push',
    'busybox git push',
    'busybox sh -c "git push"',
  ])('denies and runs git push: %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).toBe('git push')
    expect(runsCommand(cmd, 'git push')).toBe(true)
  })

  it.each(['find . -name "*.ts"', 'flock 9', 'watch -n 5 date', 'npm exec vitest'])('allows %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).toBeNull()
  })
})

describe('env -S splits its string into words', () => {
  it.each([
    'env -S "FOO=1 git push"',
    'env -S"git push"',
    'env --split-string="git push origin"',
    'env --split-string "git push"',
    'env -iS"git push"',
    'env -u HOME -S "git push"',
    'env -S "-i FOO=1 git push"',
  ])('denies and runs git push: %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).toBe('git push')
    expect(runsCommand(cmd, 'git push')).toBe(true)
  })

  it('fails closed when the string holds a ${VAR}', () => {
    expect(deniedBy('env -S "${TOOL} push"', ['git push'])).toBe(DENY_REASONS.expansion)
  })
})

describe('a glob in the command word', () => {
  it.each(['/usr/bin/gi[t] push', '/usr/bin/g* push', 'gi? push', 'sudo /usr/bin/g* push'])(
    'is an expansion: %j',
    (cmd) => {
      expect(deniedBy(cmd, ['git push'])).toBe(DENY_REASONS.expansion)
      expect(runsCommand(cmd, 'git push')).toBe(false)
    },
  )

  it.each(['"g*" push', 'g\\* push', 'ls *.ts', '[ -f x ] && echo ok', 'rm -rf ./build/*'])(
    'a quoted glob, a glob in an argument and the test command are not: %j',
    (cmd) => {
      expect(deniedBy(cmd, ['git push', ...DEFAULT_DENY])).toBeNull()
    },
  )

  it('an array assignment holds words, not a command', () => {
    expect(deniedBy('a=(git push)', ['git push'])).toBeNull()
    expect(runsCommand('a=(git push)', 'git push')).toBe(false)
    expect(runsCommand('a=(x y) && git push', 'git push')).toBe(true)
    expect(deniedBy('a=($(git push))', ['git push'])).toBe('git push')
  })
})

describe('here-document delimiters are any bash word', () => {
  it.each([
    'cat <<\'MSG-1\'\ngit push\nMSG-1\ngit push',
    'cat <<EOF>out\ngit push\nEOF\ngit push',
    'cat <<end-1;\ngit push\nend-1\ngit push',
    'cat <<"a b"\ngit push\na b\ngit push',
    'cat <<\\x.y\ngit push\nx.y\ngit push',
  ])('runs only the command after the body: %j', (cmd) => {
    expect(runsCommand(cmd, 'git push')).toBe(true)
    expect(commandSegments(cmd).filter(s => s === 'git push')).toHaveLength(1)
  })

  it('reads a substitution in an unquoted body behind a lowercase delimiter', () => {
    expect(runsCommand('cat <<msg\n$(git push)\nmsg', 'git push')).toBe(true)
  })
})

describe('rm is matched by its flag set', () => {
  it.each([
    ['rm -Rf /', 'rm -rf /'],
    ['rm -rfv /', 'rm -rf /'],
    ['rm -r -f /', 'rm -rf /'],
    ['rm -rf --no-preserve-root /', 'rm -rf /'],
    ['rm --recursive --force /', 'rm -rf /'],
    ['rm / -rf', 'rm -rf /'],
    ['rm -Rf build ~', 'rm -rf ~'],
    ['rm -fR ~', 'rm -rf ~'],
    ['rm -Rf "$HOME"', 'rm -rf ~'],
    ['rm -r -f ${HOME}', 'rm -rf ~'],
    ['rm -Rf -- /*', 'rm -rf /*'],
  ])('denies %j', (cmd, pattern) => {
    expect(deniedBy(cmd, DEFAULT_DENY)).toBe(pattern)
    expect(runsCommand(cmd, pattern)).toBe(true)
  })

  it.each(['rm -Rf ./build', 'rm -r /tmp/x', 'rm -f /etc/x.lock', 'rm -rf ~/project'])('allows %j', (cmd) => {
    expect(deniedBy(cmd, DEFAULT_DENY)).toBeNull()
  })
})

describe('a git alias defined through the environment', () => {
  it.each([
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=Alias.p GIT_CONFIG_VALUE_0=push git p',
    'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p',
    'GIT_CONFIG_PARAMETERS="\'alias.p=push\'" git p',
    'env GIT_CONFIG_PARAMETERS="\'alias.p=push\'" git -C repo p',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=$k GIT_CONFIG_VALUE_0=push git p',
    'GIT_CONFIG_PARAMETERS="\'alias.p=push\'" bash -c "git p"',
  ])('is denied like git -c alias.*: %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).toBe(DENY_REASONS.gitAlias)
    expect(runsCommand(cmd, 'git push')).toBe(false)
  })

  it('still sees a real subcommand and allows other config keys', () => {
    expect(runsCommand('GIT_CONFIG_PARAMETERS="\'alias.p=push\'" git commit -m x', 'git commit')).toBe(true)
    expect(deniedBy('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat git log', ['git push'])).toBeNull()
  })
})

describe('wrappers and precommand modifiers beyond the common ones', () => {
  it.each([
    'chrt 10 git push',
    'chrt -T 5 10 git push',
    'taskset 1 git push',
    'taskset -c 0-3 git push',
    'caffeinate -i git push',
    'caffeinate -t 60 git push',
    'arch -arm64 git push',
    'arch -arch x86_64 git push',
    'unbuffer git push',
    'strace -f -o log git push',
    'ltrace git push',
    'nsenter -t 1 -m git push',
    'chroot / git push',
    'pkexec git push',
    'run0 -u ci git push',
    'runuser -u ci git push',
    'systemd-run --user -p X=1 git push',
    'toybox git push',
    'firejail --quiet git push',
    'faketime "2020-01-01" git push',
    'dbus-launch git push',
    'xvfb-run -a git push',
    'doas -u ci git push',
    'coproc git push',
    'coproc p { git push; }',
    'function f { git push; }',
    'script -q /dev/null git push',
    'script -c "git push" /dev/null',
    'su ci -c "git push"',
    'ssh host git push',
    'ssh -p 22 host "cd repo && git push"',
    'fd -x git push',
    'git bisect run git push',
    'git rebase -x "git push" main',
    'git rebase --exec="git push" main',
    'git submodule foreach "git push"',
    'git submodule --quiet foreach --recursive git push',
    'git filter-branch --tree-filter "git push" HEAD',
    'parallel git push ::: a',
    'yarn exec "echo; git push"',
    'bun exec "git push"',
    'bun x git push',
  ])('denies and runs git push: %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).toBe('git push')
    expect(runsCommand(cmd, 'git push')).toBe(true)
  })

  it.each(['=git push', 'noglob git push', 'nocorrect git push', '- git push', '[[ -n x ]] git push'])(
    'denies a zsh-only form that bash would not run: %j',
    (cmd) => {
      expect(deniedBy(cmd, ['git push'])).toBe('git push')
      expect(runsCommand(cmd, 'git push')).toBe(false)
    },
  )

  it.each([
    'git -c core.pager="git push" log',
    'git -c core.sshCommand="sh -c \'git push\'" fetch',
    'git -ccore.editor=\'!git push\' commit',
    'trap "git push" EXIT',
    'trap -- "git push" INT TERM',
    'alias g=\'git push\'\ng',
    'alias g=git\ng push',
    'parallel ::: "git push"',
  ])('denies a command set up now and run later: %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).toBe('git push')
  })

  it.each(['git config alias.p \'!git push\'', 'git config --global alias.p push'])('denies a stored git alias: %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).toBe(DENY_REASONS.gitAlias)
  })

  it.each(['source <(echo git push)', '. /dev/stdin <<< "git push"', 'parallel', 'echo "git push" | parallel'])(
    'fails closed on a script read from stdin: %j',
    (cmd) => {
      expect(deniedBy(cmd, ['git push'])).toBe(DENY_REASONS.stdinScript)
    },
  )

  it('fails closed on commands parallel reads from a file', () => {
    expect(deniedBy('parallel :::: jobs.txt', ['git push'])).toBe(DENY_REASONS.scriptFile)
  })

  it.each(['echo push | xargs git', 'echo "git push" | xargs -I{} sh -c {}', 'xargs -I % % push', 'xargs -iX X push'])(
    'counts the words xargs adds: %j',
    (cmd) => {
      expect(deniedBy(cmd, ['git push'])).not.toBeNull()
      expect(runsCommand(cmd, 'git push')).toBe(false)
    },
  )

  it.each([
    'python3 -c \'import os; os.system("git push")\'',
    'python -Ic \'import subprocess; subprocess.run(["git", "push"])\'',
    'node -e \'require("child_process").execSync("git push")\'',
    'perl -le \'system q(git push)\'',
    'ruby -e \'`git push`\'',
    'osascript -e \'do shell script "git push"\'',
    'awk \'BEGIN { system("git push") }\'',
    'gawk -e \'BEGIN { system("git push") }\'',
  ])('denies a pattern named in an interpreter\'s inline program: %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).toBe('git push')
    expect(runsCommand(cmd, 'git push')).toBe(false)
  })

  it.each([
    'source .venv/bin/activate && pytest',
    '. ~/.nvm/nvm.sh && nvm use',
    'git ls-files | xargs wc -l',
    'python3 -c "print(1 + 1)"',
    'awk \'{ print $1 }\' file',
    'awk -f prog.awk file',
    'git rebase -i main',
    'git -c color.ui=always log',
    'git config user.name x',
    'ssh host uptime',
    'parallel echo ::: a b',
    'trap "rm -f $tmp" EXIT',
    'trap - EXIT',
    'alias ll=\'ls -la\'',
    'git submodule foreach git pull',
    'fd -e ts -x wc -l',
    'script -q /dev/null ls',
    'yarn exec tsc',
    'su -',
  ])('allows %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).toBeNull()
  })

  it('takes `command -pv` for a lookup', () => {
    expect(runsCommand('command -pv git', 'git')).toBe(false)
  })
})

describe('a line nested deeper than the stack', () => {
  it.each([['$(', 20_000], ['"$(', 20_000], ['${', 20_000], ['`$(', 5_000]] as const)(
    'fails closed instead of throwing on %j repeated %i times',
    (open, times) => {
      const cmd = open.repeat(times)
      expect(() => deniedBy(cmd, ['git push'])).not.toThrow()
      expect(deniedBy(cmd, ['git push'])).toBe(DENY_REASONS.unbalanced)
      expect(runsCommand(cmd, 'git push')).toBe(false)
      expect(() => commandSegments(cmd)).not.toThrow()
    },
  )
})

describe('options that take a value are skipped before the wrapped command', () => {
  it.each([
    '/usr/bin/time -f %e git push',
    'time -o out git push',
    'env -P /usr/bin git push',
    'env -a name git push',
    'env --argv0 name git push',
    'gtimeout 5 git push',
    'fakeroot git push',
    'unshare -r git push',
    'sandbox-exec -p "(version 1)" git push',
    'systemd-run --service-type notify git push',
    'parallel --halt now,fail=1 git push ::: a',
    'parallel --header : git push ::: a',
    'parallel --tagstring x git push ::: a',
    'npx --registry https://registry.example git push',
    'xargs -tI{} git push {}',
    'xargs -0I@ git @',
    'flock -c "git push" /tmp/lock',
    'flock -n --command "git push" /tmp/lock',
    'flock /tmp/lock --command="git push"',
    'ssh host -t git push',
    'ssh host -- git push',
    'eval -- git push',
  ])('denies git push: %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).not.toBeNull()
  })

  it.each([
    'python -c\'import os; os.system("git push")\'',
    'python3.12 -c \'import os; os.system("git push")\'',
    'perl -e\'system("git push")\'',
    'git rebase -x\'git push\' main',
  ])('reads a program given in the same word as its option: %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).toBe('git push')
  })

  it.each(['flock /tmp/lock git status', 'flock -n 9', 'ssh host ls -l', 'xargs -n 1 echo'])('allows %j', (cmd) => {
    expect(deniedBy(cmd, ['git push'])).toBeNull()
  })
})
