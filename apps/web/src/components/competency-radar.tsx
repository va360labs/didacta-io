'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';

/**
 * Radar de competencias en SVG puro (sin dependencia de charts, por el control
 * de bundle del proyecto). Dibuja N ejes (uno por competencia) con su score
 * 0-100. Para N<3 no tiene sentido un radar → devuelve null (la UI cae a barras).
 */
export function CompetencyRadar({
  data,
  size = 320,
}: {
  data: Array<{ name: string; score: number }>;
  size?: number;
}) {
  const t = useTranslations('cuentaComponentes');
  const n = data.length;
  if (n < 3) return null;

  const c = size / 2;
  const R = c - 56; // deja aire para las etiquetas
  const angle = (i: number) => (-90 + (i * 360) / n) * (Math.PI / 180);
  const at = (value: number, i: number, radius = R) => {
    const r = (Math.max(0, Math.min(100, value)) / 100) * radius;
    return [c + r * Math.cos(angle(i)), c + r * Math.sin(angle(i))] as const;
  };
  const ringPoints = (ring: number) => data.map((_, i) => at(ring * 100, i).join(',')).join(' ');
  const dataPoints = data.map((d, i) => at(d.score, i).join(',')).join(' ');

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-auto w-full max-w-[320px] overflow-visible"
      role="img"
      aria-label={t('radar.ariaLabel')}
    >
      {[0.25, 0.5, 0.75, 1].map((ring) => (
        <polygon
          key={ring}
          points={ringPoints(ring)}
          fill="none"
          stroke="#E2E8F0"
          strokeWidth={1}
        />
      ))}
      {data.map((_, i) => {
        const [x, y] = at(100, i);
        return <line key={i} x1={c} y1={c} x2={x} y2={y} stroke="#E2E8F0" strokeWidth={1} />;
      })}
      <polygon
        points={dataPoints}
        fill="rgba(255,111,97,0.18)"
        stroke="#FF6F61"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {data.map((d, i) => {
        const [x, y] = at(d.score, i);
        return <circle key={i} cx={x} cy={y} r={3} fill="#FF6F61" />;
      })}
      {data.map((d, i) => {
        const [lx, ly] = at(100, i, R + 18);
        const anchor = Math.abs(lx - c) < 6 ? 'middle' : lx > c ? 'start' : 'end';
        return (
          <text
            key={`l-${i}`}
            x={lx}
            y={ly}
            textAnchor={anchor}
            dominantBaseline="middle"
            className="fill-[#64748B]"
            fontSize={10.5}
            fontWeight={500}
          >
            {d.name}
          </text>
        );
      })}
    </svg>
  );
}
