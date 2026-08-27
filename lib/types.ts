export type MomentSource = "camera" | "parent";

export type Moment = {
  id: string;
  timestamp: string;
  source: MomentSource;
  description: string;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
};

export type MomentDraft = Omit<Moment, "id">;

export type SearchResult = Moment & {
  score?: number;
};
