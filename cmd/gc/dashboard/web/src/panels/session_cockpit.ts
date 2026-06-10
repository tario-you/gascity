import type { SessionRecord } from "../api";
import { api, cityScope, mutationHeaders } from "../api";
import { logDebug } from "../logger";
import { connectAgentOutput, type AgentOutputMessage, type SSEHandle } from "../sse";
import { showToast } from "../ui";
import { byId, clear, el } from "../util/dom";
import {
  appendDisplayTurns,
  attachActivityTurnsToFirstOutput,
  clearRenderedTranscriptImages,
  expandTranscriptTurns,
  isOutputMessageDisplayTurn,
  isStandaloneActivityDisplayTurn,
  isUserMessageDisplayTurn,
  renderTurn,
  resetTranscriptRenderContext,
  resetTranscriptRenderState,
  scrollLogDrawerToBottom,
  setTranscriptRenderContext,
  shouldReplaceWithStreamSnapshot,
  turnCountLabel,
} from "./session_transcript";
import { apiURL, attachmentImageSrc, sessionAttachmentDeletePath, sessionAttachmentsPath } from "./session_paths";
import type { ChatAttachment, DisplayTurn, PendingInteraction, StreamTurnPayload, SubmitIntent, TranscriptTurn } from "./session_types";

interface SessionCockpitHost {
  hasSelectedSession: () => boolean;
  markSessionSelection: (sessionID: string) => void;
  setSessionDetailVisible: (visible: boolean) => void;
}

const defaultHost: SessionCockpitHost = {
  hasSelectedSession: () => false,
  markSessionSelection: () => undefined,
  setSessionDetailVisible: () => undefined,
};

let host: SessionCockpitHost = defaultHost;
let logHandle: SSEHandle | null = null;
let logSessionID = "";
let logBeforeCursor = "";
let logCount = 0;
let logSubmitting = false;
let pendingAttachments: ChatAttachment[] = [];
let currentPendingInteraction: PendingInteraction | null = null;
let streamActivityBuffer: DisplayTurn[] = [];
let streamProgressBuffer: StreamProgressTurn[] = [];
let pendingLocalSubmissions: PendingLocalSubmission[] = [];
let nextLocalSubmissionID = 0;
let nextStreamProgressID = 0;

const SESSION_SUBMIT_BODY_LIMIT_BYTES = 1_048_576;
const SESSION_SUBMIT_SAFE_BYTES = 900_000;

interface PendingLocalSubmission {
  attachmentNames: string[];
  createdAt: number;
  id: string;
  text: string;
}

interface StreamProgressTurn {
  id: string;
  turn: DisplayTurn;
}

export function configureSessionCockpitHost(next: Partial<SessionCockpitHost>): void {
  host = { ...host, ...next };
}

export function isSessionCockpitOpen(): boolean {
  const drawer = byId("agent-log-drawer");
  return Boolean(logSessionID && drawer && drawer.style.display !== "none");
}

export async function openSessionCockpit(sessionID: string, label: string): Promise<void> {
  host.markSessionSelection(sessionID);
  await openLogDrawer(sessionID, label);
}

export function installSessionCockpitInteractions(): void {
  byId("log-drawer-close-btn")?.addEventListener("click", () => closeLogDrawer());
  const attachBtn = byId<HTMLButtonElement>("log-drawer-attach-btn");
  if (attachBtn) {
    attachBtn.title = "Attach images";
    attachBtn.addEventListener("click", () => byId<HTMLInputElement>("log-drawer-file-input")?.click());
  }
  byId<HTMLInputElement>("log-drawer-file-input")?.addEventListener("change", (event) => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    void addSelectedAttachments(input.files);
    input.value = "";
  });
  byId<HTMLFormElement>("log-drawer-composer")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitLogDrawerMessage();
  });
  byId<HTMLSelectElement>("log-drawer-intent")?.addEventListener("change", () => updateSubmitRequestSizeHint());
  byId<HTMLTextAreaElement>("log-drawer-input")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    void submitLogDrawerMessage();
  });
  byId<HTMLTextAreaElement>("log-drawer-input")?.addEventListener("paste", (event) => {
    const imageFiles = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void addSelectedAttachments(imageFiles);
  });
  byId("log-drawer-pending")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const action = target.dataset.pendingAction;
    if (!action) return;
    void respondToPendingInteraction(action);
  });
  byId("log-drawer-older-btn")?.addEventListener("click", () => {
    logDebug("crew", "Load older transcript clicked", {
      hasCursor: logBeforeCursor !== "",
      sessionID: logSessionID,
    });
    if (!logSessionID || !logBeforeCursor) return;
    void loadTranscript(logSessionID, true);
  });
}

