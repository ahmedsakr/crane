export function Mark({ size = 26 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden>
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 16 16">
        <path d="M3 14V3h10M5.5 3v3M10.5 3v6" stroke="#131416" strokeWidth="2" fill="none" strokeLinecap="round" />
      </svg>
    </span>
  );
}
