CREATE TABLE cue_workspace_repo (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES cue_workspace(id) ON DELETE CASCADE,
  github_id bigint NOT NULL UNIQUE,
  full_name text NOT NULL,
  credential text NOT NULL,
  auto_merge boolean NOT NULL DEFAULT false,
  hook_id bigint,
  last_event_at timestamptz,
  last_result text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cue_workspace_repo_workspace ON cue_workspace_repo(workspace_id);
