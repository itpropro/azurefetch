export { AzureClient } from "./client";
export type { AzureClientOptions, AzureRequestInit, AzureRequestOverrides } from "./client";
export type { AccessToken, TokenReuseOptions, TokenProvider } from "./types";
export { shouldRefreshToken, getAuthorizationHeader } from "./token";
export { createTokenProvider } from "./provider";
export { getServicePrincipalToken } from "./service-principal";
export { getManagedIdentityToken } from "./managed-identity";
export { AzureFetchError, TokenUnavailableError, TokenRequestError } from "./errors";
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
