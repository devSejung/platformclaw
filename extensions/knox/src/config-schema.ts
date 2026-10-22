import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

export const KnoxChannelConfigSchema = buildChannelConfigSchema(
  z
    .object({
      selfInSpaceEnabled: z.boolean().optional(),
      accounts: z
        .record(z.string(), z.object({ selfInSpaceEnabled: z.boolean().optional() }).passthrough())
        .optional(),
      accountId: z.string().min(1).optional(),
      webhookSecret: z.string().min(32).optional(),
      webhookSecretFile: z.string().min(1).optional(),
      outboundUrl: z.url().optional(),
      serviceToken: z.string().min(32).optional(),
      serviceTokenFile: z.string().min(1).optional(),
      controlPlaneUrl: z.url().optional(),
      progressDelayMs: z.number().int().min(1_000).max(60_000).optional(),
    })
    .passthrough(),
);
