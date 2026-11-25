import { encode } from "uqr";

// Rendered locally: a value such as an authenticator's otpauth URI holds a
// secret and must never be sent to an image service. Dark modules on a light
// field, as scanners expect. The text printed beside it is the accessible
// alternative.
export function QrCode({ value }: { readonly value: string }) {
  const { data, size } = encode(value, { border: 2, ecc: "M" });
  // One rectangle per horizontal run of dark modules avoids hairline seams.
  const runs = data.flatMap((row, y) =>
    row.flatMap((dark, x) => {
      if (!dark || row[x - 1] === true) return [];
      const end = row.indexOf(false, x);
      const width = (end === -1 ? row.length : end) - x;
      return [
        `M${String(x)} ${String(y)}h${String(width)}v1h-${String(width)}z`,
      ];
    })
  );
  const viewBox = `0 0 ${String(size)} ${String(size)}`;

  return (
    <svg
      aria-hidden="true"
      className="size-52 rounded-lg bg-white text-black"
      viewBox={viewBox}
    >
      <path d={runs.join("")} fill="currentColor" />
    </svg>
  );
}
