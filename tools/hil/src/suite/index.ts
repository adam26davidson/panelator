import type { Board } from "../board.ts";
import { bootBanner } from "./boot-banner.ts";

export type TestOutcome =
  | { status: "pass" }
  | { status: "fail"; message: string; /** the board printed no banner at all */ noBanner?: boolean }
  | { status: "skip"; message?: string };

export interface HilTest {
  name: string;
  run(board: Board): Promise<TestOutcome>;
}

/** The suite: one module per test. Every later firmware child adds its tests here. */
export const suite: HilTest[] = [bootBanner];
