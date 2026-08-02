/*
 * VoiceTimeline - Vencord userplugin
 * Copyright (c) 2026 feve
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import {
    AuthenticationStore,
    Button,
    ChannelStore,
    Forms,
    GuildMemberStore,
    LocaleStore,
    Menu,
    React,
    SelectedChannelStore,
    Toasts,
    UserStore,
    VoiceStateStore,
    showToast
} from "@webpack/common";

interface VoiceStateChangeEvent {
    userId: string;
    channelId?: string;
    oldChannelId?: string;
    sessionId: string;
}

type TimelineEventKind = "session" | "join" | "rejoin" | "leave";

interface Participant {
    joinedAt: number;
    displayName: string;
    avatarUrl?: string;
}

interface TimelineEvent {
    id: string;
    kind: TimelineEventKind;
    timestamp: number;
    userId?: string;
    displayName: string;
    avatarUrl?: string;
    durationMs?: number;
    otherChannelName?: string;
}

interface VoiceSession {
    channelId: string;
    channelName: string;
    startedAt: number;
    events: TimelineEvent[];
    participants: Map<string, Participant>;
    seenUserIds: Set<string>;
}

const settings = definePluginSettings({
    notifyJoins: {
        type: OptionType.BOOLEAN,
        get displayName() {
            return t("Avisar de entradas", "Notify Joins");
        },
        get description() {
            return t(
                "Mostrar un aviso cuando alguien entra en tu llamada",
                "Show a notification when someone joins your call"
            );
        },
        default: true
    },
    notifyLeaves: {
        type: OptionType.BOOLEAN,
        get displayName() {
            return t("Avisar de salidas", "Notify Leaves");
        },
        get description() {
            return t(
                "Mostrar un aviso cuando alguien sale de tu llamada",
                "Show a notification when someone leaves your call"
            );
        },
        default: true
    },
    coloredToasts: {
        type: OptionType.BOOLEAN,
        get displayName() {
            return t("Avisos con color", "Colored Toasts");
        },
        get description() {
            return t(
                "Usar colores en los avisos en pantalla (verde al entrar, rojo al salir)",
                "Use colors in on-screen notifications (green on join, red on leave)"
            );
        },
        default: true
    },
    showDurations: {
        type: OptionType.BOOLEAN,
        get displayName() {
            return t("Mostrar duraciones", "Show Durations");
        },
        get description() {
            return t(
                "Mostrar cuánto tiempo permaneció una persona al salir",
                "Show how long someone stayed when they leave"
            );
        },
        default: true
    },
    toastDuration: {
        type: OptionType.SLIDER,
        get displayName() {
            return t("Duración del aviso", "Toast Duration");
        },
        get description() {
            return t(
                "Duración de las notificaciones",
                "Notification duration"
            );
        },
        markers: [2000, 3000, 4000, 5000, 7000, 10000],
        default: 4000,
        stickToMarkers: true,
        componentProps: {
            onValueRender: (value: number) => `${value / 1000} s`,
            onMarkerRender: (value: number) => `${value / 1000} s`
        }
    }
});

let currentSession: VoiceSession | null = null;
let myLastChannelId: string | undefined;
let startTimer: number | undefined;
let testCounter = 0;
let lastTestUserId: string | undefined;

function getDiscordLanguage() {
    const discordLocale = (LocaleStore as any)?.getLocale?.();

    return discordLocale
        || globalThis.document?.documentElement?.lang
        || globalThis.navigator?.language
        || "en";
}

function isSpanish() {
    return getDiscordLanguage().toLowerCase().startsWith("es");
}

function t(spanish: string, english: string) {
    return isSpanish() ? spanish : english;
}

function makeId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getChannelName(channelId?: string) {
    if (!channelId) return undefined;
    return ChannelStore.getChannel(channelId)?.name ?? t("otro canal", "another channel");
}

function getIdentity(userId: string, channelId: string): Omit<Participant, "joinedAt"> {
    const user = UserStore.getUser(userId);
    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel?.guild_id;
    const nickname = guildId ? GuildMemberStore.getNick(guildId, userId) : undefined;
    const displayName = nickname
        ?? (user as any)?.globalName
        ?? user?.username
        ?? t("Usuario desconocido", "Unknown user");

    let avatarUrl: string | undefined;
    try {
        avatarUrl = (user as any)?.getAvatarURL?.(guildId, 64, true);
    } catch {
        avatarUrl = undefined;
    }

    return { displayName, avatarUrl };
}

function getCurrentVoiceChannelId() {
    return SelectedChannelStore.getVoiceChannelId() ?? undefined;
}

function trimHistory(session: VoiceSession) {
    const maxEvents = 250;
    if (session.events.length <= maxEvents) return;

    const sessionStart = session.events.find(event => event.kind === "session");
    const tail = session.events.slice(-(maxEvents - 1));
    session.events = sessionStart ? [sessionStart, ...tail.filter(event => event.id !== sessionStart.id)] : tail;
}

function startSession(channelId: string, channelNameOverride?: string) {
    const channelName = channelNameOverride
        ?? ChannelStore.getChannel(channelId)?.name
        ?? t("Llamada", "Call");
    const now = Date.now();
    const participants = new Map<string, Participant>();
    const voiceStates = VoiceStateStore.getVoiceStatesForChannel(channelId) as Record<string, unknown> | undefined;

    for (const userId of Object.keys(voiceStates ?? {})) {
        participants.set(userId, {
            joinedAt: now,
            ...getIdentity(userId, channelId)
        });
    }

    currentSession = {
        channelId,
        channelName,
        startedAt: now,
        participants,
        seenUserIds: new Set(participants.keys()),
        events: [{
            id: makeId(),
            kind: "session",
            timestamp: now,
            displayName: t(`Sesión iniciada en ${channelName}`, `Session started in ${channelName}`)
        }]
    };
}

function clearSession() {
    currentSession = null;
    lastTestUserId = undefined;
}

function ensureSessionFromStores() {
    const channelId = getCurrentVoiceChannelId();
    myLastChannelId = channelId;

    if (channelId) startSession(channelId);
    else clearSession();
}

function pushEvent(event: TimelineEvent) {
    if (!currentSession) return;
    currentSession.events.push(event);
    trimHistory(currentSession);
}

function formatDuration(milliseconds: number) {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return `${hours} h ${minutes} min`;
    if (minutes > 0) return `${minutes} min ${seconds} s`;
    return `${seconds} s`;
}

function showVoiceToast(
    displayName: string,
    action: string,
    durationText: string,
    kind: "join" | "rejoin" | "leave"
) {
    if (window.__OVERLAY__) return;

    const message = `${displayName} ${action}${durationText}`;
    let toastType = Toasts.Type.MESSAGE;

    if (settings.store.coloredToasts) {
        if (kind === "leave") {
            toastType = (Toasts.Type as any).FAILURE
                ?? (Toasts.Type as any).ERROR
                ?? Toasts.Type.MESSAGE;
        } else {
            toastType = (Toasts.Type as any).SUCCESS
                ?? Toasts.Type.MESSAGE;
        }
    }

    const body = globalThis.document?.body;

    // If Discord's DOM is not ready yet, keep the notification functional
    // rather than risking the loss of the toast.
    if (!body) {
        showToast(message, toastType, { duration: settings.store.toastDuration });
        return;
    }

    const preExistingTextNodes = new Set<Text>();

    const rememberExistingMatches = (root: Node) => {
        if (root.nodeType === Node.TEXT_NODE) {
            const textNode = root as Text;
            if (textNode.data.trim() === message) preExistingTextNodes.add(textNode);
            return;
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const textNode = walker.currentNode as Text;
            if (textNode.data.trim() === message) preExistingTextNodes.add(textNode);
        }
    };

    rememberExistingMatches(body);

    let finished = false;
    let observer: MutationObserver | null = null;

    const cleanup = () => {
        if (finished) return;
        finished = true;
        observer?.disconnect();
        observer = null;
    };

    const replaceTextNode = (textNode: Text) => {
        if (finished || preExistingTextNodes.has(textNode) || textNode.data.trim() !== message) {
            return false;
        }

        const parent = textNode.parentElement;
        if (!parent) return false;

        const strong = document.createElement("strong");
        strong.textContent = displayName;
        strong.setAttribute("data-vt-native-bold-user", "true");
        strong.style.color = "inherit";
        strong.style.fontFamily = "inherit";
        strong.style.fontSize = "inherit";
        strong.style.fontWeight = "700";
        strong.style.lineHeight = "inherit";

        const suffix = document.createTextNode(message.slice(displayName.length));
        textNode.replaceWith(strong, suffix);
        cleanup();
        return true;
    };

    const inspectNode = (root: Node) => {
        if (finished) return false;

        if (root.nodeType === Node.TEXT_NODE) {
            return replaceTextNode(root as Text);
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            if (replaceTextNode(walker.currentNode as Text)) return true;
        }

        return false;
    };

    observer = new MutationObserver(records => {
        for (const record of records) {
            if (record.type === "characterData" && inspectNode(record.target)) return;

            for (const addedNode of record.addedNodes) {
                if (inspectNode(addedNode)) return;
            }
        }
    });

    observer.observe(body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    showToast(message, toastType, { duration: settings.store.toastDuration });

    // Discord normally inserts the toast through a mutation before the next
    // paint. These fallbacks cover microtask/frame scheduling differences.
    queueMicrotask(() => inspectNode(body));
    requestAnimationFrame(() => inspectNode(body));
    window.setTimeout(() => inspectNode(body), 25);
    window.setTimeout(() => inspectNode(body), 75);
    window.setTimeout(cleanup, 1000);
}

function recordJoin(
    userId: string,
    sourceChannelId?: string,
    identityOverride?: Omit<Participant, "joinedAt">,
    showNotification = true
) {
    const session = currentSession;
    if (!session || session.participants.has(userId)) return;

    const now = Date.now();
    const identity = identityOverride ?? getIdentity(userId, session.channelId);
    const isRejoin = session.seenUserIds.has(userId);

    session.participants.set(userId, { joinedAt: now, ...identity });
    session.seenUserIds.add(userId);

    pushEvent({
        id: makeId(),
        kind: isRejoin ? "rejoin" : "join",
        timestamp: now,
        userId,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        otherChannelName: getChannelName(sourceChannelId)
    });

    if (showNotification && settings.store.notifyJoins) {
        const action = isRejoin
            ? t("ha vuelto a entrar", "rejoined")
            : t("se ha unido", "joined");

        showVoiceToast(
            identity.displayName,
            action,
            "",
            isRejoin ? "rejoin" : "join"
        );
    }
}

function recordLeave(
    userId: string,
    destinationChannelId?: string,
    showNotification = true
) {
    const session = currentSession;
    if (!session) return;

    const participant = session.participants.get(userId);
    if (!participant) return;

    const now = Date.now();
    const durationMs = Math.max(0, now - participant.joinedAt);
    session.participants.delete(userId);

    pushEvent({
        id: makeId(),
        kind: "leave",
        timestamp: now,
        userId,
        displayName: participant.displayName,
        avatarUrl: participant.avatarUrl,
        durationMs,
        otherChannelName: getChannelName(destinationChannelId)
    });

    if (showNotification && settings.store.notifyLeaves) {
        const movedTo = getChannelName(destinationChannelId);
        const action = movedTo
            ? t(`se ha movido a ${movedTo}`, `moved to ${movedTo}`)
            : t("ha salido", "left");
        const durationText = settings.store.showDurations && durationMs >= 5000
            ? ` · ${formatDuration(durationMs)}`
            : "";

        showVoiceToast(
            participant.displayName,
            action,
            durationText,
            "leave"
        );
    }
}

function handleLocalVoiceState(state: VoiceStateChangeEvent) {
    if (state.sessionId !== AuthenticationStore.getSessionId()) return;

    const nextChannelId = state.channelId;
    if (nextChannelId === myLastChannelId) return;

    myLastChannelId = nextChannelId;

    if (nextChannelId) startSession(nextChannelId);
    else clearSession();
}

function processVoiceStateUpdates(voiceStates: VoiceStateChangeEvent[]) {
    const myId = UserStore.getCurrentUser()?.id;
    if (!myId) return;

    for (const state of voiceStates) {
        if (state.userId === myId) {
            handleLocalVoiceState(state);
            continue;
        }

        const session = currentSession;
        if (!session) continue;

        const wasHere = state.oldChannelId === session.channelId;
        const isHere = state.channelId === session.channelId;

        if (wasHere === isHere) continue;

        if (isHere) recordJoin(state.userId, state.oldChannelId);
        else recordLeave(state.userId, state.channelId);
    }
}

function renderEventDescription(event: TimelineEvent) {
    const name = event.userId ? <strong className="vt-event-user">{event.displayName}</strong> : null;

    switch (event.kind) {
        case "session":
            return <span>{event.displayName}</span>;
        case "join":
            return event.otherChannelName
                ? <span>{name} {t("se unió desde", "joined from")} {event.otherChannelName}</span>
                : <span>{name} {t("se unió", "joined")}</span>;
        case "rejoin":
            return <span>{name} {t("volvió a entrar", "rejoined")}</span>;
        case "leave":
            return event.otherChannelName
                ? <span>{name} {t("se movió a", "moved to")} {event.otherChannelName}</span>
                : <span>{name} {t("salió", "left")}</span>;
    }
}

function eventSymbol(kind: TimelineEventKind) {
    switch (kind) {
        case "session": return "☎";
        case "join": return "+";
        case "rejoin": return "↺";
        case "leave": return "−";
    }
}

function formatClock(timestamp: number) {
    return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    }).format(timestamp);
}

function HistoryModal(props: any) {
    const session = currentSession;

    return (
        <ModalRoot {...props} size={ModalSize.MEDIUM}>
            <ModalHeader className="vt-modal-header">
                <div className="vt-modal-title-wrap">
                    <div className="vt-modal-title">{t("Historial de voz", "Voice history")}</div>
                    <div className="vt-modal-subtitle">
                        {session
                            ? `${session.channelName} · ${formatClock(session.startedAt)}`
                            : t("No hay una sesión activa", "There is no active session")}
                    </div>
                </div>
                <ModalCloseButton onClick={props.onClose} />
            </ModalHeader>

            <ModalContent className="vt-modal-content">
                {!session ? (
                    <div className="vt-empty">
                        {t("Únete a una llamada para empezar el historial.", "Join a call to start the history.")}
                    </div>
                ) : (
                    <>
                        <div className="vt-summary">
                            <div className="vt-summary-item">
                                <div className="vt-summary-label">{t("Eventos", "Events")}</div>
                                <div className="vt-summary-value">{Math.max(0, session.events.length - 1)}</div>
                            </div>

                            <div className="vt-summary-item">
                                <div className="vt-summary-label">{t("Sesión", "Session")}</div>
                                <div className="vt-summary-value">{formatDuration(Date.now() - session.startedAt)}</div>
                            </div>
                        </div>

                        <div className="vt-events">
                            {session.events.map(event => (
                                <div className={`vt-event vt-event-${event.kind}`} key={event.id}>
                                    <div className="vt-avatar-wrap">
                                        {event.avatarUrl ? (
                                            <img className="vt-avatar" src={event.avatarUrl} alt="" />
                                        ) : (
                                            <div className="vt-event-symbol">{eventSymbol(event.kind)}</div>
                                        )}
                                        {event.avatarUrl && (
                                            <div className="vt-event-badge">{eventSymbol(event.kind)}</div>
                                        )}
                                    </div>

                                    <div className="vt-event-main">
                                        <div className="vt-event-description">{renderEventDescription(event)}</div>
                                        {event.kind === "leave" && settings.store.showDurations && event.durationMs != null && (
                                            <div className="vt-event-detail">
                                                {t("Permaneció", "Stayed")} {formatDuration(event.durationMs)}
                                            </div>
                                        )}
                                    </div>

                                    <time className="vt-event-time">{formatClock(event.timestamp)}</time>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </ModalContent>
        </ModalRoot>
    );
}

function openHistory() {
    openModal(props => <HistoryModal {...props} />);
}

function clearCurrentHistory() {
    if (!currentSession) {
        showToast(t("No hay una sesión activa", "There is no active session"));
        return;
    }

    const session = currentSession;
    session.events = [{
        id: makeId(),
        kind: "session",
        timestamp: Date.now(),
        displayName: t(`Historial reiniciado en ${session.channelName}`, `History reset in ${session.channelName}`)
    }];
    session.seenUserIds = new Set(session.participants.keys());
    showToast(t("Historial reiniciado", "History reset"), Toasts.Type.SUCCESS);
}

function ensureTestSession() {
    if (!currentSession) startSession("voice-timeline-test", t("Canal de prueba", "Test channel"));
}

function simulateJoin() {
    ensureTestSession();
    testCounter += 1;
    lastTestUserId = `voice-timeline-test-user-${testCounter}`;
    recordJoin(lastTestUserId, undefined, {
        displayName: t(`Usuario de prueba ${testCounter}`, `Test user ${testCounter}`)
    });
}

function createSilentTestParticipant() {
    testCounter += 1;
    lastTestUserId = `voice-timeline-test-user-${testCounter}`;

    recordJoin(lastTestUserId, undefined, {
        displayName: t(`Usuario de prueba ${testCounter}`, `Test user ${testCounter}`)
    }, false);
}

function simulateLeave() {
    ensureTestSession();

    if (!lastTestUserId || !currentSession?.participants.has(lastTestUserId)) {
        createSilentTestParticipant();
    }

    if (lastTestUserId) recordLeave(lastTestUserId);
}

function simulateRejoin() {
    ensureTestSession();

    if (!lastTestUserId) {
        createSilentTestParticipant();
    }

    if (!lastTestUserId) return;

    if (currentSession?.participants.has(lastTestUserId)) {
        recordLeave(lastTestUserId, undefined, false);
    }

    recordJoin(lastTestUserId, undefined, {
        displayName: t(`Usuario de prueba ${testCounter}`, `Test user ${testCounter}`)
    });
}

function SettingsTestPanel() {
    return (
        <Forms.FormSection>
            <Forms.FormTitle tag="h3">{t("Pruebas sin otra cuenta", "Testing without another account")}</Forms.FormTitle>
            <Forms.FormText>
                {t(
                    "Estos botones usan el mismo flujo interno que los eventos reales.",
                    "These buttons use the same internal flow as real events."
                )}
            </Forms.FormText>
            <div className="vt-test-buttons">
                <Button size={Button.Sizes.SMALL} onClick={simulateJoin}>
                    {t("Simular entrada", "Simulate join")}
                </Button>
                <Button size={Button.Sizes.SMALL} onClick={simulateLeave}>
                    {t("Simular salida", "Simulate leave")}
                </Button>
                <Button size={Button.Sizes.SMALL} onClick={simulateRejoin}>
                    {t("Simular reentrada", "Simulate rejoin")}
                </Button>
                <Button size={Button.Sizes.SMALL} onClick={openHistory}>
                    {t("Abrir historial", "Open history")}
                </Button>
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.RED}
                    onClick={clearCurrentHistory}
                >
                    {t("Limpiar historial", "Clear history")}
                </Button>
            </div>
        </Forms.FormSection>
    );
}

const patchChannelContextMenu: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel || channel.id !== currentSession?.channelId) return;

    children.splice(-1, 0,
        <Menu.MenuItem
            id="voice-timeline-history"
            label={channel.guild_id ? t("Historial de voz", "Voice history") : t("Historial de llamada", "Call history")}
            action={openHistory}
        />
    );
};

export default definePlugin({
    name: "VoiceTimeline",
    get description() {
        return t(
            "Muestra quién entra o sale de tu llamada y conserva un historial de la sesión actual",
            "Shows who joins or leaves your call and keeps a history of the current session"
        );
    },
    authors: [{ name: "feve", id: 0n }],
    tags: ["Voice", "Utility"],

    settings,

    contextMenus: {
        "channel-context": patchChannelContextMenu
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceStateChangeEvent[]; }) {
            processVoiceStateUpdates(voiceStates);
        }
    },

    start() {
        startTimer = window.setTimeout(ensureSessionFromStores, 750);
    },

    stop() {
        if (startTimer !== undefined) window.clearTimeout(startTimer);
        startTimer = undefined;
        myLastChannelId = undefined;
        clearSession();
    },

    settingsAboutComponent: SettingsTestPanel
});
