import { type Lineage } from "@reqflow/core";

export function layoutLineage(lineage: Lineage): Record<string, { x: number; y: number }> {
  const stepsByDistance = new Map<number, typeof lineage.steps>();
  let maxDistance = 0;

  for (const step of lineage.steps) {
    if (step.distance > maxDistance) {
      maxDistance = step.distance;
    }
    const group = stepsByDistance.get(step.distance) || [];
    group.push(step);
    stepsByDistance.set(step.distance, group);
  }

  const positions: Record<string, { x: number; y: number }> = {};

  for (const [distance, group] of stepsByDistance.entries()) {
    const x = (maxDistance - distance) * 300;
    const startY = -((group.length - 1) * 150) / 2;

    group.forEach((step, index) => {
      positions[step.block.id] = {
        x,
        y: startY + index * 150,
      };
    });
  }

  return positions;
}
