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
