import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInAnonymously, User } from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { CanvasRoom, CanvasPetPayload } from "./CanvasRoom";
import { auth, db } from "./firebase";
import {
  defaultPetAnimationState,
  normalizePetAnimationState,
  petAnimationOptions,
  petSpritesheetRows,
  PetAnimationState,
  PetSpritesheetState,
} from "./petAnimation";
import { getFilePath, PetJson, savePetDraft, SavedPet } from "./petStorage";
import { loadCachedImage } from "./imageCache";

type LoadedPet = {
  folderName: string;
  imageUrl: string;
  imageName: string;
  frameWidth: number;
  frameHeight: number;
  petJson?: PetJson;
  savedPet?: SavedPet;
  files: File[];
};

type SaveStatus = "idle" | "signing-in" | "saving" | "saved";
type OnboardingState = {
  identityName: string;
  identityBio: string;
  publicStatus: string;
  animationState: PetAnimationState;
  hasEnteredCity: boolean;
};
type RoomParticipant = CanvasPetPayload & {
  uid: string;
  petId: string;
  description: string;
  updatedAt?: unknown;
};

const petStatePreviewOptions: { value: PetSpritesheetState; label: string }[] = [
  { value: "idle", label: "Idle" },
  { value: "running-right", label: "Run right" },
  { value: "running-left", label: "Run left" },
  { value: "waving", label: "Wave" },
  { value: "jumping", label: "Jump" },
  { value: "failed", label: "Failed" },
  { value: "waiting", label: "Waiting" },
  { value: "running", label: "Run" },
  { value: "review", label: "Review" },
];

const onboardingStorageKey = "openagent-city:onboarding:v1";
const defaultRoomId = "codex-city";
const defaultRoomName = "Codex City";
const roomPresenceTtlMs = 45_000;
const roomPresenceHeartbeatMs = 15_000;
const roomUpdateError = "Could not update Codex City. Check Firestore room rules.";
const roomJoinError = "Could not join Codex City. Check Firestore room rules.";
const petStatusError = "Could not save pet status. Check Firestore pet rules.";

const imageExtensions = [".png", ".webp", ".gif", ".jpg", ".jpeg"];

function readOnboardingState(): OnboardingState {
  try {
    const stored = localStorage.getItem(onboardingStorageKey);

    if (!stored) {
      throw new Error("missing onboarding state");
    }

    const parsed = JSON.parse(stored) as Partial<OnboardingState>;

    return {
      identityName: parsed.identityName ?? "",
      identityBio: parsed.identityBio ?? "",
      publicStatus: parsed.publicStatus ?? "",
      animationState: normalizePetAnimationState(parsed.animationState),
      hasEnteredCity: parsed.hasEnteredCity ?? false,
    };
  } catch {
    return {
      identityName: "",
      identityBio: "",
      publicStatus: "",
      animationState: defaultPetAnimationState,
      hasEnteredCity: false,
    };
  }
}

function normalizePublicStatus(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 64);
}

function findImageFile(files: File[], petJson?: PetJson) {
  const configuredPath =
    petJson?.spritesheetPath ?? petJson?.assets?.spritesheet ?? petJson?.assets?.publicImage;

  if (configuredPath) {
    const normalized = configuredPath.replace(/^\.\//, "");
    const configured = files.find((file) => {
      const path = getFilePath(file);
      return path.endsWith(normalized) || file.name === normalized;
    });

    if (configured) {
      return configured;
    }
  }

  return files.find((file) =>
    imageExtensions.some((extension) => file.name.toLowerCase().endsWith(extension)),
  );
}

function getFolderName(files: File[]) {
  const firstPath = files[0] ? getFilePath(files[0]) : "";
  return firstPath.includes("/") ? firstPath.split("/")[0] : "local pet";
}

async function readPetJson(files: File[]) {
  const petJsonFile = files.find((file) => file.name === "pet.json");

  if (!petJsonFile) {
    return undefined;
  }

  return JSON.parse(await petJsonFile.text()) as PetJson;
}

function readImageSize(imageUrl: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = imageUrl;
  });
}

