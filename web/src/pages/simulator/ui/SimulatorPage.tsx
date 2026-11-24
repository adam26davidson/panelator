import { useSimulator } from "../model/useSimulator";
import { SimulatorView } from "./SimulatorView";

export function SimulatorPage() {
  const { view, panel, placements, toggle, retry, canvasRef } = useSimulator();
  return (
    <SimulatorView
      view={view}
      panel={panel}
      placements={placements}
      onToggle={toggle}
      onRetry={retry}
      canvasRef={canvasRef}
    />
  );
}
