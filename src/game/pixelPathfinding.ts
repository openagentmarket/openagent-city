import {
  blocksMovement,
  furniturePosition,
  pixelObjectFootprint,
  PixelOfficeAssets,
} from "./pixelAssets";
import { Point, Tile } from "./types";

function toKey(tile: Tile) {
  return `${tile.col},${tile.row}`;
}

function fromKey(key: string): Tile {
  const [col, row] = key.split(",").map(Number);
  return { col, row };
}

function tileCenter(assets: PixelOfficeAssets, tile: Tile): Point {
  return {
    x: assets.origin.x + tile.col * assets.tileSize + assets.tileSize / 2,
    y: assets.origin.y + tile.row * assets.tileSize + assets.tileSize / 2,
  };
}

export function pixelWorldSize(assets: PixelOfficeAssets) {
  return {
    width: assets.worldWidth,
    height: assets.worldHeight,
  };
}

export function pixelSpawn(assets: PixelOfficeAssets): Point {
  const spawnRow = Math.min(assets.layout.rows - 2, Math.floor(assets.layout.rows * 0.7));

  return {
    x: assets.origin.x + Math.floor(assets.layout.cols / 2) * assets.tileSize + assets.tileSize / 2,
    y: assets.origin.y + spawnRow * assets.tileSize + assets.tileSize / 2,
  };
}

export function pointToPixelTile(assets: PixelOfficeAssets, point: Point): Tile {
  const localX = point.x - assets.origin.x;
  const localY = point.y - assets.origin.y;

  return {
    col: Math.max(0, Math.min(assets.layout.cols - 1, Math.floor(localX / assets.tileSize))),
    row: Math.max(0, Math.min(assets.layout.rows - 1, Math.floor(localY / assets.tileSize))),
  };
}

export function isPixelWalkable(assets: PixelOfficeAssets, tile: Tile) {
  if (tile.col < 0 || tile.row < 0 || tile.col >= assets.layout.cols || tile.row >= assets.layout.rows) {
    return false;
  }

  const tileValue = assets.layout.tiles[tile.row * assets.layout.cols + tile.col];
  if (tileValue === 255) {
    return false;
  }

  return !assets.layout.furniture.some((placement) => {
    if (!blocksMovement(placement.type)) {
      return false;
    }

    const footprint = pixelObjectFootprint(assets, placement.type);
    if (!footprint) {
      return false;
    }

    return (
      tile.col >= placement.col &&
      tile.col < placement.col + footprint.width &&
      tile.row >= placement.row &&
      tile.row < placement.row + footprint.height
    );
  });
}

function nearestPixelWalkableTile(assets: PixelOfficeAssets, target: Tile) {
  if (isPixelWalkable(assets, target)) {
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

      if (isPixelWalkable(assets, next)) {
        return next;
      }

      visited.add(key);
      queue.push(next);
    }
  }

  return target;
}

export function findPixelPath(assets: PixelOfficeAssets, startPoint: Point, endPoint: Point) {
  const start = nearestPixelWalkableTile(assets, pointToPixelTile(assets, startPoint));
  const goal = nearestPixelWalkableTile(assets, pointToPixelTile(assets, endPoint));
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

      if (cameFrom.has(key) || !isPixelWalkable(assets, next)) {
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
    path.push(tileCenter(assets, fromKey(currentKey)));
    currentKey = cameFrom.get(currentKey) ?? null;
  }

  return path.reverse().slice(1);
}

export function furnitureDepth(assets: PixelOfficeAssets, type: string, row: number) {
  const footprint = pixelObjectFootprint(assets, type);
  return row + (footprint?.height ?? 1);
}
