import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInAnonymously, User } from "firebase/auth";
import {
  collection,
  deleteDoc,
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
  PetAnimationState,
} from "./petAnimation";
import { getFilePath, PetJson, savePetDraft, SavedPet } from "./petStorage";

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

export default function App() {
  const initialOnboarding = useMemo(() => readOnboardingState(), []);
  const [user, setUser] = useState<User | null>(null);
  const [savedPets, setSavedPets] = useState<SavedPet[]>([]);
  const [loadedPet, setLoadedPet] = useState<LoadedPet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("signing-in");
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

    const writePresence = () => {
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

      void setDoc(participantRef, {
        ownerUid: user.uid,
        petId: petPayload.petId,
        displayName: petPayload.name,
        description: petPayload.description ?? "",
        status: petPayload.status ?? "",
        animationState: petPayload.animationState,
        spritesheetUrl: petPayload.publicImageUrl,
        frameWidth: petPayload.frameWidth,
        frameHeight: petPayload.frameHeight,
        joinedAt: now,
        updatedAt: now,
      })
        .then(() => {
          setError((current) => (current === roomJoinError ? null : current));
        })
        .catch((caughtError) => {
          console.error("Codex City participant join failed", caughtError);
          setError(roomJoinError);
        });
    };

    writePresence();
    const heartbeat = window.setInterval(writePresence, roomPresenceHeartbeatMs);

    return () => {
      window.clearInterval(heartbeat);
      void deleteDoc(participantRef);
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
        const activeAfter = Date.now() - roomPresenceTtlMs;
        setRoomPets(
          snapshot.docs
            .map((participantDoc) => {
              const data = participantDoc.data();
              return {
                uid: participantDoc.id,
                petId: String(data.petId ?? participantDoc.id),
                name: String(data.displayName ?? "pet"),
                description: String(data.description ?? ""),
                status: String(data.status ?? ""),
                animationState: normalizePetAnimationState(data.animationState),
                imageUrl: String(data.spritesheetUrl ?? ""),
                frameWidth: Number(data.frameWidth ?? 128),
                frameHeight: Number(data.frameHeight ?? 128),
                updatedAt: data.updatedAt,
              };
            })
            .filter((roomPet) => timestampToMillis(roomPet.updatedAt) >= activeAfter),
        );
      },
      () => {
        setError("Could not load pets in Codex City.");
      },
    );

    return unsubscribe;
  }, [hasEnteredCity]);

  const petAssetKey = petPayload?.imageUrl ?? "";

  useEffect(() => {
    setIsPetReady(false);
  }, [petAssetKey]);

  const handlePetReadyChange = useCallback((ready: boolean) => {
    setIsPetReady(ready);
  }, []);

  const isRestoringPet = saveStatus === "signing-in" || (!!user && !hasLoadedSavedPets);
  const otherRoomPets = roomPets.filter((roomPet) => roomPet.uid !== user?.uid && roomPet.imageUrl);

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
        pet={petPayload}
        otherPets={otherRoomPets}
        onPetReadyChange={handlePetReadyChange}
      />
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
            {defaultRoomName} · {roomPets.length || 1} pet{(roomPets.length || 1) === 1 ? "" : "s"}
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
      {error ? <p className="floating-error">{error}</p> : null}
    </main>
  );
}
