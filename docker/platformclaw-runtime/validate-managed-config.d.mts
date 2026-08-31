export declare const REQUIRED_MANAGED_PLUGIN_IDS: string[];
export declare const REQUIRED_MANAGED_AGENT_TOOL_IDS: string[];
export declare const REQUIRED_MANAGED_SANDBOX_TOOL_IDS: string[];
export declare const PLATFORMCLAW_REALTIME_IDENTITY_INSTRUCTION: string;

export declare function validateManagedConfig(
  config: unknown,
  sandboxImage: string,
  skillHubEnabled?: boolean,
): void;
export declare function sandboxPolicyDeniesBundleMcp(sandboxTools: unknown): boolean;
