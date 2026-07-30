export declare function reconcileManagedConfig<T>(
  config: T,
  sandboxImage: string,
): { config: T; changed: boolean };
