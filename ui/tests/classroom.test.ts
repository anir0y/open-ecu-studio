import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {Group, MathUtils, Vector3} from "three";
import {decodePacket, examples, worksheetCsv} from "../src/packets.ts";
import {receiverSteps} from "./receiver-example.ts";
import {levelHandwheel, mountFrontWheel, setRoadAngle} from "../src/steering.ts";

const binary = readFileSync(new URL("../public/models/car-concept/CarConcept.glb", import.meta.url));
const asset = JSON.parse(binary.toString("utf8", 20, 20 + binary.readUInt32LE(12)));
function assetNode(name: string) {
  const node = new Group();
  node.matrix.fromArray(asset.nodes.find((n: {name: string}) => n.name === name).matrix);
  node.matrix.decompose(node.position, node.quaternion, node.scale);
  return node;
}

test("both actual front axles follow the measured steering angle through spin and recentering", () => {
  const chassis = new Group();
  for (const name of ["WheelFrontL","WheelFrontR"]) {
    const wheel = assetNode(name);
    const center = wheel.position.clone();
    chassis.add(wheel);
    const pivot = mountFrontWheel(wheel);
    for (const degrees of [0,-30,18,30,0]) {
      setRoadAngle([pivot], degrees);
      wheel.rotateX(3.75);
      chassis.updateMatrixWorld(true);
      const axle = new Vector3(1,0,0).transformDirection(wheel.matrixWorld);
      assert.ok(Math.abs(-MathUtils.radToDeg(Math.atan2(axle.y, axle.x)) - degrees) < 0.001);
      assert.ok(wheel.getWorldPosition(new Vector3()).distanceTo(center) < 0.00001);
    }
  }
});
test("the neutral cabin wheel is level and retains its steering column inclination", () => {
  const column = assetNode("InteriorSteeringCylinder");
  const shaft = new Vector3(0,1,0).applyQuaternion(column.quaternion);
  levelHandwheel(column);
  assert.ok(Math.abs(new Vector3(1,0,0).applyQuaternion(column.quaternion).z) < 0.00001);
  assert.ok(new Vector3(0,1,0).applyQuaternion(column.quaternion).distanceTo(shaft) < 0.00001);
});
test("steering examples decode zero and both signs from the indexed payload", () => {
  for (const [i, expected] of ["0.0","-12.0","12.0"].entries()) {
    const field = decodePacket(examples[i]).fields.find(f => f.name === "Road-wheel steering");
    assert.deepEqual([field?.start,field?.end,field?.result,field?.unit],[2,3,expected,"°"]);
  }
  assert.match(worksheetCsv({...examples[1], sequence: 123}, "Captured frame #123"), /"2","3","Road-wheel steering","FF 88","int16 → -120 ÷ 10","-12.0","°"/);
});
test("every teaching example accounts for every byte once", () => {
  for (const p of examples) {
    const {fields} = decodePacket(p);
    assert.equal(fields.map(f => f.hex.replaceAll(" ","")).join(""),p.data);
    assert.equal(fields.at(-1)?.end,p.data.length / 2 - 1);
  }
  assert.equal(decodePacket(examples[3]).fields[2].result,"30.00");
  assert.equal(decodePacket(examples[4]).fields[1].result,"-2.50");
  assert.equal(decodePacket(examples[6]).fields[0].result,"1000");
  assert.equal(decodePacket(examples[8]).fields.find(f => f.name === "Version")?.result,"1.0");
});
test("unsupported or malformed captures keep their raw bytes and have no decoded rows", () => {
  for (const override of [{id:"0x222"}, {is_extended_id:true}, {is_fd:true}, {data:"00"}, {data:"xx"}]) {
    assert.equal(decodePacket({...examples[0],...override}).fields.length,0);
  }
  assert.equal(decodePacket({...examples[7],data:"1022F1A000000000"}).fields.length,0);
});

test("body worksheets decode independent door switches and a rejected duplicate", () => {
  const body = decodePacket({id: "0x361", is_fd: false, data: "02030300010100FF"});
  assert.deepEqual(body.fields.map(field => field.result), [
    "High beam", "Hazards", "Both open", "Unlocked", "Sweeping", "On", "Cabin", "255",
  ]);
  const receipt = {id: "0x362", is_fd: false, data: "0200000001000100"};
  const counter = decodePacket(receipt).fields.find(field => field.name === "Message counter");
  assert.deepEqual([counter?.start, counter?.end, counter?.result], [2, 5, "256"]);
  const csv = worksheetCsv(receipt, "Synthetic receiver decision");
  assert.match(csv, /"0","0","Receiver decision","02",[^\n]*"Duplicate rejected"/);
  assert.match(csv, /"6","6","Resulting lock","01",[^\n]*"Locked"/);
});

test("the same classroom unlock yields different receipts and only the unlocked door opens", () => {
  const [fresh, relock, repeat, handles] = receiverSteps;
  assert.equal(fresh.input, repeat.input);
  const result = (id: string, data: string | null, name: string) =>
    decodePacket({id, data: data ?? "", is_fd: false}).fields.find(field => field.name === name)?.result;
  for (const side of ["vulnerable", "protected"] as const) {
    assert.equal(result("0x362", fresh[side].receipt, "Message counter"), "9");
    assert.equal(result("0x362", repeat[side].receipt, "Message counter"), "9");
    assert.equal(result("0x361", relock[side].body, "Central lock"), "Locked");
    assert.equal(result("0x361", repeat[side].body, "Door switches"), "Both closed");
  }
  assert.equal(result("0x362", repeat.vulnerable.receipt, "Receiver decision"), "Accepted");
  assert.equal(result("0x362", repeat.protected.receipt, "Receiver decision"), "Duplicate rejected");
  assert.ok(repeat.vulnerable.bodySent && !repeat.protected.bodySent);
  assert.equal(repeat.protected.body, relock.protected.body);
  assert.equal(result("0x361", handles.vulnerable.body, "Door switches"), "Left open");
  assert.equal(result("0x361", handles.protected.body, "Central lock"), "Locked");
  assert.equal(handles.protected.body, relock.protected.body);
});
