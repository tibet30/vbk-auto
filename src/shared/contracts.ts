export type FieldState =
  | "proposed"
  | "researching"
  | "resolved"
  | "needs_confirmation"
  | "confirmed"
  | "blocked";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ProjectSummary {
  id: string;
  name: string;
  status: "planning" | "review" | "automating" | "draft_saved" | "blocked";
  productId?: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  destination: string;
  days: number;
  productForm: "privateTour" | "groupTour";
}

export interface ProjectReadiness {
  ready: boolean;
  completion: number;
  issues: Array<{ label: string; detail: string }>;
}

export interface ProjectDetail extends ProjectSummary {
  product: Record<string, unknown>;
  messages: ConversationMessage[];
  researchTasks: ResearchTask[];
  automation?: AutomationRun;
  /** 基本信息是否已在 VBK 成功保存，决定重试时是否需要补跑 basic 阶段。 */
  basicInfoSaved?: boolean;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  taskStatus?: TaskStatus;
}

export interface ResearchTask {
  id: string;
  label: string;
  type: "vbk" | "web" | "cost" | "image";
  status: TaskStatus;
  state: FieldState;
  detail?: string;
  evidence?: Evidence[];
}

export interface Evidence {
  id: string;
  title: string;
  url?: string;
  source: "vbk" | "web" | "user";
  retrievedAt: string;
  accepted: boolean;
}

export interface AutomationRun {
  id: string;
  status: TaskStatus;
  currentPhase?: string;
  phases: Array<{ phase: string; status: "pending" | "running" | "completed" | "failed" }>;
  logs: Array<{ at: string; message: string; level: "info" | "warning" | "error" }>;
  screenshot?: string;
}

export interface Settings {
  minimaxBaseUrl: string;
  minimaxModel: string;
  hasMiniMaxKey: boolean;
  dataPath: string;
}

export interface MiniMaxConnectionTest {
  connected: boolean;
  message: string;
}

export interface VehicleResourceMatch {
  query: string;
  city: string;
  days: number;
  dailyCost: number;
  totalCost: number;
  resourceGroupId: number;
  resourceGroupName: string;
}

export interface VbkLoginStatus {
  loggedIn: boolean;
  message: string;
  accountName?: string;
  accounts?: string[];
}

export interface AiResponse {
  reply: string;
  patch?: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }>;
  questions?: string[];
  researchTasks?: Array<Pick<ResearchTask, "label" | "type" | "detail">>;
}

export interface VbkApi {
  projects: {
    list(): Promise<ProjectSummary[]>;
    create(input: CreateProjectInput): Promise<ProjectDetail>;
    get(id: string): Promise<ProjectDetail>;
    readiness(id: string): Promise<ProjectReadiness>;
  };
  ai: { send(projectId: string, content: string): Promise<void> };
  research: {
    accept(projectId: string, taskId: string, note?: string): Promise<void>;
    resolveVehicleResource(projectId: string, taskId?: string): Promise<VehicleResourceMatch>;
  };
  browser: {
    login(): Promise<void>;
    logout(): Promise<void>;
    status(refresh?: boolean): Promise<VbkLoginStatus>;
    navigate(url: string): Promise<void>;
    openExternal(): Promise<void>;
    setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
    setVisible(visible: boolean): Promise<void>;
  };
  automation: { start(projectId: string): Promise<void>; retry(projectId: string): Promise<void> };
  settings: {
    get(): Promise<Settings>;
    getApiKey(): Promise<string>;
    save(input: Partial<Settings> & { apiKey?: string }): Promise<Settings>;
    test(input: Pick<Settings, "minimaxBaseUrl"> & { apiKey?: string }): Promise<MiniMaxConnectionTest>;
  };
  events: { onProjectUpdated(listener: (project: ProjectDetail) => void): () => void };
}
