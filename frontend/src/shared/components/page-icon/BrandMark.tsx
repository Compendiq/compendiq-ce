export function BrandMark({
  path,
  size,
}: {
  path: string;
  size: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="shrink-0 fill-current"
    >
      <path d={path} />
    </svg>
  );
}
