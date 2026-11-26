import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer, OrthographicCamera, useGLTF } from "@react-three/drei";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { MathUtils, type Group } from "three";
import { buildVehicleRig, MODEL_PATH, SceneBoundary } from "./VehicleScene";
import "./twin-car-view.css";

type Props = {vulnerableOpen: boolean; protectedOpen: boolean};

function ParkedCar({model, x, open}: {model: Group; x: number; open: boolean}) {
  const door = useMemo(() => model.getObjectByName("BodyDoorLColor1"), [model]);
  const invalidate = useThree(state => state.invalidate);
  const reducedMotion = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)"), []);
  useFrame((_, delta) => {
    if (!door) return;
    const target = open ? -1.02 : 0;
    if (reducedMotion.matches || Math.abs(door.rotation.z - target) < 0.002) {
      door.rotation.z = target;
      return;
    }
    // The first frame on a parked canvas may follow several minutes of idle time.
    door.rotation.z = MathUtils.damp(door.rotation.z, target, 11, Math.min(delta, 0.04));
    invalidate();
  });
  useEffect(() => { invalidate(); }, [open, invalidate]);
  return <group position={[x, -0.63, 0]} rotation={[0, -1.1, 0]}>
    <primitive object={model} />
    <pointLight position={[0.26, 1.04, -0.15]} intensity={open ? 2 : 0} distance={2} color="#ffdda3" />
  </group>;
}

function Pair({vulnerableOpen, protectedOpen}: Props) {
  const {scene} = useGLTF(MODEL_PATH);
  const [left, right] = useMemo(() => {
    const rig = buildVehicleRig(scene);
    rig.updateLamps(0, 0, 0);
    rig.brakeLights.forEach(material => { material.emissiveIntensity = 0; });
    // Share the paint and geometry, but give each car independent door transforms.
    return [rig.model, rig.model.clone(true)];
  }, [scene]);
  const size = useThree(state => state.size);
  const zoom = Math.min(size.width / 11.5, size.height / 3.8);
  const offset = size.width / (4 * zoom);
  return <>
    <OrthographicCamera makeDefault position={[0, 4.7, 9]} rotation={[-Math.atan2(4.7, 9), 0, 0]} zoom={zoom} />
    <color attach="background" args={["#101a20"]} />
    <hemisphereLight args={["#f2f9ff", "#8597a0", 1.1]} />
    <directionalLight position={[-4, 9, 5]} intensity={3.2} castShadow
      shadow-mapSize={[1024,1024]} shadow-camera-left={-9} shadow-camera-right={9}
      shadow-camera-top={5} shadow-camera-bottom={-5} shadow-normalBias={0.02} />
    <Environment resolution={128} frames={1}>
      <Lightformer form="rect" intensity={5} position={[0, 5, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[9, 3, 1]} />
      <Lightformer form="rect" intensity={3} color="#b2d9e7" position={[0, 2, 5]} scale={[9, 2, 1]} />
      <Lightformer form="rect" intensity={3.5} position={[-5, 2, -2]} rotation={[0, Math.PI/2, 0]} scale={[8, 2, 1]} />
    </Environment>
    <mesh rotation={[-Math.PI/2, 0, 0]} position={[0,-0.645,0]} receiveShadow>
      <planeGeometry args={[200,200]} />
      <meshStandardMaterial color="#24333d" roughness={0.92} />
    </mesh>
    <ParkedCar x={-offset} model={left} open={vulnerableOpen} />
    <ParkedCar x={offset} model={right} open={protectedOpen} />
  </>;
}

export function TwinCarView({vulnerableOpen, protectedOpen}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!root.current || !("IntersectionObserver" in window)) { setReady(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setReady(true);
        observer.disconnect();
      }
    }, {rootMargin: "240px"});
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const labels = [
    ["Vulnerable receiver", vulnerableOpen ? "Left door open" : "Left door closed"],
    ["Protected receiver", protectedOpen ? "Left door open" : "Left door closed"],
  ];
  return <div className="twin-car-view" ref={root}>
    <div className="twin-car-labels">{labels.map(([label, state]) =>
      <div key={label}><strong>{label}</strong><span>{state}</span></div>
    )}</div>
    <div className="twin-car-stage">
      {ready && <SceneBoundary fallback={<p className="twin-car-fallback">3D view unavailable on this device.</p>}>
        <Canvas orthographic shadows frameloop="demand" dpr={[1, 1.5]} aria-label="Two classroom cars viewed from the left side">
          <Suspense fallback={null}><Pair vulnerableOpen={vulnerableOpen} protectedOpen={protectedOpen} /></Suspense>
        </Canvas>
      </SceneBoundary>}
    </div>
  </div>;
}
