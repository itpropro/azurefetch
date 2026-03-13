# Changelog

## Unreleased

### Added

- Added `getDefaultAzureCredentialToken` as a minimal default Azure credential chain with ordered fallback:
  managed identity, environment service principal, Azure CLI, and Azure PowerShell.
- Added cross-environment command execution helper used by CLI and PowerShell token acquisition.
- Added coverage for default credential orchestration and command fallbacks in tests.
