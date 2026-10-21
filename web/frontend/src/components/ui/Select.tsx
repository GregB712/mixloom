type Option = { value: string; label: string };

export function Select({
  label,
  value,
  options,
  onChange,
  disabled,
  id,
}: {
  label?: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <div className="field">
      {label && (
        <label className="label" htmlFor={id}>
          {label}
        </label>
      )}
      <select
        id={id}
        className="select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
