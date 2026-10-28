export type SkillHubNotification = {
  id: string;
  kind: string;
  namespace?: string;
  slug?: string;
  message: string;
  createdAt: number;
  readAt?: number;
};

export interface SkillHubNotificationStore {
  createSkillHubNotification(params: {
    userId: string;
    kind: string;
    namespace?: string;
    slug?: string;
    message: string;
    createdAt: number;
  }): Promise<SkillHubNotification>;
  listSkillHubNotifications(userId: string, limit: number): Promise<SkillHubNotification[]>;
  countUnreadSkillHubNotifications(userId: string): Promise<number>;
  markSkillHubNotificationsRead(params: {
    userId: string;
    ids?: readonly string[];
    readAt: number;
  }): Promise<number>;
}
