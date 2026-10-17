import { describe, expect, it } from 'vitest'
import { DEFAULT_DENY, deniedBy, DENY_REASONS, runsCommand } from '../src'

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
