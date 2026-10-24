import { defineCommitlintConfig } from '@visorian/code-standards/commitlint'

export default defineCommitlintConfig({
  scopes: [
    // release-please titles its pull requests chore(azurefetch): release vX.Y.Z
    'azurefetch',
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
