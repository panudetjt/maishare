interface IconProps {
  size?: number;
  class?: string;
}

function base(size = 18): {
  width: number;
  height: number;
  viewBox: string;
  fill: string;
  stroke: string;
  "stroke-width": number;
  "stroke-linecap": "round";
  "stroke-linejoin": "round";
} {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.8,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  };
}

export function Logo({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M13 2 4.5 13.5H11l-1 8.5L18.5 10.5H12l1-8.5z"
        fill="url(#mai-g)"
        stroke="url(#mai-g)"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
      <defs>
        <linearGradient id="mai-g" x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#818cf8" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Bolt(p: IconProps) {
  return (
    <svg {...base(p.size ?? 18)} className={p.class} aria-hidden="true">
      <path d="M13 2 4.5 13.5H11l-1 8.5L18.5 10.5H12l1-8.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function LockIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function CopyIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function SendIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <path d="m22 2-7 20-4-9-9-4 20-7z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

export function FileIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

export function ImageIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.5-3.5L9 20" />
    </svg>
  );
}

export function ClipboardIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <rect x="5" y="4" width="14" height="18" rx="2" />
      <path d="M9 2h6v3H9z" />
    </svg>
  );
}

export function ChatIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function UsersIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function WifiIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <circle cx="12" cy="19.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function QrIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3zM20 14h1M14 20h1M18 20h3v1" />
    </svg>
  );
}

export function XIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function DownloadIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5M12 15V3" />
    </svg>
  );
}

export function ArrowLeft(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

export function TrashIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <svg {...base(p.size ?? 16)} className={p.class} aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function ArrowUp(p: IconProps) {
  return (
    <svg {...base(p.size ?? 14)} className={p.class} aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function ArrowDown(p: IconProps) {
  return (
    <svg {...base(p.size ?? 14)} className={p.class} aria-hidden="true">
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  );
}
