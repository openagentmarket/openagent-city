export type Point = {
  x: number;
  y: number;
};

export type Tile = {
  col: number;
  row: number;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Furniture = Rect & {
  id: string;
  kind: "rug" | "table" | "sofa" | "plant" | "board";
  label?: string;
  color: string;
  blocksMovement: boolean;
};

export type GuestPet = Point & {
  id: string;
  name: string;
  status: string;
  color: string;
  phase: number;
};

export type RoomLayout = {
  schemaVersion: "0.1.0";
  width: number;
  height: number;
  tileSize: number;
  spawn: Point;
  floor: {
    base: string;
    grid: string;
  };
  furniture: Furniture[];
  guests: GuestPet[];
};
