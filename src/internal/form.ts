export interface FormValue {
  key: string;
  value: string;
}

export function toFormUrlEncoded(values: FormValue[]): string {
  return values.map(({ key, value }) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

export function toFormEntries(record: Record<string, string | undefined>): FormValue[] {
  return Object.entries(record)
    .filter(([, value]): value is string => value !== undefined)
    .map(([key, value]) => ({
      key,
      value,
    }));
}
