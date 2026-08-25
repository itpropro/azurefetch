import "./configure-default-token-loader";

export { AzureClient } from "./client";
export type { AzureClientOptions, AzureRequestInit, AzureRequestOverrides } from "./client";
export type { AccessToken, TokenReuseOptions, TokenProvider } from "./types";
export { shouldRefreshToken, getAuthorizationHeader } from "./token";
export { createTokenProvider } from "./provider";
export { getServicePrincipalToken } from "./service-principal";
export { getManagedIdentityToken } from "./managed-identity";
export { getDefaultAzureCredentialToken, getDeveloperAzureCredentialToken } from "./default-credential";
export type { DeveloperAzureCredentialOptions } from "./default-credential";
export { DefaultAzureCredential } from "./default-azure-credential";
export type { DefaultAzureCredentialOptions } from "./default-azure-credential";
export { AzureFetchError, TokenUnavailableError, TokenRequestError } from "./errors";
export * from "./blob";
export * from "./table";
export { AppConfigurationClient, AppConfigurationRequestError } from "./app-configuration";
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
} from "./app-configuration";
export { KeyVaultRequestError, KeyVaultSecretClient } from "./keyvault-secrets";
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
} from "./keyvault-secrets";
export { uploadText, downloadText, downloadJson, getEntity, upsertEntity, listEntitiesPage } from "./convenience";
export type {
  BlobDownloadJsonResponse,
  BlobDownloadTextResponse,
  BlobUploadTextOptions,
  TableEntityPage,
  TableGetEntityResponse,
  TableListEntitiesOptions,
  TableUpsertEntityResponse,
} from "./convenience";
