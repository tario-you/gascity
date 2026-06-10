import type { SessionRecord } from "../api";
import { api, cityScope } from "../api";
import { byId, clear, el } from "../util/dom";
import { calculateActivity, formatTimestamp, statusBadgeClass, truncate } from "../util/legacy";
import { showToast } from "../ui";
import {
  closeSessionCockpitExternal,
  configureSessionCockpitHost,
  installSessionCockpitInteractions,
  isSessionCockpitOpen,
  openSessionCockpit as openSessionCockpitDrawer,
} from "./session_cockpit";

let selectedWorkspaceSessionID = "";
let openedSessionDeepLinkID = "";
let autoOpenedDefaultChatCity = "";
const pendingStateConcurrency = 8;

configureSessionCockpitHost({
  hasSelectedSession: () => selectedWorkspaceSessionID !== "",
  markSessionSelection: markSessionWorkspaceSelection,
  setSessionDetailVisible: setSessionsDetailVisible,
});

export async function renderCrew(): Promise<void> {
  const city = cityScope();
  if (!city) {
    resetCrewNoCity();
    return;
  }

  const crewLoading = byId("crew-loading");
  const crewTable = byId<HTMLTableElement>("crew-table");
  const crewEmpty = byId("crew-empty");
  const crewBody = byId("crew-tbody");
  const riggedBody = byId("rigged-body");
  const pooledBody = byId("pooled-body");
  if (!crewLoading || !crewTable || !crewEmpty || !crewBody || !riggedBody || !pooledBody) return;

  setCrewEmptyMessage("No crew configured");
  crewLoading.style.display = "block";
  crewTable.style.display = "none";
  crewEmpty.style.display = "none";
  clear(crewBody);

  const { data, error } = await api.GET("/v0/city/{cityName}/sessions", {
    params: { path: { cityName: city }, query: { state: "active", peek: true } },
  });
  if (error || !data?.items) {
    crewLoading.textContent = "Failed to load crew";
    resetSessionsWorkspace("Failed to load sessions");
    renderSimpleEmpty(riggedBody, "No rigged agents");
    renderSimpleEmpty(pooledBody, "No pooled agents");
    return;
  }

  const sessions = data.items;
  const pendingBySessionID = await loadPendingStates(sessions);
  // The Crew table is for persistent named workers — sessions whose backing
  // agent is classified server-side as "crew". Other agent kinds (pool,
  // role) belong on the Rigged/Pooled panels (or stay invisible until a
  // dedicated panel exists), so filter them out here.
  const crew = sessions.filter((session) => session.agent_kind === "crew");

  const beadTitles = new Map<string, string>();
  await Promise.all(
    sessions.map(async (session) => {
      if (!session.active_bead) return;
      if (beadTitles.has(session.active_bead)) return;
      const res = await api.GET("/v0/city/{cityName}/bead/{id}", {
        params: { path: { cityName: city, id: session.active_bead } },
      });
      beadTitles.set(session.active_bead, res.data?.id ? (res.data.title ?? res.data.id) : session.active_bead);
    }),
  );

  renderSessionsWorkspace(sessions, pendingBySessionID, beadTitles);

  crew.forEach((session) => {
    const state = classifyCrewState(session, pendingBySessionID.get(session.id) ?? false);
    const beadText = session.active_bead ? truncate(beadTitles.get(session.active_bead) ?? session.active_bead, 24) : "—";
    const row = el("tr", {}, [
      el("td", {}, [session.template]),
      el("td", {}, [session.rig ?? "city"]),
      el("td", {}, [el("span", { class: `badge ${statusBadgeClass(state)}` }, [state])]),
      el("td", {}, [beadText]),
      el("td", { class: calculateActivity(session.last_active).colorClass ? `activity-${calculateActivity(session.last_active).colorClass}` : "" }, [
        el("span", { class: "activity-dot" }),
        ` ${calculateActivity(session.last_active).display}`,
      ]),
      el("td", {}, [
        el("span", { class: `badge ${session.attached ? "badge-green" : "badge-muted"}` }, [
          session.attached ? "Attached" : "Detached",
        ]),
      ]),
      el("td", {}, [
        chatButton(session.id, session.template),
        " ",
        attachButton(session.template),
      ]),
    ]);
    crewBody.append(row);
  });

  byId("crew-count")!.textContent = String(crew.length);
  crewLoading.style.display = "none";
  if (crew.length > 0) {
    crewTable.style.display = "table";
  } else {
    setCrewEmptyMessage("No crew configured");
    crewEmpty.style.display = "block";
  }

  renderRiggedAgents(sessions, beadTitles);
  renderPooledAgents(sessions);
}

