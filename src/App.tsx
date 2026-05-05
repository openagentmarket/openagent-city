import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInAnonymously, User } from "firebase/auth";
import {
  collection,
  deleteField,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import {
  CanvasRoom,
  CanvasPetPayload,
  CommanderCommand,
  CommanderFormation,
  RoomPetLoadProgress,
} from "./CanvasRoom";
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
import {
  CityXmtpMessage,
  createCityXmtpClient,
  loadOrCreateCityGroup,
  toCityXmtpMessage,
  upsertCityXmtpMessage,
} from "./xmtp/cityXmtp";

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
  assetHash?: string;
};
type PetRenderLimit = 30 | 50 | 100 | "all";
type CityXmtpStatus = "idle" | "connecting" | "ready" | "waiting" | "error";
type CityChatDebug = {
  addAttempts: number;
  joinAttempts: number;
  lastAddMembersAt?: string;
  lastAddMembersError?: string;
  lastJoinRetryAt?: string;
  lastJoinRetryError?: string;
  lastStreamMessageAt?: string;
  lastHistoryLoadAt?: string;
  lastHistoryLoadError?: string;
  rawHistoryCount: number;
  streamState: "idle" | "starting" | "open" | "error";
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
const commanderFormationOptions: { value: CommanderFormation; label: string }[] = [
  { value: "rally", label: "Rally" },
  { value: "line", label: "Line" },
  { value: "column", label: "Column" },
];
const commanderPoseOptions: { value: PetSpritesheetState; label: string }[] = [
  ...petAnimationOptions,
  { value: "running-left", label: "Run left" },
  { value: "running-right", label: "Run right" },
];
const petRenderLimitOptions: { value: PetRenderLimit; label: string }[] = [
  { value: 30, label: "30 pets" },
  { value: 50, label: "50 pets" },
  { value: 100, label: "100 pets" },
  { value: "all", label: "All pets" },
];

const onboardingStorageKey = "openagent-city:onboarding:v1";
const defaultRoomId = "codex-city";
const defaultRoomName = "Codex City";
const roomUpdateError = "Could not update Codex City. Check Firestore room rules.";
const roomJoinError = "Could not join Codex City. Check Firestore room rules.";
const petStatusError = "Could not save pet status. Check Firestore pet rules.";
// XMTP city chat is intentionally paused. Flip this back on when we resume the XMTP work.
const enableXmtpCityChat = false;
const xmtpRoomError = "Could not start XMTP chat for Codex City.";
const defaultCityChatDebug: CityChatDebug = {
  addAttempts: 0,
  joinAttempts: 0,
  rawHistoryCount: 0,
  streamState: "idle",
};

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

function isXmtpInboxId(value?: string) {
  return Boolean(value && /^[a-f0-9]{64}$/i.test(value));
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

function assetHashFromStorageUrl(value: string) {
  return decodeURIComponent(value).match(/assets\/([^/]+)/)?.[1] ?? "";
}

function petPresenceKey(pet: CanvasPetPayload) {
  return pet.assetHash || assetHashFromStorageUrl(pet.publicImageUrl || pet.imageUrl) || pet.petId || pet.imageUrl;
}

function dedupeRoomPetsByAsset(pets: RoomParticipant[]) {
  const petsByAsset = new Map<string, RoomParticipant>();

  for (const pet of pets) {
    const key = petPresenceKey(pet);

    if (!petsByAsset.has(key)) {
      petsByAsset.set(key, pet);
    }
  }

  return [...petsByAsset.values()];
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
  const [isGateCardDismissed, setIsGateCardDismissed] = useState(false);
  const [roomPets, setRoomPets] = useState<RoomParticipant[]>([]);
  const [hasLoadedRoomPets, setHasLoadedRoomPets] = useState(false);
  const [roomPetLoadProgress, setRoomPetLoadProgress] = useState<RoomPetLoadProgress>({
    loaded: 0,
    total: 0,
  });
  const [selectedPet, setSelectedPet] = useState<CanvasPetPayload | null>(null);
  const [isCommanderMode, setIsCommanderMode] = useState(false);
  const [commanderCommand, setCommanderCommand] = useState<CommanderCommand | null>(null);
  const [petRenderLimit, setPetRenderLimit] = useState<PetRenderLimit>(30);
  const [roomXmtpGroupId, setRoomXmtpGroupId] = useState<string | null>(null);
  const [xmtpStatus, setXmtpStatus] = useState<CityXmtpStatus>("idle");
  const [xmtpInboxId, setXmtpInboxId] = useState("");
  const [xmtpAddress, setXmtpAddress] = useState("");
  const [xmtpMessages, setXmtpMessages] = useState<CityXmtpMessage[]>([]);
  const [chatText, setChatText] = useState("");
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [cityChatDebug, setCityChatDebug] = useState<CityChatDebug>(defaultCityChatDebug);
  const [cityChatResetNonce, setCityChatResetNonce] = useState(0);
  const roomXmtpGroupIdRef = useRef<string | null>(null);
  const xmtpClientRef = useRef<Awaited<ReturnType<typeof createCityXmtpClient>>["client"] | null>(
    null,
  );
  const xmtpGroupRef = useRef<Awaited<ReturnType<typeof loadOrCreateCityGroup>> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const commanderCommandIdRef = useRef(0);

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
        xmtpInboxId,
        animationState,
        frameWidth: loadedPet.frameWidth,
        frameHeight: loadedPet.frameHeight,
        petId: loadedPet.savedPet?.petId,
        assetHash: loadedPet.savedPet?.assetHash,
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
        xmtpInboxId,
        animationState,
        frameWidth: savedPets[0].frameWidth,
        frameHeight: savedPets[0].frameHeight,
        petId: savedPets[0].petId,
        assetHash: savedPets[0].assetHash,
        description: identityBio || savedPets[0].description || "",
        publicImageUrl: savedPets[0].spritesheetUrl,
        packageUrl: savedPets[0].packageUrl,
      };
    }

    return null;
  }, [animationState, identityBio, identityName, loadedPet, petName, publicStatus, savedPets, xmtpInboxId]);

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

    void getDoc(participantRef)
      .then((participantSnapshot) => {
        const participantPayload = {
          ownerUid: user.uid,
          petId: petPayload.petId,
          displayName: petPayload.name,
          description: petPayload.description ?? "",
          status: petPayload.status ?? "",
          ...(enableXmtpCityChat ? { xmtpInboxId, xmtpAddress } : {}),
          animationState: petPayload.animationState,
          ...(petPayload.assetHash ? { assetHash: petPayload.assetHash } : {}),
          spritesheetUrl: petPayload.publicImageUrl,
          packageUrl: petPayload.packageUrl ?? "",
          frameWidth: petPayload.frameWidth,
          frameHeight: petPayload.frameHeight,
          updatedAt: now,
          ...(participantSnapshot.exists() ? {} : { joinedAt: now }),
        };

        return setDoc(participantRef, participantPayload, { merge: true });
      })
      .then(() => {
        setError((current) => (current === roomJoinError ? null : current));
      })
      .catch((caughtError) => {
        console.error("Codex City participant join failed", caughtError);
        setError(roomJoinError);
      });
  }, [hasEnteredCity, petPayload, user, xmtpAddress, xmtpInboxId]);

  useEffect(() => {
    if (!enableXmtpCityChat) {
      setRoomXmtpGroupId("");
      return;
    }

    if (!user) {
      setRoomXmtpGroupId(null);
      return;
    }

    const unsubscribe = onSnapshot(doc(db, "rooms", defaultRoomId), (roomSnapshot) => {
      const data = roomSnapshot.data();
      setRoomXmtpGroupId(String(data?.xmtpGroupId ?? ""));
    });

    return unsubscribe;
  }, [user]);

  useEffect(() => {
    roomXmtpGroupIdRef.current = roomXmtpGroupId;
  }, [roomXmtpGroupId]);

  useEffect(() => {
    if (!user) {
      setRoomPets([]);
      setHasLoadedRoomPets(false);
      setRoomPetLoadProgress({ loaded: 0, total: 0 });
      return;
    }

    setHasLoadedRoomPets(false);
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
                xmtpInboxId: String(data.xmtpInboxId ?? ""),
                animationState: normalizePetAnimationState(data.animationState),
                assetHash: String(data.assetHash ?? ""),
                imageUrl: String(data.spritesheetUrl ?? ""),
                packageUrl: String(data.packageUrl ?? ""),
                githubOwner: String(data.githubOwner ?? ""),
                githubProfileUrl: String(data.githubProfileUrl ?? ""),
                sourceUrl: String(data.sourceUrl ?? ""),
                frameWidth: Number(data.frameWidth ?? 128),
                frameHeight: Number(data.frameHeight ?? 128),
              };
            }),
        );
        setHasLoadedRoomPets(true);
      },
      () => {
        setHasLoadedRoomPets(true);
        setError("Could not load pets in Codex City.");
      },
    );

    return unsubscribe;
  }, [user]);

  const hasLoadedRoomXmtpGroup = roomXmtpGroupId !== null;

  useEffect(() => {
    if (!enableXmtpCityChat || !user || !hasEnteredCity || !petPayload) {
      xmtpClientRef.current?.close();
      xmtpClientRef.current = null;
      xmtpGroupRef.current = null;
      setXmtpStatus("idle");
      setXmtpInboxId("");
      setXmtpAddress("");
      setXmtpMessages([]);
      setCityChatDebug(defaultCityChatDebug);
      return;
    }

    if (!hasLoadedRoomXmtpGroup) {
      return;
    }

    let isCurrent = true;
    let retryTimer = 0;
    let stream: { end: () => Promise<unknown> } | null = null;

    const start = async () => {
      setXmtpStatus("connecting");

      try {
        const { address, client, inboxId } = await createCityXmtpClient();

        if (!isCurrent) {
          return;
        }

        xmtpClientRef.current = client;
        setXmtpInboxId(inboxId);
        setXmtpAddress(address);

        const group = await loadOrCreateCityGroup({
          client,
          existingGroupId:
            cityChatResetNonce > 0 ? undefined : roomXmtpGroupIdRef.current || undefined,
          roomName: defaultRoomName,
        });

        if (!isCurrent) {
          return;
        }

        xmtpGroupRef.current = group;
        setXmtpStatus("ready");
        setError((current) => (current === xmtpRoomError ? null : current));

        if (!roomXmtpGroupIdRef.current || roomXmtpGroupIdRef.current !== group.id) {
          await setDoc(
            doc(db, "rooms", defaultRoomId),
            {
              name: defaultRoomName,
              xmtpGroupId: group.id,
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
        }

        await client.conversations.syncAll();
        await group.sync();
        const existingMessages = await group.messages({ limit: 100n });
        setCityChatDebug((current) => ({
          ...current,
          lastHistoryLoadAt: new Date().toLocaleTimeString(),
          lastHistoryLoadError: undefined,
          rawHistoryCount: existingMessages.length,
        }));
        setXmtpMessages(
          existingMessages
            .map(toCityXmtpMessage)
            .filter((message): message is CityXmtpMessage => Boolean(message)),
        );

        setCityChatDebug((current) => ({ ...current, streamState: "starting" }));
        stream = await group.stream({
          onValue: (message) => {
            const cityMessage = toCityXmtpMessage(message);

            if (cityMessage) {
              setCityChatDebug((current) => ({
                ...current,
                lastStreamMessageAt: new Date().toLocaleTimeString(),
                streamState: "open",
              }));
              setXmtpMessages((current) => upsertCityXmtpMessage(current, cityMessage));
            }
          },
          onError: () => {
            setCityChatDebug((current) => ({ ...current, streamState: "error" }));
            setXmtpStatus("error");
          },
        });
        setCityChatDebug((current) => ({ ...current, streamState: "open" }));
      } catch (caughtError) {
        console.warn("XMTP city chat failed", caughtError);
        setCityChatDebug((current) => ({
          ...current,
          lastHistoryLoadError:
            caughtError instanceof Error ? caughtError.message : String(caughtError),
        }));

        if (!isCurrent) {
          return;
        }

        if (roomXmtpGroupIdRef.current) {
          setXmtpStatus("waiting");
          retryTimer = window.setTimeout(start, 8000);
        } else {
          setXmtpStatus("error");
          setError(xmtpRoomError);
        }
      }
    };

    void start();

    return () => {
      isCurrent = false;
      window.clearTimeout(retryTimer);
      void stream?.end();
      xmtpGroupRef.current = null;
    };
  }, [cityChatResetNonce, hasEnteredCity, hasLoadedRoomXmtpGroup, petPayload?.petId, user]);

  useEffect(() => {
    if (!enableXmtpCityChat) {
      return;
    }

    let isCancelled = false;
    let inviteTimer = 0;

    const inviteRoomPets = async () => {
      if (isCancelled) {
        return;
      }

      const group = xmtpGroupRef.current;

      if (!group || !xmtpInboxId || xmtpStatus !== "ready") {
        return;
      }

      const inboxIds = roomPets
        .map((roomPet) => roomPet.xmtpInboxId)
        .filter(
          (inboxId): inboxId is string =>
            Boolean(inboxId && inboxId !== xmtpInboxId && isXmtpInboxId(inboxId)),
        );

      if (!inboxIds.length) {
        return;
      }

      try {
        setCityChatDebug((current) => ({
          ...current,
          addAttempts: current.addAttempts + 1,
          lastAddMembersAt: new Date().toLocaleTimeString(),
        }));
        await group.addMembers([...new Set(inboxIds)]);
      } catch (caughtError) {
        setCityChatDebug((current) => ({
          ...current,
          lastAddMembersError:
            caughtError instanceof Error ? caughtError.message : String(caughtError),
        }));
        console.warn("Could not add XMTP city members", caughtError);
      }
    };

    void inviteRoomPets();

    if (xmtpStatus === "ready") {
      inviteTimer = window.setInterval(() => {
        void inviteRoomPets();
      }, 5000);
    }

    return () => {
      isCancelled = true;
      window.clearInterval(inviteTimer);
    };
  }, [roomPets, xmtpInboxId, xmtpStatus]);

  useEffect(() => {
    if (!enableXmtpCityChat) {
      return;
    }

    if (xmtpStatus !== "waiting" || !roomXmtpGroupIdRef.current || !xmtpClientRef.current) {
      return;
    }

    let isCancelled = false;
    let retryTimer = 0;
    let stream: { end: () => Promise<unknown> } | null = null;

    const retryJoin = async () => {
      const client = xmtpClientRef.current;
      const groupId = roomXmtpGroupIdRef.current;

      if (!client || !groupId || isCancelled) {
        return;
      }

      try {
        setCityChatDebug((current) => ({
          ...current,
          joinAttempts: current.joinAttempts + 1,
          lastJoinRetryAt: new Date().toLocaleTimeString(),
        }));
        const group = await loadOrCreateCityGroup({
          client,
          existingGroupId: groupId,
          roomName: defaultRoomName,
        });

        if (isCancelled) {
          return;
        }

        xmtpGroupRef.current = group;
        setXmtpStatus("ready");

        await client.conversations.syncAll();
        await group.sync();
        const existingMessages = await group.messages({ limit: 100n });
        setCityChatDebug((current) => ({
          ...current,
          lastHistoryLoadAt: new Date().toLocaleTimeString(),
          lastHistoryLoadError: undefined,
          rawHistoryCount: existingMessages.length,
        }));
        setXmtpMessages(
          existingMessages
            .map(toCityXmtpMessage)
            .filter((message): message is CityXmtpMessage => Boolean(message)),
        );

        setCityChatDebug((current) => ({ ...current, streamState: "starting" }));
        stream = await group.stream({
          onValue: (message) => {
            const cityMessage = toCityXmtpMessage(message);

            if (cityMessage) {
              setCityChatDebug((current) => ({
                ...current,
                lastStreamMessageAt: new Date().toLocaleTimeString(),
                streamState: "open",
              }));
              setXmtpMessages((current) => upsertCityXmtpMessage(current, cityMessage));
            }
          },
          onError: () => {
            setCityChatDebug((current) => ({ ...current, streamState: "error" }));
            setXmtpStatus("error");
          },
        });
        setCityChatDebug((current) => ({ ...current, streamState: "open" }));
      } catch (caughtError) {
        setCityChatDebug((current) => ({
          ...current,
          lastHistoryLoadError:
            caughtError instanceof Error ? caughtError.message : String(caughtError),
        }));
        setCityChatDebug((current) => ({
          ...current,
          lastJoinRetryError: "Group not available to this inbox yet",
        }));
        retryTimer = window.setTimeout(retryJoin, 5000);
      }
    };

    retryTimer = window.setTimeout(retryJoin, 1500);

    return () => {
      isCancelled = true;
      window.clearTimeout(retryTimer);
      void stream?.end();
    };
  }, [xmtpStatus]);

  const petAssetKey = petPayload?.imageUrl ?? "";

  useEffect(() => {
    setIsPetReady(false);
  }, [petAssetKey]);

  const handlePetReadyChange = useCallback((ready: boolean) => {
    setIsPetReady(ready);
  }, []);

  const handleRoomPetLoadProgress = useCallback((progress: RoomPetLoadProgress) => {
    setRoomPetLoadProgress(progress);
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

  const issueCommanderCommand = useCallback((command: Omit<CommanderCommand, "id">) => {
    commanderCommandIdRef.current += 1;
    setCommanderCommand({
      id: commanderCommandIdRef.current,
      ...command,
    });
  }, []);

  const isRestoringPet = saveStatus === "signing-in" || (!!user && !hasLoadedSavedPets);
  const currentPetPresenceKey = petPayload ? petPresenceKey(petPayload) : "";
  const renderableRoomPets = useMemo(
    () => roomPets.filter((roomPet) => roomPet.imageUrl),
    [roomPets],
  );
  const allOtherRoomPets = useMemo(
    () =>
      dedupeRoomPetsByAsset(
        renderableRoomPets.filter(
          (roomPet) =>
            roomPet.uid !== user?.uid && petPresenceKey(roomPet) !== currentPetPresenceKey,
        ),
      ),
    [currentPetPresenceKey, renderableRoomPets, user?.uid],
  );
  const otherRoomPets = useMemo(
    () => (petRenderLimit === "all" ? allOtherRoomPets : allOtherRoomPets.slice(0, petRenderLimit)),
    [allOtherRoomPets, petRenderLimit],
  );
  const dedupedResidentCount = useMemo(
    () => dedupeRoomPetsByAsset(renderableRoomPets).length,
    [renderableRoomPets],
  );
  const residentCount = Math.max(dedupedResidentCount, hasEnteredCity && petPayload ? 1 : 0);
  const canvasPet = petPayload;
  const limitedRoomPetCount = otherRoomPets.length;
  const allOtherRoomPetCount = allOtherRoomPets.length;
  const roomPetProgressTotal = Math.max(roomPetLoadProgress.total, limitedRoomPetCount);
  const roomPetProgressLoaded = Math.min(roomPetLoadProgress.loaded, roomPetProgressTotal);
  const roomPetStatusLabel = !hasLoadedRoomPets
    ? "Loading city pets..."
    : roomPetProgressTotal
      ? `${roomPetProgressLoaded}/${roomPetProgressTotal} city pets loaded${
          allOtherRoomPetCount > limitedRoomPetCount ? ` · ${allOtherRoomPetCount} available` : ""
        }`
      : "No city pets online yet";
  const savedPetStatusLabel = !user
    ? "Preparing session..."
    : !hasLoadedSavedPets
      ? "Checking saved pets..."
      : `${savedPets.length} saved pet${savedPets.length === 1 ? "" : "s"} found`;
  const shouldShowLoadingStatus = isRestoringPet || !petPayload || !isPetReady;
  const chatBubbles = useMemo(() => {
    if (!enableXmtpCityChat) {
      return {};
    }

    const latestByInbox = new Map<string, CityXmtpMessage>();

    for (const message of xmtpMessages) {
      latestByInbox.set(message.senderInboxId, message);
    }

    return Object.fromEntries(
      [...latestByInbox.entries()]
        .filter(([, message]) => Date.now() - message.sentAt.getTime() < 15000)
        .map(([inboxId, message]) => [inboxId, message.text]),
    );
  }, [xmtpMessages]);
  const visibleChatMessages = xmtpMessages
    .map((message) => ({
      ...message,
      senderName: message.senderInboxId === xmtpInboxId ? petPayload?.name ?? "Pet" : "Pet",
    }))
    .slice(-6);
  const roomInboxIds = roomPets
    .map((roomPet) => roomPet.xmtpInboxId)
    .filter(isXmtpInboxId);
  const xmtpStatusLabel =
    xmtpStatus === "ready"
      ? "XMTP live"
      : xmtpStatus === "connecting"
        ? "Connecting XMTP..."
        : xmtpStatus === "waiting"
          ? "Waiting for city invite"
          : xmtpStatus === "error"
            ? "XMTP offline"
            : "XMTP idle";

  async function handleSendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!enableXmtpCityChat) {
      return;
    }

    const text = chatText.trim();
    const group = xmtpGroupRef.current;

    if (!text || !group) {
      return;
    }

    setIsSendingChat(true);
    try {
      await group.sendText(text);
      setChatText("");
    } catch (caughtError) {
      console.warn("XMTP send failed", caughtError);
      setError("Could not send XMTP message.");
    } finally {
      setIsSendingChat(false);
    }
  }

  async function handleResetCityChat() {
    if (!enableXmtpCityChat || !user) {
      return;
    }

    setXmtpStatus("connecting");
    setXmtpMessages([]);
    xmtpGroupRef.current = null;

    try {
      await setDoc(
        doc(db, "rooms", defaultRoomId),
        {
          name: defaultRoomName,
          xmtpGroupId: deleteField(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      roomXmtpGroupIdRef.current = "";
      setRoomXmtpGroupId("");
      setCityChatResetNonce((current) => current + 1);
    } catch (caughtError) {
      console.warn("Could not reset XMTP city group", caughtError);
      setError("Could not reset XMTP city chat.");
    }
  }

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
        chatBubbles={chatBubbles}
        commanderCommand={commanderCommand}
        onPetReadyChange={handlePetReadyChange}
        onRoomPetLoadProgress={handleRoomPetLoadProgress}
        onPetClick={handlePetClick}
      />
      {selectedPet ? (
        <section className="pet-inspector" aria-label={`${selectedPet.name} states`}>
          <div className="pet-inspector-header">
            <div>
              <p className="eyebrow">Pet states</p>
              <h2>{selectedPet.name}</h2>
              {selectedPet.description ? <p>{selectedPet.description}</p> : null}
              {selectedPet.githubOwner ? (
                <a
                  className="pet-source-link"
                  href={selectedPet.githubProfileUrl || `https://github.com/${selectedPet.githubOwner}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  by @{selectedPet.githubOwner}
                </a>
              ) : null}
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
      ) : !petPayload && !isGateCardDismissed ? (
        <section className="onboarding-card gate-card">
          <button
            className="icon-action onboarding-close"
            type="button"
            aria-label="Close upload panel"
            onClick={() => setIsGateCardDismissed(true)}
          >
            x
          </button>
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
      ) : petPayload && !isPetReady ? (
        <section className="onboarding-card loading-card">
          <p className="eyebrow">OpenAgent City</p>
          <h1>Loading {petPayload.name}</h1>
          <p>Preparing your pet. It will enter the city in just a moment.</p>
          <div className="loading-bar" aria-hidden="true">
            <span />
          </div>
        </section>
      ) : petPayload && !hasEnteredCity ? (
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
      ) : petPayload ? (
        <section className="room-panel">
          <p className="room-badge">
            {defaultRoomName} · {residentCount} resident{residentCount === 1 ? "" : "s"}
          </p>
          <div className="state-control compact pet-limit-control">
            <span>Load pets</span>
            <div className="state-options pet-limit-options" aria-label="Load pets">
              {petRenderLimitOptions.map((option) => (
                <button
                  key={option.value}
                  className={petRenderLimit === option.value ? "selected" : ""}
                  type="button"
                  onClick={() => setPetRenderLimit(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className={`commander-panel${isCommanderMode ? " active" : ""}`}>
            <button
              className="commander-toggle"
              type="button"
              aria-pressed={isCommanderMode}
              onClick={() => setIsCommanderMode((current) => !current)}
            >
              Commander
            </button>
            {isCommanderMode ? (
              <>
                <div className="commander-group" aria-label="Formation commands">
                  {commanderFormationOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => issueCommanderCommand({ formation: option.value })}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <div className="commander-group pose" aria-label="Pose commands">
                  {commanderPoseOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => issueCommanderCommand({ pose: option.value })}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
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
      ) : null}
      {shouldShowLoadingStatus ? (
        <div className="loading-status-badge" aria-live="polite">
          <span>
            {petPayload && !isPetReady ? "Loading your pet sprite..." : savedPetStatusLabel}
          </span>
          <span>{roomPetStatusLabel}</span>
        </div>
      ) : null}
      {enableXmtpCityChat && hasEnteredCity && petPayload ? (
        <section className="city-chat" aria-label="City XMTP chat">
          <div className="city-chat-header">
            <strong>{xmtpStatusLabel}</strong>
            <div>
              {roomXmtpGroupId ? <span>{roomXmtpGroupId.slice(0, 8)}</span> : null}
              <button type="button" onClick={handleResetCityChat}>
                Reset
              </button>
            </div>
          </div>
          <div className="city-chat-log">
            {visibleChatMessages.length ? (
              visibleChatMessages.map((message) => (
                <p key={message.id} className={message.senderInboxId === xmtpInboxId ? "mine" : ""}>
                  <span>{message.senderInboxId === xmtpInboxId ? petPayload.name : message.senderName}</span>
                  {message.text}
                </p>
              ))
            ) : (
              <p className="city-chat-empty">Say hi to the city.</p>
            )}
          </div>
          <form className="city-chat-form" onSubmit={handleSendChat}>
            <input
              maxLength={240}
              placeholder="Message Codex City"
              value={chatText}
              onChange={(event) => setChatText(event.target.value)}
            />
            <button type="submit" disabled={xmtpStatus !== "ready" || isSendingChat || !chatText.trim()}>
              Send
            </button>
          </form>
          <details className="city-chat-debug">
            <summary>Debug</summary>
            <dl>
              <dt>Status</dt>
              <dd>{xmtpStatus}</dd>
              <dt>Group</dt>
              <dd>{roomXmtpGroupId || xmtpGroupRef.current?.id || "none"}</dd>
              <dt>Inbox</dt>
              <dd>{xmtpInboxId || "none"}</dd>
              <dt>Room inboxes</dt>
              <dd>{roomInboxIds.length ? roomInboxIds.join(", ") : "none"}</dd>
              <dt>Messages</dt>
              <dd>{xmtpMessages.length} text / {cityChatDebug.rawHistoryCount} raw</dd>
              <dt>Stream</dt>
              <dd>{cityChatDebug.streamState}</dd>
              <dt>History load</dt>
              <dd>{cityChatDebug.lastHistoryLoadAt || "none"}</dd>
              <dt>History error</dt>
              <dd>{cityChatDebug.lastHistoryLoadError || "none"}</dd>
              <dt>Add attempts</dt>
              <dd>{cityChatDebug.addAttempts}</dd>
              <dt>Join attempts</dt>
              <dd>{cityChatDebug.joinAttempts}</dd>
              <dt>Last add</dt>
              <dd>{cityChatDebug.lastAddMembersAt || "none"}</dd>
              <dt>Last add error</dt>
              <dd>{cityChatDebug.lastAddMembersError || "none"}</dd>
              <dt>Last join</dt>
              <dd>{cityChatDebug.lastJoinRetryAt || "none"}</dd>
              <dt>Last join error</dt>
              <dd>{cityChatDebug.lastJoinRetryError || "none"}</dd>
              <dt>Last stream message</dt>
              <dd>{cityChatDebug.lastStreamMessageAt || "none"}</dd>
            </dl>
          </details>
        </section>
      ) : null}
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
