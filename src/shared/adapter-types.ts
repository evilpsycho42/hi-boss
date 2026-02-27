export const KNOWN_ADAPTER_TYPES = ["telegram"] as const;

export type KnownAdapterType = (typeof KNOWN_ADAPTER_TYPES)[number];

export function isKnownAdapterType(value: string): value is KnownAdapterType {
  return KNOWN_ADAPTER_TYPES.includes(value as KnownAdapterType);
}
