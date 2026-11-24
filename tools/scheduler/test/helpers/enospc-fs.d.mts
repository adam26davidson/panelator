export interface EnospcSwitch { on: boolean; restore(): void }
export function installEnospc(root: string): EnospcSwitch;
