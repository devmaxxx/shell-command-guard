import { describe, expect, it } from 'vitest'
import { commandSegments, deniedBy, invocations } from '../src'

describe('invocations', () => {
  it('returns the words after wrappers come off, quotes removed', () => {
    expect(invocations('sudo env A=1 git -C repo commit -m "fix: tidy it"', 'git commit')).toEqual([
      { args: ['git', 'commit', '-m', 'fix: tidy it'], stdin: null },
    ])
  })

  it('lists every matching command in source order, equal ones included', () => {
    expect(invocations('git commit -m a; ls; git commit -m a', 'git commit').map(i => i.args)).toEqual([
      ['git', 'commit', '-m', 'a'],
      ['git', 'commit', '-m', 'a'],
    ])
  })

  it('reads a command nested in a shell script', () => {
    expect(invocations('bash -c \'git commit -m "x y"\'', 'git commit')).toEqual([
      { args: ['git', 'commit', '-m', 'x y'], stdin: null },
    ])
  })

  it('lists nothing for a command only mentioned', () => {
    expect(invocations('echo "git commit -m x" # git commit', 'git commit')).toEqual([])
    expect(invocations('python3 - <<\'PY\'\nprint("git commit")\nPY', 'git commit')).toEqual([])
  })

  it('gives null for a word that depends on what runs', () => {
    expect(invocations('git commit -m "$MSG" -m "fix: $(date)"', 'git commit')[0]?.args).toEqual([
      'git',
      'commit',
      '-m',
      null,
      '-m',
      null,
    ])
  })

  it('resolves a word that is a substitution printing a here-document, without its trailing newlines', () => {
    const cmd = 'git commit -m "$(cat <<\'EOF\'\nfix(api): tidy\n\nWhy it changed.\nEOF\n)"'
    expect(invocations(cmd, 'git commit')[0]?.args).toEqual(['git', 'commit', '-m', 'fix(api): tidy\n\nWhy it changed.'])
  })

  it('reads stdin from a quoted here-document as written', () => {
    const cmd = 'git commit -F - <<\'EOF\'\nfeat: a $HOME\nEOF'
    expect(invocations(cmd, 'git commit')[0]?.stdin).toBe('feat: a $HOME\n')
  })

  it('strips leading tabs from a <<- here-document', () => {
    expect(invocations('git commit -F - <<-EOF\n\tfeat: a\n\tEOF', 'git commit')[0]?.stdin).toBe('feat: a\n')
  })

  it('gives null stdin for an unquoted here-document that expands', () => {
    expect(invocations('git commit -F - <<EOF\nfeat: $X\nEOF', 'git commit')[0]?.stdin).toBeNull()
  })

  it('reads stdin from a here-string, with the newline the shell adds', () => {
    expect(invocations('git commit -F - <<< "fix: x"', 'git commit')[0]?.stdin).toBe('fix: x\n')
  })

  it('passes a wrapper\'s here-document to a one-command nested script', () => {
    expect(invocations('bash -c \'git commit -F -\' <<\'EOF\'\nchore: z\nEOF', 'git commit')[0]?.stdin).toBe(
      'chore: z\n',
    )
  })

  it('does not attribute a pipe\'s input as stdin', () => {
    expect(invocations('printf "fix: x" | git commit -F -', 'git commit')[0]?.stdin).toBeNull()
  })
})

describe('substitution markers stay internal', () => {
  it('leaves no marker in commandSegments', () => {
    expect(commandSegments('git commit -m "$(cat <<\'EOF\'\nx\nEOF\n)"')).toEqual(['git commit -m ""', 'cat <<\'EOF\''])
  })

  it('still denies a command hidden inside a substitution', () => {
    expect(deniedBy('echo "$(git push)"', ['git push'])).toBe('git push')
  })
})
