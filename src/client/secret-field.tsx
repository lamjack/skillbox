import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

export function SecretField({
  label,
  configured,
  updatedAt,
  emptyPlaceholder,
  onSave,
  onRemove,
  help,
  saveLabel = "Save",
  removeLabel = "Remove",
  disabled = false,
}: {
  label: string;
  configured: boolean;
  updatedAt?: string | null;
  emptyPlaceholder: string;
  onSave: (value: string) => Promise<void>;
  onRemove: () => Promise<void>;
  help?: ReactNode;
  saveLabel?: string;
  removeLabel?: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const run = async (call: () => Promise<void>, done: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await call();
      setValue("");
      setNotice(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="secret-field">
      <label>
        {label}
        <Input
          type="password"
          autoComplete="new-password"
          value={value}
          placeholder={configured ? "••••••••••••••••" : emptyPlaceholder}
          disabled={busy || disabled}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      {help}
      <p role="status">
        {notice ||
          (configured
            ? `Saved. Paste a new value to replace it.${
                updatedAt
                  ? ` Last updated ${new Date(updatedAt).toLocaleDateString()}.`
                  : ""
              }`
            : "Nothing saved.")}
      </p>
      <div className="filters">
        <Button
          disabled={busy || disabled || !value.trim()}
          onClick={() => run(() => onSave(value.trim()), "Saved")}
        >
          {saveLabel}
        </Button>
        {configured && (
          <Button
            variant="outline"
            disabled={busy || disabled}
            onClick={() => run(onRemove, "Removed")}
          >
            {removeLabel}
          </Button>
        )}
      </div>
      {error && (
        <div className="error-note" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
