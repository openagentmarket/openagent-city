import { Point } from "./types";
import { loadCachedImage } from "../imageCache";

export type PixelFurniturePlacement = {
  uid: string;
  type: string;
  col: number;
  row: number;
};

export type PixelOfficeLayout = {
  version: number;
  cols: number;
  rows: number;
  tiles: number[];
  furniture: PixelFurniturePlacement[];
};

export type PixelAsset = {
  id: string;
  file: string;
  folder: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
};

export type LoadedPixelAsset = PixelAsset & {
  image: HTMLImageElement;
};

export type PixelObjectFootprint = {
  width: number;
  height: number;
};

export type PixelOfficeAssets = {
  layout: PixelOfficeLayout;
  tileSize: number;
  scale: number;
  origin: Point;
  worldWidth: number;
  worldHeight: number;
  floors: Map<number, HTMLImageElement>;
  wall: HTMLImageElement;
  furniture: Map<string, LoadedPixelAsset>;
};

const assetRoot = "/assets/pixel-agents";
const sourceTileSize = 16;
const renderScale = 3;

const furnitureFolders = [
  "BIN",
  "BOOKSHELF",
  "CACTUS",
  "CLOCK",
  "COFFEE",
  "COFFEE_TABLE",
  "CUSHIONED_BENCH",
  "CUSHIONED_CHAIR",
  "DESK",
  "DOUBLE_BOOKSHELF",
  "HANGING_PLANT",
  "LARGE_PAINTING",
  "LARGE_PLANT",
  "PC",
  "PLANT",
  "PLANT_2",
  "POT",
  "SMALL_PAINTING",
  "SMALL_PAINTING_2",
  "SMALL_TABLE",
  "SOFA",
  "TABLE_FRONT",
  "WHITEBOARD",
  "WOODEN_BENCH",
  "WOODEN_CHAIR",
];

const roomWidthExpansion = 8;
const rightSideFurnitureShiftStartCol = 12;

const proceduralObjectFootprints = new Map<string, PixelObjectFootprint>([
  ["ISO_HOUSE", { width: 3, height: 3 }],
  ["ISO_WORKSHOP", { width: 4, height: 3 }],
  ["ISO_STORAGE", { width: 3, height: 2 }],
  ["ISO_PORTAL", { width: 2, height: 2 }],
  ["ISO_TREE", { width: 1, height: 1 }],
  ["ISO_APPLE_TREE", { width: 1, height: 1 }],
  ["ISO_ROCK", { width: 1, height: 1 }],
  ["ISO_CRYSTAL", { width: 1, height: 1 }],
]);

function expandedPixelOfficeLayout(layout: PixelOfficeLayout): PixelOfficeLayout {
  if (roomWidthExpansion <= 0) {
    return layout;
  }

  const expandedCols = layout.cols + roomWidthExpansion;
  const tiles = Array.from({ length: layout.rows }, (_, row) => {
    const start = row * layout.cols;
    const rowTiles = layout.tiles.slice(start, start + layout.cols);
    const rightWall = rowTiles.at(-1) ?? 255;
    const extensionTile = rowTiles.at(-2) ?? 0;

    return [...rowTiles.slice(0, -1), ...Array(roomWidthExpansion).fill(extensionTile), rightWall];
  }).flat();

  return {
    ...layout,
    cols: expandedCols,
    tiles,
    furniture: layout.furniture.map((placement) => ({
      ...placement,
      col:
        placement.col >= rightSideFurnitureShiftStartCol
          ? placement.col + roomWidthExpansion
          : placement.col,
    })),
  };
}

function makeVillageLayout(): PixelOfficeLayout {
  const cols = 48;
  const rows = 24;
  const tiles = Array.from({ length: cols * rows }, (_, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);

    if (col === 0 || row === 0 || col === cols - 1 || row === rows - 1) {
      return 255;
    }

    if (col >= cols - 7 && row > 16) {
      return 1;
    }

    if (
      Math.abs(col - row - 4) <= 1 ||
      Math.abs(col + row - 28) <= 1 ||
      Math.abs(col - row - 18) <= 1 ||
      Math.abs(col + row - (cols + 4)) <= 1
    ) {
      return 7;
    }

    if (row > 17 && col < 10) {
      return 9;
    }

    return 0;
  });

  return {
    version: 2,
    cols,
    rows,
    tiles,
    furniture: [
      { uid: "v-house-1", type: "ISO_HOUSE", col: 12, row: 8 },
      { uid: "v-house-2", type: "ISO_HOUSE", col: 19, row: 10 },
      { uid: "v-house-3", type: "ISO_HOUSE", col: 34, row: 9 },
      { uid: "v-workshop", type: "ISO_WORKSHOP", col: 15, row: 14 },
      { uid: "v-workshop-2", type: "ISO_WORKSHOP", col: 31, row: 14 },
      { uid: "v-storage", type: "ISO_STORAGE", col: 8, row: 13 },
      { uid: "v-storage-2", type: "ISO_STORAGE", col: 39, row: 13 },
      { uid: "v-portal", type: "ISO_PORTAL", col: 22, row: 6 },
      { uid: "v-portal-2", type: "ISO_PORTAL", col: 40, row: 6 },
      { uid: "v-tree-1", type: "ISO_APPLE_TREE", col: 6, row: 9 },
      { uid: "v-tree-2", type: "ISO_APPLE_TREE", col: 7, row: 10 },
      { uid: "v-tree-3", type: "ISO_TREE", col: 24, row: 12 },
      { uid: "v-tree-4", type: "ISO_TREE", col: 25, row: 13 },
      { uid: "v-tree-5", type: "ISO_TREE", col: 4, row: 7 },
      { uid: "v-tree-6", type: "ISO_APPLE_TREE", col: 27, row: 8 },
      { uid: "v-tree-7", type: "ISO_TREE", col: 3, row: 19 },
      { uid: "v-tree-8", type: "ISO_TREE", col: 28, row: 14 },
      { uid: "v-tree-9", type: "ISO_TREE", col: 36, row: 7 },
      { uid: "v-tree-10", type: "ISO_APPLE_TREE", col: 43, row: 10 },
      { uid: "v-tree-11", type: "ISO_TREE", col: 45, row: 15 },
      { uid: "v-rock-1", type: "ISO_ROCK", col: 5, row: 16 },
      { uid: "v-rock-2", type: "ISO_CRYSTAL", col: 10, row: 17 },
      { uid: "v-crystal-1", type: "ISO_CRYSTAL", col: 23, row: 15 },
      { uid: "v-rock-3", type: "ISO_ROCK", col: 14, row: 5 },
      { uid: "v-rock-4", type: "ISO_ROCK", col: 29, row: 18 },
      { uid: "v-rock-5", type: "ISO_CRYSTAL", col: 37, row: 18 },
      { uid: "v-rock-6", type: "ISO_ROCK", col: 44, row: 19 },
    ],
  };
}

