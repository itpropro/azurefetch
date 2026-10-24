import { defineCommitlintConfig } from '@visorian/code-standards/commitlint'

export default defineCommitlintConfig({
  scopes: [
    'build',
    'ci',
    'config',
    'core',
    'deps',
    'docs',
    'managed-identity',
    'provider',
    'readme',
    'release',
    'service-principal',
    'tests',
  ],
})
