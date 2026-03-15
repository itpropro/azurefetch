import { getDefaultAzureCredentialToken } from "./default-credential";
import { setDefaultTokenLoader } from "./internal/default-token-loader";

setDefaultTokenLoader(getDefaultAzureCredentialToken);

export * from "./index";
export { getDefaultAzureCredentialToken } from "./default-credential";
export { DefaultAzureCredential } from "./default-azure-credential";
