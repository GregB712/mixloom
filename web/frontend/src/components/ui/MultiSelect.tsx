import { Button } from "./Button";

export type MultiOption = { value: string; label: string; meta?: string };

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label?: string;
  options: MultiOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };
  const allValues = options.map((o) => o.value);
  const allSelected = selected.length === options.length && options.length > 0;

  return (
    <div className="multiselect">
      <div className="row" style={{ justifyContent: "space-between" }}>
        {label && <span className="label">{label}</span>}
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <span className="small faint">{selected.length} selected</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(allSelected ? [] : allValues)}
          >
            {allSelected ? "Clear" : "Select all"}
          </Button>
        </div>
      </div>
      <div className="multiselect__box" role="listbox" aria-multiselectable>
        {options.map((o) => (
          <label className="option" key={o.value} role="option" aria-selected={selected.includes(o.value)}>
            <input
              type="checkbox"
              checked={selected.includes(o.value)}
              onChange={() => toggle(o.value)}
            />
            <span className="option__name">{o.label}</span>
            {o.meta && <span className="option__count">{o.meta}</span>}
          </label>
        ))}
      </div>
    </div>
  );
}
