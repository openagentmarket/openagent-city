import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { db, storage } from "./firebase";
import { PetAnimationState } from "./petAnimation";

export type PetJson = {
  id?: string;
  displayName?: string;
  description?: string;
  spritesheetPath?: string;
  assets?: {
    spritesheet?: string;
    publicImage?: string | null;
  };
};

export type SavedPet = {
  petId: string;
  ownerUid: string;
  assetHash: string;
  localPetId: string;
  slug: string;
  displayName: string;
  description?: string;
  publicStatus?: string;
  animationState?: PetAnimationState;
  spritesheetUrl: string;
  packageUrl?: string;
  frameWidth: number;
  frameHeight: number;
  status: "draft" | "published" | "archived";
  visibility: "private" | "public";
  approvalState: "draft" | "pending" | "approved" | "rejected";
  latestVersion: number;
  petJson?: PetJson;
  updatedAt?: unknown;
  createdAt?: unknown;
};

type SavePetInput = {
  uid: string;
  files: File[];
  petJson: PetJson;
  imageFile: File;
  frameWidth: number;
  frameHeight: number;
};

const uploadableNames = new Set(["pet.json", "metadata.json", "README.md", "spritesheet.webp"]);
const immutableCacheControl = "public,max-age=31536000,immutable";
const shortCacheControl = "public,max-age=300";

export function getFilePath(file: File) {
  return "webkitRelativePath" in file && typeof file.webkitRelativePath === "string"
    ? file.webkitRelativePath
    : file.name;
}

export function fileNameFromPath(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "pet";
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

async function sha256Text(text: string) {
  const bytes = new TextEncoder().encode(text);
  return sha256Bytes(bytes);
}

async function sha256File(file: File) {
  return sha256Bytes(await file.arrayBuffer());
}

async function sha256Bytes(bytes: BufferSource) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function rootlessPath(file: File) {
  const parts = getFilePath(file).split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join("/") : file.name;
}

function storageSafePath(path: string) {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "-"))
    .join("/");
}

function pickUploadFiles(files: File[], imageFile: File) {
  const picked = new Map<string, File>();

  for (const file of files) {
    const rootless = rootlessPath(file);
    const name = fileNameFromPath(rootless);

    if (uploadableNames.has(name) || file === imageFile) {
      picked.set(storageSafePath(rootless), file);
    }
  }

  if (!Array.from(picked.values()).includes(imageFile)) {
    picked.set(storageSafePath(imageFile.name), imageFile);
  }

  return picked;
}

function cacheControlForUpload(path: string, file: File, imageFile: File) {
  const name = fileNameFromPath(path);

  if (file === imageFile || name === "pet.json") {
    return immutableCacheControl;
  }

  return shortCacheControl;
}

async function buildPetPackage(files: File[], packageRoot: string) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();

  for (const file of files) {
    zip.file(`${packageRoot}/${rootlessPath(file)}`, file);
  }

  return zip.generateAsync({ type: "blob" });
}

