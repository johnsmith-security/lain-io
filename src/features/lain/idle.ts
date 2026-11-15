// Procedural body language for Lain's model (it ships with no animation clips): breathing, a slow
// weight shift, relaxed arms, eyes that glance around with the head following, and blinking.
// Her state changes it: she looks at you while listening or speaking, and up and aside while thinking.
//
// Every rotation is given in the model's own axes, measured on lain.glb (she faces +Z):
//   X pitch: + tips forward / looks down        Y yaw: + turns to her left
//   Z roll : + raises her left arm (.L), lowers her right arm (.R)
// The MMD rig's bone axes are rotated, so each bone converts these into its parent's frame.
import * as THREE from 'three';

export type IdleState = 'idle' | 'listening' | 'thinking' | 'speaking';

type Bone = { set: (x: number, y: number, z: number) => void };

/** A bone posed as rest × (rotation about model axes, expressed in the parent's rest frame). */
function bone(model: THREE.Object3D, name: string): Bone | null {
  // three.js strips "." from node names: 腕.L → 腕L.
  const object = model.getObjectByName(name.replace(/\./g, ''));
  if (!object?.parent) return null;
  model.updateWorldMatrix(true, true);
  const rest = object.quaternion.clone();
  const toParent = model.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(object.parent.getWorldQuaternion(new THREE.Quaternion()));
  const fromParent = toParent.clone().invert();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const turn = new THREE.Quaternion();
  return {
    set(x, y, z) {
      turn.setFromEuler(euler.set(x, y, z));
      object.quaternion.copy(fromParent).multiply(turn).multiply(toParent).multiply(rest);
    },
  };
}

const TAU = Math.PI * 2;
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
/** Frame-rate independent approach toward a target at `rate` per second. */
const ease = (current: number, target: number, rate: number, dt: number) => current + (target - current) * (1 - Math.exp(-rate * dt));

const BLINK_CLOSED = 0.55;        // eyelid angle that meets the lower lid
const ARM_REST = 0.2;             // lowers the arms from the export pose (20° out) to hang by her sides
const WRIST_REST = 0.3;           // turns the hands in to follow the forearm
const ELBOW_REST = -0.12;         // a slight, relaxed bend

