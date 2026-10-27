export type VerificationStatus = 'unverified' | 'verified' | 'conflicting' | 'inferred';

export interface SessionInfo {
  ownerId: string;
  displayName: string;
  email: string;
  role: string;
  deviceId: string | null;
  authMethod: string;
  expiresAt: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  status: string;
  pinned: number | boolean;
  created_at: string;
  updated_at: string;
  last_seq: number;
  message_count: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  client_message_id: string | null;
  device_id: string | null;
  created_at: string;
}

export interface Mission {
  id: string;
  title: string;
  goal: string | null;
  state: string;
  budget_limit: number | null;
  budget_spent: number;
  budget_reserved: number;
  budget_currency: string;
  executions: number;
  max_executions: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface MissionTask {
  id: string;
  title: string;
  state: string;
  deps: string;
  attempts: number;
  max_attempts: number;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
}

export interface Approval {
  id: string;
  mission_id: string | null;
  task_id: string | null;
  action: string;
  resource: string;
  params: string;
  scope: string;
  fingerprint: string;
  status: string;
  decision: string | null;
  created_at: string;
  expires_at: string;
}

export interface Device {
  id: string;
  name: string | null;
  platform: string | null;
  status: string;
  created_at: string;
  last_seen_at: string | null;
}

export interface Change {
  id: string;
  cursor: number;
  type: string;
  payload: string;
  received_at: string;
}
