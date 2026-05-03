import type { CanvasPetPayload } from "../CanvasRoom";
import { PetSpritesheetState } from "../petAnimation";
import {
  isoDepthForPoint,
  isoTileSize,
  isoWorldBounds,
  logicalPointToIsoPoint,
  tileToIsoPoint,
} from "./isometric";
import {
  furniturePosition,
  isMirroredFurniture,
  normalizeFurnitureType,
  pixelObjectFootprint,
  PixelFurniturePlacement,
  PixelOfficeAssets,
} from "./pixelAssets";
import { furnitureDepth, isPixelWalkable } from "./pixelPathfinding";
import { drawEmptyMarker, drawGuest, drawPath, drawPlayer, drawTextPill } from "./renderer";
import { GuestPet, Point } from "./types";

export type PixelRenderPlayer = {
  image: HTMLImageElement;
  pet: CanvasPetPayload;
  position: Point;
  frameIndex: number;
  flipX: boolean;
  state: "idle" | "walk";
  spritesheetState: PetSpritesheetState;
};

const officeGuests: GuestPet[] = [];

const tilePalette = new Map<number, { fill: string; stroke: string }>([
  [0, { fill: "#5d8a57", stroke: "#416940" }],
  [1, { fill: "#3d7890", stroke: "#2d5e72" }],
  [7, { fill: "#9b7446", stroke: "#765431" }],
  [8, { fill: "#59645d", stroke: "#414b45" }],
  [9, { fill: "#747c74", stroke: "#5b625b" }],
  [255, { fill: "#26231f", stroke: "#1a1816" }],
]);

function hash01(col: number, row: number, salt = 0) {
  const value = Math.sin(col * 127.1 + row * 311.7 + salt * 74.7) * 43758.5453123;
  return value - Math.floor(value);
}

