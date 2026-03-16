module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-empty": [2, "never"],
    "scope-enum": [
      2,
      "always",
      [
        "build",
        "ci",
        "config",
        "core",
        "deps",
        "docs",
        "managed-identity",
        "provider",
        "readme",
        "release",
        "service-principal",
        "tests",
      ],
    ],
    "subject-max-length": [2, "always", 71],
    "subject-case": [0, "always", "sentence-case"],
  },
};
