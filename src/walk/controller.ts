/**
 * The walk itself (Walk mode, docs/SCENE_CANVAS_CHROME_PLAN.md phase 2): a
 * pure step function that moves a walker across a scanned scene. The viewer
 * feeds it the held keys, the follow camera's yaw and the frame's dt; it
 * returns where the character stands, which way it faces and whether it is
 * moving, so the clip binding can pick idle or walk.
 *
 * Ground comes from a `floorAt` probe. A step the probe cannot see (null) or
 * one taller than `stepLimit` is a wall: the move is refused and the walker
 * stays. Heights ease toward the probe so stairs read as steps, not pops.
 * Nothing here is a metre: speed, reach and the step limit all arrive already
 * scaled to the scene.
 *
 * Walls are optional (`WallProbe`, the voxel collider in `walkCollider.ts`).
 * Without them the walk follows the floor and walks through everything else;
 * with them her body is tested where it stands, pushed out of what it enters,
 * and slides along walls.
 */

export interface WalkInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  run: boolean;
  /** Space: launch, if on the floor. */
  jump: boolean;
  /** An analog move, as a touch stick gives it: x right, z forward, camera-relative. Its length (0..1) is the share
   *  of the pace, and it replaces the four flags. */
  move?: { x: number; z: number };
}

/** The move as camera-relative axes (mx right, mz forward) and the share of the pace to take: the keys at full pace, or the analog `move`. */
export function moveAxes(input: WalkInput): { mx: number; mz: number; amount: number } {
  if (input.move) return { mx: input.move.x, mz: input.move.z, amount: Math.min(1, Math.hypot(input.move.x, input.move.z)) };
  const mx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const mz = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
  return { mx, mz, amount: mx !== 0 || mz !== 0 ? 1 : 0 };
}

export interface WalkerState {
  x: number;
  y: number;
  z: number;
  /** Facing, degrees about Y; 0 faces −Z like the fly cam at rest. */
  heading: number;
  moving: boolean;
  running: boolean;
  /** Vertical speed while airborne; 0 on the floor. */
  vy: number;
  airborne: boolean;
  /** The floor she last stepped or landed onto, which standing still settles
   *  toward. Absent until the first step. */
  floor?: number;
  /** The last place she stood with her body clear: where a fall into nothing
   *  puts her back. Seed it with the spawn. */
  safe?: { x: number; y: number; z: number };
  /** Seconds in the air since she last stood. */
  airTime?: number;
  /** While her body overlaps the scene: the least overlap since it began, at
   *  this height and with these walls. */
  stuckBase?: { cells: number; y: number; walls: number };
}

/** Seconds of air after which she is put back regardless of what the floor
 *  probe says below - the backstop for a reading that flickers mid-fall. A
 *  jump is under one second. */
const MAX_AIR_SECONDS = 3;

/**
 * Where the ground is under (x, z): the highest surface at or below `fromY`,
 * so standing on a table reads the table and walking under it reads the floor.
 * `reach` is the footprint's radius, so one thin gap in a sparse surface is
 * not a hole. `maxDrop` bounds how far below `fromY` an answer may be. Null
 * when there is no floor to stand on.
 */
export type FloorProbe = (
  x: number,
  z: number,
  reach: number,
  fromY: number,
  maxDrop?: number,
) => number | null;

/**
 * Where a body standing on floor `y` at (x, z) ends up once pushed out of the
 * walls around it, or null when there are no walls to collide with (no
 * collider yet, or none for this scene).
 */
export type WallResolver = (x: number, z: number, y: number) => { x: number; z: number } | null;

/** Walls, for a walk that has them. */
export interface WallProbe {
  /** Whether there are walls right now (the collider is built). */
  readonly active: boolean;
  /** Changes whenever the walls do (a rebuild), so overlap counts taken
   *  against different walls are never compared. */
  readonly generation: number;
  resolve: WallResolver;
  /** How much solid her body overlaps standing on floor `y` at (x, z); 0
   *  when she fits. `height` tests only her body up to that height. */
  overlap: (x: number, z: number, y: number, height?: number) => number;
  /** Her full height, for `overlap`. */
  bodyHeight: number;
  /** The floor height alone, with no body test: what a fall lands on and a
   *  step is measured against. */
  groundAt: FloorProbe;
}

