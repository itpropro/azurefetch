# Changelog

## v0.1.0

[compare changes](https://github.com/itpropro/azurefetch/compare/v0.0.2...v0.1.0)

### 🚀 Enhancements

- **core:** ⚠️ Move default credentials to root export ([5ff0f1a](https://github.com/itpropro/azurefetch/commit/5ff0f1a))

#### ⚠️ Breaking Changes

- **core:** ⚠️ Move default credentials to root export ([5ff0f1a](https://github.com/itpropro/azurefetch/commit/5ff0f1a))

### ❤️ Contributors

- Jan-Henrik Damaschke ([@itpropro](https://github.com/itpropro))

## v0.0.2

### 🚀 Enhancements

- **managed-identity:** Add default credential chain ([e7a6982](https://github.com/itpropro/azurefetch/commit/e7a6982))
- **core:** Expand blob compatibility coverage ([7872865](https://github.com/itpropro/azurefetch/commit/7872865))
- **core:** Cache tokens and add table coverage ([545a0c2](https://github.com/itpropro/azurefetch/commit/545a0c2))
- **core:** Add standalone storage benchmark ([da77fa7](https://github.com/itpropro/azurefetch/commit/da77fa7))
- **core:** Introduce shared request client layer ([6dbae50](https://github.com/itpropro/azurefetch/commit/6dbae50))
- **core:** Split edge-safe runtime entrypoints ([766c590](https://github.com/itpropro/azurefetch/commit/766c590))
- **core:** Add key vault secrets client ([db42ef1](https://github.com/itpropro/azurefetch/commit/db42ef1))
- **core:** Add app configuration and simplify public exports ([4bb5feb](https://github.com/itpropro/azurefetch/commit/4bb5feb))

### 🏡 Chore

- **config:** Initial setup ([d1bfda8](https://github.com/itpropro/azurefetch/commit/d1bfda8))
- **core:** Expand gitignore patterns ([40db9cc](https://github.com/itpropro/azurefetch/commit/40db9cc))
- **core:** Refine gitignore coverage ([6e24c54](https://github.com/itpropro/azurefetch/commit/6e24c54))

### ✅ Tests

- **core:** Add blob edge-case compatibility tests ([522285e](https://github.com/itpropro/azurefetch/commit/522285e))

### ❤️ Contributors

- Jan-Henrik Damaschke ([@itpropro](https://github.com/itpropro))

## Unreleased

### Added

- Added `getDefaultAzureCredentialToken` as a minimal default Azure credential chain with ordered fallback:
  managed identity, environment service principal, Azure CLI, and Azure PowerShell.
- Added cross-environment command execution helper used by CLI and PowerShell token acquisition.
- Added coverage for default credential orchestration and command fallbacks in tests.
