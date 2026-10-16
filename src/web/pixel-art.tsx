import { useEffect, useId, useRef, useState } from 'react';
import type { AgentId } from '../shared/types.js';
import { OFFICE_LAYOUT, officeGeometry } from './office-layout.js';
import type { SceneStatus } from './scene-state.js';
import type { SceneState } from './scene-state.js';

/** Original local SVG sprites; no remote assets or simulated telemetry. */
export function PixelBot() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M10 2h4v3h4v3h3v12h-4v2H7v-2H3V8h3V5h4z" />
      <path fill="#07231a" d="M8 8h8v2h3v8h-5v-3h-4v3H5v-8h3z" />
      <path d="M8 10h2v3H8zm6 0h2v3h-2zm-4 8h4v2h-4z" />
    </svg>
  );
}

export interface OfficeAgent {
  id: AgentId;
  name: string;
  status: SceneStatus;
}

function WorkstationArt({ state }: { state: SceneState }) {
  return (
    <>
      <path fill="#6c5136" d="M111 131h351v8H111z" />
      <path fill="#3d3627" d="M117 139h7v34h-7zm331 0h7v34h-7z" />
      <path fill="#112f23" stroke="#43805d" strokeWidth="2" d="M251 83h83v47h-83z" />
      <path className="screen-glow" fill="#164b2a" opacity=".22" d="M241 73h103v66H241z" />
      <path fill="#081b15" d="M257 89h71v34h-71z" />
      <g className="screen-activity" stroke="#41895d" strokeWidth="2">
        <path d="M300 96h19m-17 5h14m-16 5h21" />
      </g>
      <path className="screen-cursor" fill="#a4ffc1" d="M305 113h6v3h-6z" />
      <path stroke="#72db8e" strokeWidth="2" d="m265 100 5 4-5 4m13 0h12m-25 7h38" />
      <path fill="#3c6550" d="M286 130h12v5h-12zm-32 8h73v4h-73z" />
      <path fill="#142c24" stroke="#336749" strokeWidth="2" d="M149 101h57v31h-57z" />
      <path stroke="#74ab7c" strokeWidth="2" d="M156 109h19m-19 6h33m-33 6h23" />
      <path fill="#956b36" d="M352 117h10v14h-10z" />
      <path stroke="#d0b46a" strokeWidth="2" d="M362 119h5v7h-5" />
      <path fill="#344e39" d="M399 114h12v17h-12z" />
      <path fill="#6bb071" d="M401 114v-13h4v-8h4v15h5v5h-9v1z" />
      <g className="codex-character">
        <path fill="#10221d" stroke="#4a745b" strokeWidth="2" d="M210 135h31v31h-31z" />
        <path fill="#294b34" d="M213 166h7v10h-7zm11-6h24v5h-24zm12 5h7v11h-7z" />
        <g className="character-body">
          <path fill="#263e4a" d="M213 126h25v27h-25z" />
          <path fill="var(--jacket, #4d8e75)" d="M215 126h8v26h-8zm14 0h7v26h-7z" />
          <path fill="#87c697" d="M222 129h7v12h-7z" />
          <path fill="#61df92" d="M225 143h4v5h-4z" />
          <path fill="#171f22" d="M210 93h7v-6h21v5h7v28h-8v6h-20v-7h-7z" />
          <path fill="var(--hair, #47392c)" d="M213 94h6v-4h16v4h6v10h-28z" />
          <path fill="#d6a77c" d="M218 101h20v5h5v8h-5v8h-17v-6h-6v-10h3z" />
          <path fill="#efc49a" d="M224 103h14v12h-14z" />
          <path fill="#282b2d" d="M218 100h6v5h-6z" />
          <path className="character-eyes" fill="#183029" d="M225 107h3v4h-3zm10 0h3v4h-3z" />
          <path fill="#9b6552" d="M230 117h6v2h-6z" />
          <path fill="#608f7b" d="M212 105h4v13h-4zm25-5h8v3h-8zm6 3h4v13h-4z" />
          <path fill="#8ae7ab" d="M243 116h5v2h-5zm-5 2h7v2h-7z" />
        </g>
        <g className="typing-hands">
          <path fill="#d6a77c" d="M236 129h14v4h-14zm-15 5h26v4h-26z" />
          <path fill="#4c9277" d="M233 126h6v7h-6zm-15 3h6v8h-6z" />
        </g>
      </g>
      <g className="state-bubble">
        <path
          fill="#07170f"
          stroke={state === 'error' ? '#ffa99b' : '#6fc68e'}
          d="M196 64h57v17h-24v5h-5v-5h-28z"
        />
        <text
          x="224"
          y="76"
          textAnchor="middle"
          fill={state === 'error' ? '#ffa99b' : '#a9edbf'}
          fontFamily="monospace"
          fontSize="8"
        >
          {state === 'thinking'
            ? '…'
            : state === 'working'
              ? '>_ R/O'
              : state === 'error'
                ? '! ERROR'
                : state === 'stopping'
                  ? 'STOP…'
                  : state === 'offline'
                    ? 'OFFLINE'
                    : state === 'completed'
                      ? 'DONE'
                      : 'READY'}
        </text>
      </g>
    </>
  );
}