export function resetCrewNoCity(): void {
  const crewLoading = byId("crew-loading");
  const crewTable = byId<HTMLTableElement>("crew-table");
  const crewEmpty = byId("crew-empty");
  const crewBody = byId("crew-tbody");
  const riggedBody = byId("rigged-body");
  const pooledBody = byId("pooled-body");
  if (!crewLoading || !crewTable || !crewEmpty || !crewBody || !riggedBody || !pooledBody) return;

  closeSessionCockpitExternal();
  resetSessionsWorkspace("Select a city to view sessions");
  byId("crew-count")!.textContent = "0";
  byId("rigged-count")!.textContent = "0";
  byId("pooled-count")!.textContent = "0";
  crewLoading.style.display = "none";
  crewTable.style.display = "none";
  crewEmpty.style.display = "block";
  setCrewEmptyMessage("Select a city to view crew");
  clear(crewBody);
  renderSimpleEmpty(riggedBody, "Select a city to view rigged agents");
  renderSimpleEmpty(pooledBody, "Select a city to view pooled agents");
}

function setCrewEmptyMessage(message: string): void {
  byId("crew-empty")?.querySelector("p")?.replaceChildren(document.createTextNode(message));
}

function classifyCrewState(session: SessionRecord, hasPending: boolean): string {
  if (hasPending) return "questions";
  if (session.active_bead) return "spinning";
  if (!session.running) return "finished";
  return "idle";
}

async function loadPendingStates(sessions: SessionRecord[]): Promise<Map<string, boolean>> {
  const city = cityScope();
  const pending = new Map<string, boolean>();
  if (!city) return pending;
  let nextIndex = 0;
  const workerCount = Math.min(pendingStateConcurrency, sessions.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const session = sessions[nextIndex++];
      if (!session) return;
      const res = await api.GET("/v0/city/{cityName}/session/{id}/pending", {
        params: { path: { cityName: city, id: session.id } },
      });
      pending.set(session.id, Boolean(res.data?.pending));
    }
  }));
  return pending;
}

