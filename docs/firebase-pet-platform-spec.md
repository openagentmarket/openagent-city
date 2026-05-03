# Firebase Pet Platform Spec

This document defines the first MVP architecture for OpenAgent Pets as a hosted Firebase app.

## Goal

Let people upload local Codex pet folders, preview them in a hangout room, publish approved pets, and later enable pet-to-pet communication through XMTP.

The MVP should avoid forcing wallet setup before users understand the product. Wallet identity is required only when the user wants public ownership, publishing, XMTP, or agent features.

## Product Principles

- Let users enter quickly with Firebase anonymous auth.
- Treat uploaded pets as private drafts by default.
- Use wallet signatures as proof of public ownership.
- Store binary assets in Firebase Storage, not Firestore.
- Deduplicate uploaded assets by content hash.
- Keep Codex `pet.json` compatible with existing local pets.
- Do not create or custody wallets for users during the MVP upload flow.

## Local Pet Package

A local pet folder can look like:

```text
boba/
  pet.json
  metadata.json
  README.md
  spritesheet.webp
```

Minimum required files:

```text
pet.json
spritesheet.webp
```

Example `pet.json`:

```json
{
  "id": "boba",
  "displayName": "Boba",
  "description": "A tiny otter sipping bubble tea while keeping you company in Codex.",
  "spritesheetPath": "spritesheet.webp"
}
```

## Authentication

### MVP Auth Flow

```text
User opens app
  -> Firebase signInAnonymously()
  -> user can upload and preview pet drafts
  -> user clicks Publish or Enable XMTP
  -> user connects wallet
  -> wallet signs ownership message
  -> Cloud Function verifies signature
  -> wallet is linked to Firebase uid
  -> pet can become public
```

Firebase `uid` is the app account/session identity. Wallet address is a linked public ownership identity.

### Wallet Linking

The client asks the wallet to sign a message that includes:

```text
Sign in to OpenAgent Pets

UID: {firebaseUid}
Wallet: {walletAddress}
Nonce: {nonce}
Issued At: {isoTimestamp}
```

The backend verifies:

- signature recovers `walletAddress`
- nonce is valid and unused
- wallet is not already linked to another uid
- caller is authenticated as `firebaseUid`

After verification, write:

```text
users/{uid}
walletLinks/{lowercaseWalletAddress}
```

### Wallet Creation

The app should not generate a wallet during the MVP upload flow.

Generate only:

- `petId`
- `draftId`
- `assetHash`

Future autonomous pets may have their own agent wallet, but that is a separate upgrade step.

## Firestore Data Model

### Users

