import { useEffect, useState } from "react";
import type { Channel, ChannelType, User, VoiceState } from "./api.ts";
import { Avatar, Icon } from "./ui.tsx";
import { canShareScreen, DEFAULT_PLAYBACK, MAX_VOICE_VOLUME, type Voice } from "./useVoice.ts";
import { displayName, profileOf, useUsers } from "./users.tsx";
import { VolumeControl } from "./VolumeControl.tsx";
import type { Server } from "./useServer.ts";

export type Selection = { kind: ChannelType; channelId: number };

type MemberRow = { userId: number; name: string; muted: boolean; speaking: boolean; video: boolean; streaming: boolean };

/** Who to show under a voice channel: live data for the one we're in, the server's list for others. */
function voiceMembers(channel: Channel, voice: Voice, serverVoice: VoiceState): MemberRow[] {
  if (voice.status === "connected" && voice.channelId === channel.id) {
    return voice.participants.map((p) => ({
      userId: p.userId,
      name: p.name,
      muted: p.muted,
      speaking: p.speaking,
      video: !!p.camera,
      streaming: !!p.screen,
    }));
  }
  return (serverVoice[channel.id] ?? []).map((m) => ({
    userId: m.userId,
    name: m.username,
    muted: m.muted,
    speaking: false,
    video: m.video,
    streaming: m.streaming,
  }));
}

