export interface Message {
  role: 'user' | 'model' | 'system';
  content: string;
  timestamp: Date;
}

export interface ChatSession {
  id: string;
  history: Message[];
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Document Extraction Event Types
// ============================================================================

export interface StepEvent {
  type: 'step';
  name: string;
  status: 'running' | 'completed' | 'failed';
}

export interface LogEvent {
  type: 'log';
  message: string;
}

export interface StreamEvent {
  type: 'stream';
  content: string;
}

export interface ResultEvent {
  type: 'result';
  url: string;
}

export type RealmGenerationEvent =
  | StepEvent
  | LogEvent
  | StreamEvent
  | ResultEvent;
