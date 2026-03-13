export class AzureFetchError extends Error {
  public override readonly name = "AzureFetchError";

  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class TokenUnavailableError extends AzureFetchError {
  public override readonly name = "TokenUnavailableError";

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class TokenRequestError extends AzureFetchError {
  public override readonly name = "TokenRequestError";

  constructor(
    message: string,
    public readonly status?: number,
    public readonly errorCode?: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}
