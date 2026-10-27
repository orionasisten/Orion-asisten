// Tema ORION — konsisten dengan Desktop & Web (sumber: source/Orion_v_4_0.html :root)
export const theme = {
  bg: '#07090D',
  panel: '#0D1119',
  surf: '#131A25',
  surf2: '#1B2434',
  gold: '#F5B82E',
  gold2: '#FFD978',
  amber: '#D99519',
  teal: '#39E0CE',
  text: '#F4F5F7',
  tx2: '#A6AFBD',
  tx3: '#66738A',
  line: 'rgba(255,255,255,.10)',
  line2: 'rgba(255,255,255,.18)',
  goldline: 'rgba(245,184,46,.38)',
  goldglow: 'rgba(245,184,46,.10)',
  red: '#F2545B',
  fontDisplay: 'Space Grotesk',
  fontBody: 'Inter',
  fontMono: 'JetBrains Mono'
} as const;

export const radius = { sm: 8, md: 12, lg: 16 } as const;
export const space = (n: number) => n * 4;
