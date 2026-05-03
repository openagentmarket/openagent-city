export type PetAnimationState =
  | "idle"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export type PetSpritesheetState = PetAnimationState | "running-right" | "running-left";

export const defaultPetAnimationState: PetAnimationState = "idle";

export const petAnimationOptions: { value: PetAnimationState; label: string }[] = [
  { value: "idle", label: "Idle" },
  { value: "waiting", label: "Waiting" },
  { value: "review", label: "Review" },
  { value: "waving", label: "Wave" },
  { value: "jumping", label: "Jump" },
  { value: "failed", label: "Failed" },
  { value: "running", label: "Run" },
];

export const petSpritesheetRows: Record<PetSpritesheetState, { row: number; frames: number }> = {
  idle: { row: 0, frames: 6 },
  "running-right": { row: 1, frames: 8 },
  "running-left": { row: 2, frames: 8 },
  waving: { row: 3, frames: 4 },
  jumping: { row: 4, frames: 5 },
  failed: { row: 5, frames: 8 },
  waiting: { row: 6, frames: 6 },
  running: { row: 7, frames: 6 },
  review: { row: 8, frames: 6 },
};

const petAnimationStateValues = new Set<PetAnimationState>(
  petAnimationOptions.map((option) => option.value),
);

export function normalizePetAnimationState(value: unknown): PetAnimationState {
  return typeof value === "string" && petAnimationStateValues.has(value as PetAnimationState)
    ? (value as PetAnimationState)
    : defaultPetAnimationState;
}
