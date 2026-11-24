/** A placement as the readouts show it: from the scene before the modules load, with the declared rate after. */
export interface PlacementRow {
  module: string;
  /** The rate the loaded module declares; unknown until it is loaded. */
  updateHz?: number;
  width: number;
  height: number;
}
