export declare function reconcileManagedConfig<T>(
  config: T,
  sandboxImage: string,
  skillHubEnabled?: boolean,
): { config: T; changed: boolean };
