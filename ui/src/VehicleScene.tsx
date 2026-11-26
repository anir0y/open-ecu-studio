import { ContactShadows, Environment, Grid, Lightformer, OrbitControls, useGLTF } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Component, Suspense, useMemo, useRef, type ReactNode } from "react";
import { Group, MathUtils, Mesh, MeshStandardMaterial, Object3D, Vector3 } from "three";

import { fitIndicatorLamps } from "./indicators";
import { advanceRoadStripe, forwardWheelSpin } from "./motion";
import { levelHandwheel, mountFrontWheel, setRoadAngle } from "./steering";

export type VehicleVisualState = {
  speedKph: number;
  acceleration: number;
  steeringDeg: number;
  yawRate: number;
  wheelSpeeds: number[];
  intervention: boolean;
  faultActive: boolean;
};

type BodyVisualState = {
  lights: number;
  signal: number;
  left_open: boolean;
  right_open: boolean;
  wiper: boolean;
};

const parkedBody: BodyVisualState = { lights: 0, signal: 0, left_open: false, right_open: false, wiper: false };
const windshieldNormal = new Vector3(0, -0.19, 1).normalize();

type VehicleRig = {
  model: Group;
  wheels: Object3D[];
  steeringPivots: Group[];
  column?: Object3D;
  neutralColumn?: ReturnType<typeof levelHandwheel>;
  brakeLights: MeshStandardMaterial[];
  brakePads: MeshStandardMaterial[];
  updateLamps: ReturnType<typeof fitIndicatorLamps>;
  leftDoor?: Object3D;
  rightDoor?: Object3D;
  wiper?: Object3D;
  beamTarget: Object3D;
};

export const MODEL_PATH = "/models/car-concept/CarConcept.glb";

export function buildVehicleRig(source: Group): VehicleRig {
  const model = source.clone(true);
  const wheels: Object3D[] = [];
  const steeringPivots: Group[] = [];

  model.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const materials = sourceMaterials.map((material) => material.clone());
    object.material = Array.isArray(object.material) ? materials : materials[0];

    materials.forEach((material) => {
      if (!(material instanceof MeshStandardMaterial)) return;
      if (material.name === "Rim1" || material.name === "Rim2") {
        material.color.set("#182126");
        material.emissive.set("#000000");
        material.emissiveIntensity = 0;
        material.metalness = 0.92;
        material.roughness = 0.18;
      }
      if (material.name === "Hardware") {
        material.emissive.set("#000000");
        material.emissiveIntensity = 0;
      }
    });
  });

  ["WheelFrontL", "WheelFrontR", "WheelRearL", "WheelRearR"].forEach((name, index) => {
    const wheel = model.getObjectByName(name);
    if (!wheel) return;
    wheels.push(wheel);

    if (index < 2 && wheel.parent) {
      steeringPivots.push(mountFrontWheel(wheel));
    }
  });

  const cloneMaterials = (name: string) => {
    const materials: MeshStandardMaterial[] = [];
    model.getObjectByName(name)?.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
      const cloned = sourceMaterials.map((material) => material.clone());
      object.material = Array.isArray(object.material) ? cloned : cloned[0];
      cloned.forEach((material) => {
        if (material instanceof MeshStandardMaterial) materials.push(material);
      });
    });
    return materials;
  };

  const column = model.getObjectByName("InteriorSteeringCylinder");
  const beamTarget = new Object3D();
  beamTarget.position.set(0, 0, 6);
  model.add(beamTarget);
  return {
    model, column, neutralColumn: column && levelHandwheel(column),
    wheels,
    steeringPivots,
    updateLamps: fitIndicatorLamps(model),
    leftDoor: model.getObjectByName("BodyDoorLColor1"),
    rightDoor: model.getObjectByName("BodyDoorRColor1"),
    wiper: model.getObjectByName("BodyWindshieldWipers"),
    beamTarget,
    brakeLights: cloneMaterials("BodyTaillights"),
    brakePads: [
      ...cloneMaterials("WheelFrontLBrakePad"),
      ...cloneMaterials("WheelFrontRBrakePad"),
      ...cloneMaterials("WheelRearLBrakePad"),
      ...cloneMaterials("WheelRearRBrakePad"),
    ],
  };
}

