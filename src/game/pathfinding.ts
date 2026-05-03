import { Point, RoomLayout, Tile } from "./types";

function toKey(tile: Tile) {
  return `${tile.col},${tile.row}`;
}

function fromKey(key: string): Tile {
  const [col, row] = key.split(",").map(Number);
  return { col, row };
}

function tileCenter(layout: RoomLayout, tile: Tile): Point {
  return {
    x: tile.col * layout.tileSize + layout.tileSize / 2,
    y: tile.row * layout.tileSize + layout.tileSize / 2,
  };
}

export function pointToTile(layout: RoomLayout, point: Point): Tile {
  return {
    col: Math.max(0, Math.min(Math.floor(layout.width / layout.tileSize) - 1, Math.floor(point.x / layout.tileSize))),
    row: Math.max(0, Math.min(Math.floor(layout.height / layout.tileSize) - 1, Math.floor(point.y / layout.tileSize))),
  };
}

export function isWalkable(layout: RoomLayout, tile: Tile) {
  const cols = Math.floor(layout.width / layout.tileSize);
  const rows = Math.floor(layout.height / layout.tileSize);

  if (tile.col < 0 || tile.row < 0 || tile.col >= cols || tile.row >= rows) {
    return false;
  }

  const center = tileCenter(layout, tile);
  const padding = 8;

  return !layout.furniture.some((item) => {
    if (!item.blocksMovement) {
      return false;
    }

    return (
      center.x >= item.x - padding &&
      center.x <= item.x + item.width + padding &&
      center.y >= item.y - padding &&
      center.y <= item.y + item.height + padding
    );
  });
}

function nearestWalkableTile(layout: RoomLayout, target: Tile) {
  if (isWalkable(layout, target)) {
    return target;
  }

  const queue = [target];
  const visited = new Set([toKey(target)]);
  const directions = [
    { col: 1, row: 0 },
    { col: -1, row: 0 },
    { col: 0, row: 1 },
    { col: 0, row: -1 },
  ];

  while (queue.length) {
    const current = queue.shift()!;

    for (const direction of directions) {
      const next = {
        col: current.col + direction.col,
        row: current.row + direction.row,
      };
      const key = toKey(next);

      if (visited.has(key)) {
        continue;
      }

      if (isWalkable(layout, next)) {
        return next;
      }

      visited.add(key);
      queue.push(next);
    }
  }

  return target;
}

export function findPath(layout: RoomLayout, startPoint: Point, endPoint: Point) {
  const start = nearestWalkableTile(layout, pointToTile(layout, startPoint));
  const goal = nearestWalkableTile(layout, pointToTile(layout, endPoint));
  const startKey = toKey(start);
  const goalKey = toKey(goal);
  const queue = [start];
  const cameFrom = new Map<string, string | null>([[startKey, null]]);
  const directions = [
    { col: 1, row: 0 },
    { col: -1, row: 0 },
    { col: 0, row: 1 },
    { col: 0, row: -1 },
  ];

  while (queue.length) {
    const current = queue.shift()!;
    const currentKey = toKey(current);

    if (currentKey === goalKey) {
      break;
    }

    for (const direction of directions) {
      const next = {
        col: current.col + direction.col,
        row: current.row + direction.row,
      };
      const key = toKey(next);

      if (cameFrom.has(key) || !isWalkable(layout, next)) {
        continue;
      }

      cameFrom.set(key, currentKey);
      queue.push(next);
    }
  }

  if (!cameFrom.has(goalKey)) {
    return [];
  }

  const path: Point[] = [];
  let currentKey: string | null = goalKey;

  while (currentKey) {
    path.push(tileCenter(layout, fromKey(currentKey)));
    currentKey = cameFrom.get(currentKey) ?? null;
  }

  return path.reverse().slice(1);
}
