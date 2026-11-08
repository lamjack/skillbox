import { useEffect, useState } from "react";
import { Plug, LoaderCircle, RefreshCw, X } from "lucide-react";
import { api } from "./api";
import { GatewaySettings } from "./gateway-settings";
import { GitLabImportSettings } from "./gitlab-settings";
import { SecretField } from "./secret-field";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
type Integration = {
  id: string;
  status: string;
  connections: number;
  checkedAt: number;
};
export function ExecutorSettings() {
  const [config, setConfig] = useState<any>(null),
    [endpoint, setEndpoint] = useState(""),
    [items, setItems] = useState<Integration[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => {
    const c = await api("/settings/executor");
    setConfig(c);
    setEndpoint(c.endpoint);
    if (c.authenticated) {
      try {
        setItems((await api("/executor/integrations")).items);
      } catch (e) {
        setError((e as Error).message);
      }
    }
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="page">
      <header className="standard-heading">
        <h1>Settings</h1>
      </header>
      <GatewaySettings />
      <GitLabImportSettings />
      <section className="executor-settings">
        <h2>
          <Plug size={20} /> Executor
        </h2>
        <label>
          MCP endpoint
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://executor.example.com/mcp"
          />
        </label>
        <details>
          <summary>Use an access token</summary>
          <SecretField
            label="Executor access token"
            configured={config?.authMethod === "token"}
            emptyPlaceholder="Paste token…"
            disabled={!config?.endpoint}
            onSave={async (value) => {
              await api("/settings/executor", {
                method: "PUT",
                body: JSON.stringify({ endpoint: config.endpoint, bearer: value }),
              });
              await load();
            }}
            onRemove={async () => {
              await api("/settings/executor", {
                method: "PUT",
                body: JSON.stringify({ endpoint: config.endpoint, bearer: "" }),
              });
              await load();
            }}
          />
        </details>
        <div className="filters">
          <Button
            disabled={busy || !endpoint}
            onClick={() =>
              run(async () => {
                await api("/settings/executor", {
                  method: "PUT",
                  body: JSON.stringify({ endpoint }),
                });
                await load();
              })
            }
          >
            Save endpoint
          </Button>
          <Button
            disabled={busy || !config || !endpoint.trim()}
            onClick={() =>
              run(async () => {
                if (endpoint !== config.endpoint)
                  await api("/settings/executor", {
                    method: "PUT",
                    body: JSON.stringify({ endpoint }),
                  });
                const r = await api("/executor/connect", { method: "POST" });
                if (r.url) location.assign(r.url);
                else await load();
              })
            }
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Plug size={16} />
            )}{" "}
            {config?.authenticated ? "Reconnect" : "Connect Executor"}
          </Button>
          {config?.authenticated && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api("/executor/disconnect", { method: "POST" });
                  setItems([]);
                  await load();
                })
              }
            >
              Disconnect
            </Button>
          )}
        </div>
        {error && (
          <div className="error-note" role="alert">
            {error}
          </div>
        )}
        {config?.authenticated && (
          <>
            <h3>
              Connections{" "}
              <button
                aria-label="Refresh Executor connections"
                className="status-toggle"
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setItems(
                      (await api("/executor/integrations?refresh=true")).items,
                    ),
                  )
                }
              >
                <RefreshCw size={15} />
              </button>
            </h3>
            <div className="integration-grid">
              {items.map((i) => (
                <div
                  key={i.id}
                  title={
                    i.checkedAt
                      ? `Last checked ${new Date(i.checkedAt).toLocaleString()}`
                      : "Health not checked"
                  }
                >
                  <i className={`health-dot ${i.status}`} />
                  {i.id}
                  <small>
                    {i.connections} · {i.status}
                  </small>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
export function SkillIntegrations({
  id,
  revision,
  selected,
  onSaved,
  disabled,
}: {
  id: string;
  revision: string;
  selected: string[];
  onSaved: () => Promise<void>;
  disabled: boolean;
}) {
  const [items, setItems] = useState<Integration[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  useEffect(() => {
    if (open)
      api("/executor/integrations")
        .then((r) => setItems(r.items))
        .catch((e) => setError(e.message));
  }, [open]);
  const save = async (values: string[]) => {
    setBusy(true);
    setError("");
    try {
      await api(`/skills/${id}/integrations`, {
        method: "PATCH",
        body: JSON.stringify({
          integrations: values,
          expectedRevision: revision,
        }),
      });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="skill-integrations">
      <div className="integration-heading">
        <Plug size={15} />
        <strong>Executor MCPs</strong>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || busy}
          onClick={() => setOpen(!open)}
        >
          {open ? "Close" : "Associate"}
        </Button>
      </div>
      <div className="integration-chips">
        {selected.map((value) => (
          <span key={value}>
            <i
              className={`health-dot ${items.find((i) => i.id === value)?.status ?? "unknown"}`}
            />
            {value}
            <button
              aria-label={`Remove ${value}`}
              disabled={disabled || busy}
              onClick={() => save(selected.filter((s) => s !== value))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      {open && (
        <>
          <Input
            placeholder="Find an integration…"
            aria-label="Find Executor integration"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="integration-options">
            {items
              .filter(
                (i) =>
                  !selected.includes(i.id) &&
                  i.id.includes(query.toLowerCase()),
              )
              .map((i) => (
                <button
                  key={i.id}
                  disabled={disabled || busy}
                  onClick={() => save([...selected, i.id])}
                >
                  <i className={`health-dot ${i.status}`} />
                  {i.id}
                  <small>{i.status}</small>
                </button>
              ))}
          </div>
        </>
      )}
      {error && (
        <div className="error-note" role="alert">
          {error} <a href="/settings">Settings</a>
        </div>
      )}
    </section>
  );
}