function shadeHex(hex: string, amount: number) {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean, 16);
  const r = Math.max(0, Math.min(255, (value >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((value >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (value & 255) + amount));

  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function drawIsoDiamond(
  context: CanvasRenderingContext2D,
  center: Point,
  width: number,
  height: number,
  fill: string,
  stroke: string,
) {
  context.beginPath();
  context.moveTo(center.x, center.y - height / 2);
  context.lineTo(center.x + width / 2, center.y);
  context.lineTo(center.x, center.y + height / 2);
  context.lineTo(center.x - width / 2, center.y);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  context.strokeStyle = stroke;
  context.lineWidth = 1;
  context.stroke();
}

function clipIsoDiamond(context: CanvasRenderingContext2D, center: Point, width: number, height: number) {
  context.beginPath();
  context.moveTo(center.x, center.y - height / 2);
  context.lineTo(center.x + width / 2, center.y);
  context.lineTo(center.x, center.y + height / 2);
  context.lineTo(center.x - width / 2, center.y);
  context.closePath();
  context.clip();
}

function drawTileDetails(
  context: CanvasRenderingContext2D,
  tile: number,
  center: Point,
  width: number,
  height: number,
  col: number,
  row: number,
  time: number,
) {
  if (tile === 1) {
    const drift = ((time / 900 + hash01(col, row, 4) * 18) % 18) - 9;

    context.save();
    clipIsoDiamond(context, center, width, height);
    context.strokeStyle = "rgba(174, 233, 235, 0.28)";
    context.lineWidth = 2;
    for (let index = -1; index < 3; index += 1) {
      const y = center.y - height * 0.22 + index * 9 + drift * 0.2;
      context.beginPath();
      context.moveTo(center.x - width * 0.26 + drift, y);
      context.lineTo(center.x + width * 0.18 + drift, y + 5);
      context.stroke();
    }
    context.restore();
    return;
  }

  const noise = hash01(col, row, 8);

  if (tile === 0 && noise > 0.62) {
    context.save();
    context.strokeStyle = "rgba(38, 82, 41, 0.34)";
    context.lineWidth = 2;
    const x = center.x + (hash01(col, row, 9) - 0.5) * width * 0.38;
    const y = center.y + (hash01(col, row, 10) - 0.5) * height * 0.42;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + 4, y - 7);
    context.moveTo(x + 5, y + 2);
    context.lineTo(x + 10, y - 5);
    context.stroke();
    context.restore();
  }

  if ((tile === 7 || tile === 9) && noise > 0.72) {
    context.save();
    context.fillStyle = "rgba(59, 43, 31, 0.22)";
    context.beginPath();
    context.ellipse(
      center.x + (hash01(col, row, 11) - 0.5) * width * 0.34,
      center.y + (hash01(col, row, 12) - 0.5) * height * 0.34,
      3,
      2,
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();
  }
}

function drawIsoSkirtFace(
  context: CanvasRenderingContext2D,
  start: Point,
  end: Point,
  depth: number,
  fill: string,
  stroke: string,
) {
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.lineTo(end.x, end.y + depth);
  context.lineTo(start.x, start.y + depth);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  context.strokeStyle = stroke;
  context.lineWidth = 1;
  context.stroke();
}

function drawFloorSkirt(context: CanvasRenderingContext2D, assets: PixelOfficeAssets) {
  const isoTile = isoTileSize(assets);
  const depth = isoTile.height * 1.15;
  const top = tileToIsoPoint(assets, 1, 1);
  const right = tileToIsoPoint(assets, assets.layout.cols - 1, 1);
  const bottom = tileToIsoPoint(assets, assets.layout.cols - 1, assets.layout.rows - 1);
  const left = tileToIsoPoint(assets, 1, assets.layout.rows - 1);

  context.save();
  drawIsoSkirtFace(context, left, bottom, depth, "#2d4a37", "#1f3429");
  drawIsoSkirtFace(context, bottom, right, depth, "#22372f", "#172820");

  context.beginPath();
  context.moveTo(top.x, top.y);
  context.lineTo(right.x, right.y);
  context.lineTo(bottom.x, bottom.y);
  context.lineTo(left.x, left.y);
  context.closePath();
  context.strokeStyle = "rgba(230, 247, 202, 0.22)";
  context.lineWidth = 2;
  context.stroke();
  context.restore();
}

function drawFloor(context: CanvasRenderingContext2D, assets: PixelOfficeAssets, time: number) {
  const isoTile = isoTileSize(assets);

  drawFloorSkirt(context, assets);

  for (let row = 0; row < assets.layout.rows; row += 1) {
    for (let col = 0; col < assets.layout.cols; col += 1) {
      const tile = assets.layout.tiles[row * assets.layout.cols + col];

      if (tile === 255) {
        continue;
      }

      const baseColor = tilePalette.get(tile) ?? tilePalette.get(8)!;
      const shade = Math.round((hash01(col, row) - 0.5) * (tile === 1 ? 10 : 16));
      const color = {
        fill: shadeHex(baseColor.fill, shade),
        stroke: tile === 0 ? "rgba(42, 80, 42, 0.34)" : shadeHex(baseColor.stroke, Math.round(shade * 0.6)),
      };
      const center = tileToIsoPoint(assets, col, row, { center: true });
      drawIsoDiamond(context, center, isoTile.width, isoTile.height, color.fill, color.stroke);
      drawTileDetails(context, tile, center, isoTile.width, isoTile.height, col, row, time);
    }
  }
}

function drawIsoShadow(context: CanvasRenderingContext2D, base: Point, width: number, height: number, alpha = 0.18) {
  context.save();
  context.fillStyle = `rgba(20, 18, 13, ${alpha})`;
  context.beginPath();
  context.ellipse(base.x, base.y + 4, width, height, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawIsoBox(
  context: CanvasRenderingContext2D,
  base: Point,
  width: number,
  height: number,
  depth: number,
  colors: { top: string; left: string; right: string; stroke: string },
) {
  const halfW = width / 2;
  const halfH = height / 2;
  const top = base.y - depth;

  context.save();
  drawIsoShadow(context, { x: base.x + 5, y: base.y + height * 0.16 }, width * 0.5, height * 0.34, 0.16);
  context.lineWidth = 2;
  context.strokeStyle = colors.stroke;

  context.beginPath();
  context.moveTo(base.x - halfW, base.y);
  context.lineTo(base.x, base.y + halfH);
  context.lineTo(base.x, top + halfH);
  context.lineTo(base.x - halfW, top);
  context.closePath();
  context.fillStyle = colors.left;
  context.fill();
  context.stroke();

  context.beginPath();
  context.moveTo(base.x + halfW, base.y);
  context.lineTo(base.x, base.y + halfH);
  context.lineTo(base.x, top + halfH);
  context.lineTo(base.x + halfW, top);
  context.closePath();
  context.fillStyle = colors.right;
  context.fill();
  context.stroke();

  drawIsoDiamond(context, { x: base.x, y: top }, width, height, colors.top, colors.stroke);
  context.restore();
}

function drawIsoRoof(
  context: CanvasRenderingContext2D,
  base: Point,
  width: number,
  height: number,
  lift: number,
  colors: { left: string; right: string; ridge: string; stroke: string },
) {
  const halfW = width / 2;
  const halfH = height / 2;
  const eaveY = base.y - lift;
  const ridge = { x: base.x, y: eaveY - height * 0.9 };

  context.save();
  context.lineWidth = 2;
  context.strokeStyle = colors.stroke;

  context.beginPath();
  context.moveTo(base.x - halfW, eaveY);
  context.lineTo(base.x, eaveY + halfH);
  context.lineTo(ridge.x, ridge.y + halfH);
  context.lineTo(ridge.x, ridge.y);
  context.closePath();
  context.fillStyle = colors.left;
  context.fill();
  context.stroke();

  context.beginPath();
  context.moveTo(base.x + halfW, eaveY);
  context.lineTo(base.x, eaveY + halfH);
  context.lineTo(ridge.x, ridge.y + halfH);
  context.lineTo(ridge.x, ridge.y);
  context.closePath();
  context.fillStyle = colors.right;
  context.fill();
  context.stroke();

  context.fillStyle = colors.ridge;
  context.fillRect(ridge.x - 4, ridge.y - 3, 8, height * 0.7);
  context.restore();
}

function drawIsoTree(context: CanvasRenderingContext2D, base: Point, hasApples: boolean) {
  context.save();
  drawIsoShadow(context, base, 24, 8, 0.2);
  context.fillStyle = "#734d2d";
  context.fillRect(base.x - 5, base.y - 38, 10, 34);
  context.strokeStyle = "#3c2b20";
  context.lineWidth = 2;
  context.strokeRect(base.x - 5, base.y - 38, 10, 34);

  const leaves = [
    { x: -18, y: -50, r: 19, color: "#2f7754" },
    { x: 4, y: -63, r: 24, color: "#3f9a65" },
    { x: 20, y: -45, r: 18, color: "#2d6f4f" },
  ];
  for (const leaf of leaves) {
    context.fillStyle = leaf.color;
    context.beginPath();
    context.arc(base.x + leaf.x, base.y + leaf.y, leaf.r, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }

  if (hasApples) {
    context.fillStyle = "#d74435";
    for (const apple of [
      { x: -18, y: -55 },
      { x: 4, y: -70 },
      { x: 18, y: -48 },
    ]) {
      context.beginPath();
      context.arc(base.x + apple.x, base.y + apple.y, 4, 0, Math.PI * 2);
      context.fill();
    }
  }
  context.restore();
}

function drawIsoRock(context: CanvasRenderingContext2D, base: Point, crystal: boolean) {
  context.save();
  drawIsoShadow(context, base, 20, 7, crystal ? 0.16 : 0.12);
  context.lineWidth = 2;
  context.strokeStyle = crystal ? "#19455b" : "#3f4642";
  context.fillStyle = crystal ? "#5dd6ce" : "#737a72";
  context.beginPath();
  context.moveTo(base.x - 22, base.y - 8);
  context.lineTo(base.x - 6, base.y - 24);
  context.lineTo(base.x + 18, base.y - 18);
  context.lineTo(base.x + 28, base.y - 2);
  context.lineTo(base.x + 8, base.y + 10);
  context.lineTo(base.x - 18, base.y + 7);
  context.closePath();
  context.fill();
  context.stroke();

  if (crystal) {
    context.fillStyle = "rgba(255, 255, 255, 0.5)";
    context.fillRect(base.x - 2, base.y - 20, 4, 18);
  }
  context.restore();
}

function drawIsoPortal(context: CanvasRenderingContext2D, base: Point, time: number) {
  const pulse = Math.sin(time / 280) * 4;

  context.save();
  drawIsoShadow(context, base, 28, 9, 0.2);
  context.lineWidth = 5;
  context.strokeStyle = "#332147";
  context.beginPath();
  context.ellipse(base.x, base.y - 52, 24 + pulse, 42 + pulse, 0, 0, Math.PI * 2);
  context.stroke();
  context.strokeStyle = "#55f0b1";
  context.lineWidth = 3;
  context.beginPath();
  context.ellipse(base.x, base.y - 52, 18 + pulse, 34 + pulse, 0, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = "rgba(46, 17, 68, 0.62)";
  context.beginPath();
  context.ellipse(base.x, base.y - 52, 15, 30, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawProceduralObject(
  context: CanvasRenderingContext2D,
  assets: PixelOfficeAssets,
  placement: PixelFurniturePlacement,
  time: number,
) {
  const type = normalizeFurnitureType(placement.type);
  const footprint = pixelObjectFootprint(assets, placement.type);

  if (!footprint) {
    return false;
  }

  const base = logicalPointToIsoPoint(assets, {
    x: assets.origin.x + (placement.col + footprint.width / 2) * assets.tileSize,
    y: assets.origin.y + (placement.row + footprint.height) * assets.tileSize,
  });
  const naturalOffset = {
    x: (hash01(placement.col, placement.row, 20) - 0.5) * 8,
    y: (hash01(placement.col, placement.row, 21) - 0.5) * 5,
  };
  const naturalBase = {
    x: base.x + naturalOffset.x,
    y: base.y + naturalOffset.y,
  };

  if (type === "ISO_TREE" || type === "ISO_APPLE_TREE") {
    const sway = Math.sin(time / 900 + hash01(placement.col, placement.row, 22) * Math.PI * 2) * 1.5;
    drawIsoTree(context, { x: naturalBase.x + sway, y: naturalBase.y }, type === "ISO_APPLE_TREE");
    return true;
  }

  if (type === "ISO_ROCK" || type === "ISO_CRYSTAL") {
    drawIsoRock(context, naturalBase, type === "ISO_CRYSTAL");
    return true;
  }

  if (type === "ISO_PORTAL") {
    drawIsoPortal(context, naturalBase, time);
    return true;
  }

  const isoTile = isoTileSize(assets);
  const width = footprint.width * isoTile.width * 0.72;
  const height = footprint.height * isoTile.height * 0.92;
  const boxDepth = type === "ISO_WORKSHOP" ? 70 : 58;
  const roofLift = boxDepth + 6;

  drawIsoBox(context, naturalBase, width, height, boxDepth, {
    top: type === "ISO_STORAGE" ? "#c7ad7d" : "#d2b382",
    left: type === "ISO_WORKSHOP" ? "#8a6c58" : "#9d7658",
    right: type === "ISO_WORKSHOP" ? "#a47f66" : "#b88962",
    stroke: "#4b3324",
  });
  drawIsoRoof(context, naturalBase, width + 34, height + 14, roofLift, {
    left: type === "ISO_WORKSHOP" ? "#4f616a" : "#8c4534",
    right: type === "ISO_WORKSHOP" ? "#637782" : "#a7523b",
    ridge: type === "ISO_WORKSHOP" ? "#384850" : "#693023",
    stroke: "#3c2b24",
  });

  context.save();
  context.fillStyle = "#ffcf70";
  context.strokeStyle = "#4b3324";
  context.lineWidth = 2;
  context.fillRect(naturalBase.x - 12, naturalBase.y - 34, 24, 28);
  context.strokeRect(naturalBase.x - 12, naturalBase.y - 34, 24, 28);
  context.restore();

  return true;
}

function drawFurniture(
  context: CanvasRenderingContext2D,
  assets: PixelOfficeAssets,
  placement: PixelFurniturePlacement,
  time: number,
) {
  if (drawProceduralObject(context, assets, placement, time)) {
    return;
  }

  const asset = assets.furniture.get(normalizeFurnitureType(placement.type));

  if (!asset) {
    return;
  }

  const localPosition = furniturePosition(placement, assets.tileSize);
  const position = logicalPointToIsoPoint(assets, {
    x: assets.origin.x + localPosition.x + (asset.footprintW * assets.tileSize) / 2,
    y: assets.origin.y + localPosition.y + asset.footprintH * assets.tileSize,
  });
  const width = asset.width * assets.scale;
  const height = asset.height * assets.scale;
  const anchorY = isoTileSize(assets).height * 0.35;
  const mirrored = isMirroredFurniture(placement.type);

  context.save();
  context.imageSmoothingEnabled = false;

  if (mirrored) {
    context.translate(position.x, position.y);
    context.scale(-1, 1);
    context.drawImage(asset.image, 0, 0, asset.width, asset.height, -width / 2, -height + anchorY, width, height);
  } else {
    context.drawImage(
      asset.image,
      0,
      0,
      asset.width,
      asset.height,
      position.x - width / 2,
      position.y - height + anchorY,
      width,
      height,
    );
  }

  context.restore();
}

export function drawPixelOfficeBackground(context: CanvasRenderingContext2D, assets: PixelOfficeAssets, time = 0) {
  drawFloor(context, assets, time);
}

export function drawPixelOfficeEntities(
  context: CanvasRenderingContext2D,
  assets: PixelOfficeAssets,
  player: PixelRenderPlayer | null,
  remotePlayers: PixelRenderPlayer[],
  path: Point[],
  time: number,
  showDebug: boolean,
) {
  if (showDebug) {
    drawPixelCollisionOverlay(context, assets);
  }

  drawPath(context, path.map((point) => logicalPointToIsoPoint(assets, point)));

  const entries = [
    ...assets.layout.furniture.map((placement) => ({
      type: "furniture" as const,
      depth: placement.col + furnitureDepth(assets, placement.type, placement.row),
      placement,
    })),
    ...officeGuests.map((guest) => ({
      type: "guest" as const,
      depth: Math.floor(guest.y / assets.tileSize),
      guest: {
        ...guest,
        x: assets.origin.x + guest.x,
        y: assets.origin.y + guest.y,
      },
    })),
    ...(player
      ? [
          {
            type: "player" as const,
            depth: isoDepthForPoint(assets, player.position),
            player: {
              ...player,
              position: logicalPointToIsoPoint(assets, player.position),
            },
          },
        ]
      : []),
    ...remotePlayers.map((remotePlayer) => ({
      type: "player" as const,
      depth: isoDepthForPoint(assets, remotePlayer.position),
      player: {
        ...remotePlayer,
        position: logicalPointToIsoPoint(assets, remotePlayer.position),
      },
    })),
  ].sort((a, b) => a.depth - b.depth);

  for (const entry of entries) {
    if (entry.type === "furniture") {
      drawFurniture(context, assets, entry.placement, time);
    } else if (entry.type === "guest") {
      drawGuest(context, entry.guest, time);
    } else {
      drawPlayer(context, entry.player);
    }
  }
}

export function drawPixelLoading(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  label = "Loading",
) {
  context.fillStyle = "#d8c39f";
  context.fillRect(0, 0, width, height);
  drawTextPill(context, label, width / 2, height / 2, {
    font: "900 15px Avenir Next, sans-serif",
  });
}

export function drawPixelEmptyMarker(context: CanvasRenderingContext2D, spawn: Point) {
  drawEmptyMarker(context, spawn);
}

export function drawPixelCollisionOverlay(context: CanvasRenderingContext2D, assets: PixelOfficeAssets) {
  context.save();
  const isoTile = isoTileSize(assets);

  for (let row = 0; row < assets.layout.rows; row += 1) {
    for (let col = 0; col < assets.layout.cols; col += 1) {
      if (isPixelWalkable(assets, { col, row })) {
        continue;
      }

      drawIsoDiamond(
        context,
        tileToIsoPoint(assets, col, row, { center: true }),
        isoTile.width,
        isoTile.height,
        "rgba(176, 58, 46, 0.24)",
        "rgba(176, 58, 46, 0.4)",
      );
    }
  }
  context.restore();
}

export function drawPixelCredit(context: CanvasRenderingContext2D, assets: PixelOfficeAssets) {
  void context;
  void assets;
}
