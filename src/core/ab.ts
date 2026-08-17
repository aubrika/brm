// A/B harness. One experiment so far: does the LOOKAHEAD GHOST — the grey outline on the next
// target plus the connector line pointing at it — actually raise bit rate, or does it just look
// helpful? The ghost was in grid mode from the first build on the assumption that letting you plan
// the next movement while finishing this one would pay. That was never measured. This measures it.
//
// DESIGN: randomised blocks of two. Every block holds one ON run and one OFF run in a random order,
// so drift across a session — warm-up, fatigue, a wrist that stiffens up — lands on both arms about
// equally instead of loading onto whichever arm happened to come first. Free coin-flipping does not
// buy that: across the ~8 pairs a person will actually sit through, a streak of four is common
// enough to swamp the effect being measured.
//
// The player is not blind — the ghost is either on the screen or it is not — so blocking by two
// also makes the second run of each pair predictable. Accepted: blinding is impossible here, and
// balance against drift is worth more than unpredictability.
//
// The arm is assigned by the app at run start and written into the log (`RunLog.ab`), so
// scripts/analyze.mjs can pair runs exactly rather than guessing from timestamps.

export type Arm = 'on' | 'off';

/** The harness's persistent position: which block, and where inside it. */
export interface AbState {
  block: number; // 0-based pair index
  position: 0 | 1; // which run of the pair comes next
  order: Arm[]; // this pair's arm order, drawn when the pair began
}

/** What gets stamped into a run's log. */
export interface AbAssignment {
  experiment: 'ghost';
  arm: Arm;
  block: number;
  position: number;
}

const STORAGE_KEY = 'brm.ab.ghost.v1';

/** One pair's order: ON-then-OFF or OFF-then-ON, by coin flip. */
export function newBlockOrder(rand: () => number = Math.random): Arm[] {
  return rand() < 0.5 ? ['on', 'off'] : ['off', 'on'];
}

export function initialState(rand: () => number = Math.random): AbState {
  return { block: 0, position: 0, order: newBlockOrder(rand) };
}

/** The arm the next scored run will play. Pure — peeking never consumes it. */
export function peek(state: AbState): AbAssignment {
  return {
    experiment: 'ghost',
    arm: state.order[state.position] ?? 'on',
    block: state.block,
    position: state.position,
  };
}

/** Consume one run. Advancing past the second of a pair opens a new pair with a fresh coin flip. */
export function advance(state: AbState, rand: () => number = Math.random): AbState {
  if (state.position === 0) return { ...state, position: 1 };
  return { block: state.block + 1, position: 0, order: newBlockOrder(rand) };
}

/** Pairs finished so far — the number the analyzer can actually pair up. */
export function completedPairs(state: AbState): number {
  return state.block;
}

/** A stored state is only usable if it is a well-formed pair position; anything else starts over
 *  rather than silently assigning from garbage (a corrupt order would break the balance the design
 *  exists to provide). */
function isValid(s: unknown): s is AbState {
  const c = s as Partial<AbState> | null;
  return (
    !!c &&
    typeof c.block === 'number' &&
    c.block >= 0 &&
    (c.position === 0 || c.position === 1) &&
    Array.isArray(c.order) &&
    c.order.length === 2 &&
    c.order.every((a) => a === 'on' || a === 'off') &&
    c.order[0] !== c.order[1]
  );
}

export function loadAbState(): AbState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isValid(parsed)) return parsed;
    }
  } catch {
    /* ignore malformed/absent storage */
  }
  return initialState();
}

export function saveAbState(state: AbState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}
