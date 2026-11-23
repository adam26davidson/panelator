export interface SerialOptions {
  /**
   * true: the reader pulses the board's reset line after opening, so the first boot is read from its start.
   * false (a soak read): DTR and RTS are left unasserted when the port opens, since on the CH34x bridge asserting
   * them resets the board, and nothing resets it.
   */
  reset: boolean;
}

export interface SerialSession {
  /** The next line, or null when none arrived within timeoutMs (or the stream ended). */
  nextLine(timeoutMs: number): Promise<string | null>;
  close(): Promise<void>;
}

export interface Serial {
  open(port: string, options: SerialOptions): Promise<SerialSession>;
}
