export type SpaceRole = "viewer" | "editor" | "owner";
export type Space = {
  id: string;
  name: string;
  role: SpaceRole;
  revision: number;
  agentId: string;
};
export type SpacePage = {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  body: string;
  revision: number;
  createdBy: string;
  updatedAt: number;
};
export type SpaceMember = {
  userId: string;
  accountId: string;
  displayName: string;
  role: SpaceRole;
};
export const SPACE_RPC_PARAMS = {
  "platformclaw.spaces.list": [],
  "platformclaw.spaces.create": ["name", "requestId"],
  "platformclaw.spaces.get": ["spaceId"],
  "platformclaw.spaces.people": ["spaceId", "query"],
  "platformclaw.spaces.member.set": ["spaceId", "userId", "role", "expectedRevision"],
  "platformclaw.spaces.member.remove": ["spaceId", "userId", "expectedRevision"],
  "platformclaw.spaces.page.create": ["spaceId", "parentId", "title", "body", "requestId"],
  "platformclaw.spaces.page.save": ["spaceId", "pageId", "title", "body", "expectedRevision"],
  "platformclaw.spaces.chat.history": ["spaceId", "pageId", "messageId"],
  "platformclaw.spaces.chat.send": ["spaceId", "pageId", "message", "requestId", "model"],
  "platformclaw.spaces.search": ["spaceId", "query"],
} as const;
export const SPACE_RPC_METHODS = Object.keys(SPACE_RPC_PARAMS) as Array<
  keyof typeof SPACE_RPC_PARAMS
>;
