import { PixelOfficeAssets } from "./pixelAssets";
import { Point } from "./types";

export type IsoBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
};

export function isoTileSize(assets: PixelOfficeAssets) {
  return {
    width: assets.tileSize * 2,
    height: assets.tileSize,
  };
}

function isoOrigin(assets: PixelOfficeAssets) {
  const tile = isoTileSize(assets);

  return {
    x: assets.layout.rows * tile.width * 0.5 + 180,
    y: 96,
  };
}

export function logicalPointToTile(assets: PixelOfficeAssets, point: Point) {
  return {
    col: (point.x - assets.origin.x) / assets.tileSize,
    row: (point.y - assets.origin.y) / assets.tileSize,
  };
}

export function tileToIsoPoint(
  assets: PixelOfficeAssets,
  col: number,
  row: number,
  options: { center?: boolean } = {},
): Point {
  const tile = isoTileSize(assets);
  const origin = isoOrigin(assets);
  const tileCol = options.center ? col + 0.5 : col;
  const tileRow = options.center ? row + 0.5 : row;

  return {
    x: origin.x + (tileCol - tileRow) * tile.width * 0.5,
    y: origin.y + (tileCol + tileRow) * tile.height * 0.5,
  };
}

export function logicalPointToIsoPoint(assets: PixelOfficeAssets, point: Point): Point {
  const tile = logicalPointToTile(assets, point);
  return tileToIsoPoint(assets, tile.col, tile.row);
}

export function isoPointToLogicalPoint(assets: PixelOfficeAssets, point: Point): Point {
  const tile = isoTileSize(assets);
  const origin = isoOrigin(assets);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const col = (dy / (tile.height * 0.5) + dx / (tile.width * 0.5)) * 0.5;
  const row = (dy / (tile.height * 0.5) - dx / (tile.width * 0.5)) * 0.5;

  return {
    x: assets.origin.x + col * assets.tileSize,
    y: assets.origin.y + row * assets.tileSize,
  };
}

export function isoWorldBounds(assets: PixelOfficeAssets): IsoBounds {
  const corners = [
    tileToIsoPoint(assets, 0, 0),
    tileToIsoPoint(assets, assets.layout.cols, 0),
    tileToIsoPoint(assets, 0, assets.layout.rows),
    tileToIsoPoint(assets, assets.layout.cols, assets.layout.rows),
  ];
  const tile = isoTileSize(assets);
  const paddingX = tile.width * 3;
  const paddingTop = tile.height * 4;
  const paddingBottom = tile.height * 10;
  const minX = Math.min(...corners.map((corner) => corner.x)) - paddingX;
  const maxX = Math.max(...corners.map((corner) => corner.x)) + paddingX;
  const minY = Math.min(...corners.map((corner) => corner.y)) - paddingTop;
  const maxY = Math.max(...corners.map((corner) => corner.y)) + paddingBottom;

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function isoDepthForPoint(assets: PixelOfficeAssets, point: Point) {
  const tile = logicalPointToTile(assets, point);
  return tile.col + tile.row;
}