/**
 * Moves a point that is inside something soft (a person standing in the way) out to its edge, or answers null when it is
 * clear. Given to {@link stepWalker}, it makes a step into such a thing slide along its edge at the speed of the part of the
 * step that runs along it, where refusing the step outright stalls on some angles and lurches on others.
 */
export type PushOut = (x: number, z: number) => { x: number; z: number } | null;

export interface WalkParams {
  /** World units per second at a walk. */
  speed: number;
  /** Run multiplier while Shift is held. */
  runMultiplier: number;
  /** Radius of the floor probe under the feet. */
  reach: number;
  /** Largest height change one step may take before it reads as a wall. */
  stepLimit: number;
  /** Degrees per second the facing turns toward the move direction. */
  turnRate: number;
  /** Fraction per second the height eases toward the probed floor. */
  settle: number;
  /** Launch speed of a jump, world units per second. */
  jumpSpeed: number;
  /** Gravity, world units per second². */
  gravity: number;
  /** Horizontal speed kept in the air, as a fraction of ground speed. */
  airControl: number;
  /**
   * How far ahead the ground must stay within one step. A frame's move is a few
   * centimetres, so the step limit alone lets a steep surface (a curtain, a
   * wall's lower edge) be climbed a sliver at a time; a stair passes because
   * its tread is flat. 0 or absent turns the check off.
   */
  lookahead?: number;
}

const DEG = Math.PI / 180;

export const EMPTY_INPUT: WalkInput = { forward: false, back: false, left: false, right: false, run: false, jump: false };

export function turnToward(from: number, to: number, maxDelta: number): number {
  let d = ((to - from + 540) % 360) - 180;
  if (d > maxDelta) d = maxDelta;
  if (d < -maxDelta) d = -maxDelta;
  return ((from + d) % 360 + 360) % 360;
}

/** Longest slice of time one step covers. Walls are tested where a step ends,
 *  so a long frame is cut into slices short enough not to land past a wall's
 *  middle and be pushed out of its far side; 60 fps is one slice. */
const MAX_STEP_SECONDS = 1 / 45;

/**
 * Advance the walker by `dt` seconds. `cameraYaw` is the follow camera's yaw
 * in degrees (fly-cam convention: 0 looks down −Z, positive turns left), so
 * "forward" is away from the camera.
 */
export function stepWalker(
  state: WalkerState,
  input: WalkInput,
  dt: number,
  cameraYaw: number,
  params: WalkParams,
  floorAt: FloorProbe,
  walls?: WallProbe,
  push?: PushOut,
): WalkerState {
  const slices = Math.max(1, Math.ceil(dt / MAX_STEP_SECONDS - 1e-9));
  let next = stepOnce(state, input, dt / slices, cameraYaw, params, floorAt, walls, push);
  for (let i = 1; i < slices; i++) {
    next = stepOnce(next, input.jump ? { ...input, jump: false } : input, dt / slices, cameraYaw, params, floorAt, walls, push);
  }
  return next;
}

