import { describe, expect, it } from 'vitest'
import { commandSegments, DEFAULT_DENY, deniedBy, effectiveDeny } from '../src'

// The behaviour below is pinned against a fixed list, so changing DEFAULT_DENY cannot change what these cases mean.
const DENY: readonly string[] = [
  'git push',
  'gh',
  'git worktree',
  'git switch',
  'git checkout -b',
  'git remote',
  'git fetch',
  'git pull',
  'git rebase',
  'git reset --hard',
]

it('splits compound shell commands and drops env assignments', () => {
  expect(commandSegments('FOO=1 pnpm lint && git push origin x; echo $(gh pr list) | cat')).toEqual([
    'pnpm lint',
    'git push origin x',
    'echo',
    'gh pr list',
    'cat',
  ])
})

it('deny matches a prefix at word boundaries only', () => {
  expect(deniedBy('pnpm test && git push', DENY)).toBe('git push')
  expect(deniedBy('ghost --help', DENY)).toBeNull()
  expect(deniedBy('gh pr create', DENY)).toBe('gh')
  expect(deniedBy('  git   push  ', DENY)).toBe('git push')
})

it('a policy and extra commands join the default deny list, defaults first', () => {
  expect(effectiveDeny({ deny: ['docker'] }, ['pnpm tasks claim'])).toEqual([
    ...DEFAULT_DENY,
    'docker',
    'pnpm tasks claim',
  ])
})

it.each([
  '( git push )',
  '{ git push; }',
  'env git push',
  'env GIT_SSH_COMMAND=ssh git push',
  'FOO=1 git push',
  'command git push',
  'exec git push',
  'sudo git push',
  'nohup git push',
  'timeout 60 git push',
  'nice -n 5 git push',
  '! git push',
  'if true; then git push; fi',
  'git push& echo',
  'bash -c "git push"',
  'eval git push',
  'git -C dir push',
  'git -c x=y push',
  'git --no-pager push',
  '"git" push',
  '/usr/bin/git push',
  'xargs git push',
  'echo "$(git push)"',
])('a wrapped or indirect git push is denied: %s', (cmd) => {
  expect(deniedBy(cmd, DENY)).toBe('git push')
})

it.each([`sh -c 'gh pr merge 1'`, 'npx gh pr create'])('a wrapped gh call is denied: %s', (cmd) => {
  expect(deniedBy(cmd, DENY)).toBe('gh')
})

it('a git alias defined on the command line is denied, whatever it expands to', () => {
  expect(deniedBy('git -c alias.p=push p', DENY)).not.toBeNull()
})

it.each(['git commit -m "fix push"', 'grep "git push" NOTES.md', 'echo "$(date) gh"', 'command -v gh'])(
  'a denied word that is not the command is allowed: %s',
  (cmd) => {
    expect(deniedBy(cmd, DENY)).toBeNull()
  },
)

it('a deny on a wrapper still matches the wrapper itself', () => {
  expect(deniedBy('sudo rm -rf build', ['sudo'])).toBe('sudo')
})

it.each([
  ['pnpm test && git push', 'git push'],
  ['gh pr create', 'gh'],
  ['  git   push  ', 'git push'],
  ['FOO=1 pnpm lint && git push origin x; echo $(gh pr list) | cat', 'git push'],
])('every command the first matcher denied is still denied: %s', (cmd, prefix) => {
  expect(deniedBy(cmd, DENY)).toBe(prefix)
})

it.each([
  'echo x #"\ngit push',
  'echo x # it\'s\ngit push',
  `cat <<'EOF'\n"\nEOF\ngit push`,
  'cat <<EOF\nit\'s\nEOF\ngit push',
  'echo $\'\\\'\'; git push',
])('a comment, a here-document or ANSI-C quoting does not hide a later command: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).not.toBeNull()
})

it.each(['echo "unterminated', 'echo it\'s'])('quoting left open fails closed: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).toBe('unbalanced quoting')
})

it.each(['git -c Alias.p=push p', 'git -c ALIAS.p=push p', 'git --config-env=Alias.p=X p'])(
  'a git alias is recognised in any case: %s',
  (cmd) => {
    expect(deniedBy(cmd, DENY)).toBe('git -c alias.*')
  },
)

it.each([
  'pnpm -s exec git push',
  'time -p git push',
  'sudo -iu x git push',
  'sudo -uroot git push',
  'bash -o pipefail -c "git push"',
  'bash +x -c "git push"',
  'git push>/dev/null',
  'git push 2>&1',
  '>out git push',
  '2>/dev/null git push',
  '<f git push',
  'git \\\npush',
])('wrapper options, redirections and line continuations do not hide git push: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).toBe('git push')
})

