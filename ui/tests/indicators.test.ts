import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial } from "three";
import { fitIndicatorLamps } from "../src/indicators.ts";

const file = readFileSync(new URL("../public/models/car-concept/CarConcept.glb", import.meta.url));
const jsonEnd = 20 + file.readUInt32LE(12);
const asset = JSON.parse(file.toString("utf8", 20, jsonEnd));

function loadLens(name: string) {
  const node = asset.nodes.find((n: {name?: string}) => n.name === name);
  const primitive = asset.meshes[node.mesh].primitives[0];
  function offset(accessor: number) {
    const entry = asset.accessors[accessor];
    return file.byteOffset + jsonEnd + 8 + asset.bufferViews[entry.bufferView].byteOffset + (entry.byteOffset ?? 0);
  }
  const indices = primitive.indices;
  const positions = primitive.attributes.POSITION;
  const geometry = new BufferGeometry();
  geometry.setIndex(new BufferAttribute(new Uint16Array(file.buffer, offset(indices), asset.accessors[indices].count), 1));
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(file.buffer, offset(positions), 3 * asset.accessors[positions].count), 3));
  const mesh = new Mesh(geometry, new MeshStandardMaterial());
  mesh.name = name;
  return mesh;
}

test("front and rear lenses indicate the selected vehicle side, synchronise, and start lit", () => {
  const front = loadLens("BodyHeadlights");
  const rear = loadLens("BodyTurnsignalsRear");
  const originalHeadlamp = front.material;
  const update = fitIndicatorLamps(new Group().add(front, rear));
  for (const lens of [front, rear]) {
    const {geometry} = lens;
    const index = geometry.getIndex()!;
    const position = geometry.getAttribute("position");
    assert.equal(geometry.groups.reduce((n, group) => n + group.count, 0), index.count);
    // Positive X is the side of WheelFrontL in the actual model.
    for (const side of [0, 1]) {
      const group = geometry.groups.find(group => group.materialIndex === side)!;
      assert.ok(group.count > 0);
      for (let i = group.start; i < group.start + group.count; i++) {
        assert.equal(position.getX(index.getX(i)) > 0, side === 0);
      }
    }
  }
  function assertFlash(left: boolean, right: boolean) {
    for (const lens of [front, rear]) {
      assert.ok(Array.isArray(lens.material));
      assert.deepEqual(lens.material.slice(0, 2).map(m => m.type === "MeshBasicMaterial"), [left, right]);
    }
  }
  update(2, 1, 4.8); assertFlash(true, false);
  update(2, 1, 5.3); assertFlash(false, false);
  update(2, 1, 5.7); assertFlash(true, false);
  update(2, 2, 5.8); assertFlash(false, true);
  update(2, 3, 5.9); assertFlash(true, true);
  update(2, 3, 6.4); assertFlash(false, false);
  update(2, 0, 6.5); assertFlash(false, false);
  assert.ok(Array.isArray(front.material));
  assert.ok(front.material.every(section => section === originalHeadlamp));
  assert.equal(originalHeadlamp.emissiveIntensity, 6);
});
