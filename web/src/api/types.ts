export type VerificationStatus = 'unverified' | 'verified' | 'conflicting' | 'inferred';

export interface SessionInfo {
  ownerId: string;
  displayName: string;
  email: string;
  role: string;
  deviceId: string | null;
  authMethod: 'bearer' | 'cookie';
  expiresAt: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  status: string;
  pinned: number | boolean;
  created_device_id: string | null;
  last_message_at: string | null;
  last_seq: number;
  message_count: number;
  created_at: string;
  updated_at: string;
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
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decision: string | null;
  created_at: string;
  expires_at: string;
}

export interface MemoryRecord {
  id: string;
  type: string;
  content: string;
  origin: string;
  source_ref: string | null;
  excerpt: string | null;
  created: string;
  updated: string;
  confidence: number | null;
  verification_status: VerificationStatus;
  scope: string;
  sensitivity: string;
  status: string;
  content_version: number;
  integrity_hash: string | null;
  superseded_reason: string | null;
  deleted_at: string | null;
}

export interface Device {
  id: string;
  name: string | null;
  platform: string | null;
  status: string;
  created_at: string;
  last_seen_at: string | null;
}

export interface SessionRow {
  id: string;
  device_id: string | null;
  status: string;
  user_agent: string | null;
  created_at: string;
  access_expires_at: string;
  refresh_expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface Change {
  id: string;
  cursor: number;
  type: string;
  payload: string;
  received_at: string;
}
