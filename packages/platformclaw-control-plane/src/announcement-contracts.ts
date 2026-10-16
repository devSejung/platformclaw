export const ANNOUNCEMENTS_PATH = "/platformclaw/api/announcements";
export const ANNOUNCEMENTS_ADMIN_PATH = "/platformclaw/api/admin/announcements";
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
