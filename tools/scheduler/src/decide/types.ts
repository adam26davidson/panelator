export interface DecideQuestion {
  id: string;
  text: string;
  options?: string[];
}

export interface DecideRequest {
  state: unknown;
  questions: DecideQuestion[];
}

export interface DecideResponse {
  answers: Record<string, string>;
}

export interface Decider {
  decide(req: DecideRequest): Promise<DecideResponse>;
}
