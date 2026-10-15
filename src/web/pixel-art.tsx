/** Original code-drawn decoration. These sprites never represent extra live agents. */
export function PixelBot() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M10 2h4v3h4v3h3v12h-4v2H7v-2H3V8h3V5h4z" />
      <path fill="#07231a" d="M8 8h8v2h3v8h-5v-3h-4v3H5v-8h3z" />
      <path d="M8 10h2v3H8zm6 0h2v3h-2zm-4 8h4v2h-4z" />
    </svg>
  );
}

export function PixelOffice() {
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
      <path fill="#081b15" d="M257 89h71v34h-71z" />
      <path stroke="#72db8e" strokeWidth="2" d="m265 100 5 4-5 4m13 0h12m-25 7h38" />
      <path fill="#3c6550" d="M286 130h12v5h-12zm-32 8h73v4h-73z" />
      <path fill="#142c24" stroke="#336749" strokeWidth="2" d="M149 101h57v31h-57z" />
      <path stroke="#74ab7c" strokeWidth="2" d="M156 109h19m-19 6h33m-33 6h23" />
      <path fill="#956b36" d="M352 117h10v14h-10z" />
      <path stroke="#d0b46a" strokeWidth="2" d="M362 119h5v7h-5" />
      <path fill="#344e39" d="M399 114h12v17h-12z" />
      <path fill="#6bb071" d="M401 114v-13h4v-8h4v15h5v5h-9v1z" />
      <path fill="#163c2a" stroke="#4c8060" strokeWidth="2" d="M220 136h37v30h-37z" />
      <path fill="#294b34" d="M223 129h31v8h-31zm11 37h7v11h-7z" />
      <path fill="#4e8d63" d="M224 131v-13h5v-9h20v9h5v13z" />
      <path fill="#a3c091" d="M231 112h15v10h-15z" />
      <path fill="#273e2c" d="M231 109h15v6h-15z" />
      <path fill="#2b4a35" d="M537 148h46v8h-46zm5-7h35v7h-35z" />
      <path fill="#b58c57" d="M547 137h22v10h-22zm0-7h6v10h-6zm16 0h6v10h-6zm6 14h13v4h-13z" />
      <path fill="#162a20" d="M552 139h2v2h-2zm10 0h2v2h-2z" />
      <path stroke="#35704e" d="M0 153h720" />
    </svg>
  );
}
