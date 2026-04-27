/* eslint-disable react/no-unknown-property */

/* ===== Base UI primitives ===== */

function Card({ children, style, onClick, hover }) {
  const [h, setH] = React.useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        background: '#fff',
        border: '1px solid #D7DEE8',
        borderRadius: 16,
        padding: 24,
        boxShadow:
          h && hover
            ? '0 4px 12px rgba(13,27,42,.06), 0 2px 4px rgba(13,27,42,.04)'
            : '0 1px 3px rgba(13,27,42,.06), 0 1px 2px rgba(13,27,42,.04)',
        transition: 'box-shadow .15s ease',
        cursor: onClick ? 'pointer' : 'default',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Button({ variant = 'primary', children, onClick, icon, size = 'md', style }) {
  const variants = {
    primary: { bg: '#1E5AA8', color: '#fff', border: '#1E5AA8' },
    secondary: { bg: '#fff', color: '#0D1B2A', border: '#D7DEE8' },
    success: { bg: '#18B5A8', color: '#fff', border: '#18B5A8' },
    alert: { bg: '#FF6F61', color: '#fff', border: '#FF6F61' },
    ghost: { bg: 'transparent', color: '#1E5AA8', border: 'transparent' },
  };
  const v = variants[variant];
  const sizes = {
    sm: { h: 32, px: 12, fs: 13 },
    md: { h: 40, px: 16, fs: 14 },
    lg: { h: 48, px: 20, fs: 15 },
  };
  const s = sizes[size];
  return (
    <button
      onClick={onClick}
      style={{
        height: s.h,
        padding: `0 ${s.px}px`,
        borderRadius: 10,
        background: v.bg,
        color: v.color,
        border: `1px solid ${v.border}`,
        fontFamily: 'Inter',
        fontWeight: 600,
        fontSize: s.fs,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        transition: 'filter .15s ease',
        ...style,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.filter = 'brightness(0.94)')}
      onMouseLeave={(e) => (e.currentTarget.style.filter = 'none')}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

function Badge({ tone = 'info', children, dot = false, style }) {
  const tones = {
    success: { bg: '#E6F7F5', color: '#0F8077' },
    info: { bg: '#E8F1FB', color: '#1E5AA8' },
    warn: { bg: '#FFEDEA', color: '#C8473A' },
    err: { bg: '#FEE7E7', color: '#B91C1C' },
    neutral: { bg: '#F1F3F5', color: '#475569' },
    premium: { bg: '#0D1B2A', color: '#fff' },
  };
  const t = tones[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        fontFamily: 'Inter',
        fontWeight: 600,
        fontSize: 12,
        lineHeight: 1,
        background: t.bg,
        color: t.color,
        ...style,
      }}
    >
      {dot ? (
        <span style={{ width: 6, height: 6, borderRadius: 999, background: 'currentColor' }} />
      ) : null}
      {children}
    </span>
  );
}

function Progress({ value = 0, tone = 'success', height = 8 }) {
  const colors = { success: '#18B5A8', info: '#1E5AA8', warn: '#FF6F61' };
  return (
    <div style={{ height, background: '#F1F3F5', borderRadius: 999, overflow: 'hidden' }}>
      <div
        style={{
          height: '100%',
          width: `${Math.min(100, Math.max(0, value))}%`,
          background: colors[tone],
          borderRadius: 999,
          transition: 'width .3s ease',
        }}
      />
    </div>
  );
}

function StatCard({ label, value, delta, deltaTone = 'success', icon }) {
  const deltaColor =
    deltaTone === 'success' ? '#0F8077' : deltaTone === 'warn' ? '#C8473A' : '#1E5AA8';
  return (
    <Card style={{ padding: 20 }} hover>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 13, color: '#64748B', fontWeight: 500 }}>{label}</div>
        {icon ? (
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: '#E8F1FB',
              color: '#1E5AA8',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <Icon name={icon} size={18} />
          </div>
        ) : null}
      </div>
      <div
        style={{
          fontFamily: 'Sora',
          fontWeight: 700,
          fontSize: 32,
          color: '#0D1B2A',
          lineHeight: 1.1,
          marginTop: 10,
          letterSpacing: '-0.02em',
        }}
      >
        {value}
      </div>
      {delta ? (
        <div style={{ fontSize: 12, color: deltaColor, fontWeight: 600, marginTop: 6 }}>
          {delta}
        </div>
      ) : null}
    </Card>
  );
}

window.Card = Card;
window.Button = Button;
window.Badge = Badge;
window.Progress = Progress;
window.StatCard = StatCard;
