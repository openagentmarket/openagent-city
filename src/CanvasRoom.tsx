import { PointerEvent, useEffect, useRef } from "react";
import { isoPointToLogicalPoint, isoWorldBounds, logicalPointToIsoPoint } from "./game/isometric";
import { loadPixelOfficeAssets, PixelOfficeAssets } from "./game/pixelAssets";
import { findPixelPath, pixelSpawn } from "./game/pixelPathfinding";
import {
  drawPixelCredit,
  drawPixelEmptyMarker,
  drawPixelLoading,
  drawPixelOfficeBackground,
  drawPixelOfficeEntities,
} from "./game/pixelRenderer";
import { Point } from "./game/types";
import { loadCachedImage } from "./imageCache";
import { PetAnimationState, PetSpritesheetState } from "./petAnimation";

export type CanvasPetPayload = {
  imageUrl: string;
  name: string;
  status?: string;
  isOnline?: boolean;
  animationState: PetAnimationState;
  frameWidth: number;
  frameHeight: number;
  petId?: string;
  description?: string;
  publicImageUrl?: string;
  packageUrl?: string;
};

type PlayerState = "idle" | "walk";
type Viewport = {
  width: number;
  height: number;
  dpr: number;
};
type PetHitArea = {
  pet: CanvasPetPayload;
  x: number;
  y: number;
  width: number;
  height: number;
};

const petTapPadding = {
  x: 18,
  top: 16,
  bottom: 36,
};
const minPetTapSize = 128;

function moveAlongPath(position: Point, path: Point[], speed: number, delta: number) {
  let remaining = (speed * delta) / 1000;
  let flipX: boolean | null = null;

  while (remaining > 0 && path.length) {
    const target = path[0];
    const dx = target.x - position.x;
    const dy = target.y - position.y;
    const distance = Math.hypot(dx, dy);

    if (distance < 2) {
      path.shift();
      continue;
    }

    const step = Math.min(distance, remaining);
    position.x += (dx / distance) * step;
    position.y += (dy / distance) * step;
    remaining -= step;
    if (Math.abs(dx) > 0.2) {
      flipX = dx < 0;
    }

    if (step < distance) {
      break;
    }
  }

  return flipX;
}

