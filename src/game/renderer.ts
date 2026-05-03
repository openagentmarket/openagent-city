import type { CanvasPetPayload } from "../CanvasRoom";
import { petSpritesheetRows, PetSpritesheetState } from "../petAnimation";
import { Furniture, GuestPet, Point, RoomLayout, Tile } from "./types";

export type PlayerRenderState = {
  image: HTMLImageElement;
  pet: CanvasPetPayload;
  position: Point;
  frameIndex: number;
  flipX: boolean;
  state: "idle" | "walk";
  spritesheetState: PetSpritesheetState;
};

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

export function drawTextPill(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: { font?: string; fill?: string; stroke?: string; onlineDot?: boolean } = {},
) {
  context.save();
  context.font = options.font ?? "800 13px Avenir Next, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";

  const metrics = context.measureText(text);
  const dotSpace = options.onlineDot ? 14 : 0;
  const width = metrics.width + 18 + dotSpace;
  const height = 27;
  const left = x - width / 2;

  context.fillStyle = options.fill ?? "rgba(255, 248, 238, 0.96)";
  roundedRect(context, left, y - height / 2, width, height, 7);
  context.fill();
  context.strokeStyle = options.stroke ?? "rgba(43, 33, 24, 0.72)";
  context.lineWidth = 2;
  context.stroke();
  if (options.onlineDot) {
    context.fillStyle = "#38d96f";
    context.strokeStyle = "rgba(43, 33, 24, 0.52)";
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(left + 13, y, 4.5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.fillStyle = "#2b2118";
  context.fillText(text, x + dotSpace / 2, y + 1);
  context.restore();
}

function drawBlock(
  context: CanvasRenderingContext2D,
  item: Furniture,
) {
  context.save();
  context.shadowColor = "rgba(63, 45, 30, 0.12)";
  context.shadowBlur = 0;
  context.shadowOffsetY = 12;
  context.fillStyle = item.color;
  roundedRect(context, item.x, item.y, item.width, item.height, 10);
  context.fill();
  context.shadowColor = "transparent";
  context.strokeStyle = "rgba(50, 36, 25, 0.75)";
  context.lineWidth = 4;
  context.stroke();

  if (item.label) {
    context.fillStyle = item.kind === "board" ? "#38271a" : "#fff8ee";
    context.font = "800 14px Avenir Next, sans-serif";
    context.textAlign = item.kind === "board" ? "left" : "center";
    context.textBaseline = "middle";

    const lines = item.label.split("\n");
    lines.forEach((line, index) => {
      context.fillText(
        line,
        item.kind === "board" ? item.x + 20 : item.x + item.width / 2,
        item.kind === "board" ? item.y + 30 + index * 28 : item.y + item.height / 2 + 1,
      );
    });
  }

  context.restore();
}

function drawPlant(context: CanvasRenderingContext2D, item: Furniture) {
  const x = item.x + item.width / 2;
  const y = item.y + 42;

  context.save();
  context.fillStyle = "#9b5f37";
  roundedRect(context, x - 22, y + 38, 44, 34, 12);
  context.fill();
  context.fillStyle = "#3d8f62";
  context.beginPath();
  context.arc(x - 18, y + 24, 22, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#4ea86f";
  context.beginPath();
  context.arc(x + 6, y + 8, 28, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#2f7754";
  context.beginPath();
  context.arc(x + 24, y + 32, 20, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

export function drawRoom(context: CanvasRenderingContext2D, layout: RoomLayout) {
  context.fillStyle = layout.floor.base;
  context.fillRect(0, 0, layout.width, layout.height);

  context.strokeStyle = layout.floor.grid;
  context.lineWidth = 1;
  for (let x = 0; x <= layout.width; x += layout.tileSize) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, layout.height);
    context.stroke();
  }
  for (let y = 0; y <= layout.height; y += layout.tileSize) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(layout.width, y);
    context.stroke();
  }

  for (const item of layout.furniture) {
    if (item.kind === "plant") {
      drawPlant(context, item);
    } else {
      drawBlock(context, item);
    }
  }
}

export function drawGuest(context: CanvasRenderingContext2D, guest: GuestPet, time: number) {
  const bob = Math.sin(time / 380 + guest.phase) * 5;
  const x = guest.x;
  const y = guest.y + bob;

  drawTextPill(context, guest.status, x, y - 104);

  context.save();
  context.shadowColor = "rgba(65, 43, 22, 0.16)";
  context.shadowBlur = 18;
  context.shadowOffsetY = 18;
  context.fillStyle = guest.color;
  context.beginPath();
  context.ellipse(x, y - 36, 39, 50, 0, 0, Math.PI * 2);
  context.fill();
  context.shadowColor = "transparent";
  context.strokeStyle = "#2b2118";
  context.lineWidth = 4;
  context.stroke();
  context.fillStyle = "#2b2118";
  context.beginPath();
  context.arc(x - 15, y - 45, 5, 0, Math.PI * 2);
  context.arc(x + 15, y - 45, 5, 0, Math.PI * 2);
  context.fill();
  context.restore();

  drawTextPill(context, guest.name, x, y + 34, { font: "900 13px Avenir Next, sans-serif" });
}

export function drawPlayer(context: CanvasRenderingContext2D, state: PlayerRenderState) {
  const { image, pet, position, frameIndex, flipX } = state;
  const isOnline = pet.isOnline === true;
  const sourceFrameWidth = image.naturalWidth % 8 === 0 ? image.naturalWidth / 8 : pet.frameWidth;
  const sourceFrameHeight = image.naturalHeight % 9 === 0 ? image.naturalHeight / 9 : pet.frameHeight;
  const displayWidth = 96;
  const displayHeight = (sourceFrameHeight / sourceFrameWidth) * displayWidth;
  const spritesheet = petSpritesheetRows[state.spritesheetState] ?? petSpritesheetRows.idle;
  const atlasRows = Math.floor(image.naturalHeight / sourceFrameHeight);
  const row = atlasRows > spritesheet.row ? spritesheet.row : 0;
  const frame = frameIndex % spritesheet.frames;
  const sourceX = frame * sourceFrameWidth;
  const sourceY = row * sourceFrameHeight;
  const shouldFlip = flipX && state.spritesheetState !== "running-left";

  context.save();
  context.shadowColor = "rgba(65, 43, 22, 0.2)";
  context.shadowBlur = 22;
  context.shadowOffsetY = 18;

  if (shouldFlip) {
    context.translate(position.x, 0);
    context.scale(-1, 1);
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceFrameWidth,
      sourceFrameHeight,
      -displayWidth / 2,
      position.y - displayHeight,
      displayWidth,
      displayHeight,
    );
  } else {
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceFrameWidth,
      sourceFrameHeight,
      position.x - displayWidth / 2,
      position.y - displayHeight,
      displayWidth,
      displayHeight,
    );
  }

  context.restore();
  drawTextPill(context, pet.name, position.x, position.y + 22, {
    font: "900 13px Avenir Next, sans-serif",
    onlineDot: isOnline,
  });

  const status = pet.status?.trim() || (state.state === "idle" ? "idle" : "");

  if (status) {
    drawTextPill(context, status, position.x, position.y - displayHeight - 18);
  }
}

export function drawEmptyMarker(context: CanvasRenderingContext2D, spawn: Point) {
  drawTextPill(context, "Upload a pet to enter", spawn.x, spawn.y - 60, {
    font: "900 14px Avenir Next, sans-serif",
  });
  context.save();
  context.strokeStyle = "rgba(43, 33, 24, 0.58)";
  context.setLineDash([10, 8]);
  context.lineWidth = 4;
  context.beginPath();
  context.arc(spawn.x, spawn.y + 10, 54, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

export function drawPath(context: CanvasRenderingContext2D, path: Point[]) {
  if (!path.length) {
    return;
  }

  context.save();
  context.strokeStyle = "rgba(43, 33, 24, 0.18)";
  context.fillStyle = "rgba(43, 33, 24, 0.18)";
  context.lineWidth = 3;
  context.setLineDash([8, 8]);
  context.beginPath();
  path.forEach((point, index) => {
    if (index === 0) {
      context.moveTo(point.x, point.y);
    } else {
      context.lineTo(point.x, point.y);
    }
  });
  context.stroke();
  for (const point of path) {
    context.beginPath();
    context.arc(point.x, point.y, 4, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

export function drawWalkableOverlay(
  context: CanvasRenderingContext2D,
  layout: RoomLayout,
  isWalkable: (tile: Tile) => boolean,
) {
  context.save();
  for (let row = 0; row < layout.height / layout.tileSize; row += 1) {
    for (let col = 0; col < layout.width / layout.tileSize; col += 1) {
      if (isWalkable({ col, row })) {
        continue;
      }

      context.fillStyle = "rgba(119, 45, 35, 0.13)";
      context.fillRect(col * layout.tileSize, row * layout.tileSize, layout.tileSize, layout.tileSize);
    }
  }
  context.restore();
}