/** One room; scene placement and visual identity are independent of runtime state. */
export function PixelOffice({
  agents,
  selectedAgent,
  onSelect,
}: {
  agents: OfficeAgent[];
  selectedAgent: AgentId;
  onSelect: (id: AgentId) => void;
}) {
  const prefix = useId();
  const container = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 560);
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const geometry = officeGeometry(narrow);
  return (
    <div ref={container} className="shared-office" data-layout={narrow ? 'portrait' : 'landscape'}>
      <svg
        className="pixel-office"
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        fill="none"
        shapeRendering="crispEdges"
        role="group"
        aria-label="Shared pixel-art office"
      >
        <defs>
          <pattern id={`${prefix}-wall`} width="40" height="18" patternUnits="userSpaceOnUse">
            <path d="M0 0h40v18H0z" fill="#0c211c" />
            <path d="M0 17h40M39 0v17M19 0v8" stroke="#17352b" />
          </pattern>
          <pattern id={`${prefix}-floor`} width="48" height="20" patternUnits="userSpaceOnUse">
            <path d="M0 0h48v20H0z" fill="#0a1918" />
            <path d="M0 19h48M47 0v19" stroke="#17332b" />
          </pattern>
        </defs>
        <g aria-hidden="true" className="office-room">
          <path fill={`url(#${prefix}-wall)`} d={`M0 0h${geometry.width}v${geometry.wall}H0z`} />
          <path
            fill={`url(#${prefix}-floor)`}
            d={`M0 ${geometry.wall}h${geometry.width}v${geometry.height - geometry.wall}H0z`}
          />
          <path stroke="#3c6b51" strokeWidth="3" d={`M0 ${geometry.wall}h${geometry.width}`} />
          {[28, geometry.width - 156].map((x) => (
            <g key={x}>
              <path fill="#041211" stroke="#315747" strokeWidth="3" d={`M${x} 14h128v65H${x}z`} />
              <path
                fill="#1c3430"
                d={`M${x + 4} 60h14V42h18v12h17V30h21v30h15V45h20v15h15v15H${x + 4}z`}
              />
              <path fill="#71ab85" d={`M${x + 19} 22h2v2h-2zm68 8h2v2h-2z`} />
              <path stroke="#a77d39" strokeWidth="2" d={`M${x + 25} 48v5m38-12v5m36 9v5`} />
              <path stroke="#315747" strokeWidth="3" d={`M${x + 64} 15v63`} />
            </g>
          ))}
          <path
            fill="#04110d"
            stroke="#3d8060"
            strokeWidth="2"
            d={`M${geometry.width / 2 - 65} 17h130v35h-130z`}
          />
          <text
            x={geometry.width / 2}
            y="40"
            textAnchor="middle"
            fill="#7cf5a7"
            fontFamily="monospace"
            fontWeight="bold"
            fontSize="14"
          >
            AI OFFICE
          </text>
          <path fill="#6d4d32" d={`M16 ${geometry.wall - 15}h17v30H16z`} />
          <path
            fill="#367953"
            d={`M22 ${geometry.wall - 15}v-30h5v30zm-9-27h9v12h-9zm14-13h7v18h-7zm0 23h11v6H27z`}
          />
          <path
            fill="#19372c"
            stroke="#38624a"
            strokeWidth="2"
            d={`M${geometry.width - 33} ${geometry.wall - 64}h22v65h-22z`}
          />
          <path
            stroke="#38624a"
            strokeWidth="2"
            d={`M${geometry.width - 33} ${geometry.wall - 42}h22m-22 20h22`}
          />
          <path fill="#93733e" d={`M${geometry.width - 29} ${geometry.wall - 57}h4v12h-4z`} />
          <path fill="#4b926d" d={`M${geometry.width - 23} ${geometry.wall - 55}h7v10h-7z`} />
          <path
            fill="#20392b"
            d={`M${geometry.width / 2 - 22} ${geometry.height - 25}h44v7h-44z`}
          />
          <path
            fill="#b58c57"
            d={`M${geometry.width / 2 - 13} ${geometry.height - 33}h22v10h-22zm0-7h6v10h-6zm16 0h6v10h-6zm6 14h13v4h-13z`}
          />
          <path
            fill="#162a20"
            d={`M${geometry.width / 2 - 8} ${geometry.height - 31}h2v2h-2zm10 0h2v2h-2z`}
          />
        </g>
        {OFFICE_LAYOUT.map((placement) => {
          const agent = agents.find((agent) => agent.id === placement.agentId);
          if (!agent) return null;
          const point = narrow ? placement.portrait : placement.landscape;
          const selected = selectedAgent === agent.id;
          return (
            <g
              key={agent.id}
              role="button"
              tabIndex={0}
              className={`office-workstation state-${agent.status.state} identity-${placement.identity}`}
              data-agent-id={agent.id}
              data-state={agent.status.state}
              aria-label={`Select ${agent.name} workstation`}
              aria-pressed={selected}
              aria-describedby={`${prefix}-${agent.id}-status`}
              transform={`translate(${point.x - 111} ${point.y - 64})`}
              onClick={() => onSelect(agent.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  if (!event.repeat) onSelect(agent.id);
                }
                const buttons = Array.from(
                  event.currentTarget.ownerSVGElement!.querySelectorAll<SVGGElement>(
                    '.office-workstation',
                  ),
                );
                const index = buttons.indexOf(event.currentTarget);
                const next = ['ArrowRight', 'ArrowDown'].includes(event.key)
                  ? (index + 1) % buttons.length
                  : ['ArrowLeft', 'ArrowUp'].includes(event.key)
                    ? (index + buttons.length - 1) % buttons.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? buttons.length - 1
                        : undefined;
                if (next !== undefined) {
                  event.preventDefault();
                  buttons[next]?.focus();
                }
              }}
            >
              <rect
                className="station-hit-area"
                x="104"
                y="52"
                width="360"
                height="157"
                fill="transparent"
              />
              <g aria-hidden="true">
                <path
                  className="station-selection"
                  d="M109 64v-8h18m317 0h15v8m0 126v8h-18m-314 0h-18v-8"
                />
                <text
                  className="station-name"
                  x="126"
                  y="65"
                  fontFamily="monospace"
                  fontSize="11"
                  fontWeight="bold"
                >
                  {agent.name.toUpperCase()}
                </text>
                <WorkstationArt state={agent.status.state} />
                <text
                  className="station-status"
                  x="126"
                  y="193"
                  fontFamily="monospace"
                  fontSize="10"
                >
                  {selected ? '▶ ' : '○ '}
                  {agent.status.label}
                </text>
              </g>
            </g>
          );
        })}
      </svg>
      {agents.map((agent) => (
        <span key={agent.id} id={`${prefix}-${agent.id}-status`} className="sr-only">
          {agent.status.label}. Read only.
        </span>
      ))}
    </div>
  );
}
