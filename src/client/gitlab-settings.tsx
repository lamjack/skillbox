import { useEffect, useState } from "react";
import { api } from "./api";
import { SecretField } from "./secret-field";

type Status = {
  host: string | null;
  configured: boolean;
  updatedAt?: string | null;
};
export function GitLabImportSettings() {
  const [config, setConfig] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    api("/settings/gitlab-import")
      .then(setConfig)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const update = async (token: string) => {
    setConfig(
      await api("/settings/gitlab-import", {
        method: "PUT",
        body: JSON.stringify({ token }),
      }),
    );
  };
  if (!config?.host) return null;
  return (
    <section className="executor-settings" aria-labelledby="gitlab-heading">
      <h2 id="gitlab-heading">GitLab import</h2>
      <p>
        Import skills from private projects on {config.host}. The token needs
        the read_api and read_repository scopes and is stored encrypted.
      </p>
      <p role="status">Host: {config.host} (set by SKILLBOX_GITLAB_HOST)</p>
      <SecretField
        label="GitLab access token"
        configured={config.configured}
        updatedAt={config.updatedAt}
        emptyPlaceholder="glpat-…"
        onSave={update}
        onRemove={() => update("")}
        saveLabel="Save token"
        removeLabel="Remove token"
      />
      {error && (
        <div className="error-note" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