function timestampToMillis(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "toMillis" in value &&
    typeof value.toMillis === "function"
  ) {
    return value.toMillis() as number;
  }

  return 0;
}

function downloadNameForPet(pet: CanvasPetPayload) {
  const safeName = pet.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${safeName || "pet"}-spritesheet.webp`;
}

function packageNameForPet(pet: CanvasPetPayload) {
  return downloadNameForPet(pet).replace(/-spritesheet\.webp$/, "-pet.zip");
}

function petFolderName(pet: CanvasPetPayload) {
  const safeName = pet.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return safeName || "pet";
}

function rootlessDownloadPath(file: File) {
  const parts = getFilePath(file).split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join("/") : file.name;
}

function downloadUrlForPet(sourceUrl: string, fileName: string) {
  try {
    const url = new URL(sourceUrl, window.location.href);

    if (url.protocol === "http:" || url.protocol === "https:") {
      const safeFileName = fileName.replace(/["\\\r\n]/g, "_");
      url.searchParams.set("response-content-disposition", `attachment; filename="${safeFileName}"`);
    }

    return url.toString();
  } catch {
    return sourceUrl;
  }
}

function triggerDownload(href: string, fileName: string) {
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

function downloadBlob(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  triggerDownload(objectUrl, fileName);
  URL.revokeObjectURL(objectUrl);
}

function petJsonForDownload(pet: CanvasPetPayload, savedPet?: SavedPet): PetJson {
  return {
    id: savedPet?.petJson?.id ?? savedPet?.localPetId ?? petFolderName(pet),
    displayName: savedPet?.petJson?.displayName ?? savedPet?.displayName ?? pet.name,
    description: savedPet?.petJson?.description ?? savedPet?.description ?? pet.description,
    spritesheetPath: savedPet?.petJson?.spritesheetPath ?? "spritesheet.webp",
  };
}

async function buildLocalPetPackage(pet: CanvasPetPayload, loadedPet: LoadedPet) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const root = petFolderName(pet);

  for (const file of loadedPet.files) {
    zip.file(`${root}/${rootlessDownloadPath(file)}`, file);
  }

  return zip.generateAsync({ type: "blob" });
}

async function buildRemotePetPackage(pet: CanvasPetPayload, savedPet?: SavedPet) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const root = petFolderName(pet);
  const petJson = petJsonForDownload(pet, savedPet);
  const spritesheetPath = petJson.spritesheetPath ?? "spritesheet.webp";
  const response = await fetch(pet.publicImageUrl || pet.imageUrl);

  if (!response.ok) {
    throw new Error(`Spritesheet download returned ${response.status}`);
  }

  zip.file(`${root}/pet.json`, `${JSON.stringify(petJson, null, 2)}\n`);
  zip.file(`${root}/${spritesheetPath.replace(/^\.\//, "")}`, await response.blob());

  return zip.generateAsync({ type: "blob" });
}

function PetStatePreview({
  pet,
  state,
}: {
  pet: CanvasPetPayload;
  state: PetSpritesheetState;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    let isCurrent = true;
    let animationFrame = 0;

    void loadCachedImage(pet.imageUrl).then((image) => {
      const sourceFrameWidth = image.naturalWidth % 8 === 0 ? image.naturalWidth / 8 : pet.frameWidth;
      const sourceFrameHeight =
        image.naturalHeight % 9 === 0 ? image.naturalHeight / 9 : pet.frameHeight;
      const rowDefinition = petSpritesheetRows[state] ?? petSpritesheetRows.idle;
      const atlasRows = Math.floor(image.naturalHeight / sourceFrameHeight);
      const row = atlasRows > rowDefinition.row ? rowDefinition.row : 0;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = 148;
      const height = 112;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const render = (time: number) => {
        if (!isCurrent) {
          return;
        }

        const frame = Math.floor(time / 170) % rowDefinition.frames;
        const displayHeight = Math.min(94, sourceFrameHeight * (88 / sourceFrameWidth));
        const displayWidth = (sourceFrameWidth / sourceFrameHeight) * displayHeight;

        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.imageSmoothingEnabled = false;
        context.clearRect(0, 0, width, height);
        context.drawImage(
          image,
          frame * sourceFrameWidth,
          row * sourceFrameHeight,
          sourceFrameWidth,
          sourceFrameHeight,
          (width - displayWidth) / 2,
          height - displayHeight - 8,
          displayWidth,
          displayHeight,
        );
        animationFrame = requestAnimationFrame(render);
      };

      animationFrame = requestAnimationFrame(render);
    });

    return () => {
      isCurrent = false;
      cancelAnimationFrame(animationFrame);
    };
  }, [pet.frameHeight, pet.frameWidth, pet.imageUrl, state]);

  return <canvas ref={canvasRef} className="pet-state-canvas" aria-hidden="true" />;
}

export default function App() {
  const initialOnboarding = useMemo(() => readOnboardingState(), []);
  const [user, setUser] = useState<User | null>(null);
  const [savedPets, setSavedPets] = useState<SavedPet[]>([]);
  const [loadedPet, setLoadedPet] = useState<LoadedPet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("signing-in");
  const [presenceNow, setPresenceNow] = useState(() => Date.now());
  const [hasLoadedSavedPets, setHasLoadedSavedPets] = useState(false);
  const [identityName, setIdentityName] = useState(initialOnboarding.identityName);
  const [identityBio, setIdentityBio] = useState(initialOnboarding.identityBio);
  const [publicStatus, setPublicStatus] = useState(initialOnboarding.publicStatus);
  const [animationState, setAnimationState] = useState<PetAnimationState>(
    initialOnboarding.animationState,
  );
  const [hasEnteredCity, setHasEnteredCity] = useState(initialOnboarding.hasEnteredCity);
  const [isPetReady, setIsPetReady] = useState(false);
  const [isNewPetOnboarding, setIsNewPetOnboarding] = useState(false);
  const [roomPets, setRoomPets] = useState<RoomParticipant[]>([]);
  const [selectedPet, setSelectedPet] = useState<CanvasPetPayload | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setSaveStatus(currentUser ? "idle" : "signing-in");

      if (!currentUser) {
        void signInAnonymously(auth).catch(() => {
          setSaveStatus("idle");
          setError("Anonymous sign-in failed. Check that Anonymous authentication is enabled in Firebase.");
        });
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user) {
      setSavedPets([]);
      setHasLoadedSavedPets(false);
      return;
    }

    setHasLoadedSavedPets(false);
    const petsQuery = query(collection(db, "pets"), where("ownerUid", "==", user.uid));
    const unsubscribe = onSnapshot(
      petsQuery,
      (snapshot) => {
        const pets = snapshot.docs
          .map((petDoc) => petDoc.data() as SavedPet)
          .sort((a, b) => b.latestVersion - a.latestVersion);

        setSavedPets(pets);
        setHasLoadedSavedPets(true);
      },
      () => {
        setHasLoadedSavedPets(true);
        setError("Could not load saved pets from the Firestore pets database.");
      },
    );

    return unsubscribe;
  }, [user]);

  useEffect(() => {
    return () => {
      if (loadedPet?.imageUrl) {
        URL.revokeObjectURL(loadedPet.imageUrl);
      }
    };
  }, [loadedPet?.imageUrl]);

  const petName = useMemo(() => {
    return (
      loadedPet?.petJson?.displayName ??
      loadedPet?.petJson?.id ??
      savedPets[0]?.displayName ??
      loadedPet?.folderName ??
      "pet"
    );
  }, [loadedPet, savedPets]);

  useEffect(() => {
    if (!petName || petName === "pet") {
      return;
    }

    setIdentityName((current) => current || petName);
  }, [petName]);

  useEffect(() => {
    const description = loadedPet?.petJson?.description ?? savedPets[0]?.description ?? "";
    setIdentityBio((current) => current || description);
  }, [loadedPet?.petJson?.description, savedPets]);

  useEffect(() => {
    const savedStatus = savedPets[0]?.publicStatus ?? "";
    setPublicStatus((current) => current || savedStatus);
  }, [savedPets]);

  useEffect(() => {
    setAnimationState((current) =>
      current === defaultPetAnimationState
        ? normalizePetAnimationState(savedPets[0]?.animationState)
        : current,
    );
  }, [savedPets]);

  useEffect(() => {
    if (savedPets[0] && !loadedPet && !isNewPetOnboarding) {
      setHasEnteredCity(true);
    }
  }, [isNewPetOnboarding, loadedPet, savedPets]);

  useEffect(() => {
    localStorage.setItem(
      onboardingStorageKey,
      JSON.stringify({
        identityName,
        identityBio,
        publicStatus,
        animationState,
        hasEnteredCity,
      } satisfies OnboardingState),
    );
  }, [identityName, identityBio, publicStatus, animationState, hasEnteredCity]);

  async function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    setError(null);
    setSaveStatus(user ? "idle" : "signing-in");

    if (!files.length) {
      return;
    }

    if (!user) {
      setError("Creating an anonymous session. Try uploading again in a few seconds.");
      return;
    }

    try {
      const petJson = await readPetJson(files);

      if (!petJson) {
        setLoadedPet(null);
        setError("This folder does not include pet.json. Choose a complete pet folder.");
        return;
      }

      const imageFile = findImageFile(files, petJson);

      if (!imageFile) {
        setLoadedPet(null);
        setError("This folder does not include a pet image. Choose a folder with spritesheet.webp or another image file.");
        return;
      }

      const imageUrl = URL.createObjectURL(imageFile);
      const imageSize = await readImageSize(imageUrl);
      const frameWidth = imageSize.width % 8 === 0 ? imageSize.width / 8 : imageSize.width;
      const frameHeight =
        imageSize.width % 8 === 0 && imageSize.height % 9 === 0
          ? imageSize.height / 9
          : imageSize.height;

      setLoadedPet((current) => {
        if (current?.imageUrl) {
          URL.revokeObjectURL(current.imageUrl);
        }

        return {
          folderName: getFolderName(files),
          imageUrl,
          imageName: imageFile.name,
          frameWidth,
          frameHeight,
          petJson,
          files,
        };
      });
      setIdentityName(petJson.displayName?.trim() || petJson.id?.trim() || getFolderName(files));
      setIdentityBio(petJson.description?.trim() || "");
      setPublicStatus("");
      setAnimationState(defaultPetAnimationState);
      setIsNewPetOnboarding(true);
      setHasEnteredCity(false);

      setSaveStatus("saving");
      const savedPet = await savePetDraft({
        uid: user.uid,
        files,
        petJson,
        imageFile,
        frameWidth,
        frameHeight,
      });

      setLoadedPet((current) => (current ? { ...current, savedPet } : current));

      setSaveStatus("saved");
    } catch (caughtError) {
      console.error("Pet upload failed", caughtError);
      setLoadedPet(null);
      setSaveStatus("idle");
      setError("Could not save this pet. Check Firebase rules, Storage, and pet.json, then try again.");
    }
  }

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    void handleFiles(event.target.files);
    event.target.value = "";
  }

  function handleAnimationStateChange(event: ChangeEvent<HTMLSelectElement>) {
    setAnimationState(normalizePetAnimationState(event.target.value));
  }

  const petPayload = useMemo(() => {
    if (loadedPet) {
      return {
        imageUrl: loadedPet.imageUrl,
        name: identityName || petName,
        status: normalizePublicStatus(publicStatus),
        animationState,
        frameWidth: loadedPet.frameWidth,
        frameHeight: loadedPet.frameHeight,
        petId: loadedPet.savedPet?.petId,
        description: identityBio,
        publicImageUrl: loadedPet.savedPet?.spritesheetUrl,
        packageUrl: loadedPet.savedPet?.packageUrl,
      };
    }

    if (savedPets[0]) {
      return {
        imageUrl: savedPets[0].spritesheetUrl,
        name: identityName || savedPets[0].displayName,
        status: normalizePublicStatus(publicStatus || savedPets[0].publicStatus || ""),
        animationState,
        frameWidth: savedPets[0].frameWidth,
        frameHeight: savedPets[0].frameHeight,
        petId: savedPets[0].petId,
        description: identityBio || savedPets[0].description || "",
        publicImageUrl: savedPets[0].spritesheetUrl,
        packageUrl: savedPets[0].packageUrl,
      };
    }

    return null;
  }, [animationState, identityBio, identityName, loadedPet, petName, publicStatus, savedPets]);

  useEffect(() => {
    if (!user || !petPayload?.petId) {
      return;
    }

    const normalizedStatus = normalizePublicStatus(publicStatus);

    void setDoc(
      doc(db, "pets", petPayload.petId),
      {
        displayName: petPayload.name,
        description: petPayload.description ?? "",
        publicStatus: normalizedStatus,
        animationState,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
      .then(() => {
        setError((current) => (current === petStatusError ? null : current));
      })
      .catch(() => {
        setError(petStatusError);
      });
  }, [
    animationState,
    petPayload?.description,
    petPayload?.name,
    petPayload?.petId,
    publicStatus,
    user,
  ]);

  useEffect(() => {
    if (!user || !hasEnteredCity || !petPayload?.petId || !petPayload.publicImageUrl) {
      return;
    }

    const roomRef = doc(db, "rooms", defaultRoomId);
    const participantRef = doc(db, "rooms", defaultRoomId, "participants", user.uid);

    const writePresence = (includeJoinedAt = false) => {
      const now = serverTimestamp();

      void setDoc(roomRef, {
        name: defaultRoomName,
        visibility: "public",
        updatedAt: now,
        createdByUid: user.uid,
      })
        .then(() => {
          setError((current) => (current === roomUpdateError ? null : current));
        })
        .catch(() => {
          setError(roomUpdateError);
        });

      const participantPayload = {
        ownerUid: user.uid,
        petId: petPayload.petId,
        displayName: petPayload.name,
        description: petPayload.description ?? "",
        status: petPayload.status ?? "",
        animationState: petPayload.animationState,
        spritesheetUrl: petPayload.publicImageUrl,
        packageUrl: petPayload.packageUrl ?? "",
        frameWidth: petPayload.frameWidth,
        frameHeight: petPayload.frameHeight,
        updatedAt: now,
        ...(includeJoinedAt ? { joinedAt: now } : {}),
      };

      void setDoc(participantRef, participantPayload, { merge: true })
        .then(() => {
          setError((current) => (current === roomJoinError ? null : current));
        })
        .catch((caughtError) => {
          console.error("Codex City participant join failed", caughtError);
          setError(roomJoinError);
        });
    };

    writePresence(true);
    const heartbeat = window.setInterval(() => writePresence(), roomPresenceHeartbeatMs);

    return () => {
      window.clearInterval(heartbeat);
    };
  }, [hasEnteredCity, petPayload, user]);

  useEffect(() => {
    if (!hasEnteredCity) {
      setRoomPets([]);
      return;
    }

    const unsubscribe = onSnapshot(
      collection(db, "rooms", defaultRoomId, "participants"),
      (snapshot) => {
        setRoomPets(
          snapshot.docs
            .map((participantDoc) => {
              const data = participantDoc.data({ serverTimestamps: "estimate" });
              return {
                uid: participantDoc.id,
                petId: String(data.petId ?? participantDoc.id),
                name: String(data.displayName ?? "pet"),
                description: String(data.description ?? ""),
                status: String(data.status ?? ""),
                animationState: normalizePetAnimationState(data.animationState),
                imageUrl: String(data.spritesheetUrl ?? ""),
                packageUrl: String(data.packageUrl ?? ""),
                frameWidth: Number(data.frameWidth ?? 128),
                frameHeight: Number(data.frameHeight ?? 128),
                updatedAt: data.updatedAt,
              };
            }),
        );
      },
      () => {
        setError("Could not load pets in Codex City.");
      },
    );

    return unsubscribe;
  }, [hasEnteredCity]);

  useEffect(() => {
    if (!hasEnteredCity) {
      return;
    }

    setPresenceNow(Date.now());
    const timer = window.setInterval(() => setPresenceNow(Date.now()), roomPresenceHeartbeatMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [hasEnteredCity]);

  const petAssetKey = petPayload?.imageUrl ?? "";

  useEffect(() => {
    setIsPetReady(false);
  }, [petAssetKey]);

  const handlePetReadyChange = useCallback((ready: boolean) => {
    setIsPetReady(ready);
  }, []);

  const handlePetClick = useCallback((clickedPet: CanvasPetPayload) => {
    setSelectedPet(clickedPet);
  }, []);

  const handleDownloadPet = useCallback(async () => {
    if (!selectedPet) {
      return;
    }

    const savedPet = savedPets.find((pet) => pet.petId === selectedPet.petId);
    const canUseLocalFiles =
      !!loadedPet &&
      (selectedPet.imageUrl === loadedPet.imageUrl ||
        (!!selectedPet.petId && selectedPet.petId === loadedPet.savedPet?.petId));

    try {
      setError(null);

      if (selectedPet.packageUrl && !canUseLocalFiles) {
        triggerDownload(selectedPet.packageUrl, packageNameForPet(selectedPet));
      } else {
        const packageBlob = canUseLocalFiles
          ? await buildLocalPetPackage(selectedPet, loadedPet)
          : await buildRemotePetPackage(selectedPet, savedPet);

        downloadBlob(packageBlob, packageNameForPet(selectedPet));
      }
    } catch (caughtError) {
      console.warn("Pet package download fell back to spritesheet", caughtError);

      const fileName = downloadNameForPet(selectedPet);
      const sourceUrl = selectedPet.publicImageUrl || selectedPet.imageUrl;
      triggerDownload(downloadUrlForPet(sourceUrl, fileName), fileName);
    }
  }, [loadedPet, savedPets, selectedPet]);

  const isRestoringPet = saveStatus === "signing-in" || (!!user && !hasLoadedSavedPets);
  const activeAfter = presenceNow - roomPresenceTtlMs;
  const visibleRoomPets = roomPets
    .map((roomPet) => ({
      ...roomPet,
      isOnline: timestampToMillis(roomPet.updatedAt) >= activeAfter,
    }))
    .sort((a, b) => Number(b.isOnline) - Number(a.isOnline));
  const otherRoomPets = visibleRoomPets.filter((roomPet) => roomPet.uid !== user?.uid && roomPet.imageUrl);
  const residentCount = Math.max(roomPets.length, hasEnteredCity && petPayload ? 1 : 0);
  const onlineCount = Math.max(
    visibleRoomPets.filter((roomPet) => roomPet.isOnline).length,
    hasEnteredCity && petPayload ? 1 : 0,
  );
  const canvasPet = petPayload && hasEnteredCity ? { ...petPayload, isOnline: true } : petPayload;

  const uploadLabel =
    saveStatus === "signing-in"
      ? "Signing in..."
      : saveStatus === "saving"
        ? "Saving..."
        : saveStatus === "saved"
          ? "Saved"
          : loadedPet
            ? petName
            : savedPets[0]
              ? savedPets[0].displayName
              : "Upload pet";

  return (
    <main className="app-shell">
      <input
        ref={inputRef}
        className="file-input"
        type="file"
        multiple
        onChange={handleUpload}
        {...{ webkitdirectory: "", directory: "" }}
      />
      <CanvasRoom
        pet={canvasPet}
        otherPets={otherRoomPets}
        onPetReadyChange={handlePetReadyChange}
        onPetClick={handlePetClick}
      />
      {selectedPet ? (
        <section className="pet-inspector" aria-label={`${selectedPet.name} states`}>
          <div className="pet-inspector-header">
            <div>
              <p className="eyebrow">Pet states</p>
              <h2>{selectedPet.name}</h2>
              {selectedPet.description ? <p>{selectedPet.description}</p> : null}
            </div>
            <button
              className="icon-action"
              type="button"
              aria-label="Close pet states"
              onClick={() => setSelectedPet(null)}
            >
              x
            </button>
          </div>
          <div className="pet-state-grid">
            {petStatePreviewOptions.map((option) => (
              <article key={option.value} className="pet-state-card">
                <PetStatePreview pet={selectedPet} state={option.value} />
                <strong>{option.label}</strong>
              </article>
            ))}
          </div>
          <button className="primary-action" type="button" onClick={handleDownloadPet}>
            Download pet folder
          </button>
        </section>
      ) : null}
      {isRestoringPet ? (
        <section className="onboarding-card loading-card">
          <p className="eyebrow">OpenAgent City</p>
          <h1>Loading your pet</h1>
          <p>Restoring your city session.</p>
          <div className="loading-bar" aria-hidden="true">
            <span />
          </div>
        </section>
      ) : !petPayload ? (
        <section className="onboarding-card gate-card">
          <p className="eyebrow">OpenAgent City</p>
          <h1>Bring your pet into the city</h1>
          <p>
            Upload a local Codex pet folder. Your pet will appear at the city gate, then join the
            shared room.
          </p>
          <button
            className="primary-action"
            disabled={!user || saveStatus === "saving"}
            onClick={() => inputRef.current?.click()}
          >
            {!user ? "Preparing..." : "Upload pet folder"}
          </button>
        </section>
      ) : !isPetReady ? (
        <section className="onboarding-card loading-card">
          <p className="eyebrow">OpenAgent City</p>
          <h1>Loading {petPayload.name}</h1>
          <p>Preparing your pet. It will enter the city in just a moment.</p>
          <div className="loading-bar" aria-hidden="true">
            <span />
          </div>
        </section>
      ) : !hasEnteredCity ? (
        <section className="onboarding-card identity-card">
          <p className="eyebrow">City Pass</p>
          <h1>{identityName || petName}</h1>
          <label>
            <span>Name</span>
            <input value={identityName} onChange={(event) => setIdentityName(event.target.value)} />
          </label>
          <label>
            <span>Bio</span>
            <textarea
              value={identityBio}
              onChange={(event) => setIdentityBio(event.target.value)}
              rows={3}
            />
          </label>
          <label>
            <span>Status</span>
            <input
              maxLength={64}
              placeholder="Helping build pet profiles"
              value={publicStatus}
              onChange={(event) => setPublicStatus(event.target.value)}
            />
          </label>
          <div className="state-control">
            <span>State</span>
            <select
              className="state-select"
              aria-label="State"
              value={animationState}
              onChange={handleAnimationStateChange}
            >
              {petAnimationOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="state-options">
              {petAnimationOptions.map((option) => (
                <button
                  key={option.value}
                  className={animationState === option.value ? "selected" : ""}
                  type="button"
                  onClick={() => setAnimationState(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <button
            className="primary-action"
            onClick={() => {
              setIsNewPetOnboarding(false);
              setHasEnteredCity(true);
            }}
          >
            Enter {defaultRoomName}
          </button>
        </section>
      ) : (
        <section className="room-panel">
          <p className="room-badge">
            {defaultRoomName} · {residentCount} resident{residentCount === 1 ? "" : "s"} ·{" "}
            {onlineCount} online
          </p>
          <label>
            <span>Status</span>
            <input
              maxLength={64}
              placeholder="idle"
              value={publicStatus}
              onChange={(event) => setPublicStatus(event.target.value)}
            />
          </label>
          <div className="state-control compact">
            <span>State</span>
            <select
              className="state-select"
              aria-label="State"
              value={animationState}
              onChange={handleAnimationStateChange}
            >
              {petAnimationOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="state-options">
              {petAnimationOptions.map((option) => (
                <button
                  key={option.value}
                  className={animationState === option.value ? "selected" : ""}
                  type="button"
                  onClick={() => setAnimationState(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}
      <button
        className="floating-upload"
        disabled={saveStatus === "signing-in" || saveStatus === "saving"}
        onClick={() => inputRef.current?.click()}
      >
        {uploadLabel}
      </button>
      <a
        className="github-link"
        href="https://github.com/openagentmarket/openagent-city"
        target="_blank"
        rel="noreferrer"
      >
        GitHub
      </a>
      {error ? <p className="floating-error">{error}</p> : null}
    </main>
  );
}
