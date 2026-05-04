import {
  Client,
  Group,
  IdentifierKind,
  LogLevel,
  type BuiltInContentTypes,
  type DecodedMessage,
  type Signer,
} from "@xmtp/browser-sdk";
import { toBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const walletStorageKey = "openagent-city:xmtp-wallet:v1";
const xmtpEnv = "dev";
let cityClientPromise:
  | Promise<{
      address: string;
      client: Client<BuiltInContentTypes>;
      inboxId: string;
    }>
  | null = null;

export type CityXmtpMessage = {
  id: string;
  conversationId: string;
  senderInboxId: string;
  text: string;
  sentAt: Date;
};

export type CityXmtpRuntime = {
  client: Client<BuiltInContentTypes>;
  group: Group | null;
  inboxId: string;
  address: string;
  groupId?: string;
};

function readOrCreatePrivateKey() {
  const stored = localStorage.getItem(walletStorageKey);

  if (stored?.startsWith("0x")) {
    return stored as Hex;
  }

  const privateKey = generatePrivateKey();
  localStorage.setItem(walletStorageKey, privateKey);
  return privateKey;
}

function createLocalSigner(privateKey: Hex): { address: string; signer: Signer } {
  const account = privateKeyToAccount(privateKey);

  return {
    address: account.address,
    signer: {
      type: "EOA",
      getIdentifier: () => ({
        identifier: account.address.toLowerCase(),
        identifierKind: IdentifierKind.Ethereum,
      }),
      signMessage: async (message: string) => {
        const signature = await account.signMessage({ message });
        return toBytes(signature);
      },
    },
  };
}

export async function createCityXmtpClient(): Promise<{
  address: string;
  client: Client<BuiltInContentTypes>;
  inboxId: string;
}> {
  if (cityClientPromise) {
    return cityClientPromise;
  }

  cityClientPromise = createCityXmtpClientInternal().catch((error) => {
    cityClientPromise = null;
    throw error;
  });

  return cityClientPromise;
}

async function createCityXmtpClientInternal(): Promise<{
  address: string;
  client: Client<BuiltInContentTypes>;
  inboxId: string;
}> {
  const { address, signer } = createLocalSigner(readOrCreatePrivateKey());
  const client = await Client.create(signer, {
    env: xmtpEnv,
    disableDeviceSync: true,
    loggingLevel: LogLevel.Off,
    appVersion: "openagent-city/0.1.0",
  } as Parameters<typeof Client.create>[1]);

  return { address, client: client as Client<BuiltInContentTypes>, inboxId: client.inboxId ?? "" };
}

export async function loadOrCreateCityGroup({
  client,
  existingGroupId,
  roomName,
}: {
  client: Client<BuiltInContentTypes>;
  existingGroupId?: string;
  roomName: string;
}) {
  if (existingGroupId) {
    await client.conversations.sync();
    const existing = await client.conversations.getConversationById(existingGroupId);

    if (existing instanceof Group) {
      return existing;
    }

    throw new Error(`XMTP group is not available to this inbox yet: ${existingGroupId}`);
  }

  return client.conversations.createGroup([], {
    groupName: roomName,
    groupDescription: "OpenAgent City room chat",
  });
}

export function toCityXmtpMessage(message: DecodedMessage): CityXmtpMessage | null {
  if (typeof message.content !== "string" || !message.content.trim()) {
    return null;
  }

  return {
    id: message.id,
    conversationId: message.conversationId,
    senderInboxId: message.senderInboxId,
    text: message.content.trim(),
    sentAt: message.sentAt,
  };
}

export function upsertCityXmtpMessage(
  messages: CityXmtpMessage[],
  message: CityXmtpMessage,
) {
  if (messages.some((existing) => existing.id === message.id)) {
    return messages;
  }

  return [...messages, message].sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());
}
