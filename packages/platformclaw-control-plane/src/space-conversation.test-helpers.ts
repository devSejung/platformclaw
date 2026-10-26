import type { SpaceConversation } from "./space-contracts.js";
import type { createSpaceTestFixture } from "./spaces.test-fixtures.js";

type Fixture = Awaited<ReturnType<typeof createSpaceTestFixture>>;
export async function createSpaceTestConversation(
  f: Fixture,
  actor = f.alice,
  requestId = "own-tab",
) {
  return f.proxy.request<SpaceConversation>(
    actor.token,
    "platformclaw.spaces.conversation.create",
    {
      spaceId: f.space.id,
      pageId: f.page.id,
      title: `${actor.token} work`,
      requestId,
    },
  );
}