it('a prototype-named command with an option is no wrapper and does not throw', () => {
  expect(deniedBy('hasOwnProperty -x rm -rf /', DENY)).toBeNull()
})

it('a redirection glued to gh does not hide it', () => {
  expect(deniedBy('gh>/dev/null pr list', DENY)).toBe('gh')
})

it.each(['pnpm -s test', 'pnpm exec vitest run > out.txt 2>&1'])(
  'pnpm commands that run nothing denied stay allowed: %s',
  (cmd) => {
    expect(deniedBy(cmd, DENY)).toBeNull()
  },
)

it.each([
  `git commit -m "$(cat <<'EOF'\nDon't break it's parser\nEOF\n)"`,
  `git commit -m "$(cat <<'EOF'\nDon't break the parser\nEOF\n)"`,
  'git commit -F msg.txt',
  'echo hi # it\'s fine',
  'cat <<-\'EOF\'\n\tit\'s\n\tEOF',
])('a comment or a here-document body is data, not quoting: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).toBeNull()
})

it.each([
  'cat <<EOF\n$(git push)\nEOF',
  'echo x # it\'s\ngit push',
  'echo x # it\'s\nbash -c "git push"',
  'cat <<\'EOF\'\nit\'s\nEOF\nbash -c "git push"',
  'cat <<EOF\nok\nEOF\nbash -c "git push"',
  'echo $\'it\\\'s\'; bash -c "git push"',
])('a command after or inside a comment, here-document or $\'…\' is still read: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).toBe('git push')
})

it.each([
  'echo ${x# }; bash -c "git push"',
  'echo $((1<<2))\nbash -c "git push"',
  'echo $[1<<2]\nbash -c "git push"',
  'echo ${x:-<<E}\nbash -c "git push"\nE',
  'echo `true #`; bash -c "git push"',
  'echo a\\ #; bash -c "git push"',
  'cat <<\'E\'\nx\\\nE\nbash -c "git push"',
])('what bash does not read as a comment or a here-document is not skipped: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).toBe('git push')
})

it('an unterminated $\'…\' fails closed', () => {
  expect(deniedBy('echo $\'abc', DENY)).toBe('unbalanced quoting')
})

// Every line below runs P in bash 3.2, sh or zsh. P is `\git push`: the quote-blind layer does not see it, so the
// scanner has to. `it's` is text a shell reads as data but a misreading takes for an open quote, and `#'` closes it.
function shellRuns(cases: string[]) {
  return cases.map(c => c.replaceAll('P', '\\git push'))
}

it.each(
  shellRuns([
    'echo x\r# ; P',
    'echo x\f# ; P',
    'echo x\v# ; P',
    'echo x\u00A0# ; P',
    'echo x\u2028# ; P',
    'cat <<EOF\r\nx\nEOF\r\nP\nEOF\n',
  ]),
)('only a space or a tab ends a word: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).not.toBeNull()
})

it.each(
  shellRuns([
    'cat <<"E\\"F"\nbody\nE"F\nP\n',
    'cat <<$\'E\'\nbody\nE\nP\n',
    'cat <<$(x)\nfoo\n$(x)\nP\n$\n',
    'cat <<E\'O\'F\nx\nEOF\nP',
    'cat <<\\EOF\nit\'s\nEOF\nP #\'',
    'cat <<E\'O\'F\nit\'s\nEOF\nP #\'',
    'cat <<"E\\"F"\nit\'s\nE"F\nP #\'',
    'cat <<$\'E\'\nit\'s\nE\nP #\'',
    'cat <<$(x)\nit\'s\n$(x)\nP #\'',
    'cat <<END-MSG\nit\'s\nEND-MSG\nP #\'',
    'cat <<1\nit\'s\n1\nP #\'',
    'cat <<EOF>f\nit\'s\nEOF\nP #\'',
  ]),
)('a here-document delimiter outside the strict form is not read past: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).not.toBeNull()
})

it.each(
  shellRuns([
    'cat <<EOF\n$(echo \\) ; P)\nEOF',
    'cat <<EOF\n$(case x in x) P;; esac)\nEOF',
    'cat <<EOF\n$(true # )\nP)\nEOF',
    'cat <<EOF\n$(cat <<X\n)\nX\nP\n)\nEOF',
    'cat <<EOF\nit\'s $(case x in x) P;; esac)\nEOF #\'',
    'cat <<E\nx\\\nE\nit\'s\nE\nP #\'',
    'cat <<-E\n\tx\\\n\tE\nit\'s\nE\nP #\'',
    'cat <<EOF\nit\'s $(P) #\'',
    'cat <<EOF\nit\'s `P` #\'',
  ]),
)('a substitution in an unquoted here-document body is read as a command list: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).not.toBeNull()
})

