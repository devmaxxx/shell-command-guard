import { describe, expect, it } from 'vitest'
import { runsCommand } from '../src'

const GH_PR = ['gh pr create', 'gh pr edit', 'gh pr comment', 'gh pr review', 'gh pr merge']

describe('recognising a command at a command position', () => {
  it('matches a plain invocation', () => {
    expect(runsCommand('git commit -m \'x\'', 'git commit')).toBe(true)
  })

  it('matches after a shell operator', () => {
    expect(runsCommand('git add -A && git commit -m \'x\'', 'git commit')).toBe(true)
  })

  it('matches through git\'s own value-taking global flags', () => {
    expect(runsCommand('git -C /repo commit -m \'x\'', 'git commit')).toBe(true)
    expect(runsCommand('git -c user.name=x commit -m \'y\'', 'git commit')).toBe(true)
    expect(runsCommand('git --no-pager commit -m \'z\'', 'git commit')).toBe(true)
  })

  it('does not match the words inside a heredoc body', () => {
    const script = ['python3 - <<\'PY\'', 'print(\'run: git commit -m hi\')', 'PY'].join('\n')
    expect(runsCommand(script, 'git commit')).toBe(false)
  })

  it('does not match the words inside a quoted argument', () => {
    expect(runsCommand('echo "then git commit -m x"', 'git commit')).toBe(false)
    expect(runsCommand('grep -rn \'git commit\' ./docs', 'git commit')).toBe(false)
  })

  it('does not match the words in a comment', () => {
    expect(runsCommand('git status # then git commit', 'git commit')).toBe(false)
  })

  it('does not match a different subcommand that merely mentions it', () => {
    expect(runsCommand('git log --grep commit', 'git commit')).toBe(false)
  })

  it('matches any of several subcommands', () => {
    expect(runsCommand('gh pr edit 12 --body x', GH_PR)).toBe(true)
    expect(runsCommand('echo \'gh pr merge 12\'', GH_PR)).toBe(false)
  })
})

describe('commands a commit hook has to tell apart', () => {
  it('a heredoc that merely prints the words does not run them', () => {
    const script = ['python3 - <<\'PY\'', 'print(\'## Checklist before `git commit` / PR / doc\')', 'PY'].join('\n')
    expect(runsCommand(script, 'git commit')).toBe(false)
  })

  it('a commit chained with an unrelated heredoc still runs the commit', () => {
    const script = ['git commit -q -m "fix(etl): keep NULL positions" && python3 - <<\'EOF\'', 'import json,os', 'EOF'].join(
      '\n',
    )
    expect(runsCommand(script, 'git commit')).toBe(true)
  })

  it('a heredoc fed to git commit -F - runs the commit', () => {
    const script = ['git commit -F - <<\'EOF\'', 'fixed the thing', 'EOF'].join('\n')
    expect(runsCommand(script, 'git commit')).toBe(true)
  })

  it('a message built by -m "$(cat <<EOF)" runs the commit', () => {
    const script = ['git commit -m "$(cat <<\'EOF\'', 'fixed the thing', 'EOF', ')"'].join('\n')
    expect(runsCommand(script, 'git commit')).toBe(true)
  })

  it('a real commit is recognised whatever its message says', () => {
    expect(runsCommand('git commit -m "fixed the thing"', 'git commit')).toBe(true)
    expect(runsCommand('git commit -m "fix(api): tidy" -m "Co-Authored-By: someone <x@y.z>"', 'git commit')).toBe(true)
    expect(runsCommand('git commit -m "fix(api): tidy the export"', 'git commit')).toBe(true)
  })

  it('a line that runs neither command runs neither', () => {
    expect(runsCommand('ls -la && cat README.md', ['git commit', ...GH_PR])).toBe(false)
  })
})