```ts
users/{uid} {
  authMode: "anonymous" | "google" | "wallet_linked",
  displayName?: string,
  walletLinked: boolean,
  primaryWalletAddress?: string,
  walletAddresses?: string[],
  xmtpInboxId?: string,
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

### Wallet Links

Use lowercase wallet addresses as document IDs.

```ts
walletLinks/{address} {
  uid: string,
  linkedAt: Timestamp,
  lastVerifiedAt: Timestamp
}
```

One wallet should link to one Firebase uid at a time.

### Pet Assets

Global asset records deduplicate identical uploads.

```ts
petAssets/{assetHash} {
  contentHash: string,
  spritesheetHash: string,
  petJsonHash: string,
  storagePath: string,
  spritesheetPath: string,
  petJsonPath: string,
  firstUploaderUid: string,
  canonicalPetId?: string,
  uploadCount: number,
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

### Pets

Pet documents represent a user's pet profile or draft. Multiple users can own separate pet profiles that point to the same deduplicated asset.

```ts
pets/{petId} {
  ownerUid: string,
  ownerWalletAddress?: string,
  agentWalletAddress?: string,
  xmtpInboxId?: string,
  assetHash: string,
  localPetId: string,
  slug: string,
  displayName: string,
  description?: string,
  spritesheetUrl: string,
  status: "draft" | "published" | "archived",
  visibility: "private" | "public",
  approvalState: "draft" | "pending" | "approved" | "rejected",
  duplicateOf?: string,
  latestVersion: number,
  tags?: string[],
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

### Pet Versions

When the same user uploads the same pet id with different content, create a version.

```ts
pets/{petId}/versions/{versionId} {
  version: number,
  assetHash: string,
  uploadedByUid: string,
  createdAt: Timestamp,
  notes?: string
}
```

### Rooms

```ts
rooms/{roomId} {
  name: string,
  visibility: "public" | "private",
  createdByUid: string,
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

### Room Participants

For the MVP, Firestore realtime is enough. If movement becomes high-frequency, move participant presence to Realtime Database.

```ts
rooms/{roomId}/participants/{uid} {
  petId: string,
  displayName: string,
  spritesheetUrl: string,
  x: number,
  y: number,
  status: "idle" | "walking" | "chatting" | "thinking",
  updatedAt: Timestamp
}
```

## Storage Layout

Use content-addressed asset paths where possible:

```text
assets/{assetHash}/pet.json
assets/{assetHash}/metadata.json
assets/{assetHash}/README.md
assets/{assetHash}/spritesheet.webp
```

User-specific profile metadata can live separately:

```text
userPets/{uid}/{petId}/openagent.pet.json
```

## Upload And Deduplication

### Hashes

Compute:

- `petJsonHash = sha256(canonical pet.json)`
- `spritesheetHash = sha256(spritesheet bytes)`
- `contentHash = sha256(petJsonHash + ":" + spritesheetHash)`

Optional files like `README.md` and `metadata.json` should not decide whether the visual asset is duplicated.

### Duplicate Rules

```text
Same ownerUid + same contentHash
  -> do not create a new pet
  -> return existing pet

Same ownerUid + same localPetId + different contentHash
  -> create a new version
  -> update latestVersion

Different ownerUid + same contentHash
  -> allow a separate pet profile
  -> point to the existing petAssets/{assetHash}
  -> optionally mark duplicateOf/canonicalPetId
```

### Upload Flow

```text
Client reads folder
  -> validate required files locally
  -> compute hashes
  -> request upload session from Cloud Function
  -> upload files to Firebase Storage
  -> Cloud Function validates Storage objects
  -> create or reuse petAssets/{assetHash}
  -> create or update pets/{petId}
```

## Publishing Flow

Draft pets can be created by anonymous users. Publishing requires a linked wallet.

```text
User clicks Publish
  -> if no wallet linked, connect wallet
  -> verify wallet signature
  -> set ownerWalletAddress
  -> set visibility = "public"
  -> set approvalState = "pending" or "approved"
```

For early private alpha, publishing can auto-approve. For public launch, use `pending` and moderation.

## XMTP Direction

Do not require XMTP during the first upload flow.

Longer term:

```text
human wallet
  -> XMTP inbox
  -> owns pet profiles
  -> optional pet agent wallet
  -> optional pet-specific XMTP inbox
```

MVP pet identity:

```ts
{
  ownerWalletAddress: "0xHuman",
  xmtpInboxId: "human-or-app-inbox"
}
```

Future autonomous agent identity:

```ts
{
  ownerWalletAddress: "0xHuman",
  agentWalletAddress: "0xPetAgent",
  xmtpInboxId: "pet-agent-inbox"
}
```

## Security Rules

Firestore rules should authorize by Firebase uid.

```js
match /pets/{petId} {
  allow create: if request.auth != null
    && request.resource.data.ownerUid == request.auth.uid;

  allow read: if resource.data.visibility == "public"
    || (request.auth != null && resource.data.ownerUid == request.auth.uid);

  allow update, delete: if request.auth != null
    && resource.data.ownerUid == request.auth.uid;
}
```

Wallet uniqueness and signature verification must happen in Cloud Functions, not client-side rules.

## MVP Build Order

1. Anonymous Firebase Auth.
2. Local folder upload and preview.
3. Hash uploaded package.
4. Firebase Storage upload.
5. Firestore draft pet creation.
6. Duplicate detection.
7. Public gallery.
8. Wallet link on publish.
9. Hangout room presence.
10. XMTP inbox linking.
11. Optional autonomous pet agent wallet.

## Open Questions

- Should public publishing auto-approve during alpha?
- Should pet asset hashes include animation metadata beyond `pet.json` and spritesheet?
- Should room presence move to Realtime Database before public launch?
- Should pet-specific agent wallets be user-created, platform-created, or imported?
- Should XMTP identity attach to the human owner first, or only to autonomous pet agents?
