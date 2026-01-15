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
// Agentic Doctor Event Types
// ============================================================================

export type RealmGenerationEventType =
  | 'step'
  | 'log'
  | 'stream'
  | 'thought'
  | 'tool_call'
  | 'tool_result'
  | 'progress'
  | 'result';

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

export interface ThoughtEvent {
  type: 'thought';
  content: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: 'tool_result';
  name: string;
  result: string;
}

export interface ProgressEvent {
  type: 'progress';
  iteration: number;
  total: number;
}

export interface ResultEvent {
  type: 'result';
  url: string;
}

export type RealmGenerationEvent =
  | StepEvent
  | LogEvent
  | StreamEvent
  | ThoughtEvent
  | ToolCallEvent
  | ToolResultEvent
  | ProgressEvent
  | ResultEvent;