export function createIdle(model: THREE.Object3D) {
  const spine = bone(model, '上半身');
  const chest = bone(model, '上半身2');
  const neck = bone(model, '首');
  const head = bone(model, '頭');
  const eyes = bone(model, '両目');
  const lids = [bone(model, '上瞼.L'), bone(model, '上瞼.R')];
  const shoulders = [bone(model, '肩.L'), bone(model, '肩.R')];
  const arms = [bone(model, '腕.L'), bone(model, '腕.R')];
  const elbows = [bone(model, 'ひじ.L'), bone(model, 'ひじ.R')];
  const wrists = [bone(model, '手首.L'), bone(model, '手首.R')];
  const found = [spine, chest, neck, head, eyes, ...lids, ...arms].filter(Boolean).length;
  if (found < 9) console.warn(`[Lain idle] only ${found}/9 bones found; some idle motion is off.`);

  // Gaze: where she means to look; eyes get there fast, the head follows slowly.
  const gaze = { yaw: 0, pitch: 0, nextAt: rand(1.5, 3) };
  const look = { headYaw: 0, headPitch: 0, eyeYaw: 0, eyePitch: 0 };
  const tilt = { roll: 0 };
  const blink = { startAt: rand(1, 3), double: false };
  const thinkSide = Math.random() < 0.5 ? -1 : 1;
  let last = -1;

  function pickGaze(t: number, state: IdleState) {
    if (state === 'listening' || state === 'speaking') {
      // Mostly at you, with a brief look away now and then.
      const away = Math.random() < (state === 'speaking' ? 0.3 : 0.15);
      gaze.yaw = away ? rand(-0.18, 0.18) : rand(-0.03, 0.03);
      gaze.pitch = away ? rand(-0.03, 0.06) : rand(-0.02, 0.02);
      gaze.nextAt = t + (away ? rand(0.8, 1.6) : rand(2, 4));
    } else if (state === 'thinking') {
      gaze.yaw = thinkSide * rand(0.18, 0.3);
      gaze.pitch = rand(-0.14, -0.08);
      gaze.nextAt = t + rand(1.5, 3);
    } else {
      // Idle: at you about half the time, otherwise around the room.
      const atYou = Math.random() < 0.45;
      gaze.yaw = atYou ? rand(-0.04, 0.04) : rand(-0.38, 0.38);
      gaze.pitch = atYou ? rand(-0.02, 0.02) : rand(-0.05, 0.1);
      gaze.nextAt = t + rand(1.8, 5.5);
    }
    // People often blink when their eyes jump.
    if (Math.random() < 0.35 && t > blink.startAt + 0.4) { blink.startAt = t + 0.02; blink.double = false; }
  }

  /** Eyelid closure 0–1 for a blink that started `s` seconds ago (fast close, slower open). */
  function lidAt(s: number): number {
    if (s < 0) return 0;
    if (s < 0.06) return s / 0.06;
    if (s < 0.08) return 1;
    if (s < 0.2) return 1 - (s - 0.08) / 0.12;
    return 0;
  }

  return {
    /** `t` in seconds; `mouth` 0–1 (how open her jaw is right now). */
    update(t: number, state: IdleState, mouth: number) {
      const dt = last < 0 ? 1 / 60 : Math.min(0.1, t - last);
      last = t;

      // Breathing (about 14 breaths a minute) and a slow weight shift.
      const breath = Math.sin((t * TAU) / 4.3);
      const inhale = (breath + 1) / 2;
      const sway = Math.sin((t * TAU) / 7.7) + 0.35 * Math.sin((t * TAU) / 3.3 + 1.1);
      const turn = Math.sin((t * TAU) / 12.5);
      spine?.set(0.006 * breath, 0.018 * turn, 0.011 * sway);
      chest?.set(-0.012 * breath, 0.008 * turn, 0.004 * sway);
      shoulders[0]?.set(0, 0, 0.012 * inhale);
      shoulders[1]?.set(0, 0, -0.012 * inhale);

      // Gaze and head.
      if (t >= gaze.nextAt) pickGaze(t, state);
      look.eyeYaw = ease(look.eyeYaw, gaze.yaw - look.headYaw, 22, dt);
      look.eyePitch = ease(look.eyePitch, gaze.pitch - look.headPitch, 22, dt);
      look.headYaw = ease(look.headYaw, gaze.yaw * 0.8, 2.4, dt);
      look.headPitch = ease(look.headPitch, gaze.pitch * 0.8, 2.4, dt);
      tilt.roll = ease(tilt.roll, state === 'listening' ? -0.1 : state === 'thinking' ? 0.08 : 0, 3, dt);
      const nod = state === 'speaking' ? mouth * 0.035 + Math.sin(t * 1.8) * 0.02 : 0;
      const level = -0.6 * 0.011 * sway;                 // keep her head near level as her body sways
      neck?.set(look.headPitch * 0.4, look.headYaw * 0.4, tilt.roll * 0.4 + level);
      head?.set(look.headPitch * 0.6 + nod, look.headYaw * 0.6, tilt.roll * 0.6 + level);
      eyes?.set(
        THREE.MathUtils.clamp(look.eyePitch, -0.12, 0.12),
        THREE.MathUtils.clamp(look.eyeYaw, -0.25, 0.25),
        0,
      );

      // Blinking every 2–6 s, sometimes twice; less while thinking.
      let closed = lidAt(t - blink.startAt);
      if (blink.double) closed = Math.max(closed, lidAt(t - blink.startAt - 0.24));
      if (t > blink.startAt + (blink.double ? 0.5 : 0.25)) {
        blink.startAt = t + (state === 'thinking' ? rand(3.5, 7) : rand(2, 6));
        blink.double = Math.random() < 0.15;
      }
      // Eyelids follow the eyes a little when she looks down.
      const lid = BLINK_CLOSED * closed + Math.max(0, look.eyePitch + look.headPitch) * 0.6;
      lids[0]?.set(lid, 0, 0);
      lids[1]?.set(lid, 0, 0);

      // Arms hang relaxed, move with each breath, and gesture a little while she speaks.
      const talk = state === 'speaking' ? 1 : 0;
      arms[0]?.set(talk * 0.05 * Math.sin(t * 2.1), 0, -ARM_REST + 0.01 * inhale + talk * 0.02 * Math.sin(t * 1.7));
      arms[1]?.set(talk * 0.05 * Math.sin(t * 2.1 + 1.3), 0, ARM_REST - 0.01 * inhale - talk * 0.02 * Math.sin(t * 1.7 + 0.8));
      elbows[0]?.set(ELBOW_REST - talk * 0.08 * (0.5 + 0.5 * Math.sin(t * 2.3)), 0, 0);
      elbows[1]?.set(ELBOW_REST - talk * 0.08 * (0.5 + 0.5 * Math.sin(t * 2.3 + 1.7)), 0, 0);
      wrists[0]?.set(0, 0, -WRIST_REST);
      wrists[1]?.set(0, 0, WRIST_REST);
    },
  };
}
