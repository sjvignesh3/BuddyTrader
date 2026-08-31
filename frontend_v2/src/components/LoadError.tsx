interface Props {
  loading?: boolean;
  error?: unknown;
  empty?: boolean;
  emptyLabel?: string;
}

export default function LoadError({ loading, error, empty, emptyLabel }: Props) {
  if (loading) {
    return (
      <div className="py-8 text-center text-brand-mute text-sm">Loading…</div>
    );
  }
  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return (
      <div className="py-8 text-center text-brand-danger text-sm">
        Failed to load: {msg}
      </div>
    );
  }
  if (empty) {
    return (
      <div className="py-8 text-center text-brand-mute text-sm">
        {emptyLabel ?? "No data."}
      </div>
    );
  }
  return null;
}
