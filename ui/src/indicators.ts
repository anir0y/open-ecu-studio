import { Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Material } from "three";

// Coordinates are in the Car Concept lamp meshes' local space. The left
// wheel is at positive X. Each headlight sweeps from |X|=.47 to .805 m.
const outerLensStart = 0.68;
const flashPeriodSeconds = 0.84;

function lampSections(model: Group, name: string, front: boolean) {
  const lens = model.getObjectByName(name);
  if (!(lens instanceof Mesh) || !(lens.material instanceof MeshStandardMaterial)) return;
  const geometry = lens.geometry;
  const index = geometry.index;
  if (!index) return;

  const original = lens.material;
  const position = geometry.getAttribute("position");
  const triangles: number[][] = [[], [], []]; // left, right, continuous headlight
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
    const section = front && Math.abs(x) < outerLensStart ? 2 : x > 0 ? 0 : 1;
    triangles[section].push(a, b, c);
  }
  const split = geometry.clone();
  split.setIndex(triangles.flat());
  split.clearGroups();
  let offset = 0;
  triangles.forEach((indices, section) => {
    if (indices.length) split.addGroup(offset, indices.length, section);
    offset += indices.length;
  });
  const materials: Material[] = [original, original, original];
  lens.geometry = split;
  lens.material = materials;
  return { original, materials };
}

export function fitIndicatorLamps(model: Group) {
  const front = lampSections(model, "BodyHeadlights", true);
  const rear = lampSections(model, "BodyTurnsignalsRear", false);
  const amber = new MeshBasicMaterial({ color: "#ff990f", toneMapped: false });
  const dark = new MeshStandardMaterial({ color: "#190e05", roughness: 0.5 });
  let previousSignal = 0;
  let startedAt = 0;

  return function updateLamps(headlights: number, signal: number, now: number) {
    if (signal !== previousSignal) {
      startedAt = now;
      previousSignal = signal;
    }
    const bright = (now - startedAt) % flashPeriodSeconds < flashPeriodSeconds / 2;
    if (front) front.original.emissiveIntensity = headlights === 2 ? 6 : headlights === 1 ? 2 : 0;
    for (let side = 0; side < 2; side++) {
      const selected = signal === 3 || signal === side + 1;
      const indicator = bright ? amber : dark;
      if (front) front.materials[side] = selected ? indicator : front.original;
      if (rear) rear.materials[side] = selected ? indicator : dark;
    }
  };
}
