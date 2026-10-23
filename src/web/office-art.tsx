import type { ReactNode } from 'react';
import type { SceneState } from './scene-state.js';

// Original vector furniture on a single 2:1 projection. No external artwork.
const point = (x: number, y: number, z = 0) => `${(x - y) * 0.86},${(x + y) * 0.43 - z}`;
const plane = (x: number, y: number, w: number, d: number, z = 0) =>
  [point(x, y, z), point(x + w, y, z), point(x + w, y + d, z), point(x, y + d, z)].join(' ');
export const roomPoint = (x: number, y: number) => ({
  x: 500 + (x - y) * 0.86,
  y: 175 + (x + y) * 0.43,
});
function Block({
  x = 0,
  y = 0,
  w,
  d,
  h,
  z = 0,
  colors,
}: {
  x?: number;
  y?: number;
  w: number;
  d: number;
  h: number;
  z?: number;
  colors: [string, string, string];
}) {
  return (
    <g>
      <polygon
        points={[
          point(x, y + d, z),
          point(x + w, y + d, z),
          point(x + w, y + d, z + h),
          point(x, y + d, z + h),
        ].join(' ')}
        fill={colors[1]}
      />
      <polygon
        points={[
          point(x + w, y, z),
          point(x + w, y + d, z),
          point(x + w, y + d, z + h),
          point(x + w, y, z + h),
        ].join(' ')}
        fill={colors[2]}
      />
      <polygon points={plane(x, y, w, d, z + h)} fill={colors[0]} />
    </g>
  );
}
function Plant({ x, y, large = false }: { x: number; y: number; large?: boolean }) {
  const p = roomPoint(x, y);
  return (
    <g transform={`translate(${p.x} ${p.y}) scale(${large ? 1.25 : 0.75})`}>
      <ellipse cy="5" rx="22" ry="10" fill="#17252d" opacity=".22" />
      <path d="M-15 -16H15L11 8Q0 17 -11 8Z" fill="#b57558" />
      <ellipse cy="-16" rx="15" ry="7" fill="#e1a47b" />
      <ellipse cy="-16" rx="11" ry="4" fill="#514039" />
      <path d="M0 -16V-64M0 -38L-19 -54M0 -46L20 -67" stroke="#507857" strokeWidth="4" />
      <path
        d="M0 -54Q-34 -88 -24 -44Q-7 -37 0 -44M0 -40Q32 -81 28 -42Q14 -27 0 -32M0 -27Q-34 -57 -29 -24Q-12 -11 0 -20M0 -62Q-8 -96 8 -87Q20 -73 0 -62"
        fill="#699674"
      />
      <path d="M0 -44L-18 -59M0 -34L20 -51" stroke="#94b584" strokeWidth="2" />
    </g>
  );
}
export function AgentPortrait({ id, small = false }: { id: string; small?: boolean }) {
  return (
    <svg
      className={small ? 'agent-portrait small' : 'agent-portrait'}
      viewBox="-24 -53 48 66"
      aria-hidden="true"
    >
      <Character id={id} />
    </svg>
  );
}
function characterIdentity(id: string) {
  const hash = Array.from(id).reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) | 0, 0) >>> 0;
  const palettes = [
    ['#d99673', '#573f39', '#e6b997'],
    ['#82b6be', '#d5bd88', '#b98260'],
    ['#b1a0d2', '#413d53', '#d8a786'],
    ['#d5b96e', '#634d39', '#ad7456'],
  ];
  return { colors: palettes[hash % palettes.length]!, variant: hash % 3 };
}
function Character({ id }: { id: string }) {
  const {
    colors: [shirt, hair, skin],
    variant,
  } = characterIdentity(id);
  return (
    <g className="iso-character">
      <path d="M-12 8V-8H-2V8M3 8V-8H13V8" stroke="#343b4e" strokeWidth="8" />
      <path className="character-body" d="M-18 -20L-10 -27H10L18 -20V-1H-18Z" fill={shirt} />
      <path d="M-13 -47H11L16 -40V-28L9 -21H-8L-15 -28V-39Z" fill={skin} />
      <path d="M-16 -35V-48L-6 -53H11L17 -45V-35H10V-42H-9V-35Z" fill={hair} />
      <path className="character-eyes" d="M-7 -34V-30M6 -34V-30" stroke="#30333b" strokeWidth="3" />
      {variant === 0 && (
        <path
          d="M-13 -36H-2V-28H-13ZM2 -36H13V-28H2ZM-2 -33H2"
          fill="none"
          stroke="#39444d"
          strokeWidth="2"
        />
      )}
      {variant === 1 && (
        <path
          d="M-19 -35V-43Q0 -65 19 -43V-35M-18 -39V-27M18 -39V-27"
          fill="none"
          stroke="#4f6575"
          strokeWidth="5"
        />
      )}
      {variant === 2 && <path d="M-18 -46H15V-41H22V-37H-18Z" fill="#d6c698" />}
      <path
        className="typing-hands"
        d="M-17 -16L-8 -7M16 -16L25 -10"
        stroke={skin}
        strokeWidth="7"
        strokeLinecap="round"
      />
    </g>
  );
}
export const STATE_SYMBOL: Record<SceneState, string> = {
  offline: '—',
  idle: '○',
  preparing: '↻',
  queued: '≡',
  thinking: '···',
  working: '↗',
  reviewing: '⌕',
  approval: '◇',
  stopping: '■',
  completed: '✓',
  error: '!',
};
export const STATE_SHORT: Record<SceneState, string> = {
  offline: 'Offline',
  idle: 'Ready',
  preparing: 'Preparing',
  queued: 'Queued',
  thinking: 'Thinking',
  working: 'Working',
  reviewing: 'Reviewing',
  approval: 'Approval',
  stopping: 'Stopping',
  completed: 'Done',
  error: 'Attention',
};
export function StudioDesk({ id, state }: { id: string; state: SceneState }) {
  return (
    <g aria-hidden="true">
      <ellipse cy="20" rx="92" ry="33" fill="#17252d" opacity=".2" />
      <g transform="translate(0 -6)">
        <Block
          x={-45}
          y={-28}
          w={105}
          d={52}
          h={6}
          z={40}
          colors={['#dfbc8b', '#a67956', '#be9468']}
        />
        {[-36, 49].map((x) => (
          <Block
            key={x}
            x={x}
            y={-20}
            w={7}
            d={38}
            h={40}
            colors={['#74817e', '#586265', '#465760']}
          />
        ))}
        <Block x={-43} y={2} w={24} d={20} h={33} colors={['#cbb18a', '#b08d67', '#977554']} />
        <path d="M-27 -8L-9 1M-27 0L-9 9" stroke="#e6c9a2" strokeWidth="2" />
      </g>
      <path d="M-14 -40L-14 -73L32 -51V-18Z" fill="#263e4c" stroke="#526777" strokeWidth="3" />
      <path className="iso-monitor-glow" d="M-9 -65L26 -48V-27L-9 -43Z" fill="#83bdbe" />
      <path d="M-4 -56L8 -50M-4 -49L20 -37M-4 -43L10 -36" stroke="#d3eddb" strokeWidth="2" />
      <path d="M10 -28V-13L22 -7L2 -17" stroke="#4b626b" strokeWidth="4" />
      <path d="M17 -6L39 5L29 10L7 -1Z" fill="#647b80" />
      <path d="M-50 -18L-42 -23L-34 -18V-6L-42 -1L-50 -6Z" fill="#e6d7b5" />
      <path d="M-34 -16Q-24 -15 -28 -8L-34 -7" fill="none" stroke="#e6d7b5" strokeWidth="3" />
      <path d="M-4 11L21 23V41L-4 29Z" fill="#596d70" />
      <path d="M-4 29L-20 38L4 50L21 41Z" fill="#6c8380" />
      <g transform="translate(-16 9)">
        <Character id={id} />
      </g>
      <path d="M-15 57V64M-29 67L-15 62L0 69" fill="none" stroke="#465760" strokeWidth="4" />
      <g className="state-bubble" transform="translate(30 -93)">
        <rect
          x="-46"
          y="-17"
          width="92"
          height="25"
          rx="7"
          fill="#26363f"
          stroke="var(--station-ink)"
          strokeWidth="1.5"
        />
        <path d="M-4 8L0 13L4 8" fill="#26363f" />
        <text textAnchor="middle" y="0" fill="var(--station-ink)" fontSize="10" fontWeight="700">
          {STATE_SYMBOL[state]} {STATE_SHORT[state]}
        </text>
      </g>
    </g>
  );
}
export function StudioRoom({ prefix, children }: { prefix: string; children: ReactNode }) {
  const floor = plane(0, 0, 500, 500);
  return (
    <>
      <defs>
        <linearGradient id={`${prefix}-glass`} x2="0" y2="1">
          <stop stopColor="#839eac" />
          <stop offset="1" stopColor="#c6c7ac" />
        </linearGradient>
        <radialGradient id={`${prefix}-light`}>
          <stop stopColor="#ffe0a3" stopOpacity=".35" />
          <stop offset="1" stopColor="#ffe0a3" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${prefix}-floor`}>
          <polygon points={floor} />
        </clipPath>
      </defs>
      <g
        className="office-environment"
        aria-hidden="true"
        pointerEvents="none"
        transform="translate(500 175)"
      >
        <ellipse cy="260" rx="420" ry="185" fill="#070f18" opacity=".3" />
        <Block w={500} d={500} h={19} z={-19} colors={['#bb9b79', '#66534b', '#836b57']} />
        <g clipPath={`url(#${prefix}-floor)`}>
          {Array.from({ length: 24 }, (_, i) => (
            <path
              key={i}
              d={`M${point(i * 24, 0)}L${point(i * 24, 500)}`}
              stroke="#8e765f"
              strokeWidth="1"
              opacity=".55"
            />
          ))}
          {Array.from({ length: 12 }, (_, i) => (
            <path
              key={i}
              d={`M${point(0, i * 48)}L${point(500, i * 48)}`}
              stroke="#e7cba5"
              strokeWidth="1"
              opacity=".25"
            />
          ))}
          <polygon points={plane(0, 100, 280, 210)} fill="#fce2ab" opacity=".14" />
        </g>
        <polygon
          points={[point(0, 500), point(0, 0), point(0, 0, 170), point(0, 500, 170)].join(' ')}
          fill="#84958c"
        />
        <polygon
          points={[point(0, 0), point(500, 0), point(500, 0, 170), point(0, 0, 170)].join(' ')}
          fill="#a6b0a0"
        />
        <path
          d={`M${point(0, 500, 170)}L${point(0, 0, 170)}L${point(500, 0, 170)}`}
          fill="none"
          stroke="#d3cdb5"
          strokeWidth="7"
        />
        <path
          d={`M${point(0, 500, 6)}L${point(0, 0, 6)}L${point(500, 0, 6)}`}
          fill="none"
          stroke="#d5bea0"
          strokeWidth="8"
        />
        {[85, 260].map((y) => (
          <g key={y}>
            <polygon
              points={[
                point(0, y, 133),
                point(0, y + 115, 133),
                point(0, y + 115, 55),
                point(0, y, 55),
              ].join(' ')}
              fill={`url(#${prefix}-glass)`}
              stroke="#e0d4b7"
              strokeWidth="7"
            />
            <path
              d={`M${point(0, y + 57, 133)}L${point(0, y + 57, 55)}M${point(0, y, 91)}L${point(0, y + 115, 91)}`}
              stroke="#e0d4b7"
              strokeWidth="4"
            />
            <path
              d={`M${point(0, y, 139)}L${point(0, y + 115, 139)}`}
              stroke="#607c76"
              strokeWidth="7"
            />
          </g>
        ))}
        <polygon
          points={[
            point(180, 0, 128),
            point(300, 0, 128),
            point(300, 0, 72),
            point(180, 0, 72),
          ].join(' ')}
          fill="#e6d7b5"
          stroke="#6f7c6c"
          strokeWidth="5"
        />
        <path
          d={`M${point(195, 0, 88)}L${point(230, 0, 111)}L${point(250, 0, 89)}L${point(280, 0, 116)}`}
          fill="none"
          stroke="#759185"
          strokeWidth="5"
        />
        <g transform={`translate(${point(80, 0, 90)})`}>
          <text
            transform="skewY(26.5)"
            fontSize="14"
            letterSpacing="3"
            fill="#354e4e"
            fontWeight="800"
          >
            AI OFFICE
          </text>
        </g>
        <g transform={`translate(${point(365, 12)})`}>
          <Block w={103} d={30} h={83} colors={['#d6b58c', '#94785e', '#b29370']} />
          <path d="M-17 -40L70 3M-17 -68L70 -25" stroke="#d7bc96" strokeWidth="5" />
          {[0, 1, 2, 3, 4].map((i) => (
            <path
              key={i}
              d={`M${i * 11 - 9} ${-68 + i * 5.5}v17`}
              stroke={['#8ca6a2', '#bd8e76', '#ddd0a2', '#748f8c', '#a69bb6'][i]}
              strokeWidth="7"
            />
          ))}
          <path d="M-8 -33L8 -25M19 -20L32 -14M43 -8L58 -1" stroke="#d2c0a5" strokeWidth="12" />
        </g>
      </g>
      <g aria-hidden="true" pointerEvents="none">
        <Plant x={25} y={55} large />
        <Plant x={475} y={38} large />
        <g transform={`translate(${roomPoint(52, 365).x} ${roomPoint(52, 365).y})`}>
          <Block w={70} d={100} h={16} z={7} colors={['#698e85', '#4b706b', '#527c73']} />
          <Block w={18} d={100} h={40} z={7} colors={['#8caaa0', '#62857c', '#547970']} />
          <Block x={18} w={52} d={14} h={30} z={7} colors={['#8caaa0', '#62857c', '#547970']} />
          <path d="M-34 24L9 46M-10 12L33 34" stroke="#a0baaa" strokeWidth="2" opacity=".6" />
        </g>
        <g transform={`translate(${roomPoint(160, 410).x} ${roomPoint(160, 410).y})`}>
          <Block x={-20} y={-15} w={84} d={60} h={3} colors={['#a29a88', '#827b72', '#8a8273']} />
          <Block w={47} d={35} h={29} colors={['#dbc39d', '#a88b69', '#c0a17a']} />
          <Block
            x={5}
            y={5}
            w={20}
            d={15}
            h={2}
            z={29}
            colors={['#7f9e9b', '#647d7a', '#647d7a']}
          />
        </g>
        <g transform={`translate(${roomPoint(420, 75).x} ${roomPoint(420, 75).y})`}>
          <Block w={55} d={44} h={40} colors={['#ddc9a5', '#b59b7d', '#c2aa87']} />
          <Block
            x={7}
            y={7}
            w={32}
            d={24}
            h={28}
            z={40}
            colors={['#68817d', '#3c5456', '#496365']}
          />
          <path d="M-6 -21L8 -14V-5L-6 -12Z" fill="#ddc9a5" />
        </g>
        <Plant x={490} y={250} />
        <g transform={`translate(${roomPoint(37, 300).x} ${roomPoint(37, 300).y})`}>
          <ellipse rx="70" ry="45" fill={`url(#${prefix}-light)`} />
          <ellipse rx="15" ry="7" fill="#6e7669" />
          <path d="M0 0V-96" stroke="#d3bb86" strokeWidth="4" />
          <path d="M-22 -91L-13 -119H13L22 -91Z" fill="#ecd09a" />
          <ellipse cy="-91" rx="22" ry="7" fill="#f9e6b3" />
        </g>
      </g>
      {children}
      <g aria-hidden="true" pointerEvents="none">
        <ellipse cx="390" cy="310" rx="255" ry="135" fill={`url(#${prefix}-light)`} />
      </g>
    </>
  );
}
