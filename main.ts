// sokoban-solver-01 entry by Siezy: a push-optimal Sokoban solver built around the structure of these levels.
//
// Idea: pushes are what the score counts, so the search runs over pushes, not steps. Walking between pushes is
// free, so a search state is (sorted box squares, canonical player square) where the player square is the lowest
// square of the region the player can reach without moving a box. Breadth-first expansion over pushes then makes
// the first complete state reached provably push-optimal.
//
// Levels are a hallway with independent rooms off it. Squares of the player's own row from which a lone box can
// never reach a goal ("dead" squares) are cut away; each remaining floor component that holds boxes is one room.
// A box can never leave its room (the only way out lands on a dead hallway square, which the search prunes), so a
// level's optimum is the sum of its rooms' optima and each room — at most 4 boxes — is solved on its own with the
// other rooms' boxes treated as walls. If a level does not split into rooms, the same push search runs on the
// whole board instead. All budgets are counts of expanded states, never the clock, so two runs agree byte for byte.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// [dx, dy, walk letter, push letter]; the fixed order makes every tie break the same way on every run.
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];
const ROOM_BUDGET = 900000;
const WHOLE_BUDGET = 700000;
// One work allowance shared by every search of the run, so no combination of rooms, retries and fallbacks can
// spend unbounded expansions (and memory) across the set: budgets are state counts, never the clock.
let workLeft = 3000000;

// ---------------------------------------------------------------- parsing

function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '#') continue;
      const i = y * w + x;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  // The outer frame is wall whatever the text says: nothing can leave the board.
  for (let x = 0; x < w; x++) { wall[x] = 1; wall[(h - 1) * w + x] = 1; }
  for (let y = 0; y < h; y++) { wall[y * w] = 1; wall[y * w + w - 1] = 1; }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// ------------------------------------------------------- board pre-analysis

// Squares from which a single box (ignoring the others) can be pushed onto some goal, found by pulling boxes
// backwards off the goals. A box resting anywhere else, off a goal, can never finish: such pushes are pruned.
function computeLive(wall, w, goals) {
  const live = new Uint8Array(wall.length);
  const queue = [];
  for (const g of goals) { live[g] = 1; queue.push(g); }
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    for (const [dx, dy] of DIRS) {
      const step = dy * w + dx;
      const before = cell - step; // where the box stood before a push moved it onto `cell`
      const behind = cell - 2 * step; // where the player stood for that push
      if (!wall[before] && !wall[behind] && !live[before]) { live[before] = 1; queue.push(before); }
    }
  }
  return live;
}

// Flood the player's reachable region with boxes as obstacles. Fills `region` (stamped) and returns the region's
// lowest square, which names the region canonically.
function floodRegion(wall, w, occupied, start, region, stamp, stack) {
  let low = start;
  let top = 0;
  stack[top++] = start;
  region[start] = stamp;
  while (top > 0) {
    const p = stack[--top];
    if (p < low) low = p;
    const neighbours = [p - w, p + w, p - 1, p + 1];
    for (let k = 0; k < 4; k++) {
      const q = neighbours[k];
      if (wall[q] === 0 && occupied[q] === 0 && region[q] !== stamp) { region[q] = stamp; stack[top++] = q; }
    }
  }
  return low;
}

// Shortest walk from `from` to `to` avoiding walls and boxes, as lower-case letters; '' when already there.
function walkPath(wall, w, occupied, from, to) {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const letter = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head];
    if (p === to) break;
    for (const [dx, dy, ch] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      letter[q] = ch;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let out = '';
  for (let p = to; p !== from; p = prev[p]) out = letter[p] + out;
  return out;
}

// True when the box just pushed onto `t` completes a 2x2 block of walls/boxes holding a box that is off its goal:
// every box in such a block is frozen forever, so the state can be dropped without losing the optimum.
function frozenSquare(wall, w, occupied, isGoal, t) {
  const corners = [t, t - 1, t - w, t - w - 1];
  for (const a of corners) {
    const cells = [a, a + 1, a + w, a + w + 1];
    let solid = true;
    let stranded = false;
    for (const c of cells) {
      if (!wall[c] && !occupied[c]) { solid = false; break; }
      if (occupied[c] && !isGoal[c]) stranded = true;
    }
    if (solid && stranded) return true;
  }
  return false;
}