async function openLogDrawer(sessionID: string, label: string): Promise<void> {
  const drawer = byId("agent-log-drawer");
  const nameEl = byId("log-drawer-agent-name");
  const messagesEl = byId("log-drawer-messages");
  const loadingEl = byId("log-drawer-loading");
  if (!drawer || !nameEl || !messagesEl || !loadingEl) return;

  if (logSessionID === sessionID && drawer.style.display !== "none") {
    byId<HTMLTextAreaElement>("log-drawer-input")?.focus();
    return;
  }

  closeLogDrawer();
  logSessionID = sessionID;
  logBeforeCursor = "";
  logCount = 0;
  setTranscriptRenderContext(sessionID, label);
  resetTranscriptRenderState();

  nameEl.textContent = label;
  clear(messagesEl);
  messagesEl.append(loadingEl);
  loadingEl.style.display = "block";
  resetLogComposer();
  resetSessionCockpitState();
  drawer.style.display = "flex";
  byId("sessions-detail-summary")?.style.setProperty("display", "none");

  void loadSessionCockpitState(sessionID);
  await loadTranscript(sessionID, false);
  const city = cityScope();
  if (!city) return;
  logHandle = connectAgentOutput(city, sessionID, (msg) => appendStreamEvent(msg));
}

function closeLogDrawer(): void {
  logHandle?.close();
  logHandle = null;
  logSessionID = "";
  logBeforeCursor = "";
  logSubmitting = false;
  resetTranscriptRenderContext();
  resetLogComposer();
  resetSessionCockpitState();
  const drawer = byId("agent-log-drawer");
  if (drawer && drawer.style.display !== "none") {
    drawer.style.display = "none";
    byId("sessions-detail-summary")?.style.removeProperty("display");
    host.setSessionDetailVisible(host.hasSelectedSession());
  }
}

// closeLogDrawerExternal is called by main.ts when the dashboard leaves
// city scope, so the transcript stream gets torn down with the city view.
export function closeSessionCockpitExternal(): void {
  closeLogDrawer();
}

async function loadSessionCockpitState(sessionID: string): Promise<void> {
  const city = cityScope();
  if (!city) return;
  const [detailResult, pendingResult] = await Promise.allSettled([
    api.GET("/v0/city/{cityName}/session/{id}", {
      params: { path: { cityName: city, id: sessionID }, query: { peek: false } },
    }),
    api.GET("/v0/city/{cityName}/session/{id}/pending", {
      params: { path: { cityName: city, id: sessionID } },
    }),
  ]);
  if (logSessionID !== sessionID) return;
  if (detailResult.status === "fulfilled" && detailResult.value.data) {
    renderSessionCockpitMeta(detailResult.value.data);
    renderSubmitIntentSelector(detailResult.value.data.submission_capabilities);
  } else {
    renderSessionCockpitMeta(null);
    renderSubmitIntentSelector(null);
  }
  if (pendingResult.status === "fulfilled" && pendingResult.value.data) {
    renderPendingInteraction((pendingResult.value.data.pending ?? null) as PendingInteraction | null);
  } else {
    renderPendingInteraction(null);
  }
}

function resetSessionCockpitState(): void {
  currentPendingInteraction = null;
  streamActivityBuffer = [];
  streamProgressBuffer = [];
  pendingLocalSubmissions = [];
  renderSessionCockpitMeta(null);
  renderSubmitIntentSelector(null);
  renderPendingInteraction(null);
}

