export { AzureClient } from './client'
export type { AzureClientOptions, AzureRequestInit, AzureRequestOverrides } from './client'
export type { AccessToken } from './types'
export { getServicePrincipalToken } from './service-principal'
export { getManagedIdentityToken } from './managed-identity'
export {
  getDefaultAzureCredentialToken,
  getDeveloperAzureCredentialToken,
} from './default-credential'
export type { DeveloperAzureCredentialOptions } from './default-credential'
export { DefaultAzureCredential } from './default-azure-credential'
export type { DefaultAzureCredentialOptions } from './default-azure-credential'
export { AzureFetchError } from './errors'
export { TokenRequestError } from './token-request-error'
export { TokenUnavailableError } from './token-unavailable-error'
export { AzureRequestError } from './azure-request-error'
export * from './blob'
export * from './table'
export { AppConfigurationClient, AppConfigurationRequestError } from './app-configuration'
export type {
  AppConfigurationClientOptions,
  AppConfigurationPageSettings,
  ConfigurationSetting,
  ConfigurationSettingField,
  ConfigurationSettingPage,
  DeleteConfigurationSettingOptions,
  GetConfigurationSettingOptions,
  ListConfigurationSettingsOptions,
  SetConfigurationSettingOptions,
} from './app-configuration'
export { KeyVaultRequestError, KeyVaultSecretClient } from './keyvault-secrets'
export type {
  DeletedSecret,
  DeletedSecretPage,
  GetSecretOptions,
  KeyVaultClientOptions,
  KeyVaultPageSettings,
  KeyVaultRequestOptions,
  KeyVaultSecret,
  ListPropertiesOptions,
  SecretProperties,
  SecretPropertiesPage,
  SetSecretOptions,
  UpdateSecretPropertiesOptions,
} from './keyvault-secrets'
export {
  uploadText,
  downloadText,
  downloadJson,
  getEntity,
  upsertEntity,
  listEntitiesPage,
} from './convenience'
export type {
  BlobDownloadJsonResponse,
  BlobDownloadTextResponse,
  BlobUploadTextOptions,
  TableEntityPage,
  TableGetEntityResponse,
} from './convenience'
