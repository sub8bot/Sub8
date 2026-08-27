export type AgentId = string;
export type ChannelId = string;

export interface AgentProfile {
  name: string;
  description: string;
  title?: string;
  avatarShape?: string;
  avatarColor?: string;
  namedBy?: string;
}

export interface GroupJson {
  version: 1;
  memberIds: AgentId[];
}

export interface AutomationJson {
  name: string;
  prompt: string;
  schedule?: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
}
