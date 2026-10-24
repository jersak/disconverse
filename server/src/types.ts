export type Role = "owner" | "admin" | "member";

export type User = {
  id: number;
  /** Login name; always unique. */
  username: string;
  role: Role;
  /** Shown instead of the username when set. */
  displayName: string | null;
  avatarUrl: string | null;
};

export type ChannelType = "text" | "voice";

export type Channel = {
  id: number;
  type: ChannelType;
  name: string;
  position: number;
  /** Newest message id in a text channel (for unread markers); null if empty or voice. */
  latestMessageId: number | null;
};

export type Attachment = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  /** Small preview (made by the uploader's browser), if there is one. */
  thumbUrl: string | null;
  /** Deleted by an admin: the file is gone, the message shows a placeholder. */
  removed?: boolean;
};

export type Message = {
  id: number;
  channelId: number;
  userId: number;
  username: string;
  content: string;
  createdAt: number;
  attachments: Attachment[];
};

export type VoiceMember = {
  userId: number;
  username: string;
  muted: boolean;
  video: boolean;
  streaming: boolean;
};

/** Who is in each voice channel, by channel id (empty channels omitted). */
export type VoiceState = Record<number, VoiceMember[]>;

/** Messages the server pushes over the WebSocket. Mirrored in client/src/api.ts. */
export type ServerEvent =
  | {
      type: "hello";
      user: User;
      permissions: string[];
      channels: Channel[];
      online: number[];
      voice: VoiceState;
    }
  | { type: "message"; message: Message }
  | { type: "presence"; online: number[] }
  | { type: "voice"; voice: VoiceState }
  | { type: "channels"; channels: Channel[] }
  /** Accounts or roles changed: clients refetch the member list and their own permissions. */
  | { type: "users-changed" }
  /** Media deleted by an admin: clients show placeholders instead. */
  | { type: "attachments-removed"; ids: string[] };