function renderSessionCockpitMeta(session: Partial<SessionRecord> | null): void {
  const meta = byId("log-drawer-meta");
  if (!meta) return;
  clear(meta);
  if (!session) {
    meta.style.display = "none";
    return;
  }
  const items: string[] = [];
  if (session.provider) items.push(session.provider);
  if (session.model) items.push(session.model);
  if (typeof session.context_pct === "number") items.push(`${session.context_pct}% ctx`);
  if (typeof session.context_window === "number") items.push(`${session.context_window.toLocaleString()} ctx`);
  if (session.activity) items.push(session.activity);
  if (session.options?.permission_mode) items.push(session.options.permission_mode);
  if (session.running === false) items.push("not running");
  meta.append(...items.slice(0, 6).map((item) => el("span", { class: "log-drawer-meta-pill" }, [item])));
  meta.style.display = items.length > 0 ? "flex" : "none";
}

function renderSubmitIntentSelector(_caps: SessionRecord["submission_capabilities"] | null | undefined): void {
  const wrap = byId("log-drawer-intent-wrap");
  const select = byId<HTMLSelectElement>("log-drawer-intent");
  if (!wrap || !select) return;
  clear(select);
  select.append(el("option", { value: "default" }, ["Default"]));
  select.value = "default";
  wrap.style.display = "none";
}

function selectedSubmitIntent(): SubmitIntent {
  const select = byId<HTMLSelectElement>("log-drawer-intent");
  const value = select?.value;
  return value === "follow_up" || value === "interrupt_now" ? value : "default";
}

function renderPendingInteraction(pending: PendingInteraction | null): void {
  currentPendingInteraction = pending?.request_id ? pending : null;
  const container = byId("log-drawer-pending");
  if (!container) return;
  clear(container);
  if (!currentPendingInteraction) {
    container.style.display = "none";
    return;
  }
  const prompt = currentPendingInteraction.prompt?.trim() || currentPendingInteraction.kind || "Session needs a response";
  const actions = pendingActions(currentPendingInteraction);
  container.append(
    el("div", { class: "log-pending-copy" }, [
      el("span", { class: "log-pending-label" }, [currentPendingInteraction.kind ?? "pending"]),
      el("span", { class: "log-pending-prompt" }, [prompt]),
    ]),
    el("div", { class: "log-pending-actions" }, [
      ...actions.map((action) => el("button", {
        class: "log-pending-btn",
        "data-pending-action": action,
        type: "button",
      }, [actionLabel(action)])),
      el("input", {
        class: "log-pending-response",
        id: "log-drawer-pending-response",
        placeholder: "Response...",
        type: "text",
      }),
      el("button", {
        class: "log-pending-btn",
        "data-pending-action": "respond",
        type: "button",
      }, ["Respond"]),
    ]),
  );
  container.style.display = "flex";
}

function pendingActions(pending: PendingInteraction): string[] {
  const options = (pending.options ?? []).map((option) => option.trim()).filter(Boolean);
  if (options.length > 0) return options.slice(0, 4);
  return ["approve", "deny"];
}

function actionLabel(action: string): string {
  return action.replace(/[_-]+/g, " ").replace(/^\w/, (first) => first.toUpperCase());
}

async function respondToPendingInteraction(action: string): Promise<void> {
  const city = cityScope();
  const sessionID = logSessionID;
  const pending = currentPendingInteraction;
  if (!city || !sessionID || !pending?.request_id) return;
  const textInput = byId<HTMLInputElement>("log-drawer-pending-response");
  const text = action === "respond" ? textInput?.value.trim() ?? "" : "";
  const res = await api.POST("/v0/city/{cityName}/session/{id}/respond", {
    params: { path: { cityName: city, id: sessionID }, header: mutationHeaders },
    body: { action, request_id: pending.request_id, text },
  });
  if (res.error) {
    showToast("error", "Response failed", res.error.detail ?? "Could not respond to pending interaction");
    return;
  }
  renderPendingInteraction(null);
  showToast("success", "Response sent", actionLabel(action));
}

