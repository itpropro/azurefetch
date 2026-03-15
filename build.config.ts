import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/node.ts",
        "./src/blob.ts",
        "./src/table.ts",
        "./src/client.ts",
        "./src/convenience.ts",
        "./src/default-credential.ts",
        "./src/default-azure-credential.ts",
        "./src/errors.ts",
        "./src/managed-identity.ts",
        "./src/provider.ts",
        "./src/service-principal.ts",
        "./src/storage-shared-key-credential.ts",
        "./src/token.ts",
      ],
    },
  ],
});
