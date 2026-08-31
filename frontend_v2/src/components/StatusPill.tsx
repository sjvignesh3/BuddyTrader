import { statusClass } from "../lib/money";

export default function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full ring-1 ${statusClass(
        status
      )}`}
    >
      {status}
    </span>
  );
}