async function loadTranscript(sessionID: string, prepend: boolean): Promise<void> {
  const city = cityScope();
  const messagesEl = byId("log-drawer-messages");
  const loadingEl = byId("log-drawer-loading");
  const olderBtn = byId<HTMLButtonElement>("log-drawer-older-btn");
  const countEl = byId("log-drawer-count");
  const body = byId("log-drawer-body");
  if (!city || !messagesEl || !loadingEl || !olderBtn || !countEl) return;

  const previousScrollHeight = body?.scrollHeight ?? 0;
  const previousScrollTop = body?.scrollTop ?? 0;
  loadingEl.style.display = "block";
  const res = await api.GET("/v0/city/{cityName}/session/{id}/transcript", {
    params: {
      path: { cityName: city, id: sessionID },
      query: { tail: String(prepend ? 50 : 25), before: prepend ? logBeforeCursor : undefined },
    },
  });
  if (logSessionID !== sessionID) return;
  loadingEl.style.display = "none";
  if (res.error || !res.data) {
    showToast("error", "Transcript failed", res.error?.detail ?? "Could not load transcript");
    return;
  }

  if (!prepend) {
    clearRenderedTranscriptImages();
    streamActivityBuffer = [];
    streamProgressBuffer = [];
    pendingLocalSubmissions = [];
  }
  const fragment = document.createDocumentFragment();
  logCount += appendDisplayTurns(fragment, expandTranscriptTurns(res.data.turns ?? []));
  if (prepend) {
    messagesEl.prepend(fragment);
  } else {
    clear(messagesEl);
    messagesEl.append(fragment);
  }
  messagesEl.append(loadingEl);
  loadingEl.style.display = "none";
  countEl.textContent = turnCountLabel(logCount);

  logBeforeCursor = res.data.pagination?.truncated_before_message ?? "";
  olderBtn.style.display = res.data.pagination?.has_older_messages && logBeforeCursor ? "inline-flex" : "none";
  if (prepend && body) {
    body.scrollTop = body.scrollHeight - previousScrollHeight + previousScrollTop;
  } else {
    scrollLogDrawerToBottom();
    byId<HTMLTextAreaElement>("log-drawer-input")?.focus();
  }
  logDebug("crew", "Transcript loaded", {
    hasOlderMessages: res.data.pagination?.has_older_messages ?? false,
    nextBeforeCursor: logBeforeCursor,
    prepend,
    sessionID,
    turnCount: res.data.turns?.length ?? 0,
  });
}

function appendStreamEvent(msg: AgentOutputMessage): void {
  const messagesEl = byId("log-drawer-messages");
  if (!messagesEl) return;
  const payload = msg.data as StreamTurnPayload | null;
  if (msg.type === "pending" || isPendingInteractionPayload(msg.data)) {
    renderPendingInteraction(msg.data as PendingInteraction);
    return;
  }
  if (msg.type === "activity" && isActivityPayload(msg.data)) {
    renderSessionActivity(String((msg.data as { activity: string }).activity));
    return;
  }
  if ((msg.type === "turn" || msg.type === "message") && Array.isArray(payload?.turns)) {
    if (shouldReplaceWithStreamSnapshot(payload)) {
      replaceTranscriptTurns(payload.turns);
      return;
    }
    appendStreamTurns(payload.turns);
    return;
  }
  if (msg.type !== "message" || !payload?.data?.message) return;
  appendStreamTurns([payload.data.message]);
}

function appendStreamTurns(turns: TranscriptTurn[]): void {
  const messagesEl = byId("log-drawer-messages");
  if (!messagesEl) return;
  const displayTurns = displayTurnsForStreamAppend(turns);
  if (displayTurns.length === 0) return;
  acknowledgeLocalSubmissions(displayTurns);
  logCount += appendStreamDisplayTurns(messagesEl, displayTurns);
  updateLogCount();
  scrollLogDrawerToBottom();
}

function displayTurnsForStreamAppend(turns: TranscriptTurn[]): DisplayTurn[] {
  const displayTurns = expandTranscriptTurns(turns);
  const renderable: DisplayTurn[] = [];

  for (const turn of displayTurns) {
    if (isUserMessageDisplayTurn(turn)) {
      clearStreamProgressCandidates();
      renderable.push(turn);
      continue;
    }

    if (isStandaloneActivityDisplayTurn(turn)) {
      streamActivityBuffer.push(turn);
      continue;
    }

    let nextTurn = turn;
    if (isOutputMessageDisplayTurn(turn) && (streamActivityBuffer.length > 0 || streamProgressBuffer.length > 0)) {
      const bufferedTurns = [...streamActivityBuffer, ...streamProgressBuffer.map((entry) => entry.turn)];
      const attached = attachActivityTurnsToFirstOutput([turn], bufferedTurns);
      if (attached.attached) {
        removeStreamProgressCandidates();
        streamActivityBuffer = [];
        nextTurn = attached.turns[0] ?? turn;
      }
    }
    renderable.push(nextTurn);
  }

  return renderable;
}

