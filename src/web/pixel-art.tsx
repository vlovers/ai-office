import type { SceneState } from './scene-state.js';

/** Original local SVG sprites; one workstation, tied to actual task state. */
export function PixelBot() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M10 2h4v3h4v3h3v12h-4v2H7v-2H3V8h3V5h4z" />
      <path fill="#07231a" d="M8 8h8v2h3v8h-5v-3h-4v3H5v-8h3z" />
      <path d="M8 10h2v3H8zm6 0h2v3h-2zm-4 8h4v2h-4z" />
    </svg>
  );
}

export function PixelOffice({ state }: { state: SceneState }) {
  return (
    <svg
      className="pixel-office"
      viewBox="0 0 720 184"
      fill="none"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <defs>
        <pattern id="wall" width="40" height="18" patternUnits="userSpaceOnUse">
          <path d="M0 0h40v18H0z" fill="#0c211c" />
          <path d="M0 17h40M39 0v17M19 0v8" stroke="#17352b" />
        </pattern>
        <pattern id="floor" width="48" height="16" patternUnits="userSpaceOnUse">
          <path d="M0 0h48v16H0z" fill="#0a1918" />
          <path d="M0 15h48M47 0v15" stroke="#17332b" />
        </pattern>
        <pattern id="stars" width="51" height="35" patternUnits="userSpaceOnUse">
          <path d="M6 8h2v2H6zm28 17h2v2h-2z" fill="#5b9d84" />
        </pattern>
      </defs>
      <path fill="url(#wall)" d="M0 0h720v151H0z" />
      <path fill="url(#floor)" d="M0 151h720v33H0z" />
      {[40, 215, 500].map((x) => (
        <g key={x}>
          <path fill="#041211" stroke="#315747" strokeWidth="4" d={`M${x} 12h145v113H${x}z`} />
          <path fill="url(#stars)" d={`M${x + 4} 16h137v105H${x + 4}z`} />
          <path
            fill="#1c3430"
            d={`M${x + 8} 86h22V60h18v20h17V47h21v37h15V67h20v21h18v33H${x + 8}z`}
          />
          <path stroke="#a77d39" strokeWidth="2" d={`M${x + 18} 94v9m20-24v8m38-24v8m37 17v8`} />
          <path stroke="#315747" strokeWidth="4" d={`M${x + 72} 14v109M${x} 126h145`} />
        </g>
      ))}
      <path fill="#04110d" stroke="#3d8060" strokeWidth="2" d="M376 18h108v49H376z" />
      <text
        x="430"
        y="39"
        textAnchor="middle"
        fill="#7cf5a7"
        fontFamily="monospace"
        fontWeight="bold"
        fontSize="15"
      >
        AI OFFICE
      </text>
      <text x="430" y="55" textAnchor="middle" fill="#8dbca3" fontFamily="monospace" fontSize="7">
        READ / THINK / REVIEW
      </text>
      <path fill="#294337" d="M373 74h115v5H373z" />
      <path fill="#326b45" d="M391 74v-9h5v-6h5v15zm72 0v-12h5v-5h5v17z" />
      <path fill="#6d4d32" d="M14 129h15v34H14zm0-4h18v7H14z" />
      <path fill="#367953" d="M18 128v-30h5v30zm-9-27h9v12H9zm14-13h7v18h-7zm0 23h11v6H23z" />
      <path fill="#19372c" stroke="#38624a" strokeWidth="2" d="M654 68h45v89h-45z" />
      <path stroke="#38624a" strokeWidth="2" d="M654 98h45m-45 29h45m-24-59v89" />
      <path fill="#93733e" d="M661 75h4v18h-4zm8 4h4v14h-4z" />
      <path fill="#4b926d" d="M680 77h12v16h-12zm-20 60h10v12h-10z" />
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
          <path fill="#4d8e75" d="M215 126h8v26h-8zm14 0h7v26h-7z" />
          <path fill="#87c697" d="M222 129h7v12h-7z" />
          <path fill="#61df92" d="M225 143h4v5h-4z" />
          <path fill="#171f22" d="M210 93h7v-6h21v5h7v28h-8v6h-20v-7h-7z" />
          <path fill="#47392c" d="M213 94h6v-4h16v4h6v10h-28z" />
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
                    : 'CODEX'}
        </text>
      </g>
      <path fill="#2b4a35" d="M537 148h46v8h-46zm5-7h35v7h-35z" />
      <path fill="#b58c57" d="M547 137h22v10h-22zm0-7h6v10h-6zm16 0h6v10h-6zm6 14h13v4h-13z" />
      <path fill="#162a20" d="M552 139h2v2h-2zm10 0h2v2h-2z" />
      <path stroke="#35704e" d="M0 153h720" />
    </svg>
  );
}
