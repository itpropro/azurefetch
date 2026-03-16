import { getDefaultAzureCredentialToken } from "./default-credential";
import { setDefaultTokenLoader } from "./internal/default-token-loader";

setDefaultTokenLoader(getDefaultAzureCredentialToken);