function appendStreamDisplayTurns(container: Node, turns: DisplayTurn[]): number {
  for (const turn of turns) {
    const node = renderTurn(turn.role, turn.text, turn.timestamp, [], turn.assets ?? [], turn.trace ?? [], turn.activity ?? []);
    if (isOutputMessageDisplayTurn(turn)) {
      const id = `stream-progress-${Date.now()}-${nextStreamProgressID++}`;
      node.dataset.streamProgressId = id;
      streamProgressBuffer.push({ id, turn });
    }
    container.appendChild(node);
  }
  return turns.length;
}

function clearStreamProgressCandidates(): void {
  streamProgressBuffer = [];
  streamActivityBuffer = [];
}

function removeStreamProgressCandidates(): void {
  const messagesEl = byId("log-drawer-messages");
  let removed = 0;
  for (const entry of streamProgressBuffer) {
    const node = messagesEl?.querySelector(`[data-stream-progress-id="${entry.id}"]`);
    if (!node) continue;
    node.remove();
    removed += 1;
  }
  streamProgressBuffer = [];
  logCount = Math.max(0, logCount - removed);
}

function replaceTranscriptTurns(turns: TranscriptTurn[]): void {
  const messagesEl = byId("log-drawer-messages");
  const loadingEl = byId("log-drawer-loading");
  if (!messagesEl || !loadingEl) return;
  streamActivityBuffer = [];
  streamProgressBuffer = [];
  pendingLocalSubmissions = [];
  clearRenderedTranscriptImages();
  const displayTurns = expandTranscriptTurns(turns);
  const fragment = document.createDocumentFragment();
  appendDisplayTurns(fragment, displayTurns);
  clear(messagesEl);
  messagesEl.append(fragment, loadingEl);
  loadingEl.style.display = "none";
  logCount = displayTurns.length;
  updateLogCount();
  scrollLogDrawerToBottom();
}

function updateLogCount(): void {
  byId("log-drawer-count")!.textContent = turnCountLabel(logCount);
}

function isPendingInteractionPayload(value: unknown): value is PendingInteraction {
  return Boolean(value && typeof value === "object" && typeof (value as { request_id?: unknown }).request_id === "string");
}

function isActivityPayload(value: unknown): value is { activity: string } {
  return Boolean(value && typeof value === "object" && typeof (value as { activity?: unknown }).activity === "string");
}

function renderSessionActivity(activity: string): void {
  const meta = byId("log-drawer-meta");
  if (!meta) return;
  const existing = Array.from(meta.querySelectorAll(".log-drawer-meta-pill"))
    .filter((node) => !node.classList.contains("log-drawer-meta-activity"));
  clear(meta);
  existing.forEach((node) => meta.append(node));
  meta.append(el("span", { class: "log-drawer-meta-pill log-drawer-meta-activity" }, [activity]));
  meta.style.display = "flex";
}

