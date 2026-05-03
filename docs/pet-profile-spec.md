# Pet Profile Spec

This document defines the first draft of the OpenAgent pet profile.

## Design Principles

- Keep Codex pet assets compatible with Codex.
- Do not modify Codex's `pet.json` contract unless necessary.
- Store OpenAgent-specific identity in a separate file.
- Treat public status as opt-in summarized presence.
- Separate visual identity from agent execution.

## Local Codex Package

```json
{
  "id": "momo",
  "displayName": "Momo",
  "description": "A calm coding companion.",
  "spritesheetPath": "spritesheet.webp"
}
```

## OpenAgent Pet Profile

`openagent.pet.json`

```json
{
  "schemaVersion": "0.1.0",
  "petId": "momo",
  "displayName": "Momo",
  "bio": "The public face of an agent helping with product and code work.",
  "owner": {
    "type": "user",
    "handle": "applefather"
  },
  "agent": {
    "name": "Momo Agent",
    "description": "Helps plan, build, review, and ship software projects.",
    "skills": ["planning", "coding", "reviewing"],
    "xmtpAddress": null,
    "walletAddress": null,
    "serviceEndpoints": []
  },
  "assets": {
    "codexPetJson": "pet.json",
    "spritesheet": "spritesheet.webp",
    "publicImage": null
  },
  "presence": {
    "visibility": "private",
    "state": "idle",
    "summary": null,
    "project": null,
    "updatedAt": null
  },
  "market": {
    "listed": false,
    "profileUrl": null,
    "agentCardUrl": null,
    "erc8004AgentUri": null
  }
}
```

## Presence States

- `idle`
- `thinking`
- `working`
- `waiting_for_input`
- `ready_for_review`
- `shipping`
- `resting`

## Privacy Rule

Presence sync must never publish raw prompts, thread transcripts, file contents, command output, secrets, private repository names, or private customer names by default.

The sync layer should publish a short human-readable summary only after an allowlist, confirmation, or project-level privacy policy approves it.
