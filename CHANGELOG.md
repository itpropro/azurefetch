# Changelog

## [0.6.0](https://github.com/itpropro/azurefetch/compare/v0.5.0...v0.6.0) (2026-10-24)


### ⚠ BREAKING CHANGES

* **core:** cover the data-tables entity operations in TableClient ([#55](https://github.com/itpropro/azurefetch/issues/55))
* **core:** entity property values extend beyond JSON primitives, and typed service properties decode into Date, bigint, Uint8Array and { value, type: 'Guid' }. Reads return TableEntityResult instead of TableEntity: it carries etag and timestamp, and a projection may omit its keys and timestamp. TableEntityResponse, TableGetEntityResponse and TableEntityPage use it. Table requests ask for odata=minimalmetadata, and entity reads reject responses without odata.etag.

### Features

* **core:** close the remaining Azure Identity gaps ([#54](https://github.com/itpropro/azurefetch/issues/54)) ([fea1041](https://github.com/itpropro/azurefetch/commit/fea1041b328681f79be266960e43f4ad6a3bdeb9))
* **core:** cover the data-tables entity operations in TableClient ([b75fc53](https://github.com/itpropro/azurefetch/commit/b75fc534ed72223fe2536675e517a480e2603130)), closes [#53](https://github.com/itpropro/azurefetch/issues/53)
* **core:** cover the data-tables entity operations in TableClient ([#55](https://github.com/itpropro/azurefetch/issues/55)) ([3968c21](https://github.com/itpropro/azurefetch/commit/3968c2127d99b081fd050956d604332eeaefa20d))
* **core:** honor getToken options in credentials ([ed7d1ad](https://github.com/itpropro/azurefetch/commit/ed7d1ada4a27c9c193b56199aedac228937677cc)), closes [#50](https://github.com/itpropro/azurefetch/issues/50)
* **core:** read certificate and password sources in the default chain ([7173627](https://github.com/itpropro/azurefetch/commit/7173627b695f1e834a444caf279c9100a977d9c6)), closes [#52](https://github.com/itpropro/azurefetch/issues/52)
* **core:** retry transient failures with backoff and wait hints ([769d651](https://github.com/itpropro/azurefetch/commit/769d651fe30a8641168bc8800f2a9c6e19d81522)), closes [#51](https://github.com/itpropro/azurefetch/issues/51)
* **core:** return entity etags from writes and merge upserts ([4f8ce72](https://github.com/itpropro/azurefetch/commit/4f8ce721aea2e7da9f77d3ccce8d47b505566004))
* **core:** return entity etags from writes and merge upserts ([#58](https://github.com/itpropro/azurefetch/issues/58)) ([b9015c2](https://github.com/itpropro/azurefetch/commit/b9015c28a1bfde5d40956f4ffb3151fe0e43008c))
* **core:** sign client certificate assertions with Web Crypto ([64319f2](https://github.com/itpropro/azurefetch/commit/64319f217e28b73fa03f48243c8080ad64a4e05d)), closes [#52](https://github.com/itpropro/azurefetch/issues/52)


### Bug Fixes

* **core:** keep a property named __proto__ in table entities ([891ad6a](https://github.com/itpropro/azurefetch/commit/891ad6ad3fa7c787b4ac4904ee238de955a626bf)), closes [#53](https://github.com/itpropro/azurefetch/issues/53)
* **core:** keep a valid cached token when its refresh fails ([b0e0982](https://github.com/itpropro/azurefetch/commit/b0e098202192b949edda80c3b689f5f2283c6f6a)), closes [#49](https://github.com/itpropro/azurefetch/issues/49)
* **core:** key default credential tokens by the effective tenant ([208e6d5](https://github.com/itpropro/azurefetch/commit/208e6d5b732841d03ac66cb8561ab9426759165d)), closes [#50](https://github.com/itpropro/azurefetch/issues/50)
* **core:** name the claims call's tenant in re-login commands ([bb2835d](https://github.com/itpropro/azurefetch/commit/bb2835d96624253b2c5a8cf58d969b05498da96f)), closes [#50](https://github.com/itpropro/azurefetch/issues/50)
* **core:** stop retries for cancellation and unbuildable requests ([9f31dd6](https://github.com/itpropro/azurefetch/commit/9f31dd6aac9539be80e3eb37ef55f6a07cfece33)), closes [#51](https://github.com/itpropro/azurefetch/issues/51)

## [0.5.0](https://github.com/itpropro/azurefetch/compare/v0.4.0...v0.5.0) (2026-10-24)


### Features

* **core:** add client secret and workload identity credentials ([537272f](https://github.com/itpropro/azurefetch/commit/537272fa415078c2c32e1dd65887c9df81911946))
* **core:** add client secret and workload identity credentials ([#44](https://github.com/itpropro/azurefetch/issues/44)) ([6ba3efc](https://github.com/itpropro/azurefetch/commit/6ba3efcd5ddfb24a83b236d2d9f911c1f23febf0))

## [0.4.0](https://github.com/itpropro/azurefetch/compare/v0.3.2...v0.4.0) (2026-10-24)


### ⚠ BREAKING CHANGES

* **core:** AppConfigurationPageSettings, KeyVaultPageSettings and ListPropertiesOptions were removed in the Key Vault and App Configuration commit; use PageSettings and KeyVaultRequestOptions. AzureRequestError no longer carries the parsed service error body as its cause.
* **core:** TableListEntitiesOptions was removed in the previous Table commit; use ListOptions. Failed transactions report the status of the failed sub-response without a service error code.
* **core:** KeyVaultRequestError and AppConfigurationRequestError are replaced by AzureRequestError. App Configuration drops the fields, acceptDateTime and tagsFilter options, the page etag and response, and the camelCase response fallbacks. Key Vault drops maxPageSize and the page response; SetSecretOptions/UpdateSecretPropertiesOptions become SecretAttributesOptions and the page types become SecretPage.
* **core:** BlobServiceClientOptions, ParsedConnectionString, BlobBatchDeleteBlobOptions and BlobItem.metadata were removed in the previous Blob commit; use StorageClientOptions and BlobDeleteOptions.
* **core:** TableClient is constructed with (tableUrl, credential, options), TableClient.list, TableServiceClient.request, the update mode parameters and nextPartitionKey/nextRowKey are removed, entity keys must use partitionKey/rowKey, entity properties are JSON primitives, transaction actions are one TableTransactionAction union, convenience results no longer include the Response, upsertEntity returns nothing, and the convenience request options are reduced to uploadText's contentType.
* **core:** AccountSASPermissions, getAccountNameFromUrl, BlockBlobClient.downloadToBuffer/exists, ContainerClient.deleteBlob/ getBlobBatchClient, BlobServiceClient.request and BlobBatch are removed. Batch deletes use BlobBatchClient.deleteBlobs(urls, options) and return { status, errorCode } per sub-request. BlockBlobClient.upload no longer takes a content length, list pages no longer carry nextMarker, client constructors take (url, credential, options), StorageSharedKeyCredential no longer exposes accountKey, and ES2023 array methods are required.
* **core:** shouldRefreshToken, getAuthorizationHeader, createTokenProvider and the TokenProvider/TokenReuseOptions types are no longer exported, AzureClient.sign is removed, getManagedIdentityToken no longer accepts probeTimeoutMs, and Deno 1 is no longer supported for developer credentials.

### Bug Fixes

* **core:** accept trailing-slash table URLs and surface other conflicts ([af97977](https://github.com/itpropro/azurefetch/commit/af979770e8c87c16853e2cec5275b9f70d327fe4)), closes [#38](https://github.com/itpropro/azurefetch/issues/38)
* **core:** fix credential sources and simplify their plumbing ([da681a0](https://github.com/itpropro/azurefetch/commit/da681a0189e169c2772fa5f18a732c54551fd5df)), closes [#38](https://github.com/itpropro/azurefetch/issues/38)
* **core:** keep batch deletes inside the client's account ([82e0f63](https://github.com/itpropro/azurefetch/commit/82e0f63cd0d7bb47ca316cb33ee6bfef1b9c7a0a)), closes [#38](https://github.com/itpropro/azurefetch/issues/38)
* **core:** keep blob names and secret listings in their own scope ([2d1002d](https://github.com/itpropro/azurefetch/commit/2d1002de91a4b649c98b6023a8d0e46cc4f0a585)), closes [#38](https://github.com/itpropro/azurefetch/issues/38)
* **core:** keep credential failures that occur after the response headers ([2ce8e5d](https://github.com/itpropro/azurefetch/commit/2ce8e5dab2b9b29b41665af623fbc4d6fdd34b4a)), closes [#38](https://github.com/itpropro/azurefetch/issues/38)
* **core:** move Table onto shared storage plumbing ([d7740f7](https://github.com/itpropro/azurefetch/commit/d7740f7019341edb6551b1f1c3734907f61fecc7)), closes [#38](https://github.com/itpropro/azurefetch/issues/38)
* **core:** sanitize malformed token responses and keep vault path prefixes ([f272f55](https://github.com/itpropro/azurefetch/commit/f272f55e0d447147b766838da191f54187c3cccb)), closes [#38](https://github.com/itpropro/azurefetch/issues/38)
* **core:** share errors and paging across Key Vault and App Config ([5bba823](https://github.com/itpropro/azurefetch/commit/5bba8232e32115e3d542f9f8f881910d5b279b1c)), closes [#38](https://github.com/itpropro/azurefetch/issues/38)
* **core:** share storage request plumbing and slim the Blob API ([f009be1](https://github.com/itpropro/azurefetch/commit/f009be14686b1c42d7bc78a1542ff01857835a94)), closes [#38](https://github.com/itpropro/azurefetch/issues/38)

## [0.3.2](https://github.com/itpropro/azurefetch/compare/v0.3.1...v0.3.2) (2026-08-25)


### Bug Fixes

* **release:** harden npm publication boundary ([#36](https://github.com/itpropro/azurefetch/issues/36)) ([4d83f4c](https://github.com/itpropro/azurefetch/commit/4d83f4c34e2cc6a23904dec1d53765b48f82b909))

## [0.3.1](https://github.com/itpropro/azurefetch/compare/v0.3.0...v0.3.1) (2026-08-25)


### Bug Fixes

* **release:** declare npm provenance repository ([#29](https://github.com/itpropro/azurefetch/issues/29)) ([a503299](https://github.com/itpropro/azurefetch/commit/a503299c27a730867097603ee395040fa29e49b0))
* **release:** ignore generated changelog formatting ([#26](https://github.com/itpropro/azurefetch/issues/26)) ([a8ae05e](https://github.com/itpropro/azurefetch/commit/a8ae05e33a16a83f5ec747d1d10044b50a303b99))
* **release:** parse npm 12 pack output ([#28](https://github.com/itpropro/azurefetch/issues/28)) ([fc1d2af](https://github.com/itpropro/azurefetch/commit/fc1d2affc3041238fb22a1ad7eb48dc994a19914))

## [0.3.0](https://github.com/itpropro/azurefetch/compare/v0.2.0...v0.3.0) (2026-08-25)


### Features

* **core:** add bounded developer authentication ([#22](https://github.com/itpropro/azurefetch/issues/22)) ([46a3473](https://github.com/itpropro/azurefetch/commit/46a34737a3502d9bfe11f42f80cce9c540506e59)), closes [#19](https://github.com/itpropro/azurefetch/issues/19)

## [0.2.0](https://github.com/itpropro/azurefetch/compare/v0.1.0...v0.2.0) (2026-08-25)

### Features

- **core:** Updated package name to azurefetch ([6ea7d03](https://github.com/itpropro/azurefetch/commit/6ea7d038e868d3b59f8c844dc57d4c711cee8353))

### Bug Fixes

- **core:** canonicalize zero-byte storage requests ([ec18031](https://github.com/itpropro/azurefetch/commit/ec180313ea0a53c3a97e15bf88a99bb1304477cf))
- **core:** implement atomic table transactions ([98fe18b](https://github.com/itpropro/azurefetch/commit/98fe18b552eb461304eb36c0496fd965b568fbf1))
- **core:** merge authentication hardening ([5649d70](https://github.com/itpropro/azurefetch/commit/5649d70f8fad962458a6ec684a36bfa0f95e712e))
- **core:** merge storage protocol corrections ([23c9d9c](https://github.com/itpropro/azurefetch/commit/23c9d9ca34f04bc8d7960689af122214240bfa0e))
- **core:** require HTTPS credential endpoints ([b32f2e0](https://github.com/itpropro/azurefetch/commit/b32f2e005425c383d6d9ffdafc3686dddfba8353))
- **core:** restrict Key Vault continuation origins ([0f729f8](https://github.com/itpropro/azurefetch/commit/0f729f8aae9d67803fcaca4f6c525a70a373223e))
- **core:** retain App Configuration sync tokens ([7dca503](https://github.com/itpropro/azurefetch/commit/7dca503f7929f48b9b5fe46cfa9a45c2fd066afb))
- **core:** sign account SAS URLs ([e816bab](https://github.com/itpropro/azurefetch/commit/e816babfd61e8b07d3cf53bb039cc5e6476c1bc0))
- **core:** support standard Azure access tokens ([f216023](https://github.com/itpropro/azurefetch/commit/f2160237803eba9a59df529fde063a159be14e78))
- **deps:** merge consistency and dependency safety ([91c94bb](https://github.com/itpropro/azurefetch/commit/91c94bbde4081af292845240ae4245ca7766617c))
- **deps:** resolve development advisories ([5ba1fee](https://github.com/itpropro/azurefetch/commit/5ba1fee5f836019f9b2b2c9f35c6d82afce0b2aa))
- harden Azure request and storage semantics ([e7a3c97](https://github.com/itpropro/azurefetch/commit/e7a3c97f04f5cf684234d4f92df384e1924a999b))
- **managed-identity:** support valid IMDS token requests ([5169f77](https://github.com/itpropro/azurefetch/commit/5169f776cc1828df87e3f66bda8d9164321ce6db))

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