async function submitLogDrawerMessage(): Promise<void> {
  const city = cityScope();
  const input = byId<HTMLTextAreaElement>("log-drawer-input");
  const sendBtn = byId<HTMLButtonElement>("log-drawer-send-btn");
  const statusEl = byId("log-drawer-status");
  const sessionID = logSessionID;
  const message = input?.value.trim() ?? "";
  const attachments = [...pendingAttachments];
  if (!city || !sessionID || !input || !sendBtn || logSubmitting) return;
  if (!message && attachments.length === 0) {
    input.focus();
    return;
  }
  const submitMessage = buildSubmitMessage(message, attachments);
  const submitIntent = selectedSubmitIntent();
  const submitBytes = submitRequestBytes(submitMessage, submitIntent);
  if (submitBytes > SESSION_SUBMIT_SAFE_BYTES) {
    statusEl?.replaceChildren(document.createTextNode(""));
    showToast(
      "error",
      "Message too large",
      `Remove an image or shorten the message (${formatBytes(submitBytes)} / ${formatBytes(SESSION_SUBMIT_BODY_LIMIT_BYTES)})`,
    );
    input.focus();
    return;
  }

  logSubmitting = true;
  sendBtn.disabled = true;
  statusEl?.replaceChildren(document.createTextNode("Sending..."));
  const res = await api.POST("/v0/city/{cityName}/session/{id}/submit", {
    params: { path: { cityName: city, id: sessionID }, header: mutationHeaders },
    body: { intent: submitIntent, message: submitMessage },
  });
  logSubmitting = false;
  sendBtn.disabled = false;

  if (res.error) {
    statusEl?.replaceChildren(document.createTextNode(""));
    showToast("error", "Message failed", res.error.detail ?? "Could not submit message");
    input.focus();
    return;
  }

  input.value = "";
  pendingAttachments = [];
  renderPendingAttachments();
  appendLocalTurn("user", message, attachments);
  statusEl?.replaceChildren(document.createTextNode("Sent"));
  showToast("success", "Message sent", res.data?.request_id ?? sessionID);
  input.focus();
}

function appendLocalTurn(role: string, text: string, attachments: ChatAttachment[] = []): void {
  const messagesEl = byId("log-drawer-messages");
  if (!messagesEl) return;
  const node = renderTurn(role, text, new Date().toISOString(), attachments);
  if ((role ?? "").toLowerCase() === "user") {
    const id = `local-${Date.now()}-${nextLocalSubmissionID++}`;
    node.dataset.localSubmitId = id;
    pendingLocalSubmissions.push({
      attachmentNames: attachments.map((attachment) => attachment.name),
      createdAt: Date.now(),
      id,
      text,
    });
  }
  messagesEl.append(node);
  logCount += 1;
  updateLogCount();
  scrollLogDrawerToBottom();
}

function acknowledgeLocalSubmissions(turns: DisplayTurn[]): void {
  if (pendingLocalSubmissions.length === 0) return;
  prunePendingLocalSubmissions();
  for (const turn of turns) {
    if ((turn.role ?? "").toLowerCase() !== "user") continue;
    const index = pendingLocalSubmissions.findIndex((submission) => localSubmissionMatchesTurn(submission, turn));
    if (index < 0) continue;
    const [submission] = pendingLocalSubmissions.splice(index, 1);
    byId("log-drawer-messages")?.querySelector(`[data-local-submit-id="${submission?.id}"]`)?.remove();
    logCount = Math.max(0, logCount - 1);
  }
}

function prunePendingLocalSubmissions(): void {
  const cutoff = Date.now() - 120_000;
  pendingLocalSubmissions = pendingLocalSubmissions.filter((submission) => submission.createdAt >= cutoff);
}

function localSubmissionMatchesTurn(submission: PendingLocalSubmission, turn: DisplayTurn): boolean {
  const submittedText = normalizeSubmittedText(submission.text);
  const turnText = normalizeSubmittedText([
    turn.text,
    ...(turn.assets ?? []).map((asset) => asset.name ?? asset.path ?? asset.url ?? ""),
  ].join(" "));
  if (submittedText) {
    if (!turnText) return false;
    if (turnText !== submittedText && !turnText.includes(submittedText) && !submittedText.includes(turnText)) return false;
  }
  return submission.attachmentNames.every((name) => turnText.includes(normalizeSubmittedText(name)));
}

function normalizeSubmittedText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function resetLogComposer(): void {
  const input = byId<HTMLTextAreaElement>("log-drawer-input");
  const sendBtn = byId<HTMLButtonElement>("log-drawer-send-btn");
  if (input) input.value = "";
  if (sendBtn) sendBtn.disabled = false;
  pendingAttachments = [];
  renderPendingAttachments();
  byId("log-drawer-status")?.replaceChildren(document.createTextNode(""));
}

