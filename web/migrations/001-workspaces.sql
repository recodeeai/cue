CREATE TABLE cue_workspace (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('personal', 'team')),
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cue_workspace_personal_owner ON cue_workspace(owner_id) WHERE kind = 'personal';
CREATE INDEX cue_workspace_owner ON cue_workspace(owner_id);
CREATE TABLE cue_workspace_member (
  workspace_id uuid NOT NULL REFERENCES cue_workspace(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX cue_workspace_member_user ON cue_workspace_member(user_id);
CREATE UNIQUE INDEX cue_workspace_one_owner ON cue_workspace_member(workspace_id) WHERE role = 'owner';
CREATE TABLE cue_workspace_invite (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES cue_workspace(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cue_workspace_invite_workspace ON cue_workspace_invite(workspace_id);
