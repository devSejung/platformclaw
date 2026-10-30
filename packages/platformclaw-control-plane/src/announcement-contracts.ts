export const ANNOUNCEMENTS_PATH = "/platformclaw/api/announcements";
export const ANNOUNCEMENTS_ADMIN_PATH = "/platformclaw/api/admin/announcements";
export const ANNOUNCEMENTS_HISTORY_PATH = `${ANNOUNCEMENTS_ADMIN_PATH}/history`;
export const ANNOUNCEMENTS_CHANGED = "platformclaw.announcements.invalidated";

export type WebAnnouncement = {
  id: string;
  revision: number;
  title: string;
  body: string;
  kind: "general" | "maintenance";
  maintenanceAt: number | null;
  expiresAt: number;
};

export type AnnouncementSnapshot = {
  revision: number;
  serverNow: number;
  announcement: WebAnnouncement | null;
};

export type AnnouncementAdministrationSnapshot = AnnouncementSnapshot & {
  current: (WebAnnouncement & { cancelled: boolean }) | null;
};

export type AnnouncementHistoryCursor = { occurredAt: number; id: string };

export type AnnouncementHistoryEntry = {
  id: string;
  announcementId: string;
  revision: number;
  action: "publish" | "update" | "cancel";
  occurredAt: number;
  announcement: (WebAnnouncement & { cancelled: boolean }) | null;
};

export type AnnouncementHistoryPage = {
  items: AnnouncementHistoryEntry[];
  nextCursor: AnnouncementHistoryCursor | null;
};
