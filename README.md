# sokoban-solver-01

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Siezy/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Siezy/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver. The score counts pushes, not steps, so the search runs over pushes: a state is the sorted box squares plus the canonical lowest square of the region the player can reach without moving a box, and breadth-first expansion over pushes makes the first complete state reached provably push-optimal. Walking between pushes is free and is filled in by shortest-path search when a state is created.

These levels are a hallway with independent rooms off it, so the solver splits before it searches: the dead squares of the player's row (squares from which a lone box can never reach a goal) are cut out of the floor graph, each remaining component that holds boxes is one room, and a level's optimum is the sum of its rooms' optima — a box can never leave its room, because the only way out lands on a dead hallway square and such pushes are pruned. Each room holds at most 4 boxes and is solved on its own with the other rooms' boxes standing as walls; a level that does not split cleanly falls back to the same push search over the whole board.

Two deadlock prunes keep the search small without ever touching the optimum: dead squares (found by pulling boxes backwards off the goals) and frozen 2×2 blocks of walls and boxes holding a box off its goal. Every budget is a count of expanded states, never the clock, and every tie breaks by a fixed direction and square order, so two runs of the program write byte-identical answers. Before any answer is written, the solver replays it on the level and checks that every step is legal and every box ends on a goal.

On the kit's practice set it solves all five instances in exactly the optimal number of pushes (13, 16, 29, 47 and 60), for the maximum score of 1,000,000, in about 3 seconds of the 60-second wall.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Requires Node.js 22.18 or later (standard library only). Input is a directory of instances, each `<id>/level.txt` in XSB format; the answer for each lands in `out/<id>/solution.txt` as LURD move letters.

---

<sub>Entered on [make.fun](https://make.fun/?ref=y1qp32ce&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
