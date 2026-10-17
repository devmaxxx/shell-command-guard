// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'lib',
  },
  {
    // Test inputs are shell command lines, where `${x}` is parameter expansion, not a misplaced template literal.
    files: ['test/**/*.ts'],
    rules: {
      'no-template-curly-in-string': 'off',
    },
  },
)