it.each(
  shellRuns([
    '$(cat <<EOF)\nP\nEOF',
    '`cat <<EOF`\nP\nEOF',
    '( cat <<EOF )\nit\'s\nEOF\nP #\'',
    'cat <<EOF\nit\'s\nEOF\necho $(cat <<X\n); P\nX\n) #\'',
    'echo "$( (true); P )"',
    'echo "$( (true) ; P)"',
    'echo "$(case x in x) P;; esac)"',
    'echo "$(case x in (x) P;; esac)"',
    'echo "$((echo a) ; P)"',
    'echo "$( ( echo a ) # it\'s\nP #\'\n)"',
  ]),
)('a here-document or a parenthesis inside a substitution does not move where it ends: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).not.toBeNull()
})

it.each(
  shellRuns([
    'a[1<<2]=x\nP',
    'a[1<<2]=x; cat <<EOF\nit\'s\nEOF\nP #\'',
    'a[1<< x ]=y\nP\nx',
    'echo a[1<<2]\nit\'s\n2]\nP #\'',
  ]),
)('a shift in an array subscript is not a here-document: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).not.toBeNull()
})

it.each(
  shellRuns([
    'echo "((" # it\'s\nP #\'',
    'echo $((1)); cat <<EOF\nit\'s\nEOF\nP #\'',
    'echo $${ # it\'s\nP #\'',
    'cat \\<<<EOF\nit\'s\nEOF\nP #\'',
    '(echo x)# it\'s\nP #\'',
    'echo $(( 1 )) # it\'s\nP #\'',
    '(( 1 )) # it\'s\nP #\'',
    'echo $[1] # it\'s\nP #\'',
    'echo $((1<<2)); cat <<EOF\nit\'s\nEOF\nP #\'',
    '((1<<2)); cat <<EOF\nit\'s\nEOF\nP #\'',
  ]),
)('arithmetic and parameter expansion end where the shell ends them: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).not.toBeNull()
})

it.each([
  '"$x \\git push"',
  '"${x#y} \\git push"',
  '"${x#y}\\git push"',
  '"\\git push${x#y}"',
  '$x push',
  '$(echo git) push',
  '`echo git` push',
  '$\'\\x67it\' push',
  '$"git" push',
  'sudo $x push',
  'bash -c "$x push"',
  'eval "$x"',
])('a command word that comes from an expansion is denied: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).toBe('command word comes from an expansion')
})

it.each([
  'FOO=$x pnpm lint',
  'echo $x',
  'PATH="$HOME/bin:$PATH" pnpm -s test',
  '\'$x\' push',
  'git commit -m "$(date)"',
])('an expansion outside the command word is allowed: %j', (cmd) => {
  expect(deniedBy(cmd, DENY)).toBeNull()
})

it.each(['\\git push${x#y}', 'git push$x', 'git $x', 'git pu$(echo sh)', 'g$x push'])(
  'an argument an expansion could complete into a denied command is denied: %j',
  (cmd) => {
    expect(deniedBy(cmd, DENY)).not.toBeNull()
  },
)

it.each(['${x#y} \\git push', '${x#y}\\git push', '! \\r ; ${x% } \\git push #c && ]'])(
  'an expansion before git push in the command word is denied: %j',
  (cmd) => {
    expect(deniedBy(cmd, DENY)).toBe('command word comes from an expansion')
  },
)

describe('rm operands are folded before matching', () => {
  it.each([
    ['rm -rf //', 'rm -rf /'],
    ['rm -rf /./', 'rm -rf /'],
    ['rm -rf /.', 'rm -rf /'],
    ['rm -rf //*', 'rm -rf /*'],
    ['rm -rf ~/.', 'rm -rf ~'],
    ['rm -rf ~//', 'rm -rf ~'],
    ['rm -rf ~/*', 'rm -rf ~/*'],
    ['rm -rf ~/', 'rm -rf ~/'],
  ])('denies %j', (cmd, pattern) => {
    expect(deniedBy(cmd, DEFAULT_DENY)).toBe(pattern)
  })

  it.each(['rm -rf ./dist', 'rm -rf ~/tmp/x', 'rm -rf /tmp/build'])('allows %j', (cmd) => {
    expect(deniedBy(cmd, DEFAULT_DENY)).toBeNull()
  })
})
