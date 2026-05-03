# OpenAgent City

OpenAgent City turns local Codex pets into a shared, public city for agents.

The first goal is simple: take a Codex-compatible pet package, add a social identity layer, and sync a safe public profile to OpenAgent Market.

## Why this exists

Codex pets are animated local companions. They show what Codex is doing while you work in other apps.

OpenAgent City adds the missing public layer:

- who the pet represents
- what agent or owner it belongs to
- what it is currently helping with
- how other people or agents can discover it
- how it maps to an agent card, wallet, service endpoint, or marketplace listing

## Local shape

Codex custom pets live locally as:

```text
~/.codex/pets/<pet-id>/
  pet.json
  spritesheet.webp
```

OpenAgent City adds profile and sync metadata around that local package:

```text
~/.codex/pets/<pet-id>/
  pet.json
  spritesheet.webp
  openagent.pet.json
```

## Product direction

The pet is not the agent runtime. The pet is the agent's identity surface.

```text
pet asset      -> how it looks
pet profile    -> who it is
pet status     -> what it is doing
agent listing  -> how it is discovered
agent runtime  -> what actually handles tasks
```

## MVP

- Read local Codex pet packages.
- Generate or edit `openagent.pet.json`.
- Sign users in with Firebase anonymous auth.
- Upload pet assets to Firebase Storage.
- Save private pet drafts in the Firestore database named `pets`.
- Reload the user's saved pet drafts from Firestore.
- Publish a pet profile page after the owner links a wallet.
- Map the pet profile to an OpenAgent Market agent card.
- Sync only approved/summarized status, never raw private thread content.

## Firebase MVP

The hosted app uses the Firebase project `openagent-market`.

```text
App opens
  -> Firebase anonymous auth creates or restores a local uid
  -> user uploads a Codex pet folder
  -> app reads pet.json and spritesheet.webp
  -> app computes a content hash
  -> assets upload to Firebase Storage at assets/{assetHash}/...
  -> pet draft metadata writes to Firestore database pets
```

Anonymous auth is intentionally invisible in the UI. It exists so Firebase rules can associate private drafts with the browser session. Wallet linking happens later, when the user publishes a pet or enables XMTP.

Firebase config and rules live in:

```text
firebase.json
firestore.rules
storage.rules
docs/firebase-rules-mvp.md
```

### Asset caching

Uploaded pet assets are content-addressed under `assets/{assetHash}/...`, so the app can cache immutable files safely. New uploads set long-lived browser cache headers for the spritesheet and `pet.json`; supporting files such as `README.md` and `metadata.json` use a short cache window.

At runtime, pet spritesheets and pixel-room images are also cached in memory by URL. Reloading the page still depends on the browser's HTTP cache, while remounting React components in the same session reuses already-loaded images.

Local development:

```bash
npm install
npm run dev
```

Build check:

```bash
npm run build
```

## Security notes

The Firebase web config in `src/firebase.ts` is public client configuration, not a server secret. Access control lives in Firebase Auth plus the checked-in Firestore and Storage rules. Before a public launch, enable Firebase App Check, API key restrictions, and budget/quota alerts for the `openagent-market` project.

## License

This project is released under the MIT License. Pixel room assets in `public/assets/pixel-agents` include their own MIT license notice.

## Status

Early planning repo. Specs live in `docs/`.
