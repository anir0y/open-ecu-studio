import { Group, MathUtils, Object3D, Vector3 } from "three";

// The authored chassis is Z-up, with the axle along X. Remove the display
// pose around Z while retaining each rim's original rotation about its axle.
export function mountFrontWheel(wheel: Object3D): Group {
  const parent = wheel.parent;
  if (!parent) throw new Error("A front wheel needs a chassis");
  const pivot = new Group();
  pivot.position.copy(wheel.position);
  const axle = new Vector3(1, 0, 0).applyQuaternion(wheel.quaternion);
  wheel.rotateOnWorldAxis(new Vector3(0, 0, 1), -Math.atan2(axle.y, axle.x));
  parent.add(pivot);
  wheel.position.set(0, 0, 0);
  pivot.add(wheel);
  return pivot;
}

export function setRoadAngle(pivots: Group[], degrees: number) {
  for (const pivot of pivots) pivot.rotation.z = -MathUtils.degToRad(degrees);
}

export function levelHandwheel(column: Object3D) {
  // Keep the shaft inclination. Level the transverse spoke in the chassis XY plane.
  const shaft = new Vector3(0, 1, 0).applyQuaternion(column.quaternion).normalize();
  const level = shaft.clone().cross(new Vector3(0, 0, 1)).normalize();
  const spoke = new Vector3(1, 0, 0).applyQuaternion(column.quaternion);
  const correction = Math.atan2(spoke.clone().cross(level).dot(shaft), spoke.dot(level));
  column.rotateY(correction);
  return column.quaternion.clone();
}