// ------------------------------------------------------------ push-level BFS

// Push-optimal solution of one (sub)level, or null when the state budget runs out / no solution exists.
// Returns { pushes, moves } with moves a full LURD string (upper case = a push).
function solvePushBfs(level, budget) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const live = computeLive(wall, w, goals);
  for (const b of level.boxes) if (!live[b]) return null;

  const occupied = new Uint8Array(size);
  const region = new Int32Array(size);
  const probe = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // State key: boxes packed in base `size` behind the canonical player square. Exact in a double while
  // size^(boxes+1) < 2^53, which holds for every sublevel this program builds; wider states use a string key.
  const numeric = level.boxes.length <= 6 && Math.pow(size, level.boxes.length + 1) < 9007199254740992;
  const keyOf = (boxes, low) => {
    if (numeric) {
      let k = low;
      for (const b of boxes) k = k * size + b;
      return k;
    }
    return low + '|' + boxes.join(',');
  };

  const allOnGoal = (boxes) => boxes.every((b) => isGoal[b]);

  // Parallel arrays describe each state; `segment` is the move string that produced it from its parent.
  const stateBoxes = [level.boxes.slice()];
  const statePlayer = [level.player];
  const stateParent = [-1];
  const stateSegment = [''];
  const visited = new Set();

  for (const b of level.boxes) occupied[b] = 1;
  const startLow = floodRegion(wall, w, occupied, level.player, region, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  visited.add(keyOf(level.boxes, startLow));
  if (allOnGoal(level.boxes)) return { pushes: 0, moves: '' };

  const cap = Math.min(budget, workLeft);
  let found = -1;
  let head = 0;
  for (; head < stateBoxes.length && found < 0; head++) {
    if (head >= cap) { workLeft -= head; return null; }
    const boxes = stateBoxes[head];
    const player = statePlayer[head];
    for (const b of boxes) occupied[b] = 1;
    floodRegion(wall, w, occupied, player, region, ++stamp, stack);
    const here = stamp;

    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi];
      for (const [dx, dy, , pushLetter] of DIRS) {
        const step = dy * w + dx;
        const target = box + step;
        const stand = box - step;
        // The player must reach the far side, the landing square must be open, and the box must stay on live ground.
        if (region[stand] !== here || wall[target] || occupied[target] || !live[target]) continue;
        occupied[box] = 0;
        occupied[target] = 1;
        const frozen = frozenSquare(wall, w, occupied, isGoal, target);
        let key = null;
        let nextBoxes = null;
        let walk = null;
        if (!frozen) {
          nextBoxes = boxes.slice();
          nextBoxes[bi] = target;
          nextBoxes.sort((a, b) => a - b);
          const low = floodRegion(wall, w, occupied, box, probe, ++stamp, stack);
          key = keyOf(nextBoxes, low);
        }
        occupied[target] = 0;
        occupied[box] = 1;
        // The walk happens before the push, on the board as it stands: the box still sits on `box`.
        if (!frozen && key !== null && !visited.has(key)) walk = walkPath(wall, w, occupied, player, stand);
        if (frozen || walk === null || visited.has(key)) continue;
        visited.add(key);
        stateBoxes.push(nextBoxes);
        statePlayer.push(box); // after the push the player stands where the box was
        stateParent.push(head);
        stateSegment.push(walk + pushLetter);
        if (allOnGoal(nextBoxes)) found = stateBoxes.length - 1;
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  workLeft -= head;
  if (found < 0) return null;

  const segments = [];
  let pushes = 0;
  for (let s = found; s > 0; s = stateParent[s]) { segments.push(stateSegment[s]); pushes++; }
  segments.reverse();
  return { pushes, moves: segments.join('') };
}

// ------------------------------------------------------------- room splitting

// Split a level into rooms: cut the dead squares of the player's row (the hallway) out of the floor graph, then
// group what remains. Returns an array of { boxes, goals } in a fixed scan order, or null when the level is not a
// clean set of rooms (a box in the hallway, a goal in a cut square, or a room whose boxes and goals differ).
function splitRooms(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = computeLive(wall, w, goals);
  const cut = new Uint8Array(wall.length);
  const rowStart = Math.floor(player / w) * w;
  for (let i = rowStart; i < rowStart + w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  for (const b of boxes) if (cut[b]) return null;

  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const id = rooms.length;
    const squares = [s];
    part[s] = id;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      const neighbours = [p - w, p + w, p - 1, p + 1];
      for (const q of neighbours) {
        if (!wall[q] && !cut[q] && part[q] < 0) { part[q] = id; squares.push(q); }
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  const kept = rooms.filter((r) => r.boxes.length > 0);
  for (const r of kept) {
    if (r.boxes.length !== r.goals.length) return null;
    r.boxes.sort((a, b) => a - b);
    r.goals.sort((a, b) => a - b);
  }
  return kept;
}

// Solve room by room. While one room is solved, every other room's boxes stand as walls — on their starting
// squares before their turn, on their goals after it — so no push can disturb a finished room.
function solveByRooms(level, rooms) {
  let player = level.player;
  let moves = '';
  let pushes = 0;
  const finished = new Set();
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const blockers = finished.has(other) ? other.goals : other.boxes;
      for (const b of blockers) wall[b] = 1;
    }
    const sub = { w: level.w, h: level.h, wall, goals: room.goals, boxes: room.boxes, player };
    const solved = solvePushBfs(sub, ROOM_BUDGET);
    if (solved === null) return null;
    moves += solved.moves;
    pushes += solved.pushes;
    // Replay just the letters to learn where the player ends up.
    let p = player;
    for (const ch of solved.moves.toLowerCase()) p += ch === 'u' ? -level.w : ch === 'd' ? level.w : ch === 'l' ? -1 : 1;
    player = p;
    finished.add(room);
  }
  return { pushes, moves };
}

// ------------------------------------------------------------------- replay

// Replay a move string on the level; true only when every step is legal and every box ends on a goal. The solver
// checks its own answer with this before writing it, so a bug can cost points but can never emit an illegal file
// that a plain empty answer would have tied.
function replaySolves(level, moves) {
  const { w, wall } = level;
  const isGoal = new Uint8Array(wall.length);
  for (const g of level.goals) isGoal[g] = 1;
  const boxes = new Set(level.boxes);
  let player = level.player;
  for (const ch of moves.toLowerCase()) {
    const step = ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : ch === 'r' ? 1 : 0;
    if (step === 0) return false;
    const next = player + step;
    if (wall[next]) return false;
    if (boxes.has(next)) {
      const beyond = next + step;
      if (wall[beyond] || boxes.has(beyond)) return false;
      boxes.delete(next);
      boxes.add(beyond);
    }
    player = next;
  }
  for (const b of boxes) if (!isGoal[b]) return false;
  return true;
}

// Every ordering of the rooms, the identity (scan) order first, the rest in lexicographic index order.
function roomOrders(rooms) {
  const idx = rooms.map((_, i) => i);
  const orders = [];
  const build = (prefix, rest) => {
    if (rest.length === 0) { orders.push(prefix.map((i) => rooms[i])); return; }
    for (let k = 0; k < rest.length; k++) build([...prefix, rest[k]], rest.filter((_, j) => j !== k));
  };
  build([], idx);
  return orders;
}

// --------------------------------------------------------------------- main

function solveLevel(text) {
  const level = parseLevel(text);
  if (level.boxes.length === 0 || level.player < 0) return '';
  const rooms = splitRooms(level);
  if (rooms !== null && rooms.length > 0) {
    // Rooms are independent, so any solving order gives the same push total. The scan order goes first; the other
    // orders are insurance for the player getting sealed in by a finished room on some unseen layout.
    for (const order of roomOrders(rooms)) {
      const byRooms = solveByRooms(level, order);
      if (byRooms !== null && replaySolves(level, byRooms.moves)) return byRooms.moves;
      if (workLeft <= 0) break;
    }
  }
  const whole = solvePushBfs(level, WHOLE_BUDGET);
  if (whole !== null && replaySolves(level, whole.moves)) return whole.moves;
  return '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