function flattenManifest(folder: string, node: unknown): PixelAsset[] {
  if (!node || typeof node !== "object") {
    return [];
  }

  const record = node as Record<string, unknown>;

  if (record.type === "asset" && typeof record.id === "string" && typeof record.file === "string") {
    return [
      {
        id: record.id,
        file: record.file,
        folder,
        width: Number(record.width ?? sourceTileSize),
        height: Number(record.height ?? sourceTileSize),
        footprintW: Number(record.footprintW ?? 1),
        footprintH: Number(record.footprintH ?? 1),
      },
    ];
  }

  if (!Array.isArray(record.members)) {
    return [];
  }

  return record.members.flatMap((member) => flattenManifest(folder, member));
}

export function normalizeFurnitureType(type: string) {
  return type.split(":")[0];
}

export function pixelObjectFootprint(assets: PixelOfficeAssets, type: string): PixelObjectFootprint | null {
  const id = normalizeFurnitureType(type);
  const procedural = proceduralObjectFootprints.get(id);

  if (procedural) {
    return procedural;
  }

  const asset = assets.furniture.get(id);

  if (!asset) {
    return null;
  }

  return {
    width: asset.footprintW,
    height: asset.footprintH,
  };
}

export function isMirroredFurniture(type: string) {
  return type.endsWith(":left");
}

export function furniturePosition(placement: PixelFurniturePlacement, tileSize: number): Point {
  return {
    x: placement.col * tileSize,
    y: placement.row * tileSize,
  };
}

export function blocksMovement(type: string) {
  const id = normalizeFurnitureType(type);

  if (proceduralObjectFootprints.has(id)) {
    return true;
  }

  return ![
    "CLOCK",
    "COFFEE",
    "HANGING_PLANT",
    "LARGE_PAINTING",
    "PC_BACK",
    "PC_FRONT_OFF",
    "PC_FRONT_ON_1",
    "PC_FRONT_ON_2",
    "PC_FRONT_ON_3",
    "PC_SIDE",
    "SMALL_PAINTING",
    "SMALL_PAINTING_2",
  ].includes(id);
}

let pixelOfficeAssetsPromise: Promise<PixelOfficeAssets> | null = null;
let pixelOfficeAssetWarmupPromise: Promise<void> | null = null;

async function warmPixelOfficeAssetCache() {
  await Promise.all([
    fetch(`${assetRoot}/default-layout-1.json`).then((response) => response.json() as Promise<PixelOfficeLayout>),
    loadCachedImage(`${assetRoot}/walls/wall_0.png`),
    Promise.all(
      Array.from({ length: 9 }, async (_, index) => {
        await loadCachedImage(`${assetRoot}/floors/floor_${index}.png`);
      }),
    ),
    Promise.all(
      furnitureFolders.map(async (folder) => {
        const manifest = await fetch(`${assetRoot}/furniture/${folder}/manifest.json`).then((response) => response.json());
        const assetDefinitions = flattenManifest(folder, manifest);

        await Promise.all(
          assetDefinitions.map((asset) =>
            loadCachedImage(`${assetRoot}/furniture/${asset.folder}/${asset.file}`),
          ),
        );
      }),
    ),
  ]);
}

function startPixelOfficeAssetWarmup() {
  if (!pixelOfficeAssetWarmupPromise) {
    pixelOfficeAssetWarmupPromise = warmPixelOfficeAssetCache().catch((error) => {
      pixelOfficeAssetWarmupPromise = null;
      console.warn("Pixel office asset warmup failed", error);
    });
  }
}

async function loadPixelOfficeAssetsUncached(): Promise<PixelOfficeAssets> {
  const layout = makeVillageLayout();
  const placeholderImage = new Image();
  startPixelOfficeAssetWarmup();

  return {
    layout,
    wall: placeholderImage,
    scale: renderScale,
    tileSize: sourceTileSize * renderScale,
    origin: { x: 360, y: 220 },
    worldWidth: Math.max(1400, 360 * 2 + layout.cols * sourceTileSize * renderScale),
    worldHeight: Math.max(1200, 220 * 2 + layout.rows * sourceTileSize * renderScale),
    floors: new Map(),
    furniture: new Map(),
  };
}

export function loadPixelOfficeAssets(): Promise<PixelOfficeAssets> {
  if (!pixelOfficeAssetsPromise) {
    pixelOfficeAssetsPromise = loadPixelOfficeAssetsUncached().catch((error) => {
      pixelOfficeAssetsPromise = null;
      throw error;
    });
  }

  return pixelOfficeAssetsPromise;
}
