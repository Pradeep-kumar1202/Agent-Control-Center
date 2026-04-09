/** Reusable diff viewer — renders a unified diff with syntax coloring. */

interface DiffSectionProps {
  diff: string;
}

export function DiffSection({ diff }: DiffSectionProps) {
  return (
    <div className="flex-1 overflow-auto p-4">
      <pre className="text-xs font-mono leading-relaxed whitespace-pre overflow-x-auto">
        {diff.split("\n").map((line, i) => (
          <DiffLine key={i} line={line} />
        ))}
      </pre>
    </div>
  );
}

function DiffLine({ line }: { line: string }) {
  let color = "text-slate-400";
  if (line.startsWith("+") && !line.startsWith("+++")) color = "text-emerald-400";
  else if (line.startsWith("-") && !line.startsWith("---")) color = "text-red-400";
  else if (line.startsWith("@@")) color = "text-indigo-400";
  else if (line.startsWith("diff ") || line.startsWith("index ")) color = "text-slate-500";
  return <div className={color}>{line || " "}</div>;
}
