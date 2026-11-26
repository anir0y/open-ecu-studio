const ROAD_REPEAT_METERS = 14;
const ROAD_REAR_EDGE = -7;

export function advanceRoadStripe(positionZ: number, speedKph: number, deltaSeconds: number): number {
  let nextPosition = positionZ - Math.max(0, speedKph) * deltaSeconds * 0.018;
  while (nextPosition < ROAD_REAR_EDGE) nextPosition += ROAD_REPEAT_METERS;
  return nextPosition;
}

export function forwardWheelSpin(speedKph: number, deltaSeconds: number): number {
  return Math.max(0, speedKph) * deltaSeconds * 0.2;
}

export function activeMotionValue(running: boolean, value: number): number {
  return running ? value : 0;
}