async function addSelectedAttachments(files: FileList | File[] | null): Promise<void> {
  if (!files) return;
  const city = cityScope();
  const sessionID = logSessionID;
  if (!city || !sessionID) return;
  const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
  if (imageFiles.length === 0) {
    showToast("error", "Unsupported file", "Only image attachments are supported");
    return;
  }
  const statusEl = byId("log-drawer-status");
  for (const file of imageFiles) {
    statusEl?.replaceChildren(document.createTextNode(`Uploading ${file.name}...`));
    try {
      const attachment = await uploadSessionAttachment(city, sessionID, file);
      pendingAttachments.push(attachment);
      renderPendingAttachments();
      statusEl?.replaceChildren(document.createTextNode("Image attached"));
    } catch (error) {
      statusEl?.replaceChildren(document.createTextNode(""));
      showToast("error", "Image upload failed", error instanceof Error ? error.message : String(error));
    }
  }
}

async function uploadSessionAttachment(city: string, sessionID: string, file: File): Promise<ChatAttachment> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(apiURL(sessionAttachmentsPath(city, sessionID)), {
    body: form,
    headers: mutationHeaders,
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(await responseErrorDetail(res));
  }
  const data = await res.json() as { id?: string; mime_type?: string; name?: string; path?: string; size?: number; url?: string };
  if (!data.id || !data.name || !data.url || !data.path) {
    throw new Error("Attachment upload returned an incomplete response");
  }
  return {
    id: data.id,
    name: data.name,
    path: data.path,
    size: data.size ?? file.size,
    type: data.mime_type ?? file.type,
    url: data.url,
  };
}

async function responseErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json() as { detail?: string; title?: string };
    return body.detail ?? body.title ?? `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function submitRequestBytes(message: string, intent: SubmitIntent = "default"): number {
  return utf8Bytes(JSON.stringify({ intent, message }));
}

function updateSubmitRequestSizeHint(): void {
  const input = byId<HTMLTextAreaElement>("log-drawer-input");
  const statusEl = byId("log-drawer-status");
  if (!input || !statusEl || !input.value.trim()) return;
  const bytes = submitRequestBytes(buildSubmitMessage(input.value.trim(), pendingAttachments), selectedSubmitIntent());
  if (bytes > SESSION_SUBMIT_SAFE_BYTES) {
    statusEl.replaceChildren(document.createTextNode(`${formatBytes(bytes)} pending`));
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
  return `${Math.round(bytes / 1000)} KB`;
}

function renderPendingAttachments(): void {
  const container = byId("log-drawer-attachments");
  if (!container) return;
  clear(container);
  pendingAttachments.forEach((attachment) => {
    const remove = el("button", {
      class: "chat-attachment-remove",
      "data-attachment-id": attachment.id,
      title: "Remove",
      type: "button",
    }, ["x"]);
    remove.addEventListener("click", () => {
      void removePendingAttachment(attachment.id);
    });
    container.append(el("div", { class: "chat-attachment-chip" }, [
      el("img", { alt: "", class: "chat-attachment-thumb", src: attachmentImageSrc(attachment.url) }),
      el("span", { class: "chat-attachment-name" }, [attachment.name]),
      remove,
    ]));
  });
}

async function removePendingAttachment(attachmentID: string): Promise<void> {
  const city = cityScope();
  const sessionID = logSessionID;
  const attachment = pendingAttachments.find((item) => item.id === attachmentID);
  pendingAttachments = pendingAttachments.filter((item) => item.id !== attachmentID);
  renderPendingAttachments();
  if (!city || !sessionID || !attachment) return;
  try {
    await deleteSessionAttachment(city, sessionID, attachmentID);
  } catch (error) {
    showToast("error", "Image cleanup failed", error instanceof Error ? error.message : String(error));
  }
}

async function deleteSessionAttachment(city: string, sessionID: string, attachmentID: string): Promise<void> {
  const res = await fetch(apiURL(sessionAttachmentDeletePath(city, sessionID, attachmentID)), {
    headers: mutationHeaders,
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(await responseErrorDetail(res));
  }
}

function buildSubmitMessage(message: string, attachments: ChatAttachment[]): string {
  const parts = message ? [message] : [];
  if (attachments.length > 0) {
    parts.push([
      "Attached images:",
      ...attachments.map((attachment, index) => [
        `${index + 1}. ${attachment.name}`,
        `   ![${attachment.name}](${attachment.url})`,
        `   Local file: ${attachment.path}`,
      ].join("\n")),
      "Use the local file path to inspect the image when needed. Do not inline or decode base64.",
    ].join("\n"));
  }
  return parts.join("\n\n");
}
