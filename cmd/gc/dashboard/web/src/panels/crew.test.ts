import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { syncCityScopeFromLocation } from "../state";
import { renderCrew } from "./crew";

vi.mock("../sse", () => ({
  connectAgentOutput: vi.fn(() => ({ close: vi.fn() })),
}));

describe("crew empty states", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="crew-loading">Loading crew...</div>
      <table id="crew-table" style="display:none"><tbody id="crew-tbody"></tbody></table>
      <div id="crew-empty" style="display:none"><p>No crew configured</p></div>
      <div id="rigged-body"></div>
      <div id="pooled-body"></div>
      <span id="sessions-count"></span>
      <div id="sessions-list"></div>
      <div id="sessions-detail"><div id="sessions-detail-summary"></div></div>
      <span id="crew-count"></span>
      <span id="rigged-count"></span>
      <span id="pooled-count"></span>
      <div id="agent-log-drawer" style="display:none"></div>
    `;
    window.history.pushState({}, "", "/dashboard?city=mc-city");
    syncCityScopeFromLocation();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/dashboard");
    syncCityScopeFromLocation();
  });

  it("shows no crew configured when the city has zero crew sessions", async () => {
    vi.spyOn(api, "GET").mockImplementation(async (path: string) => {
      if (path === "/v0/city/{cityName}/sessions") {
        return { data: { items: [] } } as never;
      }
      throw new Error(`unexpected GET ${path}`);
    });

    await renderCrew();

    expect((document.getElementById("crew-empty") as HTMLElement).style.display).toBe("block");
    expect(document.getElementById("crew-empty")?.textContent).toContain("No crew configured");
    expect(document.getElementById("crew-empty")?.textContent).not.toContain("Select a city");
  });

  it("hides agent role sessions from the crew table while keeping crew rows", async () => {
    vi.spyOn(api, "GET").mockImplementation(async (path: string) => {
      if (path === "/v0/city/{cityName}/sessions") {
        return {
          data: {
            items: [
              // Crew member — should appear.
              {
                active_bead: "",
                agent_kind: "crew",
                attached: true,
                id: "s-fontaine",
                last_active: "2026-04-18T20:00:00Z",
                last_output: "",
                rig: "rig-a/crew",
                running: true,
                template: "rig-a/crew/fontaine",
              },
              // Role agents — should NOT appear in the crew table.
              {
                active_bead: "",
                agent_kind: "role",
                attached: false,
                id: "s-role-1",
                last_active: "2026-04-18T20:00:00Z",
                last_output: "",
                running: true,
                template: "rig-a/singleton",
              },
              {
                active_bead: "",
                agent_kind: "role",
                attached: false,
                id: "s-role-2",
                last_active: "2026-04-18T20:00:00Z",
                last_output: "",
                running: true,
                template: "rig-a/another-singleton",
              },
              // Pool/multi-instance agent — also not crew.
              {
                active_bead: "",
                agent_kind: "pool",
                attached: false,
                id: "s-pool-1",
                last_active: "2026-04-18T20:00:00Z",
                last_output: "",
                pool: "scaler",
                rig: "rig-a",
                running: true,
                template: "rig-a/scaler-1",
              },
            ],
          },
        } as never;
      }
      if (path === "/v0/city/{cityName}/session/{id}/pending") {
        return { data: { pending: false } } as never;
      }
      if (path === "/v0/city/{cityName}/bead/{id}") {
        return { data: null } as never;
      }
      throw new Error(`unexpected GET ${path}`);
    });

    await renderCrew();

    const crewRows = document.querySelectorAll("#crew-tbody tr");
    expect(crewRows.length).toBe(1);
    expect(crewRows[0]?.textContent).toContain("rig-a/crew/fontaine");
    expect(document.getElementById("crew-count")?.textContent).toBe("1");
    expect((document.getElementById("crew-table") as HTMLElement).style.display).toBe("table");
    // Pool agent should still flow through to the rigged panel.
    expect(document.getElementById("rigged-count")?.textContent).toBe("1");
  });

  it("shows every active session in the workspace and opens chat from there", async () => {
    document.body.innerHTML = `
      <div id="crew-loading">Loading crew...</div>
      <table id="crew-table" style="display:none"><tbody id="crew-tbody"></tbody></table>
      <div id="crew-empty" style="display:none"><p>No crew configured</p></div>
      <div id="rigged-body"></div>
      <div id="pooled-body"></div>
      <span id="sessions-count"></span>
      <div id="sessions-list"></div>
      <div id="sessions-detail">
        <div id="sessions-detail-summary"></div>
        <div id="agent-log-drawer" style="display:none">
          <span id="log-drawer-agent-name"></span>
          <span id="log-drawer-count"></span>
          <button id="log-drawer-older-btn" style="display:none">Load older</button>
          <button id="log-drawer-close-btn">Close</button>
          <div id="log-drawer-body">
            <div id="log-drawer-messages">
              <div id="log-drawer-loading">Loading logs...</div>
            </div>
          </div>
        </div>
      </div>
      <span id="crew-count"></span>
      <span id="rigged-count"></span>
      <span id="pooled-count"></span>
    `;
    vi.spyOn(api, "GET").mockImplementation(async (path: string) => {
      if (path === "/v0/city/{cityName}/sessions") {
        return {
          data: {
            items: [
              {
                active_bead: "",
                agent_kind: "role",
                attached: false,
                configured_named_session: true,
                id: "s-mayor",
                last_active: "2026-04-18T20:00:00Z",
                last_output: "city heartbeat",
                running: true,
                template: "mayor",
              },
              {
                active_bead: "",
                agent_kind: "crew",
                attached: true,
                id: "s-reviewer",
                last_active: "2026-04-18T19:55:00Z",
                last_output: "reviewing",
                rig: "rig-a/crew",
                running: true,
                template: "reviewer",
              },
              {
                active_bead: "",
                agent_kind: "role",
                attached: false,
                id: "s-role",
                last_active: "2026-04-18T19:50:00Z",
                last_output: "routing",
                rig: "rig-a",
                running: true,
                template: "rig-a/router",
              },
            ],
          },
        } as never;
      }
      if (path === "/v0/city/{cityName}/session/{id}/pending") {
        return { data: { pending: false } } as never;
      }
      if (path === "/v0/city/{cityName}/session/{id}") {
        return { data: { id: "s-role", model: "gpt-5", provider: "codex", running: true } } as never;
      }
      if (path === "/v0/city/{cityName}/session/{id}/transcript") {
        return {
          data: {
            turns: [{ role: "assistant", text: "Router transcript", timestamp: "2026-04-18T20:00:00Z" }],
            pagination: {
              has_older_messages: false,
              returned_message_count: 1,
              total_compactions: 0,
              total_message_count: 1,
            },
          },
        } as never;
      }
      throw new Error(`unexpected GET ${path}`);
    });

    await renderCrew();

    expect(document.getElementById("sessions-count")?.textContent).toBe("3");
    expect(document.getElementById("sessions-list")?.textContent).toContain("mayor");
    expect(document.getElementById("sessions-list")?.textContent).toContain("reviewer");
    expect(document.getElementById("sessions-list")?.textContent).toContain("rig-a/router");
    expect(document.getElementById("crew-count")?.textContent).toBe("1");

    document.querySelector<HTMLButtonElement>('.session-row[data-session-id="s-role"] .agent-log-link')?.click();
    await waitFor(() => {
      expect((document.getElementById("agent-log-drawer") as HTMLElement).style.display).toBe("flex");
      expect(document.getElementById("log-drawer-agent-name")?.textContent).toBe("rig-a/router");
      expect(document.getElementById("log-drawer-messages")?.textContent).toContain("Router transcript");
    });
    expect(document.querySelector(".log-msg-type-assistant")?.textContent).toBe("rig-a/router");
    expect(new URL(window.location.href).searchParams.get("session")).toBe("s-role");
    expect(document.getElementById("agent-log-drawer")?.closest("#sessions-detail")).not.toBeNull();
    expect((document.getElementById("sessions-detail-summary") as HTMLElement).style.display).toBe("none");
  });

  it("pins the mayor session and opens it as the default chat", async () => {
    window.history.pushState({}, "", "/dashboard?city=default-city");
    syncCityScopeFromLocation();
    document.body.innerHTML = `
      <div id="crew-loading">Loading crew...</div>
      <table id="crew-table" style="display:none"><tbody id="crew-tbody"></tbody></table>
      <div id="crew-empty" style="display:none"><p>No crew configured</p></div>
      <div id="rigged-body"></div>
      <div id="pooled-body"></div>
      <span id="sessions-count"></span>
      <div id="sessions-list"></div>
      <div id="sessions-detail">
        <div id="sessions-detail-summary"></div>
        <div id="agent-log-drawer" style="display:none">
          <span id="log-drawer-agent-name"></span>
          <span id="log-drawer-count"></span>
          <button id="log-drawer-older-btn" style="display:none">Load older</button>
          <button id="log-drawer-close-btn">Close</button>
          <div id="log-drawer-body">
            <div id="log-drawer-messages">
              <div id="log-drawer-loading">Loading logs...</div>
            </div>
          </div>
        </div>
      </div>
      <span id="crew-count"></span>
      <span id="rigged-count"></span>
      <span id="pooled-count"></span>
    `;
    vi.spyOn(api, "GET").mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/v0/city/{cityName}/sessions") {
        return {
          data: {
            items: [
              {
                active_bead: "",
                agent_kind: "role",
                attached: false,
                configured_named_session: true,
                id: "s-dispatcher",
                last_active: "2026-04-18T20:05:00Z",
                last_output: "dispatching",
                running: true,
                template: "control-dispatcher",
              },
              {
                active_bead: "",
                agent_kind: "role",
                attached: false,
                id: "s-mayor",
                last_active: "2026-04-18T19:55:00Z",
                last_output: "checking city",
                running: true,
                template: "gastown.mayor",
              },
            ],
          },
        } as never;
      }
      if (path === "/v0/city/{cityName}/session/{id}/pending") {
        return { data: { pending: false } } as never;
      }
      if (path === "/v0/city/{cityName}/session/{id}") {
        const id = (options as { params?: { path?: { id?: string } } } | undefined)?.params?.path?.id ?? "";
        return { data: { id, model: "gpt-5", provider: "codex", running: true } } as never;
      }
      if (path === "/v0/city/{cityName}/session/{id}/transcript") {
        const id = (options as { params?: { path?: { id?: string } } } | undefined)?.params?.path?.id ?? "";
        return {
          data: {
            turns: [{ role: "assistant", text: `${id} transcript`, timestamp: "2026-04-18T20:00:00Z" }],
            pagination: {
              has_older_messages: false,
              returned_message_count: 1,
              total_compactions: 0,
              total_message_count: 1,
            },
          },
        } as never;
      }
      throw new Error(`unexpected GET ${path}`);
    });

    await renderCrew();

    const rows = Array.from(document.querySelectorAll<HTMLElement>(".session-row"));
    expect(rows.map((row) => row.dataset.sessionId)).toEqual(["s-mayor", "s-dispatcher"]);
    await waitFor(() => {
      expect((document.getElementById("agent-log-drawer") as HTMLElement).style.display).toBe("flex");
      expect(document.getElementById("log-drawer-agent-name")?.textContent).toBe("gastown.mayor");
      expect(document.getElementById("log-drawer-messages")?.textContent).toContain("s-mayor transcript");
    });
    expect(new URL(window.location.href).searchParams.get("session")).toBe("s-mayor");
  });

  it("opens a session cockpit from the session query parameter", async () => {
    document.body.innerHTML = `
      <div id="crew-loading">Loading crew...</div>
      <table id="crew-table" style="display:none"><tbody id="crew-tbody"></tbody></table>
      <div id="crew-empty" style="display:none"><p>No crew configured</p></div>
      <div id="rigged-body"></div>
      <div id="pooled-body"></div>
      <span id="sessions-count"></span>
      <div id="sessions-list"></div>
      <div id="sessions-detail">
        <div id="sessions-detail-summary"></div>
        <div id="agent-log-drawer" style="display:none">
          <span id="log-drawer-agent-name"></span>
          <span id="log-drawer-count"></span>
          <button id="log-drawer-older-btn" style="display:none">Load older</button>
          <button id="log-drawer-close-btn">Close</button>
          <div id="log-drawer-body">
            <div id="log-drawer-messages">
              <div id="log-drawer-loading">Loading logs...</div>
            </div>
          </div>
        </div>
      </div>
      <span id="crew-count"></span>
      <span id="rigged-count"></span>
      <span id="pooled-count"></span>
    `;
    window.history.pushState({}, "", "/dashboard?city=mc-city&session=s-role");
    syncCityScopeFromLocation();
    vi.spyOn(api, "GET").mockImplementation(async (path: string) => {
      if (path === "/v0/city/{cityName}/sessions") {
        return {
          data: {
            items: [{
              active_bead: "",
              agent_kind: "role",
              attached: false,
              id: "s-role",
              last_active: "2026-04-18T20:00:00Z",
              last_output: "routing",
              rig: "rig-a",
              running: true,
              template: "rig-a/router",
            }],
          },
        } as never;
      }
      if (path === "/v0/city/{cityName}/session/{id}/pending") {
        return { data: { pending: false } } as never;
      }
      if (path === "/v0/city/{cityName}/session/{id}") {
        return { data: { id: "s-role", model: "gpt-5", provider: "codex", running: true } } as never;
      }
      if (path === "/v0/city/{cityName}/session/{id}/transcript") {
        return {
          data: {
            turns: [{ role: "assistant", text: "Opened from deep link", timestamp: "2026-04-18T20:00:00Z" }],
            pagination: {
              has_older_messages: false,
              returned_message_count: 1,
              total_compactions: 0,
              total_message_count: 1,
            },
          },
        } as never;
      }
      throw new Error(`unexpected GET ${path}`);
    });

    await renderCrew();

    await waitFor(() => {
      expect((document.getElementById("agent-log-drawer") as HTMLElement).style.display).toBe("flex");
      expect(document.getElementById("log-drawer-agent-name")?.textContent).toBe("rig-a/router");
      expect(document.getElementById("log-drawer-messages")?.textContent).toContain("Opened from deep link");
    });
  });

  it("falls back to the empty state when only role/pool sessions exist", async () => {
    vi.spyOn(api, "GET").mockImplementation(async (path: string) => {
      if (path === "/v0/city/{cityName}/sessions") {
        return {
          data: {
            items: [
              {
                active_bead: "",
                agent_kind: "role",
                attached: false,
                id: "s-role",
                last_active: "2026-04-18T20:00:00Z",
                last_output: "",
                running: true,
                template: "rig-a/singleton",
              },
              {
                active_bead: "",
                agent_kind: "role",
                attached: false,
                id: "s-role-rigged",
                last_active: "2026-04-18T20:00:00Z",
                last_output: "",
                rig: "rig-a",
                running: true,
                template: "rig-a/another-singleton",
              },
            ],
          },
        } as never;
      }
      if (path === "/v0/city/{cityName}/session/{id}/pending") {
        return { data: { pending: false } } as never;
      }
      if (path === "/v0/city/{cityName}/bead/{id}") {
        return { data: null } as never;
      }
      throw new Error(`unexpected GET ${path}`);
    });

    await renderCrew();

    expect(document.querySelectorAll("#crew-tbody tr").length).toBe(0);
    expect((document.getElementById("crew-empty") as HTMLElement).style.display).toBe("block");
    expect(document.getElementById("crew-empty")?.textContent).toContain("No crew configured");
    expect(document.getElementById("crew-count")?.textContent).toBe("0");
  });

});

// Slow Blacksmith CI runs have shown the openLogDrawer + loadTranscript
// chain take ~1.3s while passing runs finish in ~100ms — same VM class,
// same code. The 1s budget here was missing those slow runs by a few
// hundred ms even though the chain ultimately completed (the
// `[crew] Transcript loaded` debug log fires *after* the assertion times
// out). Five seconds keeps the local cost negligible and absorbs the
// observed CI variance.
async function waitFor(assertion: () => void): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 5000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}