function renderSessionsWorkspace(
  sessions: SessionRecord[],
  pendingBySessionID: Map<string, boolean>,
  beadTitles: Map<string, string>,
): void {
  const count = byId("sessions-count");
  const list = byId("sessions-list");
  const detail = byId("sessions-detail-summary");
  if (!count || !list || !detail) return;

  const rows = [...sessions].sort(compareSessions);
  count.textContent = String(rows.length);
  clear(list);

  if (rows.length === 0) {
    selectedWorkspaceSessionID = "";
    renderSimpleEmpty(list, "No active sessions");
    renderSimpleEmpty(detail, "No session selected");
    setSessionsDetailVisible(false);
    return;
  }

  if (!rows.some((session) => session.id === selectedWorkspaceSessionID)) {
    selectedWorkspaceSessionID = "";
  }

  const requestedSessionID = requestedSessionDeepLinkID();
  if (!requestedSessionID) openedSessionDeepLinkID = "";
  const requestedSession = requestedSessionID ? rows.find((session) => session.id === requestedSessionID) : undefined;
  if (requestedSession && requestedSessionID !== openedSessionDeepLinkID) {
    selectedWorkspaceSessionID = requestedSession.id;
  }
  if (!selectedWorkspaceSessionID) {
    selectedWorkspaceSessionID = defaultChatSession(rows)?.id ?? "";
  }

  rows.forEach((session) => {
    const hasPending = pendingBySessionID.get(session.id) ?? false;
    const state = sessionWorkspaceState(session, hasPending);
    const activity = calculateActivity(session.last_active);
    const active = session.id === selectedWorkspaceSessionID;
    const row = el("div", {
      class: `session-row${active ? " active" : ""}`,
      "data-session-id": session.id,
      tabindex: "0",
    }, [
      el("div", { class: "session-row-main" }, [
        el("span", { class: "session-row-name" }, [sessionTitle(session)]),
        el("span", { class: `badge ${sessionStateBadgeClass(state)}` }, [state]),
      ]),
      el("div", { class: "session-row-meta" }, [
        el("span", {}, [sessionKind(session)]),
        el("span", {}, [sessionLocation(session)]),
        el("span", { class: `activity-${activity.colorClass}` }, [el("span", { class: "activity-dot" }), activity.display]),
      ]),
      el("div", { class: "session-row-work" }, [
        session.active_bead ? truncate(beadTitles.get(session.active_bead) ?? session.active_bead, 72) : truncate(session.last_output, 72) || "—",
      ]),
      el("div", { class: "session-row-actions" }, [
        chatButton(session.id, sessionTitle(session)),
        " ",
        attachButton(session.template),
      ]),
    ]);
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement | null)?.closest("button")) return;
      selectedWorkspaceSessionID = session.id;
      markSessionWorkspaceSelection(session.id);
      void openSessionCockpit(session.id, sessionTitle(session));
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectedWorkspaceSessionID = session.id;
      markSessionWorkspaceSelection(session.id);
      void openSessionCockpit(session.id, sessionTitle(session));
    });
    list.append(row);
  });

  const selected = rows.find((session) => session.id === selectedWorkspaceSessionID);
  if (selected) {
    setSessionsDetailVisible(true);
    renderSessionWorkspaceDetail(selected, pendingBySessionID.get(selected.id) ?? false, beadTitles);
  } else {
    renderSimpleEmpty(detail, "No session selected");
    setSessionsDetailVisible(false);
  }

  if (requestedSession && requestedSessionID !== openedSessionDeepLinkID) {
    openedSessionDeepLinkID = requestedSessionID;
    void openSessionCockpit(requestedSession.id, sessionTitle(requestedSession));
  } else if (!requestedSessionID && selected && autoOpenedDefaultChatCity !== cityScope() && !isSessionCockpitOpen()) {
    autoOpenedDefaultChatCity = cityScope();
    void openSessionCockpit(selected.id, sessionTitle(selected));
  }
}

function requestedSessionDeepLinkID(): string {
  return new URLSearchParams(window.location.search).get("session")?.trim() ?? "";
}

function resetSessionsWorkspace(message: string): void {
  const count = byId("sessions-count");
  const list = byId("sessions-list");
  const detail = byId("sessions-detail-summary");
  if (!count || !list || !detail) return;
  count.textContent = "0";
  selectedWorkspaceSessionID = "";
  autoOpenedDefaultChatCity = "";
  setSessionsDetailVisible(false);
  renderSimpleEmpty(list, message);
  renderSimpleEmpty(detail, message);
}

function renderSessionWorkspaceDetail(
  session: SessionRecord,
  hasPending: boolean,
  beadTitles: Map<string, string>,
): void {
  const detail = byId("sessions-detail-summary");
  if (!detail) return;
  const state = sessionWorkspaceState(session, hasPending);
  const activity = calculateActivity(session.last_active);
  const work = session.active_bead ? `${session.active_bead} ${beadTitles.get(session.active_bead) ?? ""}`.trim() : "—";
  clear(detail);
  detail.append(
    el("div", { class: "session-detail-header" }, [
      el("div", {}, [
        el("h3", {}, [sessionTitle(session)]),
        el("div", { class: "session-detail-subtitle" }, [session.id]),
      ]),
      el("span", { class: `badge ${sessionStateBadgeClass(state)}` }, [state]),
    ]),
    el("div", { class: "session-detail-grid" }, [
      detailField("Kind", sessionKind(session)),
      detailField("Location", sessionLocation(session)),
      detailField("Terminal", session.attached ? "Attached" : "Detached"),
      detailField("Activity", activity.display),
      detailField("Work", work),
      detailField("Model", [session.provider, session.model].filter(Boolean).join(" / ") || "—"),
    ]),
    el("div", { class: "session-detail-actions" }, [
      chatButton(session.id, sessionTitle(session)),
      attachButton(session.template),
    ]),
  );
  detail.style.display = isSessionCockpitOpen() ? "none" : "flex";
  setSessionsDetailVisible(true);
}

