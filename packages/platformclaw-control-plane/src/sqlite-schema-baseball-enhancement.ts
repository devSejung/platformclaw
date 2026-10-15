export const BASEBALL_ENHANCEMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS baseball_bat_enhancements (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 20),
  status TEXT NOT NULL CHECK (status IN ('ready', 'broken')),
  equipped INTEGER NOT NULL CHECK (equipped IN (0, 1)),
  version INTEGER NOT NULL CHECK (version = 1),
  CHECK (status <> 'broken' OR level = 0)
) STRICT;
CREATE TABLE IF NOT EXISTS baseball_team_selections (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL CHECK (team_id IN ('kia','kt','lg','nc','ssg','doosan','lotte','samsung','kiwoom','hanwha'))
) STRICT;
`;
