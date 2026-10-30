
export function MapCompass() {
  return (
    <div
      className="absolute left-4 bottom-4 z-10 rounded-md border border-line-strong bg-raised p-1.5 shadow-sm"
      aria-hidden="true"
      role="none"
    >
      {/* North-pointer compass rose — 40×40 display size, viewBox 0 0 40 40.
          N label at top, cardinal tick marks at E/W/S.
          The arrow points upward (north) in the local frame — since this is a
          static compass the arrow always points screen-up. */}
      <svg
        viewBox="0 0 40 40"
        width="40"
        height="40"
        fill="none"
        aria-hidden="true"
        role="none"
        className="text-neutral-600 dark:text-neutral-400"
      >
        {/* Outer ring */}
        <circle
          cx="20"
          cy="20"
          r="17"
          stroke="currentColor"
          strokeOpacity="0.3"
          strokeWidth="1"
        />

        {/* North arrow — filled accent color, points up */}
        <path
          d="M20 4 L23 20 L20 17 L17 20 Z"
          fill="var(--color-accent, oklch(0.6 0.18 270))"
        />

        {/* South tail — neutral fill, points down */}
        <path
          d="M20 36 L17 20 L20 23 L23 20 Z"
          fill="currentColor"
          fillOpacity="0.4"
        />

        {/* Cardinal tick marks — E, W, S (N is indicated by the arrow tip) */}
        {/* East */}
        <line x1="35" y1="20" x2="32" y2="20" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.5" strokeLinecap="round" />
        {/* West */}
        <line x1="5" y1="20" x2="8" y2="20" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.5" strokeLinecap="round" />
        {/* South */}
        <line x1="20" y1="35" x2="20" y2="32" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.5" strokeLinecap="round" />
        {/* North tick (shorter, behind arrow tip) */}
        <line x1="20" y1="5" x2="20" y2="8" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" strokeLinecap="round" />

        {/* N label */}
        <text
          x="20"
          y="13"
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize="6"
          fontWeight="600"
          fill="var(--color-accent, oklch(0.6 0.18 270))"
          letterSpacing="0.5"
        >
          N
        </text>

        {/* Center dot */}
        <circle cx="20" cy="20" r="2" fill="currentColor" fillOpacity="0.5" />
      </svg>
    </div>
  );
}