function markSessionWorkspaceSelection(sessionID: string): void {
  selectedWorkspaceSessionID = sessionID;
  setSessionsDetailVisible(true);
  document.querySelectorAll<HTMLElement>(".session-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.sessionId === sessionID);
  });
}

function setSessionsDetailVisible(visible: boolean): void {
  byId("sessions-list")?.closest(".sessions-workspace")?.classList.toggle("detail-visible", visible);
}

function detailField(label: string, value: string): HTMLElement {
  return el("div", { class: "session-detail-field" }, [
    el("span", { class: "session-detail-label" }, [label]),
    el("span", { class: "session-detail-value" }, [value]),
  ]);
}

function compareSessions(left: SessionRecord, right: SessionRecord): number {
  const leftPinned = isPinnedChatSession(left);
  const rightPinned = isPinnedChatSession(right);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  const leftRank = sessionRank(left);
  const rightRank = sessionRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftTime = Date.parse(left.last_active ?? "") || 0;
  const rightTime = Date.parse(right.last_active ?? "") || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return sessionTitle(left).localeCompare(sessionTitle(right));
}

function sessionRank(session: SessionRecord): number {
  if (session.configured_named_session && !session.rig && !session.pool) return 0;
  if (session.active_bead) return 1;
  if (session.agent_kind === "crew") return 2;
  if (session.rig) return 3;
  if (session.pool) return 4;
  return 5;
}

function defaultChatSession(sessions: SessionRecord[]): SessionRecord | undefined {
  return sessions.find(isPinnedChatSession) ?? sessions[0];
}

function isPinnedChatSession(session: SessionRecord): boolean {
  const candidates = [session.template, session.title, session.alias, session.session_name]
    .filter((candidate): candidate is string => Boolean(candidate));
  return candidates.some((candidate) => {
    const role = candidate.toLowerCase().split(/[/.]/).pop() ?? "";
    return role === "mayor" || role.startsWith("mayor-");
  });
}

function sessionTitle(session: SessionRecord): string {
  return session.template || session.id;
}

function sessionKind(session: SessionRecord): string {
  if (session.configured_named_session && !session.rig && !session.pool) return "city";
  return session.agent_kind || (session.pool ? "pool" : session.rig ? "rig" : "session");
}

function sessionLocation(session: SessionRecord): string {
  if (session.rig && session.pool) return `${session.rig}/${session.pool}`;
  if (session.rig) return session.rig;
  if (session.pool) return session.pool;
  return "city";
}

function sessionWorkspaceState(session: SessionRecord, hasPending: boolean): string {
  if (hasPending) return "needs reply";
  if (!session.running) return "stopped";
  if (session.active_bead) return "working";
  if (calculateActivity(session.last_active).colorClass === "green") return "active";
  return "idle";
}

function sessionStateBadgeClass(state: string): string {
  switch (state) {
    case "active":
    case "working":
      return "badge-green";
    case "needs reply":
      return "badge-yellow";
    case "stopped":
      return "badge-muted";
    default:
      return statusBadgeClass(state);
  }
}

function attachButton(template: string): HTMLElement {
  const btn = el("button", { class: "attach-btn", type: "button" }, ["Terminal"]);
  btn.addEventListener("click", async () => {
    const command = `gc agent attach ${template}`;
    try {
      await navigator.clipboard.writeText(command);
      showToast("success", "Attach command copied", command);
    } catch {
      showToast("error", "Copy failed", command);
    }
  });
  return btn;
}

function chatButton(sessionID: string, label: string): HTMLElement {
  return logButton(sessionID, "Chat", label);
}

function logButton(sessionID: string, label: string, title = label): HTMLElement {
  const btn = el("button", { class: "agent-log-link", type: "button", "data-session-id": sessionID, title }, [label]);
  btn.addEventListener("click", () => {
    void openSessionCockpit(sessionID, title);
  });
  return btn;
}