function RollingRoad({ speed }: { speed: number }) {
  const stripes = useRef<Group>(null);
  useFrame((_, delta) => {
    stripes.current?.children.forEach((line) => {
      line.position.z = advanceRoadStripe(line.position.z, speed, delta);
    });
  });

  return (
    <group position={[0, -0.48, 0]}>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[18, 24]} />
        <meshStandardMaterial color="#090e12" roughness={0.92} metalness={0.14} />
      </mesh>
      <group ref={stripes}>
        {Array.from({ length: 10 }, (_, index) => (
          <mesh key={index} position={[0, 0.008, index * 1.5 - 7]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.055, 0.72]} />
            <meshBasicMaterial color="#5b707b" transparent opacity={0.34} />
          </mesh>
        ))}
      </group>
      <Grid
        args={[18, 24]}
        cellColor="#172833"
        sectionColor="#28404d"
        cellSize={0.5}
        sectionSize={2}
        fadeDistance={14}
        fadeStrength={1.5}
        infiniteGrid
      />
    </group>
  );
}

function ProfessionalVehicle({ state, controls }: { state: VehicleVisualState; controls: BodyVisualState }) {
  const body = useRef<Group>(null);
  const { scene } = useGLTF(MODEL_PATH);
  const rig = useMemo(() => buildVehicleRig(scene), [scene]);
  const wiperPhase = useRef(0);

  useFrame(({ clock }, delta) => {
    const steering = -state.steeringDeg * Math.PI / 180;
    setRoadAngle(rig.steeringPivots, state.steeringDeg);
    if (rig.column && rig.neutralColumn) {
      rig.column.quaternion.copy(rig.neutralColumn);
      rig.column.rotateY(steering);
    }
    rig.wheels.forEach((wheel, index) => {
      wheel.rotateX(forwardWheelSpin(state.wheelSpeeds[index] ?? state.speedKph, delta));
    });

    if (body.current) {
      const targetPitch = Math.max(-0.045, Math.min(0.045, state.acceleration * 0.012));
      const targetRoll = Math.max(-0.055, Math.min(0.055, -state.yawRate * 0.0015));
      body.current.rotation.x += (targetPitch - body.current.rotation.x) * Math.min(1, delta * 6);
      body.current.rotation.z += (targetRoll - body.current.rotation.z) * Math.min(1, delta * 6);
    }

    const braking = state.intervention || state.acceleration < -0.4;
    rig.updateLamps(controls.lights, controls.signal, clock.elapsedTime);
    if (rig.leftDoor) rig.leftDoor.rotation.z = MathUtils.damp(rig.leftDoor.rotation.z, controls.left_open ? -1.02 : 0, 10, delta);
    if (rig.rightDoor) rig.rightDoor.rotation.z = MathUtils.damp(rig.rightDoor.rotation.z, controls.right_open ? 1.02 : 0, 10, delta);
    if (rig.wiper) {
      const period = 2 * Math.PI;
      const phase = wiperPhase.current + delta * 4.5;
      // Finish the current sweep when switched off, then park at phase zero.
      if (controls.wiper) wiperPhase.current = phase % period;
      else if (wiperPhase.current > 0) wiperPhase.current = phase < period ? phase : 0;
      const angle = (Math.cos(wiperPhase.current) - 1) * 0.52;
      rig.wiper.quaternion.setFromAxisAngle(windshieldNormal, angle);
    }
    rig.brakeLights.forEach((material) => {
      material.emissiveIntensity = braking ? 8 : controls.lights ? 2.2 : 0;
    });
    rig.brakePads.forEach((material) => {
      material.emissive.set(state.intervention ? "#ff2d0b" : "#000000");
      material.emissiveIntensity = state.intervention ? 3 : 0;
    });
  });

  return (
    <group ref={body} position={[0, -0.46, 0]}>
      <primitive object={rig.model} />
      <spotLight position={[0, 0.61, 2.23]} target={rig.beamTarget} angle={0.43}
        penumbra={0.8} distance={11} intensity={controls.lights === 2 ? 42 : controls.lights === 1 ? 15 : 0}
        color="#d8edff" />
      <pointLight position={[0, 1.04, -0.15]} color="#ffdda3" distance={2}
        intensity={controls.left_open || controls.right_open ? 2 : 0} />
      {state.faultActive && (
        <group position={[0.99, 0.38, -1.31]} rotation={[0, Math.PI / 2, 0]}>
          <mesh>
            <torusGeometry args={[0.55, 0.014, 8, 64]} />
            <meshBasicMaterial color="#ff6846" transparent opacity={0.9} />
          </mesh>
          <pointLight color="#ff6846" intensity={2.2} distance={1.3} />
        </group>
      )}
      {state.intervention && (
        <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[2.55, 2.59, 96]} />
          <meshBasicMaterial color="#ff6846" transparent opacity={0.72} />
        </mesh>
      )}
    </group>
  );
}