export function Sidebar({
  user,
  server,
  voice,
  selection,
  onSelect,
  onShareScreen,
  onCreateChannel,
  onEditChannel,
  onOpenServerSettings,
  onOpenSettings,
  onLogout,
}: {
  user: User;
  server: Server;
  voice: Voice;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  onShareScreen: () => void;
  onCreateChannel: (type: ChannelType) => void;
  onEditChannel: (channel: Channel) => void;
  onOpenServerSettings: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}) {
  const users = useUsers();
  const inVoice = voice.status !== "idle";
  /** Whose voice volume panel is open (people in our call). */
  const [volumeFor, setVolumeFor] = useState<number | null>(null);

  useEffect(() => {
    if (volumeFor === null) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element).closest(".voice-member-volume, .voice-members li.adjustable")) setVolumeFor(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [volumeFor]);
  useEffect(() => {
    if (voice.status !== "connected") setVolumeFor(null);
  }, [voice.status]);
  const voiceChannel = server.channels.find((c) => c.id === voice.channelId);
  const canManage = server.can("manageChannels");
  const canAdminister = server.can("manageInvites") || server.can("manageRoles");

  const category = (type: ChannelType, label: string) => (
    <div className="category category-row">
      <span>{label}</span>
      {canManage && (
        <button className="category-add" onClick={() => onCreateChannel(type)} title={`Create ${type} channel`}>
          <Icon name="plus" size={16} />
        </button>
      )}
    </div>
  );

  const editButton = (channel: Channel) =>
    canManage && (
      <span
        role="button"
        tabIndex={0}
        className="channel-edit"
        title="Edit channel"
        onClick={(e) => {
          e.stopPropagation();
          onEditChannel(channel);
        }}
      >
        <Icon name="settings" size={16} />
      </span>
    );

  return (
    <nav className="sidebar">
      <header className="server-name">
        <span>Disconverse</span>
        {canAdminister && (
          <button className="icon-button" onClick={onOpenServerSettings} title="Server settings">
            <Icon name="settings" size={18} />
          </button>
        )}
      </header>

      <div className="channels">
        {category("text", "Text Channels")}
        {server.channels
          .filter((c) => c.type === "text")
          .map((c) => {
            const active = selection?.kind === "text" && selection.channelId === c.id;
            const unread = !active && server.isUnread(c);
            const mentionCount = active ? 0 : (server.mentionCounts[c.id] ?? 0);
            return (
              <button
                key={c.id}
                className={`channel${active ? " active" : ""}${unread ? " unread" : ""}`}
                onClick={() => onSelect({ kind: "text", channelId: c.id })}
              >
                {unread && <span className="unread-pill" />}
                <span className="hash">#</span>
                <span className="channel-name">{c.name}</span>
                {mentionCount > 0 && (
                  <span className="mention-badge" title={`${mentionCount} mention${mentionCount === 1 ? "" : "s"}`}>
                    {mentionCount > 99 ? "99+" : mentionCount}
                  </span>
                )}
                {editButton(c)}
              </button>
            );
          })}

        {category("voice", "Voice Channels")}
        {server.channels
          .filter((c) => c.type === "voice")
          .map((c) => {
            const members = voiceMembers(c, voice, server.voice);
            const active = selection?.kind === "voice" && selection.channelId === c.id;
            const connectedHere = inVoice && voice.channelId === c.id;
            return (
              <div key={c.id}>
                <button
                  className={`channel${active ? " active" : ""}${connectedHere ? " connected" : ""}`}
                  onClick={() => onSelect({ kind: "voice", channelId: c.id })}
                  title={connectedHere ? undefined : "Join voice"}
                >
                  <Icon name="speaker" />
                  <span className="channel-name">{c.name}</span>
                  {editButton(c)}
                </button>
                {members.length > 0 && (
                  <ul className="voice-members">
                    {members.map((m) => {
                      const profile = profileOf(users, m.userId, m.name);
                      // People in our call can be made louder or quieter (for us only).
                      const adjustable = connectedHere && voice.status === "connected" && m.userId !== user.id;
                      const playback = voice.playback.voice[m.userId] ?? DEFAULT_PLAYBACK;
                      const toggleVolume = () => setVolumeFor((cur) => (cur === m.userId ? null : m.userId));
                      return (
                      <li
                        key={m.userId}
                        className={adjustable ? "adjustable" : undefined}
                        onClick={adjustable ? toggleVolume : undefined}
                        onContextMenu={
                          adjustable
                            ? (e) => {
                                e.preventDefault();
                                setVolumeFor(m.userId);
                              }
                            : undefined
                        }
                        title={adjustable ? "Change volume" : undefined}
                      >
                        <div className="voice-member-row">
                          <Avatar userId={m.userId} name={profile.name} avatarUrl={profile.avatarUrl} size={24} speaking={m.speaking} />
                          <span className="name">{profile.name}</span>
                          {m.streaming && <span className="live-badge">LIVE</span>}
                          {m.video && <Icon name="camera" size={14} />}
                          {m.muted && <Icon name="mic" size={14} slashed />}
                          {adjustable && playback.muted && (
                            <span className="locally-muted" title="Muted for you">
                              <Icon name="speaker" size={14} slashed />
                            </span>
                          )}
                        </div>
                        {adjustable && volumeFor === m.userId && (
                          <div className="voice-member-volume" onClick={(e) => e.stopPropagation()}>
                            <div className="voice-member-volume-title">
                              <span>User volume</span>
                              {playback.volume !== 1 && (
                                <button className="link" onClick={() => voice.setPlayback("voice", m.userId, { volume: 1 })}>
                                  Reset
                                </button>
                              )}
                            </div>
                            <VolumeControl
                              audio={playback}
                              onChange={(change) => voice.setPlayback("voice", m.userId, change)}
                              max={MAX_VOICE_VOLUME}
                              what={profile.name}
                              showPercent
                            />
                          </div>
                        )}
                      </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
      </div>

      {(inVoice || voice.error) && (
        <div className="voice-status">
          <div className="voice-status-row">
            <div className="voice-status-text">
              {inVoice && (
                <>
                  <div className={voice.status === "connected" ? "ok" : "pending"}>
                    {voice.status === "connected" ? "Voice Connected" : "Connecting…"}
                  </div>
                  <div className="sub">{voiceChannel?.name ?? "Voice"} / Disconverse</div>
                </>
              )}
              {voice.error && <div className="error">{voice.error}</div>}
            </div>
            {inVoice && (
              <button className="icon-button" onClick={voice.leave} title="Disconnect">
                <Icon name="hangup" />
              </button>
            )}
          </div>
          {voice.status === "connected" && (
            <div className="voice-status-actions">
              <button
                className={`panel-button${voice.cameraOn ? " on" : ""}`}
                onClick={voice.toggleCamera}
                title={voice.cameraOn ? "Turn off camera" : "Turn on camera"}
              >
                <Icon name="camera" />
              </button>
              {canShareScreen && (
                <button
                  className={`panel-button${voice.sharing ? " on" : ""}`}
                  onClick={() => (voice.sharing ? void voice.stopScreenShare() : onShareScreen())}
                  title={voice.sharing ? "Stop streaming" : "Share your screen"}
                >
                  <Icon name="screen" />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="user-panel">
        <Avatar userId={user.id} name={displayName(user)} avatarUrl={user.avatarUrl} />
        <span className="name" title={`@${user.username}`}>
          {displayName(user)}
        </span>
        <button
          className={`icon-button${voice.muted ? " active" : ""}`}
          onClick={voice.toggleMute}
          title={voice.muted ? "Unmute" : "Mute"}
        >
          <Icon name="mic" slashed={voice.muted} />
        </button>
        <button
          className={`icon-button${voice.deafened ? " active" : ""}`}
          onClick={voice.toggleDeafen}
          title={voice.deafened ? "Undeafen" : "Deafen"}
        >
          <Icon name="headset" slashed={voice.deafened} />
        </button>
        <button className="icon-button" onClick={onOpenSettings} title="Settings">
          <Icon name="settings" />
        </button>
        <button className="icon-button" onClick={onLogout} title="Log out">
          <Icon name="logout" />
        </button>
      </div>
    </nav>
  );
}
