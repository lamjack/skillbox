import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "./api";
import type { GitHubImportPreview, GitLabImportPreview } from "../shared";

type ImportPreview = GitHubImportPreview | GitLabImportPreview;
export function GitHubImportPage() {
  const nav = useNavigate();
  const [source, setSource] = useState<"github" | "gitlab">("github");
  const [gitlabHost, setGitlabHost] = useState("");
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [libraryIds, setLibraryIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    api("/settings/gitlab-import")
      .then((s: { host: string | null }) => setGitlabHost(s.host ?? ""))
      .catch(() => {});
    api("/skills?includeArchived=true&includeDisabled=true")
      .then((r: { items: { id: string }[] }) =>
        setLibraryIds(new Set(r.items.map((i) => i.id))),
      )
      .catch(() => {});
  }, []);
  const [selected, setSelected] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [batch, setBatch] = useState<
    { path: string; id: string; status: string; message?: string }[] | null
  >(null);
  const [batchError, setBatchError] = useState("");
  const summaryRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (batch) summaryRef.current?.scrollIntoView({ block: "nearest" });
  }, [batch]);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inspect = async (selection?: string) => {
    setBusy(true);
    setError("");
    setOverwrite(false);
    try {
      const result = await api(`/imports/${source}/preview`, {
        method: "POST",
        body: JSON.stringify({
          url:
            selection !== undefined && preview?.kind === "catalog"
              ? preview.url
              : url.trim(),
          ...(selection !== undefined ? { path: selection } : {}),
        }),
      });
      setPreview(result);
      if (result.kind === "catalog") {
        setSelected(result.candidates[0]);
        setChecked([]);
        setBatch(null);
      }
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  const importSelected = async () => {
    if (preview?.kind !== "catalog" || !checked.length) return;
    setBusy(true);
    setError("");
    setBatch(null);
    setBatchError("");
    try {
      const result = await api(`/imports/${source}/publish-batch`, {
        method: "POST",
        body: JSON.stringify({
          url: preview.url,
          items: checked.map((path) => ({
            path,
            id: path.split("/").at(-1) || path,
          })),
          overwrite,
        }),
      });
      setBatch(result.results);
      setChecked([]);
      api("/skills?includeArchived=true&includeDisabled=true")
        .then((r: { items: { id: string }[] }) =>
          setLibraryIds(new Set(r.items.map((i) => i.id))),
        )
        .catch(() => {});
    } catch (e) {
      setBatchError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    if (preview?.kind !== "skill" || (preview.expectedRevision && !overwrite))
      return;
    setBusy(true);
    setError("");
    try {
      const result = await api(`/imports/${source}/publish`, {
        method: "POST",
        body: JSON.stringify({
          url: preview.source.url,
          id: preview.id,
          expectedRevision: preview.expectedRevision,
        }),
      });
      await nav({ to: "/skills/$id", params: { id: result.id } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="page github-import-page">
      <header className="page-heading">
        <h1>Import from Git</h1>
        <Button variant="outline" asChild>
          <Link to="/">Library</Link>
        </Button>
      </header>
      {gitlabHost && (
        <div className="filters">
          <label htmlFor="github-import-source">Source</label>
          <select
            id="github-import-source"
            value={source}
            disabled={busy}
            onChange={(e) => {
              setSource(e.target.value as "github" | "gitlab");
              setUrl("");
              setPreview(null);
              setError("");
            }}
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </div>
      )}
      <form
        className="github-import-form"
        onSubmit={(e) => {
          e.preventDefault();
          void inspect();
        }}
      >
        <label htmlFor="github-import-url">
          {source === "gitlab" ? "GitLab project URL" : "Public GitHub URL"}
        </label>
        <div className="filters">
          <Input
            id="github-import-url"
            type="url"
            required
            placeholder={
              source === "gitlab"
                ? "https://…/group/project/-/tree/main/skill-name"
                : "https://github.com/owner/repo/tree/main/skills/example"
            }
            value={url}
            disabled={busy}
            onChange={(e) => {
              setUrl(e.target.value);
              setPreview(null);
              setOverwrite(false);
            }}
          />
          <Button type="submit" disabled={busy || !url.trim()}>
            {busy ? "Loading…" : "Preview"}
          </Button>
        </div>
      </form>
      {error && (
        <div className="error-note" role="alert">
          {error}
        </div>
      )}
      {preview?.kind === "catalog" && (
        <section className="github-import-preview">
          <div className="filters">
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() =>
                setChecked(
                  preview.candidates.filter(
                    (p) =>
                      overwrite ||
                      !libraryIds.has(p.split("/").at(-1) || p),
                  ),
                )
              }
            >
              Select all
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy || !checked.length}
              onClick={() => setChecked([])}
            >
              Clear
            </button>
            <label>
              <input
                type="checkbox"
                checked={overwrite}
                disabled={busy}
                onChange={(e) => setOverwrite(e.target.checked)}
              />{" "}
              Overwrite existing
            </label>
            <Button
              className="push"
              disabled={busy || !checked.length}
              onClick={importSelected}
            >
              {busy ? "Importing…" : `Import selected (${checked.length})`}
            </Button>
          </div>
          {batchError && (
            <div className="error-note" role="alert">
              {batchError}
            </div>
          )}
          {batch &&
            (() => {
              const imported = batch.filter(
                (r) => r.status === "created" || r.status === "updated",
              ).length;
              const skipped = batch.filter(
                (r) => r.status === "skipped",
              ).length;
              const failed = batch.filter(
                (r) => r.status === "conflict" || r.status === "error",
              ).length;
              return (
                <>
                  <p role="status" ref={summaryRef}>
                    Imported {imported}
                    {skipped ? ` · Skipped ${skipped}` : ""}
                    {failed ? ` · Failed ${failed}` : ""}
                  </p>
                  <details>
                    <summary>Show details</summary>
                    <table className="import-table">
                      <thead>
                        <tr>
                          <th>Skill</th>
                          <th>Status</th>
                          <th>Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batch.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <code>{r.id}</code>
                            </td>
                            <td>{r.status}</td>
                            <td>{r.message ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </>
              );
            })()}
          <table className="import-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all skills"
                    disabled={busy}
                    checked={(() => {
                      const selectable = preview.candidates.filter(
                        (p) =>
                          overwrite ||
                          !libraryIds.has(p.split("/").at(-1) || p),
                      );
                      return (
                        checked.length > 0 && checked.length === selectable.length
                      );
                    })()}
                    ref={(el) => {
                      if (el) {
                        const selectable = preview.candidates.filter(
                          (p) =>
                            overwrite ||
                            !libraryIds.has(p.split("/").at(-1) || p),
                        );
                        el.indeterminate =
                          checked.length > 0 && checked.length < selectable.length;
                      }
                    }}
                    onChange={(e) =>
                      setChecked(
                        e.target.checked
                          ? preview.candidates.filter(
                              (p) =>
                                overwrite ||
                                !libraryIds.has(p.split("/").at(-1) || p),
                            )
                          : [],
                      )
                    }
                  />
                </th>
                <th>Skill</th>
                <th>Path</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {preview.candidates.map((path) => {
                const name = path.split("/").at(-1) || path;
                return (
                  <tr key={path}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${name}`}
                        checked={checked.includes(path)}
                        disabled={
                          busy || (!overwrite && libraryIds.has(name))
                        }
                        title={
                          !overwrite && libraryIds.has(name)
                            ? "Already in library — enable Overwrite existing to replace"
                            : undefined
                        }
                        onChange={(e) =>
                          setChecked(
                            e.target.checked
                              ? [...checked, path]
                              : checked.filter((p) => p !== path),
                          )
                        }
                      />
                    </td>
                    <td>{name}</td>
                    <td>
                      <code>{path || "/"}</code>
                    </td>
                    <td>
                      {libraryIds.has(name) && (
                        <span className="tag">In library</span>
                      )}
                    </td>
                    <td>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => inspect(path)}
                      >
                        Preview
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      {preview?.kind === "skill" && (
        <section className="github-import-preview">
          <h2>{preview.id}</h2>
          <a href={preview.source.url} target="_blank" rel="noreferrer">
            {preview.source.repository}@{preview.source.commit.slice(0, 12)}
            {preview.source.path && ` / ${preview.source.path}`}
          </a>
          <p>
            {preview.files.length} files ·{" "}
            {preview.files.reduce((sum, f) => sum + f.size, 0).toLocaleString()}{" "}
            bytes
          </p>
          <div className="github-import-files">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Bytes</th>
                  <th>Executable</th>
                </tr>
              </thead>
              <tbody>
                {preview.files.map((file) => (
                  <tr key={file.path}>
                    <td>
                      <code>{file.path}</code>
                    </td>
                    <td>{file.size.toLocaleString()}</td>
                    <td>{file.executable ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>SKILL.md</summary>
            <pre className="github-import-instructions">
              {preview.instructions}
            </pre>
          </details>
          {!!preview.skipped.length && (
            <details>
              <summary>Excluded artifacts ({preview.skipped.length})</summary>
              <ul>
                {preview.skipped.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {preview.warnings.map((warning, i) => (
            <p key={i} role="status">
              {warning.message}
            </p>
          ))}
          <p>
            Review imported instructions before use. Importing never runs
            scripts.
          </p>
          {preview.expectedRevision && (
            <label className="check">
              <input
                type="checkbox"
                checked={overwrite}
                disabled={busy}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              Publish a new revision of existing “{preview.id}”
            </label>
          )}
          <Button
            disabled={busy || (!!preview.expectedRevision && !overwrite)}
            onClick={publish}
          >
            {busy
              ? "Importing…"
              : preview.expectedRevision
                ? "Publish new revision"
                : "Import skill"}
          </Button>
        </section>
      )}
    </main>
  );
}
