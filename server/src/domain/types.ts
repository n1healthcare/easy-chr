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
