import { describe, expect, it } from 'vitest'
import {
  aiSignatures,
  authoredMessages,
  authorshipViolations,
  branchNames,
  isConventionalBranch,
  isConventionalCommit,
} from '../src'

const TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>'

describe('authoredMessages: git commit', () => {
  it('joins -m values as paragraphs', () => {
    expect(authoredMessages('git commit -m "fix: a" -m "Body."')).toEqual([
      { kind: 'commit', text: 'fix: a\n\nBody.', file: null },
    ])
  })

  it('reads attached, long, abbreviated and clustered forms', () => {
    const texts = [
      'git commit -mfix:\\ a',
      'git commit --message="fix: a"',
      'git commit --mess "fix: a"',
      'git commit -am "fix: a"',
    ].map(cmd => authoredMessages(cmd)[0]?.text)
    expect(texts).toEqual(['fix: a', 'fix: a', 'fix: a', 'fix: a'])
  })

  it('reads -F - from a here-document', () => {
    expect(authoredMessages('git commit -F - <<\'EOF\'\nfeat: b\nEOF')[0]?.text).toBe('feat: b\n')
  })

  it('appends --trailer lines as one block', () => {
    expect(authoredMessages('git commit -m "fix: a" --trailer "Refs: #1" --trailer "Closes: #2"')[0]?.text).toBe(
      'fix: a\n\nRefs: #1\nCloses: #2',
    )
  })

  it('names a message file without opening it', () => {
    expect(authoredMessages('git commit -F msg.txt')).toEqual([{ kind: 'commit', text: null, file: 'msg.txt' }])
  })

  it('gives null text when the message comes from an editor, another commit or an expansion', () => {
    for (const cmd of ['git commit', 'git commit -C HEAD', 'git commit -m "$M"', 'git commit $FLAGS']) {
      expect(authoredMessages(cmd)[0]?.text).toBeNull()
    }
  })

  it('does not take a value-taking option\'s value as a message', () => {
    expect(authoredMessages('git commit --author "A <a@b>" -m "fix: a"')[0]?.text).toBe('fix: a')
  })
})

describe('authoredMessages: gh pr', () => {
  it('joins title and body', () => {
    expect(authoredMessages('gh pr create -t "Add login" -b "Adds it."')).toEqual([
      { kind: 'pull-request', text: 'Add login\n\nAdds it.', file: null },
    ])
  })

  it('reads --body-file - from a here-document', () => {
    expect(authoredMessages('gh pr comment 3 --body-file - <<\'EOF\'\nLooks good.\nEOF')[0]?.text).toBe(
      'Looks good.\n',
    )
  })

  it('names a body file without opening it', () => {
    expect(authoredMessages('gh pr edit 3 -F body.md')[0]?.file).toBe('body.md')
  })

  it('reads -t as the merge subject and leaves review -r a flag', () => {
    expect(authoredMessages('gh pr merge 3 -s -t "Add login" -b "x"')[0]?.text).toBe('Add login\n\nx')
    expect(authoredMessages('gh pr review 3 -r -b "Fix the test"')[0]?.text).toBe('Fix the test')
  })

  it('reads no message from a command that only mentions one', () => {
    expect(authoredMessages('echo "gh pr create -b hi"; grep "git commit" notes.md')).toEqual([])
  })
})

describe('branchNames', () => {
  it('reads every way a branch is created or renamed', () => {
    expect(
      branchNames(
        [
          'git checkout -b feat/a',
          'git switch -c feat/b',
          'git switch --create=feat/c',
          'git branch feat/d main',
          'git branch -m feat/d feat/e',
          'git worktree add -b feat/f ../f',
          'git worktree add ../feat-g',
        ].join(' && '),
      ),
    ).toEqual(['feat/a', 'feat/b', 'feat/c', 'feat/d', 'feat/e', 'feat/f', 'feat-g'])
  })

  it('names no branch for listing, deleting, switching to one, or a worktree on a commit', () => {
    expect(
      branchNames('git branch; git branch -d old; git branch --list "feat/*"; git switch main; git worktree add ../x main'),
    ).toEqual([])
  })

  it('gives null for a name from an expansion', () => {
    expect(branchNames('git checkout -b "$NAME"')).toEqual([null])
  })
})

describe('aiSignatures', () => {
  it('finds signing trailers, footers and session links', () => {
    const text = [
      'fix: tidy',
      '',
      TRAILER,
      'Claude-Session: https://claude.ai/code/session_1',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      'Assisted-by: GitHub Copilot',
    ].join('\n')
    expect(aiSignatures(text).map(s => s.line)).toEqual([3, 4, 5, 6])
  })

  it('ignores a tool named in prose and a human co-author', () => {
    expect(aiSignatures('docs(claude): explain the .claude folder\n\nCo-authored-by: Ada <ada@example.com>')).toEqual([])
  })
})

