# Firebase Rules MVP

These rules allow the current client-side MVP to save anonymous users' private pet drafts.

The checked-in `firestore.rules` and `storage.rules` files are the source of truth. The snippets below describe the intent; deploy the real rules with `firebase deploy --only firestore:pets` for the named `pets` database.

## Firestore

Use these rules for the Firestore database named `pets`.

```js
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }

    match /pets/{petId} {
      allow create: if request.auth != null
        && request.resource.data.ownerUid == request.auth.uid;

      allow get: if request.auth != null
        && (!exists(/databases/$(database)/documents/pets/$(petId))
          || resource.data.ownerUid == request.auth.uid);

      allow list: if request.auth != null
        && resource.data.ownerUid == request.auth.uid;

      allow update, delete: if request.auth != null
        && resource.data.ownerUid == request.auth.uid;
    }

    match /pets/{petId}/versions/{versionId} {
      allow read, write: if request.auth != null
        && get(/databases/$(database)/documents/pets/$(petId)).data.ownerUid == request.auth.uid;
    }

    match /petAssets/{assetHash} {
      allow read: if request.auth != null;
      allow create, update: if request.auth != null
        && request.resource.data.contentHash == assetHash;
    }
  }
}
```

The production rule additionally validates the allowed fields, preserves the first uploader on updates, and requires `uploadCount` to move forward.

## Storage

These rules let signed-in anonymous users upload pet assets and let the app read them back.

```js
rules_version = '2';

service firebase.storage {
  match /b/{bucket}/o {
    match /assets/{assetHash}/{assetPath=**} {
      allow read: if true;
      allow write: if request.auth != null
        && request.resource.size < 10 * 1024 * 1024
        && request.resource.metadata.ownerUid == request.auth.uid
        && request.resource.metadata.assetHash == assetHash;
    }
  }
}
```

For public launch, asset writes should move behind Cloud Functions so hash validation cannot be spoofed by the client.

Also enable Firebase App Check, API key restrictions, and budget/quota alerts before making the repository public. The Firebase web config is not a secret, so the rules and abuse controls are the security boundary.
