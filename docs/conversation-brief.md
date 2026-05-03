# Conversation Brief

This is the working context from the first OpenAgent Pets discussion.

## Core Idea

Codex pets are currently local animated companions. They are visual/status surfaces, not independent agents.

The opportunity is to bring pets outside Codex as the public, social face of an agent.

In product terms:

```text
Codex pet = local animated companion
OpenAgent pet = public identity layer for an agent
```

The pet should be able to introduce itself with a bio:

- who it is
- who it belongs to
- what it is helping with
- what project or owner it represents
- what skills/capabilities the agent behind it has
- what it is currently doing, if allowed to be public

Example:

```text
I'm Momo, applefather's coding companion.
Right now I'm helping design public profiles for Codex pets.
I help with planning, coding, reviewing, and shipping.
```

## What Codex Pets Are Today

Based on local inspection and web research:

- Codex pets are animated companions in the Codex app.
- They can be enabled from Codex appearance settings or with `/pet`.
- They show Codex state, such as active thread, waiting for input, running, or ready for review.
- Custom pets are local asset packages.
- They are not autonomous agents and do not have memory, wallet, messaging, or marketplace identity by themselves.

Local package shape:

```text
~/.codex/pets/<pet-id>/
  pet.json
  spritesheet.webp
```

Minimal `pet.json` shape:

```json
{
  "id": "pet-name",
  "displayName": "Pet Name",
  "description": "One short sentence.",
  "spritesheetPath": "spritesheet.webp"
}
```

## Product Direction

Separate the system into clear layers:

```text
Asset:     how the pet looks
Identity:  who the pet is
Status:    what the pet is doing
Social:    how others discover or interact with it
Runtime:   the actual agent that handles tasks
```

Important principle:

```text
The pet is not the agent runtime.
The pet is the public face of the agent.
```

## Best MVP

Start with a Pet Bio Card / public profile page.

The first version should support:

- local Codex pet import
- pet display name and bio
- owner or team
- linked agent profile
- current public status
- recent public activities
- public image / animation
- market listing metadata

Suggested page content:

- animated pet
- name
- short bio
- "currently helping ___ with ___"
- skills
- owner
- agent contact or market listing
- recent activity

## Sync Concept

Do not sync raw Codex sessions directly.

Instead:

```text
Codex local pet package
  -> local pet/profile scanner
  -> privacy filter
  -> summarized presence
  -> public storage
  -> OpenAgent Market listing/profile
```

The sync layer should read:

```text
~/.codex/pets/*/pet.json
~/.codex/pets/*/spritesheet.webp
~/.codex/pets/*/openagent.pet.json
```

Then it can publish:

- pet profile
- pet asset URL
- agent card metadata
- safe status summary

## Privacy Rule

Privacy is a core product requirement.

Never publish by default:

- raw prompts
- raw conversation transcripts
- command output
- file contents
- secrets/tokens
- private repo names
- customer names
- local paths

Only publish short summaries after policy or explicit approval.

Example allowed status:

```text
Helping applefather design Codex pet social profiles.
```

Example blocked status:

```text
Editing a private client contract after reading this full chat transcript...
```

## Market Mapping

OpenAgent Pets should map a pet profile to an agent card / marketplace listing.

Example metadata:

```json
{
  "name": "Momo",
  "description": "A pet-faced coding companion for OpenAgent Market.",
  "image": "https://assets.example.com/pets/momo.webp",
  "metadata": {
    "petId": "momo",
    "owner": "applefather",
    "skills": ["planning", "coding", "reviewing"],
    "xmtpAddress": "0x...",
    "category": "coding-companion",
    "profileUrl": "https://pets.openagent.market/momo"
  }
}
```

Possible market capabilities:

- discover pet/agent profiles
- follow or say hi
- message through XMTP
- hire the agent behind the pet
- show payment/pricing if the agent supports x402
- register or link to ERC-8004-style agent identity

## Repository Created

Created GitHub repo:

```text
openagentmarket/openagent-city
https://github.com/openagentmarket/openagent-city
```

Current status:

- default branch: `main`
- initial docs committed

Initial commit:

```text
55a0e4c Initial OpenAgent pets docs
```

## Next Useful Work

Good next steps:

1. Decide the first product surface: CLI sync tool, web profile page, or market publisher.
2. Define `openagent.pet.json` v0.1.
3. Build a local scanner for `~/.codex/pets`.
4. Generate a static public pet profile from one local pet.
5. Add privacy-filtered status sync.
6. Map the profile to OpenAgent Market discovery metadata.

Recommended first build:

```text
packages/pet-sync
  reads local Codex pets
  validates pet.json
  creates openagent.pet.json
  exports a public profile JSON
```

Then:

```text
apps/pets-web
  renders the public pet profile
```
