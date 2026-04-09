interface Props {
  status: "idle" | "running" | "done" | "failed";
  onClick: () => void;
}

export function RunButton({ status, onClick }: Props) {
  const running = status === "running";
  return (
    <button
      onClick={onClick}
      disabled={running}
      className={
        "rounded-lg px-5 py-2.5 font-medium text-white transition " +
        (running
          ? "bg-indigo-700 cursor-wait"
          : "bg-indigo-600 hover:bg-indigo-500")
      }
    >
      {running ? (
        <span className="inline-flex items-center gap-2">
          <Spinner /> Running…
        </span>
      ) : (
        "Run Gap Analysis"
      )}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4 text-white"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}