function stepOnce(
  state: WalkerState,
  input: WalkInput,
  dt: number,
  cameraYaw: number,
  params: WalkParams,
  floorAt: FloorProbe,
  walls?: WallProbe,
  push?: PushOut,
): WalkerState {
  const { mx, mz, amount } = moveAxes(input);
  const moving = amount > 0;
  const running = moving && input.run;

  let { x, y, z, heading, vy, airborne } = state;
  let movedFloor: number | null = null;
  const x0 = x, z0 = z;

  // With walls, her body is tested where it actually is (`fits`) and the floor
  // is read on its own. Without them `floorAt` is the floor and nothing else.
  const hasWalls = !!walls && walls.active;
  const ground = hasWalls ? walls!.groundAt : floorAt;
  const overlapAt = (cx: number, cz: number, cy: number): number => (hasWalls ? walls!.overlap(cx, cz, cy) : 0);
  // Already overlapping something - a lamp top under the ceiling, a spawn in a
  // wall - the body test keeps only the part of her that is still clear, so a
  // head in the ceiling does not hold her but walls still stop her legs.
  // Nothing clear at all, the test is off.
  const stuck = overlapAt(x, z, y);
  let clearHeight = 0;
  if (stuck > 0) {
    for (const f of [0.85, 0.7, 0.55, 0.4]) {
      const h = walls!.bodyHeight * f;
      if (walls!.overlap(x, z, y, h) === 0) { clearHeight = h; break; }
    }
  }
  // Nor may a move take her deeper in. The slack lets her along a rough
  // ceiling, whose overlap varies a little from spot to spot. It is measured
  // from the least overlap since she got stuck, not from this step's, or it
  // would add up, step by step, into walking through a wall. Her height
  // changing (settling, landing) or the walls being rebuilt starts the count
  // again: that overlap is not one she walked into.
  const generation = hasWalls ? walls!.generation : 0;
  const prior = state.stuckBase;
  const same = prior && prior.walls === generation && Math.abs(prior.y - y) < params.stepLimit * 0.02 ? prior : null;
  const stuckBase = stuck > 0 ? Math.min(stuck, same?.cells ?? stuck) : 0;
  const deeper = stuckBase + Math.max(6, stuckBase * 0.25);
  const fitsAt = (cx: number, cz: number, cy: number): boolean => {
    if (stuck === 0) return overlapAt(cx, cz, cy) === 0;
    if (overlapAt(cx, cz, cy) > deeper) return false;
    return clearHeight === 0 || walls!.overlap(cx, cz, cy, clearHeight) === 0;
  };
  // Her height eases up a step over several frames, so a step up has to fit
  // where she is now as well as where she will settle. A drop is tested where
  // she is: the fall's push-out deals with what she passes on the way down.
  const fits = (cx: number, cz: number, floor: number): boolean =>
    fitsAt(cx, cz, y) && (floor <= y || fitsAt(cx, cz, floor));
  const legsIn = (cx: number, cz: number, cy: number): boolean => hasWalls && walls!.overlap(cx, cz, cy, walls!.bodyHeight * 0.5) > 0;
  // A push out of the walls, or null when there is none or it is too far to be
  // a graze - a far push is the resolver reaching through something.
  const pushAt = (cx: number, cz: number, cy: number): { x: number; z: number } | null => {
    const p = hasWalls ? walls!.resolve(cx, cz, cy) : null;
    return p && Math.hypot(p.x - cx, p.z - cz) <= walls!.bodyHeight * 0.1 ? p : null;
  };
  const stuckFor = (atY: number) => (stuck > 0 ? { cells: stuckBase, y: same?.y ?? atY, walls: generation } : undefined);

  // The ground under her BEFORE she moves. Separate from `here` below, which
  // is read after the step and answers about wherever she ended up.
  const standingOn = ground(x, z, params.reach, y + params.stepLimit);

  // Launch only from a detected floor: from an undetected patch nothing below
  // would ever answer to land on.
  if (input.jump && !airborne && standingOn !== null) {
    airborne = true;
    vy = params.jumpSpeed;
  }

  if (moving) {
    // Camera-relative move direction on the ground plane. The fly cam's
    // forward at yaw θ is (−sin θ, 0, −cos θ); right is (cos θ, 0, −sin θ).
    const yaw = cameraYaw * DEG;
    const fx = -Math.sin(yaw); const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw); const rz = -Math.sin(yaw);
    let dx = fx * mz + rx * mx;
    let dz = fz * mz + rz * mx;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;

    const targetHeading = Math.atan2(-dx, -dz) / DEG;
    heading = turnToward(heading, targetHeading, params.turnRate * dt);

    const dist = params.speed * (running ? params.runMultiplier : 1) * amount * dt * (airborne ? params.airControl : 1);
    let nx = x + dx * dist;
    let nz = z + dz * dist;
    // A step into a person ends on their edge, so the rest of it slides round them.
    const slid = push?.(nx, nz);
    if (slid) { nx = slid.x; nz = slid.z; }
    // The floor she would stand on at (cx, cz), or null when she cannot go.
    // Up is limited by the step. Down is a fall, but only onto detected floor:
    // no floor is a wall, which keeps her inside the capture.
    // Stuck, she only goes level or down: with her body test partly off, a
    // wall's face reads as a floor a step up at every move. The small rise
    // allowed for a bumpy floor is not taken (see `take`), or it would add up.
    const rise = stuck > 0 ? params.stepLimit * 0.1 : params.stepLimit;
    const standAt = (cx: number, cz: number): number | null => {
      let floor = ground(cx, cz, params.reach, y + rise);
      if (floor === null || floor - y > rise) return null;
      // A step up needs headroom where she will stand. With none, she walks on
      // at her own level - the higher surface is usually only the edge of her
      // reach (a lamp's flank), and refusing would hold her beside it.
      if (!fits(cx, cz, floor)) {
        const low = Math.min(rise, params.stepLimit * 0.2);
        floor = ground(cx, cz, params.reach, y + low);
        if (floor === null || floor - y > low || !fits(cx, cz, floor)) return null;
      }
      if (airborne || y - floor > params.stepLimit) return floor;
      const look = params.lookahead ?? 0;
      const ux = cx - x; const uz = cz - z;
      const d = Math.hypot(ux, uz);
      if (look > 0 && d > 0) {
        // Asked from two steps up, so a surface too steep to stand on is seen.
        const ahead = floorAt(cx + (ux / d) * look, cz + (uz / d) * look, params.reach, y + params.stepLimit * 2);
        if (ahead !== null && ahead - y > params.stepLimit) return null;
      }
      return floor;
    };
    const take = (cx: number, cz: number): boolean => {
      const floor = standAt(cx, cz);
      if (floor === null) return false;
      x = cx; z = cz; movedFloor = stuck > 0 ? Math.min(floor, y) : floor;
      return true;
    };
    // Collide and slide: take the move, push the body out of what it entered,
    // keep it if that still went forward. A bump along a wall costs a little
    // speed instead of stopping her.
    const pushed = stuck === 0 ? pushAt(nx, nz, y) : null;
    if (pushed && (pushed.x - x) * dx + (pushed.z - z) * dz > 0 && take(pushed.x, pushed.z)) {
      // slid
    } else if (!take(nx, nz)) {
      // Per-axis slide, the way GameEditor's walk preview resolves a blocked
      // move (Docs/2026-09-24-motion-cleanup-port/04-environment-colliders.md,
      // section A2). A diagonal refused as a whole is usually free along one of
      // its axes, and sliding along a wall is what a reader expects from
      // walking into one at an angle; refusing the whole move reads as being
      // glued to it. X first, then Z from wherever X landed, so a corner
      // resolves in one frame. An axis the move has no part in is skipped:
      // "moving" to where she stands would re-read her floor from a step up.
      if (nx !== x) take(nx, z);
      if (nz !== z) take(x, nz);
    }
  }

  const here = ground(x, z, params.reach, y + params.stepLimit);
  // Standing still she settles on the floor she last stepped onto, never
  // higher: a fresh read from a step above her would ride her up a slope
  // beside her. A fresh walk has no floor yet and takes the probe's, so a
  // spawn placed off the floor rises to it once.
  const remembered = state.floor ?? here;
  const settleTo = movedFloor ?? (here === null ? null : remembered === null ? here : Math.min(here, remembered));
  // Walked off a ledge: fall from rest.
  if (!airborne && settleTo !== null && y - settleTo > params.stepLimit) {
    airborne = true;
    vy = 0;
  }
  if (airborne) {
    // Falling with nothing below, two body heights under where she last stood
    // clear: put her back there rather than let her fall forever. Or after
    // MAX_AIR_SECONDS whatever the probe says. A fall with a floor below is
    // left alone until then.
    const safe = state.safe;
    const airTime = (state.airTime ?? 0) + dt;
    if (safe && ((here === null && vy < 0 && y < safe.y - params.stepLimit * 8) || airTime > MAX_AIR_SECONDS)) {
      // Recorded before the walls existed, it can be inside one now.
      const back = overlapAt(safe.x, safe.z, safe.y) > 0 ? walls!.resolve(safe.x, safe.z, safe.y) ?? safe : safe;
      const to = { x: back.x, y: safe.y, z: back.z };
      return { ...to, heading, moving, running, vy: 0, airborne: false, floor: safe.y, safe: to };
    }
    vy -= params.gravity * dt;
    const nextY = y + vy * dt;
    // Moving vertically into something - a flared lampshade on the way down,
    // an overhang's edge on the way up - pushes her out sideways, so she slides
    // off it rather than sinking in and later landing on it. Any new overlap
    // counts, not only more of it: a thin ceiling has a constant count.
    // The floor to land on, re-read if a push moves her off the spot `here`
    // was read at.
    const landingFrom = y + params.stepLimit;
    let below = here;
    const into = overlapAt(x, z, nextY);
    if (into > 0 && into >= stuck) {
      const p = pushAt(x, z, nextY);
      if (p && overlapAt(p.x, p.z, nextY) <= Math.min(stuck, into - 1) && ground(p.x, p.z, params.reach, nextY + params.stepLimit) !== null) {
        below = ground(p.x, p.z, params.reach, landingFrom);
        x = p.x; z = p.z; y = nextY;
      } else if (vy > 0) {
        // A ceiling: the rise stops.
        vy = 0;
      } else if ((x !== x0 || z !== z0) && legsIn(x, z, nextY) && !legsIn(x0, z0, nextY)) {
        // Her drift carried her over the edge of something her legs would now
        // fall into: drop straight down where she was instead.
        below = ground(x0, z0, params.reach, landingFrom);
        x = x0; z = z0; y = nextY;
      } else {
        y = nextY;
      }
    } else {
      y = nextY;
    }
    // Landing is falling ONTO a floor: one at most a hair above where she was
    // last frame, not up to a step above, or inside foliage, which reads as
    // floor just under every height, each jump's peak would be a landing. The
    // hair keeps a landing on ground rising under her as she drifts forward.
    // Not onto something with no room for her either: she falls past it,
    // unless a small sideways push clears her - a floor beside a wall - or
    // falling on would only sink her deeper into solid (a gap narrower than
    // her body), when she lands where she is.
    let landable = below !== null && below <= state.y + params.stepLimit * 0.1;
    // Read from a step up, a higher surface beside her can hide the one she
    // is coming down on. With walls, the floor just under her feet counts too
    // where her body fits on it - foliage the collider sees is solid.
    if (!landable && hasWalls && vy <= 0) {
      const under = ground(x, z, params.reach, state.y + params.stepLimit * 0.1);
      if (under !== null && fitsAt(x, z, under)) { below = under; landable = true; }
    }
    if (vy <= 0 && landable && y <= below!) {
      let at: { x: number; z: number } | null = fitsAt(x, z, below!) ? { x, z } : null;
      if (!at && hasWalls) {
        const p = walls!.resolve(x, z, below!);
        if (p && Math.hypot(p.x - x, p.z - z) <= walls!.bodyHeight * 0.25 && fitsAt(p.x, p.z, below!)) at = p;
        else if (overlapAt(x, z, below!) < overlapAt(x, z, y)) at = { x, z };
      }
      if (at) {
        return { x: at.x, y: below!, z: at.z, heading, moving, running, vy: 0, airborne: false, floor: below!, safe: state.safe, stuckBase: stuckFor(below!) };
      }
    }
    return { x, y, z, heading, moving, running, vy, airborne, safe: state.safe, airTime, stuckBase: stuckFor(y) };
  }
  if (settleTo !== null && Math.abs(settleTo - y) <= params.stepLimit * 2) {
    y += (settleTo - y) * Math.min(1, params.settle * dt);
  }
  const safe = overlapAt(x, z, y) === 0 ? { x, y, z } : state.safe;
  return { x, y, z, heading, moving, running, vy, airborne, floor: settleTo ?? undefined, safe, stuckBase: stuckFor(y) };
}

/** Held-key tracking for the walk. Ignores keystrokes aimed at text fields. */
export function walkInputFromKeys(keys: ReadonlySet<string>): WalkInput {
  return {
    forward: keys.has('w') || keys.has('arrowup'),
    back: keys.has('s') || keys.has('arrowdown'),
    left: keys.has('a') || keys.has('arrowleft'),
    right: keys.has('d') || keys.has('arrowright'),
    run: keys.has('shift'),
    jump: keys.has(' '),
  };
}