function LoadingVehicle() {
  return (
    <group position={[0, -0.05, 0]}>
      <mesh>
        <boxGeometry args={[2.3, 0.03, 4.4]} />
        <meshBasicMaterial color="#66d9e8" transparent opacity={0.12} wireframe />
      </mesh>
    </group>
  );
}

export class SceneBoundary extends Component<{children: ReactNode; fallback: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function VehicleScene({ state, body = parkedBody }: { state: VehicleVisualState; body?: BodyVisualState }) {
  return (
    <SceneBoundary fallback={<p className="stage-hint">3D view unavailable on this device.</p>}>
    <Canvas shadows dpr={[1, 1.6]} camera={{ position: [5.9, 2.45, 6.7], fov: 33 }} gl={{ antialias: true, toneMappingExposure: 1.08 }}>
      <color attach="background" args={["#080b0e"]} />
      <fog attach="fog" args={["#080b0e", 9, 20]} />
      <ambientLight intensity={0.28} color="#9ec6d3" />
      <directionalLight position={[4, 7, 5]} intensity={3.2} color="#e7f1f5" castShadow shadow-mapSize={[2048, 2048]} />
      <spotLight position={[-4, 3, -3]} intensity={12} angle={0.38} penumbra={0.84} color={state.intervention ? "#ff6846" : "#66d9e8"} />
      <Environment resolution={256}>
        <Lightformer form="rect" intensity={5} color="#e8fbff" position={[0, 5, -1]} rotation={[Math.PI / 2, 0, 0]} scale={[7, 1, 1]} />
        <Lightformer form="rect" intensity={3.5} color="#70d8e8" position={[4, 2, 0]} rotation={[0, -Math.PI / 2, 0]} scale={[2, 4, 1]} />
        <Lightformer form="rect" intensity={2.2} color="#f4fbff" position={[-4, 1.2, 1]} rotation={[0, Math.PI / 2, 0]} scale={[2, 3, 1]} />
        <Lightformer form="ring" intensity={2.8} color="#ffffff" position={[0, 1, 5]} scale={[3, 3, 1]} />
      </Environment>
      <RollingRoad speed={state.speedKph} />
      <Suspense fallback={<LoadingVehicle />}>
        <ProfessionalVehicle state={state} controls={body} />
      </Suspense>
      <ContactShadows position={[0, -0.455, 0]} scale={8} opacity={0.76} blur={2.2} far={4.5} />
      <OrbitControls makeDefault enablePan={false} minDistance={5.2} maxDistance={10} minPolarAngle={0.62} maxPolarAngle={1.36} target={[0, 0.22, 0]} />
    </Canvas>
    </SceneBoundary>
  );
}

useGLTF.preload(MODEL_PATH);
