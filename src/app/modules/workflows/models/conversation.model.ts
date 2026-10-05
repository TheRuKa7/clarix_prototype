export interface ConversationContact {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  fallbackPhone?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

export interface ConversationToneAnalysis {
  classification?: string;
  trend?: string;
  notes?: string;
}

export interface ConversationSatisfactionScore {
  rating?: number;
  confidence?: number;
  reasoning?: string;
}

export interface ConversationSummary {
  mom?: string | string[];
  resolution?: string;
  pending_items?: string | string[];
}

export interface PostCallIntelligence {
  summary?: ConversationSummary;
  intent?: string;
  sentiment?: string;
  tone_analysis?: ConversationToneAnalysis;
  satisfaction_score?: ConversationSatisfactionScore;
  REQUIRED_DATA?: Record<string, unknown>;
}

export interface ConversationDetail {
  id: string;
  workflowExecutionId?: string;
  orgId?: string;
  stepId?: string;
  channelType?: string;
  status?: string;
  /** Which configured call provider (see CallProvider) actually placed this call. */
  providerKey?: string;
  providerSessionId?: string;
  contact?: ConversationContact;
  audioUrl?: string;
  transcriptUrl?: string;
  /** Plain-text transcript for providers (e.g. Exchange) that send it inline, not as a fetchable URL. */
  transcriptText?: string;
  durationSeconds?: number;
  cost?: number;
  extractedFields?: Record<string, unknown>;
  postCallIntelligence?: PostCallIntelligence;
  providerRequestPayload?: Record<string, unknown>;
  providerWebhookPayload?: Record<string, unknown>;
  startedAt?: string;
  endedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TranscriptMessage {
  speaker: string;
  text: string;
  time?: string;
  isUser: boolean;
}