function spritesheetStateForPlayer(playerState: PlayerState, petState: PetAnimationState, flipX: boolean): PetSpritesheetState {
  if (playerState === "walk") {
    return flipX ? "running-left" : "running-right";
  }

  return petState;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function computeCamera(
  position: Point,
  viewport: Viewport,
  worldBounds: { minX: number; minY: number; width: number; height: number },
) {
  if (worldBounds.width <= viewport.width && worldBounds.height <= viewport.height) {
    return {
      x: worldBounds.minX - (viewport.width - worldBounds.width) / 2,
      y: worldBounds.minY - (viewport.height - worldBounds.height) / 2,
    };
  }

  const maxX = worldBounds.minX + Math.max(0, worldBounds.width - viewport.width);
  const maxY = worldBounds.minY + Math.max(0, worldBounds.height - viewport.height);

  return {
    x:
      worldBounds.width <= viewport.width
        ? worldBounds.minX - (viewport.width - worldBounds.width) / 2
        : clamp(position.x - viewport.width / 2, worldBounds.minX, maxX),
    y:
      worldBounds.height <= viewport.height
        ? worldBounds.minY - (viewport.height - worldBounds.height) / 2
        : clamp(position.y - viewport.height / 2, worldBounds.minY, maxY),
  };
}

function resizeCanvas(canvas: HTMLCanvasElement): Viewport {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(320, rect.width);
  const height = Math.max(320, rect.height);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  return { width, height, dpr };
}

export function CanvasRoom({
  pet,
  otherPets = [],
  showDebug = false,
  onPetReadyChange,
  onPetClick,
}: {
  pet: CanvasPetPayload | null;
  otherPets?: CanvasPetPayload[];
  showDebug?: boolean;
  onPetReadyChange?: (isReady: boolean) => void;
  onPetClick?: (pet: CanvasPetPayload) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const assetsRef = useRef<PixelOfficeAssets | null>(null);
  const petRef = useRef(pet);
  const otherPetsRef = useRef(otherPets);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const otherImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const positionRef = useRef<Point>({ x: 336, y: 560 });
  const pathRef = useRef<Point[]>([]);
  const flipRef = useRef(false);
  const playerStateRef = useRef<PlayerState>("idle");
  const viewportRef = useRef<Viewport>({ width: 672, height: 704, dpr: 1 });
  const hitAreasRef = useRef<PetHitArea[]>([]);

  useEffect(() => {
    let isCurrent = true;

    void loadPixelOfficeAssets().then((assets) => {
      if (!isCurrent) {
        return;
      }

      assetsRef.current = assets;
      positionRef.current = pixelSpawn(assets);

      const canvas = canvasRef.current;
      if (canvas) {
        viewportRef.current = resizeCanvas(canvas);
      }
    });

    return () => {
      isCurrent = false;
    };
  }, []);

  useEffect(() => {
    petRef.current = pet;
  }, [pet]);

  useEffect(() => {
    otherPetsRef.current = otherPets;

    for (const otherPet of otherPets) {
      const key = otherPet.petId ?? otherPet.imageUrl;

      if (otherImagesRef.current.has(key)) {
        continue;
      }

      void loadCachedImage(otherPet.imageUrl).then((image) => {
        otherImagesRef.current.set(key, image);
      });
    }
  }, [otherPets]);

  useEffect(() => {
    imageRef.current = null;
    pathRef.current = [];
    playerStateRef.current = "idle";
    onPetReadyChange?.(false);

    if (!pet) {
      return;
    }

    let isCurrent = true;
    void loadCachedImage(pet.imageUrl)
      .then((image) => {
        if (isCurrent) {
          imageRef.current = image;
          onPetReadyChange?.(true);
        }
      })
      .catch(() => {
        if (isCurrent) {
          onPetReadyChange?.(false);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [pet?.frameHeight, pet?.frameWidth, pet?.imageUrl, onPetReadyChange]);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    viewportRef.current = resizeCanvas(canvas);

    let animationFrame = 0;
    let lastTime = performance.now();

    const render = (time: number) => {
      const delta = Math.min(32, time - lastTime);
      lastTime = time;
      const viewport = resizeCanvas(canvas);
      viewportRef.current = viewport;
      context.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, viewport.width, viewport.height);

      const assets = assetsRef.current;

      if (!assets) {
        drawPixelLoading(context, viewport.width, viewport.height);
        animationFrame = requestAnimationFrame(render);
        return;
      }

      const path = pathRef.current;
      const position = positionRef.current;

      if (path.length) {
        const flipX = moveAlongPath(position, path, 185, delta);
        if (flipX !== null) {
          flipRef.current = flipX;
        }
        playerStateRef.current = "walk";
      } else {
        playerStateRef.current = "idle";
      }

      const camera = computeCamera(logicalPointToIsoPoint(assets, position), viewport, isoWorldBounds(assets));

      context.save();
      context.translate(-camera.x, -camera.y);

      drawPixelOfficeBackground(context, assets, time);

      const currentPet = petRef.current;
      const currentOtherPets = otherPetsRef.current;
      const image = imageRef.current;

      if (currentPet && !image) {
        context.restore();
        drawPixelLoading(context, viewport.width, viewport.height, `Loading ${currentPet.name}`);
        animationFrame = requestAnimationFrame(render);
        return;
      }

      const player =
        currentPet && image
          ? {
              image,
              pet: currentPet,
              position,
              frameIndex:
                playerStateRef.current === "walk"
                  ? Math.floor(time / 95)
                  : Math.floor(time / 160),
              flipX: flipRef.current,
              state: playerStateRef.current,
              spritesheetState: spritesheetStateForPlayer(
                playerStateRef.current,
                currentPet.animationState,
                flipRef.current,
              ),
            }
          : null;
      const remotePlayers = currentOtherPets
        .map((otherPet, index) => {
          const key = otherPet.petId ?? otherPet.imageUrl;
          const otherImage = otherImagesRef.current.get(key);

          if (!otherImage) {
            return null;
          }

          const spawn = pixelSpawn(assets);
          const angle = (index / Math.max(1, currentOtherPets.length)) * Math.PI * 2 - Math.PI / 2;
          const radius = 120 + (index % 2) * 54;

          return {
            image: otherImage,
            pet: otherPet,
            position: {
              x: spawn.x + Math.cos(angle) * radius,
              y: spawn.y + Math.sin(angle) * radius * 0.55,
            },
            frameIndex: Math.floor(time / 180 + index),
            flipX: index % 2 === 0,
            state: "idle" as const,
            spritesheetState: otherPet.animationState,
          };
        })
        .filter((remotePlayer): remotePlayer is NonNullable<typeof remotePlayer> => Boolean(remotePlayer));

      hitAreasRef.current = [...remotePlayers, ...(player ? [player] : [])].map((renderPet) => {
        const sourceFrameWidth =
          renderPet.image.naturalWidth % 8 === 0
            ? renderPet.image.naturalWidth / 8
            : renderPet.pet.frameWidth;
        const sourceFrameHeight =
          renderPet.image.naturalHeight % 9 === 0
            ? renderPet.image.naturalHeight / 9
            : renderPet.pet.frameHeight;
        const width = 96;
        const height = (sourceFrameHeight / sourceFrameWidth) * width;
        const tapWidth = Math.max(minPetTapSize, width + petTapPadding.x * 2);
        const tapHeight = Math.max(minPetTapSize, height + petTapPadding.top + petTapPadding.bottom);

        return {
          pet: renderPet.pet,
          x: renderPet.position.x - tapWidth / 2,
          y: renderPet.position.y - height - petTapPadding.top,
          width: tapWidth,
          height: tapHeight,
        };
      });

      drawPixelOfficeEntities(context, assets, player, remotePlayers, pathRef.current, time, showDebug);

      if (!player) {
        drawPixelEmptyMarker(context, logicalPointToIsoPoint(assets, pixelSpawn(assets)));
      }

      drawPixelCredit(context, assets);
      context.restore();
      animationFrame = requestAnimationFrame(render);
    };

    animationFrame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrame);
    };
  }, [showDebug]);

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    event.preventDefault();

    const assets = assetsRef.current;

    if (!petRef.current || !assets) {
      return;
    }

    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    const viewport = viewportRef.current;
    const camera = computeCamera(
      logicalPointToIsoPoint(assets, positionRef.current),
      viewport,
      isoWorldBounds(assets),
    );
    const targetIso = {
      x: camera.x + event.clientX - bounds.left,
      y: camera.y + event.clientY - bounds.top,
    };
    const clickedPet = [...hitAreasRef.current].reverse().find((area) => {
      return (
        targetIso.x >= area.x &&
        targetIso.x <= area.x + area.width &&
        targetIso.y >= area.y &&
        targetIso.y <= area.y + area.height
      );
    });

    if (clickedPet) {
      onPetClick?.(clickedPet.pet);
      return;
    }

    const target = isoPointToLogicalPoint(assets, targetIso);

    pathRef.current = findPixelPath(assets, positionRef.current, target);
  }

  return <canvas ref={canvasRef} className="room-canvas" onPointerDown={handlePointerDown} />;
}
