import { useEffect, useState } from "react";
import { api } from "./api";
import { SecretField } from "./secret-field";
import type { JevProvider } from "../shared";

const names: Record<JevProvider, string> = {
  vercel: "Vercel AI Gateway",
  typesafe: "TypeSafe AI",
  openrouter: "OpenRouter",
};
type ProviderStatus = { configured: boolean; updatedAt?: string | null };
type Status = {
  provider: JevProvider;
  configured: boolean;
  providers: Record<JevProvider, ProviderStatus>;
};
export function GatewaySettings() {
  const [config, setConfig] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api("/settings/ai-gateway")
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  const update = async (provider: JevProvider, key?: string | null) => {
    setBusy(true);
    setError("");
    try {
      setConfig(
        await api("/settings/ai-gateway", {
          method: "PUT",
          body: JSON.stringify({
            provider,
            ...(key !== undefined ? { apiKey: key } : {}),
          }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const provider = config?.provider ?? "vercel";
  const current = config?.providers[provider];
  return (
    <section className="executor-settings" aria-labelledby="gateway-heading">
      <h2 id="gateway-heading">Jev recommendations</h2>
      <label>
        Provider
        <select
          value={provider}
          disabled={busy || !config}
          onChange={(e) => update(e.target.value as JevProvider)}
        >
          <option value="vercel">Vercel AI Gateway</option>
          <option value="typesafe">TypeSafe AI</option>
          <option value="openrouter">OpenRouter</option>
        </select>
      </label>
      <p>
        Tasks and authorized skill descriptions are sent to {names[provider]};
        charges apply to your account. Keys are saved separately for each
        provider; without one, deterministic search is used.
      </p>
      <SecretField
        key={provider}
        label={`${names[provider]} API key`}
        configured={!!current?.configured}
        updatedAt={current?.updatedAt}
        emptyPlaceholder="sk-…"
        disabled={!config}
        onSave={(key) => update(provider, key)}
        onRemove={() => update(provider, null)}
        saveLabel="Save key"
        removeLabel="Remove key"
      />
      {error && (
        <div className="error-note" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
