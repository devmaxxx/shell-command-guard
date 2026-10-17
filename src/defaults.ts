/**
 * A starting deny-list for commands an unattended process should not run on its own: privilege escalation,
 * wiping the disk or the home directory, powering the machine off, and publishing work beyond the local checkout.
 *
 * Each entry is a word prefix: `'git push'` denies `git push origin main` but not `git pushd`. Extend it with
 * {@link effectiveDeny}, or pass your own list to {@link deniedBy}.
 */
export const DEFAULT_DENY: readonly string[] = [
  'sudo',
  'su',
  'doas',
  'pkexec',
  'run0',
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf ~/',
  'rm -rf ~/*',
  'rm -fr /',
  'rm -fr ~',
  'mkfs',
  'dd',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'git push',
  'git reset --hard',
  'git clean',
  'npm publish',
  'pnpm publish',
  'yarn publish',
]