export async function savePetDraft({
  uid,
  files,
  petJson,
  imageFile,
  frameWidth,
  frameHeight,
}: SavePetInput) {
  const petJsonHash = await sha256Text(stableStringify(petJson));
  const spritesheetHash = await sha256File(imageFile);
  const assetHash = await sha256Text(`${petJsonHash}:${spritesheetHash}`);
  const localPetId = petJson.id?.trim() || slugify(petJson.displayName || imageFile.name);
  const slug = slugify(localPetId);
  const petId = `${uid}_${slug}`;
  const duplicateQuery = query(collection(db, "pets"), where("ownerUid", "==", uid));
  const duplicate = await getDocs(duplicateQuery);
  const duplicatePet = duplicate.docs.find((petDoc) => petDoc.data().assetHash === assetHash);

  if (duplicatePet?.data().packageUrl) {
    return duplicatePet.data() as SavedPet;
  }

  const uploadFiles = pickUploadFiles(files, imageFile);
  const uploadedPaths: Record<string, string> = {};
  let spritesheetUrl = "";
  let packageUrl: string | undefined;

  for (const [path, file] of uploadFiles) {
    const storagePath = `assets/${assetHash}/${path}`;
    const fileRef = ref(storage, storagePath);
    await uploadBytes(fileRef, file, {
      cacheControl: cacheControlForUpload(path, file, imageFile),
      contentType: file.type || undefined,
      customMetadata: {
        ownerUid: uid,
        assetHash,
      },
    });

    uploadedPaths[path] = storagePath;

    if (file === imageFile || file.name === imageFile.name) {
      spritesheetUrl = await getDownloadURL(fileRef);
    }
  }

  if (!spritesheetUrl) {
    const fallbackRef = ref(storage, `assets/${assetHash}/${storageSafePath(imageFile.name)}`);
    spritesheetUrl = await getDownloadURL(fallbackRef);
  }

  try {
    const packageBlob = await buildPetPackage(files, slug);
    const packagePath = `${slug}.zip`;
    const packageRef = ref(storage, `assets/${assetHash}/${packagePath}`);
    await uploadBytes(packageRef, packageBlob, {
      cacheControl: immutableCacheControl,
      contentType: "application/zip",
      customMetadata: {
        ownerUid: uid,
        assetHash,
      },
    });
    uploadedPaths[packagePath] = `assets/${assetHash}/${packagePath}`;
    packageUrl = await getDownloadURL(packageRef);
  } catch (caughtError) {
    console.warn("Pet package upload failed", caughtError);
  }

  const petRef = doc(db, "pets", petId);
  const existingPet = await getDoc(petRef);
  const latestVersion = existingPet.exists()
    ? ((existingPet.data().latestVersion as number | undefined) ?? 1) + 1
    : 1;
  const now = serverTimestamp();
  const pet: Omit<SavedPet, "createdAt" | "updatedAt"> & {
    createdAt?: unknown;
    updatedAt: unknown;
    petJson: PetJson;
  } = {
    petId,
    ownerUid: uid,
    assetHash,
    localPetId,
    slug,
    displayName: petJson.displayName?.trim() || localPetId,
    description: petJson.description?.trim() || undefined,
    publicStatus: "",
    spritesheetUrl,
    packageUrl: packageUrl ?? (duplicatePet?.data().packageUrl as string | undefined),
    frameWidth,
    frameHeight,
    status: "draft",
    visibility: "private",
    approvalState: "draft",
    latestVersion,
    updatedAt: now,
    petJson,
  };

  const assetRef = doc(db, "petAssets", assetHash);
  const existingAsset = await getDoc(assetRef);
  await setDoc(
    assetRef,
    {
      contentHash: assetHash,
      spritesheetHash,
      petJsonHash,
      storagePath: `assets/${assetHash}`,
      spritesheetPath:
        uploadedPaths[storageSafePath(rootlessPath(imageFile))] ?? `assets/${assetHash}/${imageFile.name}`,
      petJsonPath: uploadedPaths["pet.json"] ?? null,
      packagePath: uploadedPaths[`${slug}.zip`] ?? existingAsset.data()?.packagePath ?? null,
      firstUploaderUid: existingAsset.exists() ? existingAsset.data().firstUploaderUid : uid,
      uploadCount: existingAsset.exists() ? increment(1) : 1,
      updatedAt: now,
      createdAt: existingAsset.exists() ? existingAsset.data().createdAt : now,
    },
    { merge: true },
  );

  await setDoc(
    petRef,
    existingPet.exists()
      ? pet
      : {
          ...pet,
          createdAt: now,
        },
    { merge: true },
  );

  if (latestVersion > 1) {
    await setDoc(doc(db, "pets", petId, "versions", String(latestVersion)), {
      version: latestVersion,
      assetHash,
      uploadedByUid: uid,
      createdAt: now,
    });
  }

  return pet as SavedPet;
}