export async function openSessionCockpit(sessionID: string, label: string): Promise<void> {
  writeSessionDeepLink(sessionID);
  await openSessionCockpitDrawer(sessionID, label);
}

function writeSessionDeepLink(sessionID: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionID);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export const installCrewInteractions = installSessionCockpitInteractions;
export const closeLogDrawerExternal = closeSessionCockpitExternal;

// renderRiggedAgents lists sessions attached to a specific rig. Grouping
// is purely by the API's `rig` + `pool` fields — no role names hardcoded.
function renderRiggedAgents(sessions: SessionRecord[], beadTitles: Map<string, string>): void {
  const body = byId("rigged-body");
  const count = byId("rigged-count");
  if (!body || !count) return;

  const rows = sessions.filter((session) => session.rig && session.pool);
  count.textContent = String(rows.length);
  if (rows.length === 0) {
    renderSimpleEmpty(body, "No rigged agents");
    return;
  }

  const tbody = el("tbody");
  rows.forEach((session) => {
    const activity = calculateActivity(session.last_active);
    const workStatus = !session.active_bead ? "Idle" : activity.colorClass === "red" ? "Stuck" : activity.colorClass === "yellow" ? "Stale" : "Working";
    tbody.append(el("tr", { class: `rigged-${workStatus.toLowerCase()}` }, [
      el("td", {}, [logButton(session.id, session.template)]),
      el("td", {}, [el("span", { class: "badge badge-muted" }, [session.pool ?? "pool"])]),
      el("td", {}, [session.rig ?? "city"]),
      el("td", { class: "rigged-issue" }, [
        session.active_bead
          ? `${session.active_bead} ${beadTitles.get(session.active_bead) ?? ""}`.trim()
          : "—",
      ]),
      el("td", {}, [el("span", { class: `badge ${statusBadgeClass(workStatus)}` }, [workStatus])]),
      el("td", { class: `activity-${activity.colorClass}` }, [el("span", { class: "activity-dot" }), ` ${activity.display}`]),
    ]));
  });

  clear(body);
  body.append(el("table", {}, [
    el("thead", {}, [el("tr", {}, [
      el("th", {}, ["Agent"]),
      el("th", {}, ["Pool"]),
      el("th", {}, ["Rig"]),
      el("th", {}, ["Working On"]),
      el("th", {}, ["Status"]),
      el("th", {}, ["Activity"]),
    ])]),
    tbody,
  ]));
}

// renderPooledAgents lists sessions that belong to a pool but are not
// bound to a specific rig (floating workers). Grouping is by API fields
// only — no role names hardcoded.
function renderPooledAgents(sessions: SessionRecord[]): void {
  const body = byId("pooled-body");
  const count = byId("pooled-count");
  if (!body || !count) return;
  const rows = sessions.filter((session) => !session.rig && session.pool);
  count.textContent = String(rows.length);
  if (rows.length === 0) {
    renderSimpleEmpty(body, "No pooled agents");
    return;
  }

  const tbody = el("tbody");
  rows.forEach((session) => {
    tbody.append(el("tr", {}, [
      el("td", {}, [session.template]),
      el("td", {}, [el("span", { class: `badge ${session.active_bead ? "badge-yellow" : "badge-green"}` }, [session.active_bead ? "Working" : "Idle"])]),
      el("td", { class: "status-hint" }, [truncate(session.last_output, 80) || "—"]),
      el("td", {}, [formatTimestamp(session.last_active)]),
    ]));
  });

  clear(body);
  body.append(el("table", {}, [
    el("thead", {}, [el("tr", {}, [
      el("th", {}, ["Agent"]),
      el("th", {}, ["State"]),
      el("th", {}, ["Work"]),
      el("th", {}, ["Activity"]),
    ])]),
    tbody,
  ]));
}

function renderSimpleEmpty(container: HTMLElement, message: string): void {
  clear(container);
  container.append(el("div", { class: "empty-state" }, [el("p", {}, [message])]));
}
