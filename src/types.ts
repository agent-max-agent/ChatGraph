export type Role = 'user' | 'assistant';

export interface MessageNode {
  id: string;
  parent: string | null;
  role: Role;
  text: string;
  hasAttachments?: boolean;
  branchSource: string | null;
  createdAt?: number;
}

export interface Conversation {
  id: string;
  title: string;
  titleKind?: 'draft' | 'unavailable';
  nodes: MessageNode[];
  activePath: string[];
  currentNode?: string | null;
  fork: { id: string; branchSource: string | null } | null;
  unavailable?: boolean;
}

export interface RawNode {
  id: string;
  parent: string | null;
  message?: {
    author: { role: string };
    recipient?: string;
    metadata: {
      is_visually_hidden_from_conversation?: boolean;
      branching_from_conversation_id?: string;
      attachments?: unknown[];
    };
    content: {
      content_type?: string;
      parts?: unknown[];
      thoughts?: { summary: string }[];
      content?: string;
    };
    create_time: number;
  } | null;
}

export interface ConversationData {
  id: string;
  title: string;
  currentNode: string | null;
  mapping: Record<string, RawNode>;
}

export interface GraphNode {
  key: string;
  id: string | null;
  role: Role | 'root';
  text: string;
  hasAttachments?: boolean;
  conversationTitle: string;
  titleKind?: Conversation['titleKind'];
  conversationId?: string;
  navigationConversationId?: string;
  unavailable?: boolean;
  active: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: { from: string; to: string; kind: 'message' | 'fork' | 'version' }[];
  title: string;
  titleKind?: Conversation['titleKind'];
  conversationCount: number;
}

export interface Layout {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

export type NavigationPlan =
  | { kind: 'current'; targetId: string; pathIds: string[] }
  | {
      kind: 'version';
      targetId: string;
      anchorId: string;
      branchId: string;
      matchId: string;
      targetRole: Role;
      targetText: string;
      pathIds: string[];
    };

export type PageRequest =
  | { kind: 'conversation'; id: string }
  | { kind: 'versions'; id: string; messageId: string }
  | { kind: 'list'; offset: number };

export interface PageFailure {
  error: string;
  status?: number;
  errorKey?: string;
  errorArgs?: string[];
}

export type PageResult =
  ConversationData | { ids: string[]; total: number } | string[][] | PageFailure;

export interface TabState {
  id: string | undefined;
  loading: boolean;
  error: string | null;
  draft?: Conversation | null;
}

export interface IndexProgress {
  requestInterval?: number;
  nextRequestAt?: number;
  offset: number;
  ids: string[];
  cursor: number;
  completed: number;
  total: number;
  done: boolean;
}

export interface Snapshot {
  tabId: number;
  id: string | undefined;
  state?: TabState;
  index?: IndexProgress;
  conversations: Conversation[];
}

export type CoordinatorMessage =
  | {
      type: 'sync' | 'snapshot' | 'indexStep' | 'indexReset' | 'ready' | 'navigated';
      tabId?: number;
    }
  | { type: 'navigate'; tabId?: number; conversationId: string; messageId: string }
  | { type: 'navigationError'; tabId?: number; error: string };

export interface NavigationReply {
  ok?: boolean;
  error?: string;
  plan?: NavigationPlan;
}
