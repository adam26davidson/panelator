// The two things that touch the board are behind interfaces the tests fake (spec 106 AC-17); the Docker
// implementations are in docker.ts.
export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface Flasher {
  /** The flasher's chip query: does the board answer in download mode? */
  chipQuery(port: string): Promise<ToolResult>;
  /** Flashes the files of `<dir>/flasher_args.json` at its offsets, without resetting the board. */
  flash(port: string, dir: string): Promise<ToolResult>;
}
