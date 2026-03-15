interface ContinuationState {
  partitionKey: string;
  rowKey: string;
}

export function encodeContinuationToken(state: ContinuationState): string {
  const params = new URLSearchParams();
  params.set("NextPartitionKey", state.partitionKey);
  params.set("NextRowKey", state.rowKey);
  return params.toString();
}

export function parseContinuationToken(token: string | undefined): ContinuationState | undefined {
  if (token == null || token.length === 0) {
    return undefined;
  }

  const params = new URLSearchParams(token);
  const partitionKey = params.get("NextPartitionKey");
  const rowKey = params.get("NextRowKey");

  if (partitionKey == null || rowKey == null) {
    return undefined;
  }

  return { partitionKey, rowKey };
}