describe('isConventionalCommit', () => {
  it('accepts type, lowercase scope and breaking mark', () => {
    expect(isConventionalCommit('feat(api)!: drop v1')).toBe(true)
    expect(isConventionalCommit('# comment\n\nfix: a\n\nbody')).toBe(true)
  })

  it('rejects an unknown type, an uppercase scope or no description', () => {
    expect(isConventionalCommit('fixed it')).toBe(false)
    expect(isConventionalCommit('feat(API): x')).toBe(false)
    expect(isConventionalCommit('fix:')).toBe(false)
  })

  it('passes subjects git writes itself', () => {
    expect(isConventionalCommit('Merge branch \'main\'')).toBe(true)
    expect(isConventionalCommit('fixup! feat: a')).toBe(true)
  })

  it('takes custom types', () => {
    expect(isConventionalCommit('wip: a', ['wip'])).toBe(true)
  })
})

describe('isConventionalBranch', () => {
  it('accepts type/description and the trunks', () => {
    expect(isConventionalBranch('feat/add-login')).toBe(true)
    expect(isConventionalBranch('release/v1.2.0')).toBe(true)
    expect(isConventionalBranch('main')).toBe(true)
  })

  it('rejects uppercase, underscores, dots outside release, and unknown types', () => {
    for (const name of ['Feat/x', 'feat/add_login', 'feat/v1.2', 'wip/x', 'feat/', 'feat/a--b', 'feat/a/b']) {
      expect(isConventionalBranch(name)).toBe(false)
    }
  })
})

describe('authorshipViolations', () => {
  it('reports a signature, a subject and a branch', () => {
    expect(authorshipViolations(`git switch -c Fix_Login && git commit -m "fixed it" -m "${TRAILER}"`)).toEqual([
      'branch "Fix_Login" is not a Conventional Branch',
      `AI signature: "${TRAILER}"`,
      'commit subject "fixed it" is not a Conventional Commit',
    ])
  })

  it('finds a signature passed as --trailer even when the message comes from an editor', () => {
    expect(authorshipViolations(`git commit --trailer "${TRAILER}"`)).toEqual([`AI signature: "${TRAILER}"`])
  })

  it('finds a signature in a commit hidden behind a wrapper', () => {
    expect(authorshipViolations(`env A=1 bash -c 'git commit -m "fix: a" -m "${TRAILER}"'`)).toEqual([
      `AI signature: "${TRAILER}"`,
    ])
  })

  it('finds a pull-request footer', () => {
    expect(authorshipViolations('gh pr create -t "Add login" -b "Adds it.\n\n🤖 Generated with [Claude Code](x)"')).toEqual(
      ['AI signature: "🤖 Generated with [Claude Code](x)"'],
    )
  })

  it('reads a message file only through readFile', () => {
    const readFile = (path: string): string | null => (path === 'msg.txt' ? 'fixed it\n' : null)
    expect(authorshipViolations('git commit -F msg.txt')).toEqual([])
    expect(authorshipViolations('git commit -F msg.txt', { readFile })).toEqual([
      'commit subject "fixed it" is not a Conventional Commit',
    ])
  })

  it('reports nothing for a clean line or one that only mentions the commands', () => {
    expect(authorshipViolations('git switch -c feat/login && git commit -m "feat: add login"')).toEqual([])
    expect(authorshipViolations(`echo "git commit -m 'fixed it' -m '${TRAILER}'"`)).toEqual([])
  })

  it('takes custom types and prefixes', () => {
    expect(
      authorshipViolations('git switch -c claude/x && git commit -m "wip: a"', {
        commitTypes: ['wip'],
        branchTypes: ['claude'],
      }),
    ).toEqual([])
  })
})

describe('authorshipViolations: glued options and partial messages', () => {
  it('finds a signature glued to its flag', () => {
    expect(authorshipViolations('git commit -m "feat: a" --trailer="Co-Authored-By: Claude <c@example.com>"')).toEqual([
      'AI signature: "Co-Authored-By: Claude <c@example.com>"',
    ])
    expect(authorshipViolations('gh pr create -t "feat: a" -b"🤖 made it"')).toEqual(['AI signature: "🤖 made it"'])
  })

  it('checks the subject when a later -m comes from an expansion', () => {
    expect(authorshipViolations('git commit -m "fixed it" -m "$(date)"')).toEqual([
      'commit subject "fixed it" is not a Conventional Commit',
    ])
    expect(authorshipViolations('git commit -m "$SUBJECT" -m "body"')).toEqual([])
  })

  it('does not take a tool named in a sentence for a signature', () => {
    expect(aiSignatures('feat: parse replies generated by OpenAI models')).toEqual([])
  })

  it('accepts a commit type that holds a regex metacharacter', () => {
    expect(isConventionalCommit('c++: add a thing', ['c++'])).toBe(true)
  })
})
